// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

import { IEquilibraPool } from "./interfaces/IEquilibraPool.sol";
import { IEquilibraFactory } from "./interfaces/IEquilibraFactory.sol";
import { Constants } from "./libraries/Constants.sol";
import { Errors } from "./libraries/Errors.sol";

/**
 * @title EquilibraParamTimelock
 * @notice Per-pool runtime administration of the adjustable parameter set (dynamic-fee triple,
 * repeg step cap, repeg share, direction-split repeg dead-bands, donation-parachute band
 * multiplier) by the pool's creator, under a 24-hour timelock (`PRIVATE_DELAY` of 10 minutes on
 * private pools).
 * @dev Trust model: the creator calibrated the curve and seeded the pool before anyone joined, so
 * the creator administers the parameters and the timelock is the LPs' safeguard. Every change is
 * announced on chain a full queue window before it takes effect and `removeLiquidity` is never
 * gated, so a dissenting LP can exit at the old parameters. Curve shape (`aWad`, `lambdaWad`),
 * the EMA period and the protocol fee are immutable; the pool has no setters for them. The pool's
 * setters are bare stores gated to this contract: every factory invariant and policy rule is
 * enforced here at queue time and again at execution time against the live config.
 */
contract EquilibraParamTimelock {
    // ============ Process constants ============

    /**
     * @notice Delay between queueing a change and its earliest execution on public pools: the
     * LPs' exit window.
     */
    uint256 public constant DELAY = 1 days;

    /**
     * @notice Queue delay of private pools. Their LP set is allowlisted by the same admin who
     * tunes the parameters, so the public announcement window protects nobody the admin has not
     * already chosen; 10 minutes still routes every change through the queue, cancel and grace
     * machinery. The applicable delay is resolved at queue time from the factory's immutable
     * privacy flag.
     */
    uint256 public constant PRIVATE_DELAY = 10 minutes;

    /**
     * @notice Window after `eta` during which a queued change stays executable. An older change
     * must be re-queued, so a stale intent cannot fire into a market it was never announced for.
     */
    uint256 public constant GRACE_PERIOD = 7 days;

    // ============ Runtime change policy ============

    /**
     * @notice Runtime repeg-share floor in user-facing bps. Below it only strict increases from
     * the current nonzero share are allowed, so a low-share pool can grow its budget gradually
     * but never reduce it below the floor. Pools created with share zero stay opted out.
     */
    uint16 public constant RUNTIME_SHARE_FLOOR_BPS = 5_000;
    /**
     * @notice Runtime repeg-share ceiling in stored (protocol-fee grossed-up) bps, the share the
     * repeg gate consumes, so LPs keep at least 5% of growth at any `protocolFeePercent`.
     */
    uint16 public constant RUNTIME_SHARE_CEIL_BPS = 9_500;

    // ============ Storage ============

    /**
     * @notice The factory that deployed this timelock; the only account allowed to register
     * pool admins.
     */
    address public immutable factory;

    /**
     * @notice Parameter administrator per pool: the creator unless transferred or renounced
     * (zero means frozen forever).
     */
    mapping(address => address) public poolAdmin;

    /**
     * @notice Queued dynamic-fee triple; `eta` is the earliest execution timestamp, zero when
     * nothing is queued.
     */
    struct PendingFeeParams {
        uint16 baseFee;
        uint16 feeRampBps;
        uint16 feeFloorBps;
        uint64 eta;
    }

    /**
     * @notice Queued repeg step cap (WAD) and its earliest execution timestamp.
     */
    struct PendingRepegStep {
        uint64 repegStepWad;
        uint64 eta;
    }

    /**
     * @notice Queued user-facing repeg share (bps) and its earliest execution timestamp.
     */
    struct PendingRepegShare {
        uint16 repegShareBps;
        uint64 eta;
    }

    /**
     * @notice Queued direction-split dead-band pair (WAD) and its earliest execution timestamp.
     */
    struct PendingRepegThresholds {
        uint64 repegThresholdToken1UpWad;
        uint64 repegThresholdToken1DownWad;
        uint64 eta;
    }

    /**
     * @notice Queued donation-parachute multiplier and its earliest execution timestamp.
     */
    struct PendingParachuteBandMult {
        uint8 parachuteBandMult;
        uint64 eta;
    }

    /**
     * @notice Queued dynamic-fee change per pool.
     */
    mapping(address => PendingFeeParams) public pendingFeeParams;
    /**
     * @notice Queued step-cap change per pool.
     */
    mapping(address => PendingRepegStep) public pendingRepegStep;
    /**
     * @notice Queued repeg-share change per pool.
     */
    mapping(address => PendingRepegShare) public pendingRepegShare;
    /**
     * @notice Queued dead-band change per pool.
     */
    mapping(address => PendingRepegThresholds) public pendingRepegThresholds;
    /**
     * @notice Queued parachute-multiplier change per pool.
     */
    mapping(address => PendingParachuteBandMult) public pendingParachuteBandMult;

    /**
     * @notice Nominated next admin per pool. The nominee must call `acceptPoolAdmin` to take the
     * role, so a mistyped or dead address never captures administration.
     */
    mapping(address => address) public pendingPoolAdmin;

    // ============ Events ============

    /**
     * @notice Emitted when a pool's admin is registered, transferred or renounced.
     * @param pool The pool.
     * @param admin New admin; zero when renounced.
     */
    event PoolAdminSet(address indexed pool, address indexed admin);
    /**
     * @notice Emitted when a next admin is nominated or a nomination is cleared.
     * @param pool The pool.
     * @param nominee Nominated admin; zero when the nomination is cleared.
     */
    event PoolAdminNominated(address indexed pool, address indexed nominee);
    /**
     * @notice Emitted when a dynamic-fee change is queued.
     * @param pool The pool.
     * @param baseFee Fee ceiling in bps.
     * @param feeRampBps Ramp width in bps of WAD.
     * @param feeFloorBps Fee floor in bps.
     * @param eta Earliest execution timestamp.
     */
    event FeeParamsQueued(
        address indexed pool,
        uint16 baseFee,
        uint16 feeRampBps,
        uint16 feeFloorBps,
        uint64 eta
    );
    /**
     * @notice Emitted when a step-cap change is queued.
     * @param pool The pool.
     * @param repegStepWad New step cap, WAD.
     * @param eta Earliest execution timestamp.
     */
    event RepegStepQueued(address indexed pool, uint256 repegStepWad, uint64 eta);
    /**
     * @notice Emitted when a repeg-share change is queued.
     * @param pool The pool.
     * @param repegShareBps New user-facing share in bps.
     * @param eta Earliest execution timestamp.
     */
    event RepegShareQueued(address indexed pool, uint16 repegShareBps, uint64 eta);
    /**
     * @notice Emitted when a dead-band change is queued.
     * @param pool The pool.
     * @param repegThresholdToken1UpWad New band while `ema > priceScale`, WAD.
     * @param repegThresholdToken1DownWad New band while `ema < priceScale`, WAD.
     * @param eta Earliest execution timestamp.
     */
    event RepegThresholdsQueued(
        address indexed pool,
        uint64 repegThresholdToken1UpWad,
        uint64 repegThresholdToken1DownWad,
        uint64 eta
    );
    /**
     * @notice Emitted when a parachute-multiplier change is queued.
     * @param pool The pool.
     * @param parachuteBandMult New multiplier K.
     * @param eta Earliest execution timestamp.
     */
    event ParachuteBandMultQueued(address indexed pool, uint8 parachuteBandMult, uint64 eta);
    /**
     * @notice Emitted when a queued change is executed.
     * @param pool The pool.
     * @param selector Pool setter that was called.
     */
    event ChangeExecuted(address indexed pool, bytes4 indexed selector);
    /**
     * @notice Emitted when a queued change is cancelled, explicitly or by an admin handover or
     * renounce.
     * @param pool The pool.
     * @param selector Pool setter the change targeted.
     */
    event ChangeCancelled(address indexed pool, bytes4 indexed selector);

    // ============ Wiring ============

    /**
     * @dev Deployed from the factory constructor, so the deployer is the factory; no post-deploy
     * wiring exists.
     */
    constructor() {
        factory = msg.sender;
    }

    /**
     * @dev Reverts `NotPoolAdmin` unless `msg.sender` administers `pool`.
     * @param pool The pool.
     */
    modifier onlyPoolAdmin(address pool) {
        if (msg.sender != poolAdmin[pool]) revert Errors.NotPoolAdmin();
        _;
    }

    /**
     * @notice Bind a freshly created pool to its creator. Factory only.
     * @param pool The pool.
     * @param admin Initial parameter admin.
     */
    function registerPool(address pool, address admin) external {
        if (msg.sender != factory) revert Errors.NotFactory();
        poolAdmin[pool] = admin;
        emit PoolAdminSet(pool, admin);
    }

    /**
     * @notice Nominate the next admin (step one of the two-step handover). The current admin
     * stays in control and the pending queue is untouched until the nominee accepts.
     * Re-nominating overwrites a prior nominee; nominating `address(0)` cancels an outstanding
     * nomination.
     * @param pool The pool.
     * @param newAdmin Nominee.
     */
    function nominatePoolAdmin(address pool, address newAdmin) external onlyPoolAdmin(pool) {
        pendingPoolAdmin[pool] = newAdmin;
        emit PoolAdminNominated(pool, newAdmin);
    }

    /**
     * @notice Claim administration as the nominee (step two). Clears every pending parameter
     * change, so the incoming admin starts from a clean queue, and clears the nomination.
     * @param pool The pool.
     */
    function acceptPoolAdmin(address pool) external {
        if (msg.sender != pendingPoolAdmin[pool]) revert Errors.NotPendingPoolAdmin();
        _clearPending(pool);
        pendingPoolAdmin[pool] = address(0);
        emit PoolAdminNominated(pool, address(0));
        poolAdmin[pool] = msg.sender;
        emit PoolAdminSet(pool, msg.sender);
    }

    /**
     * @notice Renounce administration: the parameter set freezes at its current values forever,
     * since registration is factory-only and happens at creation. Pending changes and any
     * nomination are cleared, so no surviving queue can execute after the freeze.
     * @param pool The pool.
     */
    function renouncePoolAdmin(address pool) external onlyPoolAdmin(pool) {
        _clearPending(pool);
        if (pendingPoolAdmin[pool] != address(0)) {
            pendingPoolAdmin[pool] = address(0);
            emit PoolAdminNominated(pool, address(0));
        }
        poolAdmin[pool] = address(0);
        emit PoolAdminSet(pool, address(0));
    }

    // ============ Queue / cancel ============

    /**
     * @notice Queue a dynamic-fee change. Validation also re-runs at execution; the queue-time
     * check gives the admin an early revert.
     * @param pool The pool.
     * @param baseFee_ Fee ceiling in bps, within `[MIN_BASE_FEE, MAX_BASE_FEE]`.
     * @param feeRampBps_ Ramp width in bps of WAD, at most `MAX_FEE_RAMP_BPS`; zero disables the
     * ramp.
     * @param feeFloorBps_ Fee floor in bps; with a live ramp it must satisfy
     * `1 <= feeFloorBps_ < baseFee_` and the ramp monotonicity guard.
     */
    function queueFeeParams(
        address pool,
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) external onlyPoolAdmin(pool) {
        _validateFeeParams(baseFee_, feeRampBps_, feeFloorBps_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingFeeParams[pool] = PendingFeeParams(baseFee_, feeRampBps_, feeFloorBps_, eta);
        emit FeeParamsQueued(pool, baseFee_, feeRampBps_, feeFloorBps_, eta);
    }

    /**
     * @notice Queue a step-cap change within the factory range `[MIN_REPEG_STEP, MAX_REPEG_STEP]`
     * and within `[half, double]` of the live value. The new cap must be at least both live
     * activation bands.
     * @param pool The pool.
     * @param repegStepWad_ New step cap, WAD.
     */
    function queueRepegStep(address pool, uint256 repegStepWad_) external onlyPoolAdmin(pool) {
        _validateStep(pool, repegStepWad_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingRepegStep[pool] = PendingRepegStep(uint64(repegStepWad_), eta);
        emit RepegStepQueued(pool, repegStepWad_, eta);
    }

    /**
     * @notice Queue a repeg-share change within the runtime policy band and the protocol-fee
     * budget cap.
     * @param pool The pool.
     * @param repegShareBps_ New user-facing share in bps.
     */
    function queueRepegShare(address pool, uint16 repegShareBps_) external onlyPoolAdmin(pool) {
        _validateShare(pool, repegShareBps_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingRepegShare[pool] = PendingRepegShare(repegShareBps_, eta);
        emit RepegShareQueued(pool, repegShareBps_, eta);
    }

    /**
     * @notice Queue a change of the direction-split dead-bands, validated against the factory
     * range and the live step cap, independently of fees. Both bands must be at most the step
     * cap.
     * @param pool The pool.
     * @param repegThresholdToken1UpWad_ Band while `ema > priceScale`, WAD.
     * @param repegThresholdToken1DownWad_ Band while `ema < priceScale`, WAD.
     */
    function queueRepegThresholds(
        address pool,
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) external onlyPoolAdmin(pool) {
        _validateThresholds(pool, repegThresholdToken1UpWad_, repegThresholdToken1DownWad_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingRepegThresholds[pool] = PendingRepegThresholds(
            repegThresholdToken1UpWad_,
            repegThresholdToken1DownWad_,
            eta
        );
        emit RepegThresholdsQueued(
            pool,
            repegThresholdToken1UpWad_,
            repegThresholdToken1DownWad_,
            eta
        );
    }

    /**
     * @notice Queue a change of the donation-parachute multiplier K (the parachute opens at a
     * deviation of at least `K * active dead-band`). Range `[1, 255]`: zero would erase the lag
     * qualifier and is rejected. On pools with `repegShareBps == 0` the knob is inert.
     * @param pool The pool.
     * @param parachuteBandMult_ New multiplier.
     */
    function queueParachuteBandMult(
        address pool,
        uint8 parachuteBandMult_
    ) external onlyPoolAdmin(pool) {
        _validateParachuteBandMult(parachuteBandMult_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingParachuteBandMult[pool] = PendingParachuteBandMult(parachuteBandMult_, eta);
        emit ParachuteBandMultQueued(pool, parachuteBandMult_, eta);
    }

    /**
     * @notice Cancel the queued dynamic-fee change. Reverts `ParamChangeNotQueued` when none is
     * queued.
     * @param pool The pool.
     */
    function cancelFeeParams(address pool) external onlyPoolAdmin(pool) {
        if (pendingFeeParams[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingFeeParams[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setFeeParams.selector);
    }

    /**
     * @notice Cancel the queued step-cap change. Reverts `ParamChangeNotQueued` when none is
     * queued.
     * @param pool The pool.
     */
    function cancelRepegStep(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegStep[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegStep[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegStepWad.selector);
    }

    /**
     * @notice Cancel the queued repeg-share change. Reverts `ParamChangeNotQueued` when none is
     * queued.
     * @param pool The pool.
     */
    function cancelRepegShare(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegShare[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegShare[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegShareBps.selector);
    }

    /**
     * @notice Cancel the queued dead-band change. Reverts `ParamChangeNotQueued` when none is
     * queued.
     * @param pool The pool.
     */
    function cancelRepegThresholds(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegThresholds[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegThresholds[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegThresholds.selector);
    }

    /**
     * @notice Cancel the queued parachute-multiplier change. Reverts `ParamChangeNotQueued` when
     * none is queued.
     * @param pool The pool.
     */
    function cancelParachuteBandMult(address pool) external onlyPoolAdmin(pool) {
        if (pendingParachuteBandMult[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingParachuteBandMult[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setParachuteBandMult.selector);
    }

    // ============ Execute ============
    // Execution is admin-gated like queue and cancel: after the delay the admin either executes
    // or cancels, and nobody else can force the announced change through. A lost admin key
    // strands pending changes together with the queue itself; the grace window expires them.

    /**
     * @notice Execute the queued dynamic-fee change after its delay, re-validating it first.
     * @param pool The pool.
     */
    function executeFeeParams(address pool) external onlyPoolAdmin(pool) {
        PendingFeeParams memory p = pendingFeeParams[pool];
        _checkEta(p.eta);
        _validateFeeParams(p.baseFee, p.feeRampBps, p.feeFloorBps);
        delete pendingFeeParams[pool];
        IEquilibraPool(pool).setFeeParams(p.baseFee, p.feeRampBps, p.feeFloorBps);
        emit ChangeExecuted(pool, IEquilibraPool.setFeeParams.selector);
    }

    /**
     * @notice Execute the queued step-cap change after its delay, re-validating it against the
     * live cap and bands.
     * @param pool The pool.
     */
    function executeRepegStep(address pool) external onlyPoolAdmin(pool) {
        PendingRepegStep memory p = pendingRepegStep[pool];
        _checkEta(p.eta);
        _validateStep(pool, p.repegStepWad);
        delete pendingRepegStep[pool];
        IEquilibraPool(pool).setRepegStepWad(p.repegStepWad);
        emit ChangeExecuted(pool, IEquilibraPool.setRepegStepWad.selector);
    }

    /**
     * @notice Execute the queued dead-band change after its delay, re-validating it against the
     * live step cap.
     * @param pool The pool.
     */
    function executeRepegThresholds(address pool) external onlyPoolAdmin(pool) {
        PendingRepegThresholds memory p = pendingRepegThresholds[pool];
        _checkEta(p.eta);
        _validateThresholds(pool, p.repegThresholdToken1UpWad, p.repegThresholdToken1DownWad);
        delete pendingRepegThresholds[pool];
        IEquilibraPool(pool).setRepegThresholds(
            p.repegThresholdToken1UpWad,
            p.repegThresholdToken1DownWad
        );
        emit ChangeExecuted(pool, IEquilibraPool.setRepegThresholds.selector);
    }

    /**
     * @notice Execute the queued repeg-share change after its delay, re-validating it against the
     * live share and the pool's immutable protocol fee.
     * @param pool The pool.
     */
    function executeRepegShare(address pool) external onlyPoolAdmin(pool) {
        PendingRepegShare memory p = pendingRepegShare[pool];
        _checkEta(p.eta);
        _validateShare(pool, p.repegShareBps);
        delete pendingRepegShare[pool];
        IEquilibraPool(pool).setRepegShareBps(p.repegShareBps);
        emit ChangeExecuted(pool, IEquilibraPool.setRepegShareBps.selector);
    }

    /**
     * @notice Execute the queued parachute-multiplier change after its delay.
     * @param pool The pool.
     */
    function executeParachuteBandMult(address pool) external onlyPoolAdmin(pool) {
        PendingParachuteBandMult memory p = pendingParachuteBandMult[pool];
        _checkEta(p.eta);
        _validateParachuteBandMult(p.parachuteBandMult);
        delete pendingParachuteBandMult[pool];
        IEquilibraPool(pool).setParachuteBandMult(p.parachuteBandMult);
        emit ChangeExecuted(pool, IEquilibraPool.setParachuteBandMult.selector);
    }

    // ============ Internals ============

    /**
     * @dev Queue delay of `pool`: `PRIVATE_DELAY` for private pools (factory-attested, immutable
     * per pool), `DELAY` otherwise.
     */
    function _delayFor(address pool) private view returns (uint256) {
        return IEquilibraFactory(factory).isPrivatePool(pool) ? PRIVATE_DELAY : DELAY;
    }

    /**
     * @dev Reverts `ParamChangeNotQueued` on a zero `eta`, `ParamChangeNotReady` before it and
     * `ParamChangeExpired` after `eta + GRACE_PERIOD`.
     */
    function _checkEta(uint64 eta) private view {
        if (eta == 0) revert Errors.ParamChangeNotQueued();
        if (block.timestamp < eta) revert Errors.ParamChangeNotReady();
        if (block.timestamp > uint256(eta) + GRACE_PERIOD) revert Errors.ParamChangeExpired();
    }

    /**
     * @dev Validate the fee triple at queue and execution time; the pool's `setFeeParams` stores
     * it without validation. Reverts `InvalidFee`, `InvalidFeeRamp`, `InvalidFeeFloor` or
     * `FeeRampTooNarrow` with the same bounds and monotonicity guard as the factory.
     */
    function _validateFeeParams(
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) private pure {
        if (baseFee_ < Constants.MIN_BASE_FEE || baseFee_ > Constants.MAX_BASE_FEE)
            revert Errors.InvalidFee();
        if (feeRampBps_ != 0) {
            if (feeRampBps_ > Constants.MAX_FEE_RAMP_BPS) revert Errors.InvalidFeeRamp();
            if (feeFloorBps_ == 0 || feeFloorBps_ >= baseFee_) revert Errors.InvalidFeeFloor();
            // Same monotonicity guard as the factory's deploy-time check.
            uint256 span = uint256(baseFee_) - uint256(feeFloorBps_);
            uint256 inv = Constants.BPS - uint256(baseFee_);
            if (
                uint256(feeRampBps_) * inv * inv <
                Constants.FEE_RAMP_GUARD_MULT * Constants.BPS * span * span
            ) revert Errors.FeeRampTooNarrow();
        }
    }

    /**
     * @dev Both bands must lie in [1, WAD) and not exceed the live step cap. Runs at
     * queue and execution time, independently of fees. Reverts `InvalidRepegThreshold` or
     * `RepegThresholdExceedsStep`.
     */
    function _validateThresholds(
        address pool,
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) private view {
        if (
            repegThresholdToken1UpWad_ < Constants.MIN_REPEG_STEP ||
            repegThresholdToken1UpWad_ >= Constants.WAD ||
            repegThresholdToken1DownWad_ < Constants.MIN_REPEG_STEP ||
            repegThresholdToken1DownWad_ >= Constants.WAD
        ) revert Errors.InvalidRepegThreshold();
        _validateThresholdStep(
            IEquilibraPool(pool).getFeeConfig().repegStepWad,
            repegThresholdToken1UpWad_,
            repegThresholdToken1DownWad_
        );
    }

    /**
     * @dev Reverts `RepegShareImmutable` on an opted-out pool and `RepegShareChangeOutOfRange`
     * when the target is below the floor without strictly increasing the live share, or when its
     * stored (grossed-up) value exceeds `RUNTIME_SHARE_CEIL_BPS`, which also keeps it under the
     * protocol-fee budget cap.
     */
    function _validateShare(address pool, uint16 repegShareBps_) private view {
        IEquilibraPool.FeeConfig memory cfg = IEquilibraPool(pool).getFeeConfig();
        if (cfg.repegShareBps == 0) revert Errors.RepegShareImmutable();
        if (repegShareBps_ < RUNTIME_SHARE_FLOOR_BPS && repegShareBps_ <= cfg.repegShareBps)
            revert Errors.RepegShareChangeOutOfRange();
        if (_storedShare(repegShareBps_, cfg.protocolFeePercent) > RUNTIME_SHARE_CEIL_BPS)
            revert Errors.RepegShareChangeOutOfRange();
    }

    /**
     * @dev The runtime step range equals the factory's deploy range, and one queued change may at
     * most double or halve the live value; both edges are exact comparisons (`new > 2 * current`
     * or `2 * new < current` rejects) without division rounding and without overflow, since both
     * operands are at most `MAX_REPEG_STEP = WAD`. The multiplicative band puts the slew-rate
     * knob on a gradual ratchet, so an extreme setting takes several queue windows and LPs keep a
     * full exit window between moves. The new cap must also be at least both live bands. Runs at
     * queue and execution time. Reverts `InvalidRepegStep`, `RepegStepChangeTooLarge` or
     * `RepegThresholdExceedsStep`.
     */
    function _validateStep(address pool, uint256 repegStepWad_) private view {
        if (repegStepWad_ < Constants.MIN_REPEG_STEP || repegStepWad_ > Constants.MAX_REPEG_STEP)
            revert Errors.InvalidRepegStep();
        IEquilibraPool.FeeConfig memory cfg = IEquilibraPool(pool).getFeeConfig();
        uint256 current = cfg.repegStepWad;
        if (repegStepWad_ > current * 2 || repegStepWad_ * 2 < current)
            revert Errors.RepegStepChangeTooLarge();
        _validateThresholdStep(
            repegStepWad_,
            cfg.repegThresholdToken1UpWad,
            cfg.repegThresholdToken1DownWad
        );
    }

    /**
     * @dev Reverts `RepegThresholdExceedsStep` when either band exceeds the step cap.
     */
    function _validateThresholdStep(uint256 stepWad, uint256 upWad, uint256 downWad) private pure {
        if (upWad > stepWad || downWad > stepWad) revert Errors.RepegThresholdExceedsStep();
    }

    /**
     * @dev Standalone range check: the `uint8` type caps the ceiling at 255 and only zero is
     * rejected with `InvalidParachuteBandMult`. Runs at queue and execution time.
     */
    function _validateParachuteBandMult(uint8 parachuteBandMult_) private pure {
        if (parachuteBandMult_ == 0) revert Errors.InvalidParachuteBandMult();
    }

    /**
     * @dev The floor-division gross-up map the pool applies in `setRepegShareBps` and
     * `initialize`, simplified to `userShare * 100 / (100 - protocolFeePercent)`.
     */
    function _storedShare(
        uint16 userShareBps,
        uint8 protocolFeePercent
    ) private pure returns (uint256) {
        return (uint256(userShareBps) * 100) / (100 - uint256(protocolFeePercent));
    }

    /**
     * @dev Drop every pending change of `pool`, emitting the matching `ChangeCancelled` events so
     * LP-side monitoring sees the queue empty out.
     */
    function _clearPending(address pool) private {
        if (pendingFeeParams[pool].eta != 0) {
            delete pendingFeeParams[pool];
            emit ChangeCancelled(pool, IEquilibraPool.setFeeParams.selector);
        }
        if (pendingRepegStep[pool].eta != 0) {
            delete pendingRepegStep[pool];
            emit ChangeCancelled(pool, IEquilibraPool.setRepegStepWad.selector);
        }
        if (pendingRepegShare[pool].eta != 0) {
            delete pendingRepegShare[pool];
            emit ChangeCancelled(pool, IEquilibraPool.setRepegShareBps.selector);
        }
        if (pendingRepegThresholds[pool].eta != 0) {
            delete pendingRepegThresholds[pool];
            emit ChangeCancelled(pool, IEquilibraPool.setRepegThresholds.selector);
        }
        if (pendingParachuteBandMult[pool].eta != 0) {
            delete pendingParachuteBandMult[pool];
            emit ChangeCancelled(pool, IEquilibraPool.setParachuteBandMult.selector);
        }
    }
}
