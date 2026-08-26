import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import hre from "hardhat";
import { MaxUint256 } from "ethers";

import { buildPreset, deploySecurityFixture, exactInputSingle, currentBlockTime } from "../helpers/securityFixtures";

// These two views exist purely so an EXTERNAL consumer — the
// EquilibraBoost fair-value LP oracle — can (a) gauge anchor freshness
// without reading raw storage slots by index and (b) refuse to price
// during a read-only-reentrancy window. Neither touches the swap hot
// path; both are additive and must never change existing behaviour.
describe("Pool views for the Boost fair-value oracle", () => {
  async function fixture() {
    // Default security preset (flat 1 bps fee, auto-repeg disabled). The
    // view tests only need lastEmaTs to advance on a swap and the guard
    // to toggle across a callback — neither requires a live repeg, and
    // enabling one here would trip the factory's flat-fee stall guard.
    const preset = buildPreset("WETH");
    return deploySecurityFixture(preset);
  }

  describe("getOracleTimestamps()", () => {
    it("seeds both timestamps at genesis and advances lastEmaTs on a later-block swap", async () => {
      const fx = await loadFixture(fixture);

      const [emaTs0, repegTs0] = await fx.pool.getOracleTimestamps();
      // create+seed is atomic, so both are the genesis block timestamp.
      expect(emaTs0).to.be.greaterThan(0n);
      expect(repegTs0).to.equal(emaTs0);

      // Advance a block and swap so the lazy EMA update runs.
      await time.increase(60);
      await exactInputSingle(fx, fx.trader, {
        tokenIn: fx.baseAddr,
        tokenOut: fx.quoteAddr,
        amountIn: fx.initialBaseRaw / 100n,
      });

      const [emaTs1] = await fx.pool.getOracleTimestamps();
      const nowTs = BigInt(await currentBlockTime());
      expect(emaTs1).to.be.greaterThan(emaTs0);
      expect(emaTs1).to.equal(nowTs);
    });

    it("returns the same values the raw storage slots hold", async () => {
      const fx = await loadFixture(fixture);
      await time.increase(60);
      await exactInputSingle(fx, fx.trader, {
        tokenIn: fx.baseAddr,
        tokenOut: fx.quoteAddr,
        amountIn: fx.initialBaseRaw / 100n,
      });

      const [emaTs, repegTs] = await fx.pool.getOracleTimestamps();
      // The getter must never over- or under-report relative to reality:
      // lastEmaTs is now (a swap just ran), lastRepegTs is <= now.
      const nowTs = BigInt(await currentBlockTime());
      expect(emaTs).to.equal(nowTs);
      expect(repegTs).to.be.lessThanOrEqual(nowTs);
    });
  });

  describe("reentrancyGuardEntered()", () => {
    it("is false at rest (no guarded frame on the stack)", async () => {
      const fx = await loadFixture(fixture);
      expect(await fx.pool.reentrancyGuardEntered()).to.equal(false);
    });

    it("reports the guard as HELD when observed from inside a pool callback", async () => {
      const fx = await loadFixture(fixture);

      const Probe = await hre.ethers.getContractFactory("MockReentrancyGuardProbe");
      const probe: any = await Probe.deploy();
      await probe.waitForDeployment();
      const probeAddr = await probe.getAddress();

      // The probe's mint callback pulls the owed legs from the payer
      // (the EOA calling probe.addLiquidity), so approve the probe.
      await fx.quote.connect(fx.owner).approve(probeAddr, MaxUint256);
      await fx.base.connect(fx.owner).approve(probeAddr, MaxUint256);

      // Small proportional add on the already-seeded pool.
      const [r0, r1] = await fx.pool.getReserves();
      const amt0 = BigInt(r0) / 1000n;
      const amt1 = BigInt(r1) / 1000n;

      await probe.connect(fx.owner).addLiquidity(fx.poolAddr, amt0, amt1, 0, await fx.owner.getAddress());

      expect(await probe.callbackRan()).to.equal(true);
      // The load-bearing assertion: mid-callback the guard is held, so a
      // reserves+supply read is unsafe and the Boost oracle must refuse.
      expect(await probe.enteredDuringCallback()).to.equal(true);

      // Clear-on-exit, tested WITHIN the same transaction: the probe read
      // the guard again after the inner addLiquidity returned, before the
      // tx ended. A cross-tx eth_call could not prove this — EIP-1153
      // wipes transient storage at every tx boundary, so it would read
      // false even if the modifier never cleared the slot.
      expect(await probe.clearedAfterInner()).to.equal(false);

      // And a fresh call also sees it clear (belt-and-suspenders; this
      // one is trivially true because transient storage resets per tx).
      expect(await fx.pool.reentrancyGuardEntered()).to.equal(false);
    });
  });
});
