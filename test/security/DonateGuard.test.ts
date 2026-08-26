// Router-side donation guard. A donation is LP shares parked on the
// pool's OWN address; the pool exposes no entrypoint for it — a plain
// ERC20 `transfer` of LP shares to the pool is the canonical, unguarded
// route. `EquilibraRouter.donate(tokenA, tokenB, poolIndex, shares,
// maxSupply, deadline)` wraps that transfer for donors that need the
// donation atomic against the state they quoted:
//   - `maxSupply` pins the pool's `totalSupply()`: any mint landing
//     first raises supply and reverts the call, so a zero-capital
//     sandwich cannot join to divert part of the lift the donation
//     gives the active float;
//   - `deadline` bounds how long the signed intent stays live.
// The donor approves the ROUTER on the pool's LP token (the router
// pulls via `safeTransferFrom(pool, msg.sender, pool, shares)`).
import { expect } from "chai";
import { MaxUint256 } from "ethers";
import { buildPreset, deploySecurityFixture, currentBlockTime } from "../helpers/securityFixtures";

describe("Donation front-run guard (EquilibraRouter.donate)", () => {
  const FAR = 1_900_000_000n;

  async function fx() {
    const f = await deploySecurityFixture(buildPreset("WETH"));
    // LP-share allowance for the router: the donate entrypoint pulls
    // the shares from the donor (token approvals are fixture-wide).
    await f.pool.connect(f.owner).approve(await f.router.getAddress(), MaxUint256);
    return f;
  }

  it("parks shares at the quoted supply without touching totalSupply or reserves", async () => {
    const f = await fx();
    const supply0: bigint = await f.pool.totalSupply();
    const parked0: bigint = await f.pool.balanceOf(f.poolAddr);
    const donorBefore: bigint = await f.pool.balanceOf(f.owner.address);
    const [r0, r1] = await f.pool.getReserves();
    const shares = donorBefore / 20n;

    // `maxSupply == live supply` is the passing boundary of the pin.
    await f.router.connect(f.owner).donate(f.quoteAddr, f.baseAddr, 0, shares, supply0, FAR);

    expect((await f.pool.balanceOf(f.poolAddr)) - parked0).to.equal(shares);
    expect(await f.pool.balanceOf(f.owner.address)).to.equal(donorBefore - shares);
    expect(await f.pool.totalSupply()).to.equal(supply0);
    const [q0, q1] = await f.pool.getReserves();
    expect(q0).to.equal(r0);
    expect(q1).to.equal(r1);
  });

  it("reverts when a mint front-runs the quoted supply; re-quoting recovers", async () => {
    const f = await fx();
    const quoted: bigint = await f.pool.totalSupply();
    const shares = (await f.pool.balanceOf(f.owner.address)) / 20n;

    // Front-running joiner: any mint raises totalSupply above the pin.
    await f.router.connect(f.attacker).addLiquidity({
      tokenA: f.quoteAddr,
      tokenB: f.baseAddr,
      poolIndex: 0,
      amountADesired: f.initialQuoteRaw / 10n,
      amountBDesired: f.initialBaseRaw / 10n,
      minShares: 0,
      recipient: f.attacker.address,
      deadline: FAR,
    });
    expect(await f.pool.totalSupply()).to.be.greaterThan(quoted);

    await expect(
      f.router.connect(f.owner).donate(f.quoteAddr, f.baseAddr, 0, shares, quoted, FAR)
    ).to.be.revertedWithCustomError(f.router, "SlippageExceeded");

    // The donor re-quotes against the new supply and the pin passes.
    const requoted: bigint = await f.pool.totalSupply();
    const parked0: bigint = await f.pool.balanceOf(f.poolAddr);
    await f.router.connect(f.owner).donate(f.quoteAddr, f.baseAddr, 0, shares, requoted, FAR);
    expect((await f.pool.balanceOf(f.poolAddr)) - parked0).to.equal(shares);
  });

  it("a plain LP transfer to the pool is still an equivalent, unguarded donation", async () => {
    const f = await fx();
    const supply0: bigint = await f.pool.totalSupply();
    const shares = (await f.pool.balanceOf(f.owner.address)) / 40n;
    const parked0: bigint = await f.pool.balanceOf(f.poolAddr);
    await f.pool.connect(f.owner).transfer(f.poolAddr, shares);
    expect((await f.pool.balanceOf(f.poolAddr)) - parked0).to.equal(shares);
    expect(await f.pool.totalSupply()).to.equal(supply0);
  });

  it("reverts past the deadline, on zero shares, and on identical tokens", async () => {
    const f = await fx();
    const s: bigint = await f.pool.totalSupply();
    const now = BigInt(await currentBlockTime());
    await expect(
      f.router.connect(f.owner).donate(f.quoteAddr, f.baseAddr, 0, 1n, s, now - 10n)
    ).to.be.revertedWithCustomError(f.router, "DeadlineExpired");
    await expect(
      f.router.connect(f.owner).donate(f.quoteAddr, f.baseAddr, 0, 0n, s, FAR)
    ).to.be.revertedWithCustomError(f.router, "ZeroAmount");
    await expect(
      f.router.connect(f.owner).donate(f.quoteAddr, f.quoteAddr, 0, 1n, s, FAR)
    ).to.be.revertedWithCustomError(f.router, "IdenticalTokens");
  });
});
