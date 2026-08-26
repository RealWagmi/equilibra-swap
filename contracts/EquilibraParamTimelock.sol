// SPDX-License-Identifier: SAL-1.0
pragma solidity ^0.8.20;

import { IEquilibraPool } from "./interfaces/IEquilibraPool.sol";
import { IEquilibraFactory } from "./interfaces/IEquilibraFactory.sol";
import { Constants } from "./libraries/Constants.sol";
import { Errors } from "./libraries/Errors.sol";

/// @title EquilibraParamTimelock
/// @notice Per-pool runtime administration of the safe parameter set
///         (dynamic-fee triple, repeg step cap, repeg share,
///         direction-split repeg dead-bands, donation-parachute band
///         multiplier) by the pool's creator, under a 24-hour timelock
///         ({PRIVATE_DELAY} = 10 minutes for private pools).
///
///     Trust model: the creator calibrated the curve and seeded the
///     pool before anyone else joined, so every LP position is an
///     explicit act of trust in that calibration. The creator is
///     therefore the parameter administrator — not an LP vote — and
///     the timelock is the LPs' safeguard: every change is announced
///     on chain a full queue window before it takes effect (a day for
///     public pools; {PRIVATE_DELAY} for private ones, whose LP set the
///     admin curates anyway), and `removeLiquidity` stays open
///     unconditionally, so a dissenting LP always has the whole delay
///     window to exit at the old parameters.
///
///     The changeable set is deliberately minimal: the dynamic-fee
///     triple, the repeg step cap, the repeg share, the
///     direction-split repeg dead-bands and the donation-parachute
///     band multiplier. Curve shape (`aWad`,
///     `lambdaWad`), the EMA period and the protocol fee are immutable
///     for the pool's lifetime — the pool's setters do not exist for
///     them. The pool's setters are bare stores gated to this
///     contract; every factory invariant and every policy rule is
///     enforced here, both at queue time and again at execution time
///     against the live config.
contract EquilibraParamTimelock {
    // ============ Process constants ============

    /// @notice Delay between queueing a change and the earliest moment
    ///         it can be executed — the LPs' exit window.
    uint256 public constant DELAY = 1 days;

    /// @notice {DELAY} for PRIVATE pools. Their LP set is allowlisted
    ///         by the same admin who tunes the parameters, so the
    ///         day-long public announcement window protects nobody the
    ///         admin has not already chosen; 10 minutes still forces
    ///         every change through the queue/execute machinery (an
    ///         on-chain announcement, cancellable, grace-bounded)
    ///         rather than making it instant. `removeLiquidity` stays
    ///         ungated either way. Which delay applies is resolved at
    ///         QUEUE time from the factory's immutable privacy flag.
    uint256 public constant PRIVATE_DELAY = 10 minutes;

    /// @notice Window after `eta` during which a queued change stays
    ///         executable. A change older than `eta + GRACE_PERIOD`
    ///         must be re-queued, so stale intents cannot fire into a
    ///         market they were never announced for.
    uint256 public constant GRACE_PERIOD = 7 days;

    // ============ Runtime change policy ============

    /// @notice Runtime repeg-share band. The floor applies to the
    ///         user-facing share: it can never be tuned below half of
    ///         growth (starving the anchor of budget is a rug against
    ///         wrappers pricing LP through it). The ceiling applies to
    ///         the STORED, protocol-fee grossed-up share the repeg gate
    ///         actually consumes — so LPs keep at least a 5% slice of
    ///         growth regardless of `protocolFeePercent` (a user-space
    ///         ceiling would let the gross-up collapse the LP floor to
    ///         zero at high protocol fees). The band is absolute: a
    ///         pool created below the floor can only be raised into it.
    uint16 public constant RUNTIME_SHARE_FLOOR_BPS = 5_000;
    uint16 public constant RUNTIME_SHARE_CEIL_BPS = 9_500;

    // ============ Storage ============

    /// @notice The factory that deployed this timelock; the only
    ///         account allowed to register pool admins.
    address public immutable factory;

    /// @notice Parameter administrator per pool — the pool's creator,
    ///         unless transferred or renounced (zero = frozen forever).
    mapping(address => address) public poolAdmin;

    struct PendingFeeParams {
        uint16 baseFee;
        uint16 feeRampBps;
        uint16 feeFloorBps;
        uint64 eta;
    }

    struct PendingRepegStep {
        uint64 repegStepWad;
        uint64 eta;
    }

    struct PendingRepegShare {
        uint16 repegShareBps;
        uint64 eta;
    }

    struct PendingRepegThresholds {
        uint64 repegThresholdToken1UpWad;
        uint64 repegThresholdToken1DownWad;
        uint64 eta;
    }

    struct PendingParachuteBandMult {
        uint8 parachuteBandMult;
        uint64 eta;
    }

    mapping(address => PendingFeeParams) public pendingFeeParams;
    mapping(address => PendingRepegStep) public pendingRepegStep;
    mapping(address => PendingRepegShare) public pendingRepegShare;
    mapping(address => PendingRepegThresholds) public pendingRepegThresholds;
    mapping(address => PendingParachuteBandMult) public pendingParachuteBandMult;

    /// @notice Nominated next admin per pool (two-step handover). The
    ///         nominee must call {acceptPoolAdmin} to take the role, so a
    ///         mistyped/dead address never captures administration.
    mapping(address => address) public pendingPoolAdmin;

    // ============ Events ============

    event PoolAdminSet(address indexed pool, address indexed admin);
    event PoolAdminNominated(address indexed pool, address indexed nominee);
    event FeeParamsQueued(
        address indexed pool,
        uint16 baseFee,
        uint16 feeRampBps,
        uint16 feeFloorBps,
        uint64 eta
    );
    event RepegStepQueued(address indexed pool, uint256 repegStepWad, uint64 eta);
    event RepegShareQueued(address indexed pool, uint16 repegShareBps, uint64 eta);
    event RepegThresholdsQueued(
        address indexed pool,
        uint64 repegThresholdToken1UpWad,
        uint64 repegThresholdToken1DownWad,
        uint64 eta
    );
    event ParachuteBandMultQueued(address indexed pool, uint8 parachuteBandMult, uint64 eta);
    event ChangeExecuted(address indexed pool, bytes4 indexed selector);
    event ChangeCancelled(address indexed pool, bytes4 indexed selector);

    // ============ Wiring ============

    /// @dev Deployed from the factory constructor, so the deployer IS
    ///      the factory — no post-deploy wiring step exists.
    constructor() {
        factory = msg.sender;
    }

    modifier onlyPoolAdmin(address pool) {
        if (msg.sender != poolAdmin[pool]) revert Errors.NotPoolAdmin();
        _;
    }

    /// @notice Bind a freshly created pool to its creator. Factory only.
    function registerPool(address pool, address admin) external {
        if (msg.sender != factory) revert Errors.NotFactory();
        poolAdmin[pool] = admin;
        emit PoolAdminSet(pool, admin);
    }

    /// @notice Step 1 of a two-step admin handover: nominate the next
    ///         admin. The current admin stays in control and the pending
    ///         parameter queue is untouched until the nominee accepts, so
    ///         a mistyped or non-controllable address cannot strand the
    ///         role. Re-nominating overwrites a prior pending nominee;
    ///         nominating `address(0)` cancels an outstanding nomination.
    function nominatePoolAdmin(address pool, address newAdmin) external onlyPoolAdmin(pool) {
        pendingPoolAdmin[pool] = newAdmin;
        emit PoolAdminNominated(pool, newAdmin);
    }

    /// @notice Step 2: the nominee claims administration. Clears any
    ///         pending parameter changes so the incoming admin starts
    ///         from a clean queue instead of inheriting announcements it
    ///         never made, and clears the nomination.
    function acceptPoolAdmin(address pool) external {
        if (msg.sender != pendingPoolAdmin[pool]) revert Errors.NotPendingPoolAdmin();
        _clearPending(pool);
        pendingPoolAdmin[pool] = address(0);
        emit PoolAdminNominated(pool, address(0));
        poolAdmin[pool] = msg.sender;
        emit PoolAdminSet(pool, msg.sender);
    }

    /// @notice Renounce pool administration: the parameter set freezes
    ///         at its current values forever (registration is factory-
    ///         only and the factory registers only at creation).
    ///         Pending changes are cleared — with no admin left to
    ///         cancel them, a surviving queue would make the freeze a
    ///         lie for up to `DELAY + GRACE_PERIOD`.
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

    /// @notice Queue a dynamic-fee re-parameterisation. Validation
    ///         also re-runs at execution; the queue-time check gives
    ///         the admin an early revert instead of a day-late one.
    function queueFeeParams(
        address pool,
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) external onlyPoolAdmin(pool) {
        _validateFeeParams(pool, baseFee_, feeRampBps_, feeFloorBps_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingFeeParams[pool] = PendingFeeParams(baseFee_, feeRampBps_, feeFloorBps_, eta);
        emit FeeParamsQueued(pool, baseFee_, feeRampBps_, feeFloorBps_, eta);
    }

    /// @notice Queue a repeg step-cap change, held to the factory's
    ///         deploy range `[MIN_REPEG_STEP, MAX_REPEG_STEP]` and to a
    ///         per-change band of `[half, double]` of the live value.
    function queueRepegStep(address pool, uint256 repegStepWad_) external onlyPoolAdmin(pool) {
        _validateStep(pool, repegStepWad_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingRepegStep[pool] = PendingRepegStep(uint64(repegStepWad_), eta);
        emit RepegStepQueued(pool, repegStepWad_, eta);
    }

    /// @notice Queue a repeg-share change within the runtime policy
    ///         band and the protocol-fee budget cap.
    function queueRepegShare(address pool, uint16 repegShareBps_) external onlyPoolAdmin(pool) {
        _validateShare(pool, repegShareBps_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingRepegShare[pool] = PendingRepegShare(repegShareBps_, eta);
        emit RepegShareQueued(pool, repegShareBps_, eta);
    }

    /// @notice Queue a change of the direction-split repeg dead-bands,
    ///         validated against the factory range and the stall guard
    ///         on the live fee scale.
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

    /// @notice Queue a change of the donation-parachute activation
    ///         multiplier K (parachute opens at deviation ≥ `K × active
    ///         dead-band`). Range `[1, 255]`: the `uint8` type caps the
    ///         ceiling, zero is rejected — it would erase the lag
    ///         qualifier and turn the parachute into the continuous
    ///         top-up the design deliberately rejects. On pools with
    ///         `repegShareBps == 0` the knob is inert (the parachute is
    ///         unreachable), so queueing there is a harmless no-op.
    function queueParachuteBandMult(
        address pool,
        uint8 parachuteBandMult_
    ) external onlyPoolAdmin(pool) {
        _validateParachuteBandMult(parachuteBandMult_);
        uint64 eta = uint64(block.timestamp + _delayFor(pool));
        pendingParachuteBandMult[pool] = PendingParachuteBandMult(parachuteBandMult_, eta);
        emit ParachuteBandMultQueued(pool, parachuteBandMult_, eta);
    }

    function cancelFeeParams(address pool) external onlyPoolAdmin(pool) {
        if (pendingFeeParams[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingFeeParams[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setFeeParams.selector);
    }

    function cancelRepegStep(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegStep[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegStep[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegStepWad.selector);
    }

    function cancelRepegShare(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegShare[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegShare[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegShareBps.selector);
    }

    function cancelRepegThresholds(address pool) external onlyPoolAdmin(pool) {
        if (pendingRepegThresholds[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingRepegThresholds[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setRepegThresholds.selector);
    }

    function cancelParachuteBandMult(address pool) external onlyPoolAdmin(pool) {
        if (pendingParachuteBandMult[pool].eta == 0) revert Errors.ParamChangeNotQueued();
        delete pendingParachuteBandMult[pool];
        emit ChangeCancelled(pool, IEquilibraPool.setParachuteBandMult.selector);
    }

    // ============ Execute ============
    // Execution is admin-gated, like queue and cancel: the admin keeps
    // the whole lifecycle of a queued change — after the delay they
    // either execute it or cancel it, and nobody else can force the
    // announced change over the line while the admin is still deciding.
    // A lost admin key therefore strands pending changes, but it
    // equally strands the queue itself; the grace window expires them.

    function executeFeeParams(address pool) external onlyPoolAdmin(pool) {
        PendingFeeParams memory p = pendingFeeParams[pool];
        _checkEta(p.eta);
        // The pool's setter is a bare store — validation here, against
        // the LIVE config, is the authoritative gate (an interim change
        // cannot invalidate a queued one unnoticed).
        _validateFeeParams(pool, p.baseFee, p.feeRampBps, p.feeFloorBps);
        delete pendingFeeParams[pool];
        IEquilibraPool(pool).setFeeParams(p.baseFee, p.feeRampBps, p.feeFloorBps);
        emit ChangeExecuted(pool, IEquilibraPool.setFeeParams.selector);
    }

    function executeRepegStep(address pool) external onlyPoolAdmin(pool) {
        PendingRepegStep memory p = pendingRepegStep[pool];
        _checkEta(p.eta);
        _validateStep(pool, p.repegStepWad);
        delete pendingRepegStep[pool];
        IEquilibraPool(pool).setRepegStepWad(p.repegStepWad);
        emit ChangeExecuted(pool, IEquilibraPool.setRepegStepWad.selector);
    }

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

    function executeRepegShare(address pool) external onlyPoolAdmin(pool) {
        PendingRepegShare memory p = pendingRepegShare[pool];
        _checkEta(p.eta);
        // Policy is re-checked against live config: an interim fee
        // change cannot smuggle the share past the budget cap.
        _validateShare(pool, p.repegShareBps);
        delete pendingRepegShare[pool];
        IEquilibraPool(pool).setRepegShareBps(p.repegShareBps);
        emit ChangeExecuted(pool, IEquilibraPool.setRepegShareBps.selector);
    }

    function executeParachuteBandMult(address pool) external onlyPoolAdmin(pool) {
        PendingParachuteBandMult memory p = pendingParachuteBandMult[pool];
        _checkEta(p.eta);
        _validateParachuteBandMult(p.parachuteBandMult);
        delete pendingParachuteBandMult[pool];
        IEquilibraPool(pool).setParachuteBandMult(p.parachuteBandMult);
        emit ChangeExecuted(pool, IEquilibraPool.setParachuteBandMult.selector);
    }

    // ============ Internals ============

    /// @dev Queue delay for `pool`: the short window for private pools
    ///      (factory-attested, immutable per pool), the full public
    ///      exit window otherwise.
    function _delayFor(address pool) private view returns (uint256) {
        return IEquilibraFactory(factory).isPrivatePool(pool) ? PRIVATE_DELAY : DELAY;
    }

    function _checkEta(uint64 eta) private view {
        if (eta == 0) revert Errors.ParamChangeNotQueued();
        if (block.timestamp < eta) revert Errors.ParamChangeNotReady();
        if (block.timestamp > uint256(eta) + GRACE_PERIOD) revert Errors.ParamChangeExpired();
    }

    /// @dev The authoritative fee-invariant check. The pool's
    ///      `setFeeParams` is a bare store with no validation, so this
    ///      runs at BOTH queue time (early admin feedback) and execution
    ///      time (against the live config — see {executeFeeParams}).
    function _validateFeeParams(
        address pool,
        uint16 baseFee_,
        uint16 feeRampBps_,
        uint16 feeFloorBps_
    ) private view {
        if (baseFee_ < Constants.MIN_BASE_FEE || baseFee_ > Constants.MAX_BASE_FEE)
            revert Errors.InvalidFee();
        if (feeRampBps_ > Constants.MAX_FEE_RAMP_BPS) revert Errors.InvalidFeeRamp();
        if (feeFloorBps_ > baseFee_) revert Errors.InvalidFeeFloor();
        if (feeRampBps_ != 0 && baseFee_ == feeFloorBps_) revert Errors.FeeRampNoHeadroom();
        // Same monotonicity guard as the factory's deploy-time check —
        // a runtime fee change must not create a ramp too narrow for
        // its span and ceiling (see `Constants.FEE_RAMP_GUARD_MULT`).
        if (feeRampBps_ != 0) {
            uint256 span = uint256(baseFee_) - uint256(feeFloorBps_);
            uint256 inv = Constants.BPS - uint256(baseFee_);
            if (
                uint256(feeRampBps_) * inv * inv <
                Constants.FEE_RAMP_GUARD_MULT * Constants.BPS * span * span
            ) revert Errors.FeeRampTooNarrow();
        }
        IEquilibraPool.FeeConfig memory cfg = IEquilibraPool(pool).getFeeConfig();
        if (cfg.repegShareBps != 0) {
            uint256 feeScaleBps = feeRampBps_ == 0 ? uint256(baseFee_) : uint256(feeFloorBps_);
            if (
                cfg.repegThresholdToken1UpWad > feeScaleBps * 1e14 ||
                cfg.repegThresholdToken1DownWad > feeScaleBps * 1e14
            ) revert Errors.RepegThresholdExceedsFeeScale();
        }
    }

    /// @dev Direction-split dead-band validation: each band shares the
    ///      factory's deploy range and, while auto-repeg is live, the
    ///      stall guard against the LIVE fee scale (the first permitted
    ///      move must stay affordable out of the fee-funded growth
    ///      budget). Runs at BOTH queue time and execution time.
    function _validateThresholds(
        address pool,
        uint64 repegThresholdToken1UpWad_,
        uint64 repegThresholdToken1DownWad_
    ) private view {
        if (
            repegThresholdToken1UpWad_ < Constants.MIN_REPEG_STEP ||
            repegThresholdToken1UpWad_ > Constants.MAX_REPEG_STEP ||
            repegThresholdToken1DownWad_ < Constants.MIN_REPEG_STEP ||
            repegThresholdToken1DownWad_ > Constants.MAX_REPEG_STEP
        ) revert Errors.InvalidRepegThreshold();
        IEquilibraPool.FeeConfig memory cfg = IEquilibraPool(pool).getFeeConfig();
        if (cfg.repegShareBps != 0) {
            uint256 feeScaleBps = cfg.feeRampBps == 0
                ? uint256(cfg.baseFee)
                : uint256(cfg.feeFloorBps);
            if (
                repegThresholdToken1UpWad_ > feeScaleBps * 1e14 ||
                repegThresholdToken1DownWad_ > feeScaleBps * 1e14
            ) revert Errors.RepegThresholdExceedsFeeScale();
        }
    }

    function _validateShare(address pool, uint16 repegShareBps_) private view {
        if (repegShareBps_ < RUNTIME_SHARE_FLOOR_BPS) revert Errors.RepegShareChangeOutOfRange();
        IEquilibraPool.FeeConfig memory cfg = IEquilibraPool(pool).getFeeConfig();
        if (cfg.repegShareBps == 0) revert Errors.RepegShareImmutable();
        // Ceiling in STORED space: the grossed-up share the repeg gate
        // consumes stays <= 9500, which also keeps it under the
        // protocol-fee budget cap (< BPS) by construction.
        if (_storedShare(repegShareBps_, cfg.protocolFeePercent) > RUNTIME_SHARE_CEIL_BPS)
            revert Errors.RepegShareChangeOutOfRange();
    }

    /// @dev The runtime step range equals the factory's deploy range, and
    ///      one queued change may at most double or halve the LIVE
    ///      value, intersected with the absolute range. Both edges are
    ///      exact rational comparisons — reject when `new > 2·current`
    ///      or `2·new < current` — with no division rounding. The
    ///      multiplicative per-change band puts the anchor's slew-rate
    ///      knob on a gradual ratchet: an extreme setting takes several
    ///      queue windows instead of one (24-hour public,
    ///      {PRIVATE_DELAY} private), so LPs always see a bounded move
    ///      per window and keep a full exit window between moves. No
    ///      overflow: both operands already passed the
    ///      `<= MAX_REPEG_STEP = WAD` check. Runs at queue time AND at
    ///      execution against the then-live value, like every other
    ///      validation here.
    function _validateStep(address pool, uint256 repegStepWad_) private view {
        if (repegStepWad_ < Constants.MIN_REPEG_STEP || repegStepWad_ > Constants.MAX_REPEG_STEP)
            revert Errors.InvalidRepegStep();
        uint256 current = IEquilibraPool(pool).getFeeConfig().repegStepWad;
        if (repegStepWad_ > current * 2 || repegStepWad_ * 2 < current)
            revert Errors.RepegStepChangeTooLarge();
    }

    /// @dev Standalone range check — no live-config read needed: the
    ///      `uint8` type caps the ceiling at 255 and only the zero
    ///      floor is rejected. Runs at queue AND execution time like
    ///      every other validation here.
    function _validateParachuteBandMult(uint8 parachuteBandMult_) private pure {
        if (parachuteBandMult_ == 0) revert Errors.InvalidParachuteBandMult();
    }

    /// @dev The same floor-division gross-up map the pool applies in
    ///      `setRepegShareBps` / `initialize`.
    function _storedShare(
        uint16 userShareBps,
        uint8 protocolFeePercent
    ) private pure returns (uint256) {
        return
            (uint256(userShareBps) * Constants.BPS) /
            (Constants.BPS - uint256(protocolFeePercent) * 100);
    }

    /// @dev Drop every pending change of `pool`, emitting the matching
    ///      cancellation events so LP-side monitoring sees the queue
    ///      empty out.
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
