// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IArenaSettlement} from "./IArenaSettlement.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/// @title ArenaEscrow
/// @notice House backed settlement for Arena rounds on Arc. An operator funded pool, topped up
///         by entries, pays on placement from a tier table. One contract, no proxy, no
///         upgrade path, no selfdestruct, no payable function, no msg.value: USDC moves only
///         through its ERC-20 interface (6 decimals, 0x3600...0000 on Arc).
///
/// Roles, three distinct keys:
///   owner     sets the operator and signer, the tiers, the caps and the pause switch, and
///             may withdraw the free pool (balance minus what players are owed).
///   operator  opens rounds and submits settlements.
///   signer    signs settlements off chain (EIP-712) and holds nothing.
/// A settlement needs the signer's signature and the operator's transaction. A compromised
/// signer alone cannot settle; a compromised signer and operator together are bounded by the
/// caps below, which live here and not in the signer.
///
/// Caps, enforced on chain: at most maxPayoutPerRound credited per round, at most
/// maxPayoutPerPlayerPerWindow credited to one player per rolling window of windowBlocks
/// blocks (block numbers, never timestamps: Arc timestamps are non-decreasing only), never
/// more owed in total than the contract holds, and a pause switch on every player path.
///
/// Payouts are pull only. settleRound credits claimable[player]; withdraw sends the caller
/// its own balance and nothing else. A recipient USDC refuses (blocklisted) reverts its own
/// withdraw and touches no one else.
contract ArenaEscrow is IArenaSettlement, Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---- errors ----
    error ZeroAddress();
    error RolesMustDiffer();
    error NotOperator();
    error BadTiers();
    error BadCaps();
    error BadEntryAmount();
    error RoundExists();
    error RoundNotOpen();
    error AlreadySettled();
    error AlreadyEntered();
    error TooManyPlacements();
    error BadCommit();
    error BadSignature();
    error BadPlacement(address player, uint8 place);
    error NotEntered(address player);
    error DuplicatePlacement(address player);
    error RoundCapExceeded(uint256 total, uint256 cap);
    error PlayerWindowCapExceeded(address player, uint256 total, uint256 cap);
    error PoolInsufficient(uint256 owed, uint256 held);
    error NothingToWithdraw();
    error ExceedsFreePool(uint256 requested, uint256 free);

    // ---- events beyond the interface ----
    event OperatorSet(address indexed operator);
    event SignerSet(address indexed signer);
    event EntryAmountSet(uint256 entryAmount);
    event TiersSet(uint256[] tiers);
    event CapsSet(uint256 maxPayoutPerRound, uint256 maxPayoutPerPlayerPerWindow, uint256 windowBlocks);
    event PoolFunded(address indexed from, uint256 amount);
    event PoolWithdrawn(address indexed to, uint256 amount);

    // ---- constants ----
    uint256 public constant MAX_TIERS = 8; // one per seat at most
    uint256 public constant MAX_PLACEMENTS = 8; // a round has eight seats
    bytes32 private constant PLACEMENT_TYPEHASH = keccak256("Placement(address player,uint8 place)");
    bytes32 private constant SETTLEMENT_TYPEHASH = keccak256(
        "Settlement(bytes32 roundId,bytes32 seed,Placement[] placements)Placement(address player,uint8 place)"
    );

    // ---- immutables ----
    IERC20 public immutable usdc;
    ISignatureTransfer public immutable permit2;

    // ---- roles ----
    address public operator;
    address public signer;

    // ---- parameters (constructor set, owner tunable) ----
    uint256 public override entryAmount;
    uint256[] private _tiers; // payout for place 1 at index 0, USDC 6 decimals
    uint256 public maxPayoutPerRound;
    uint256 public maxPayoutPerPlayerPerWindow;
    uint256 public windowBlocks;

    // ---- rounds ----
    struct Round {
        bytes32 seedCommit; // non zero exactly when the round has been opened
        uint64 openedAtBlock; // informational: a round opened in block 0 is still open
        bool settled;
        uint32 entrants;
    }

    mapping(bytes32 => Round) public rounds;
    mapping(bytes32 => mapping(address => bool)) public entered;
    mapping(bytes32 => mapping(address => bool)) public placed;

    // ---- balances ----
    mapping(address => uint256) public override claimable;
    uint256 public totalClaimable;

    struct Window {
        uint64 startBlock;
        uint192 paid;
    }

    mapping(address => Window) public windows;

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    constructor(
        address usdc_,
        address permit2_,
        address owner_,
        address operator_,
        address signer_,
        uint256 entryAmount_,
        uint256[] memory tiers_,
        uint256 maxPayoutPerRound_,
        uint256 maxPayoutPerPlayerPerWindow_,
        uint256 windowBlocks_
    ) Ownable(owner_) EIP712("ArenaEscrow", "1") {
        if (usdc_ == address(0) || permit2_ == address(0)) revert ZeroAddress();
        usdc = IERC20(usdc_);
        permit2 = ISignatureTransfer(permit2_);
        _setRoles(owner_, operator_, signer_);
        _setEntryAmount(entryAmount_);
        _setCaps(maxPayoutPerRound_, maxPayoutPerPlayerPerWindow_, windowBlocks_);
        _setTiers(tiers_);
    }

    // ---- views ----

    function tiers() external view returns (uint256[] memory) {
        return _tiers;
    }

    /// @notice The pool not owed to anyone: what settlements can still draw on.
    function freePool() public view returns (uint256) {
        uint256 held = usdc.balanceOf(address(this));
        return held > totalClaimable ? held - totalClaimable : 0;
    }

    /// @notice The EIP-712 digest the signer signs for a settlement. Bound to this chain and
    ///         this contract by the domain.
    function settlementDigest(bytes32 roundId, bytes32 seed, Placement[] calldata placements)
        public
        view
        returns (bytes32)
    {
        bytes32[] memory hashes = new bytes32[](placements.length);
        for (uint256 i = 0; i < placements.length; i++) {
            hashes[i] = keccak256(abi.encode(PLACEMENT_TYPEHASH, placements[i].player, placements[i].place));
        }
        return _hashTypedDataV4(
            keccak256(abi.encode(SETTLEMENT_TYPEHASH, roundId, seed, keccak256(abi.encodePacked(hashes))))
        );
    }

    /// @notice The commitment a round is opened under: keccak256 of the 32 byte seed.
    function commitFor(bytes32 seed) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(seed));
    }

    // ---- rounds ----

    function openRound(bytes32 roundId, bytes32 seedCommit) external override onlyOperator whenNotPaused {
        if (roundId == bytes32(0) || seedCommit == bytes32(0)) revert BadCommit();
        Round storage r = rounds[roundId];
        if (r.seedCommit != bytes32(0)) revert RoundExists();
        r.seedCommit = seedCommit;
        // block.number fits uint64 for longer than the chain will exist
        // forge-lint: disable-next-line(unsafe-typecast)
        r.openedAtBlock = uint64(block.number);
        emit RoundOpened(roundId, seedCommit, entryAmount, block.number);
    }

    function enter(bytes32 roundId) external override whenNotPaused {
        _seat(roundId, msg.sender);
        usdc.safeTransferFrom(msg.sender, address(this), entryAmount);
        emit Entered(roundId, msg.sender, entryAmount, false);
    }

    function enterWithPermit2(bytes32 roundId, uint256 nonce, uint256 deadline, bytes calldata signature)
        external
        override
        whenNotPaused
    {
        _seat(roundId, msg.sender);
        permit2.permitTransferFrom(
            ISignatureTransfer.PermitTransferFrom({
                permitted: ISignatureTransfer.TokenPermissions({token: address(usdc), amount: entryAmount}),
                nonce: nonce,
                deadline: deadline
            }),
            ISignatureTransfer.SignatureTransferDetails({to: address(this), requestedAmount: entryAmount}),
            msg.sender,
            signature
        );
        emit Entered(roundId, msg.sender, entryAmount, true);
    }

    function _seat(bytes32 roundId, address player) internal {
        Round storage r = rounds[roundId];
        if (r.seedCommit == bytes32(0)) revert RoundNotOpen();
        if (r.settled) revert AlreadySettled();
        if (entered[roundId][player]) revert AlreadyEntered();
        entered[roundId][player] = true;
        r.entrants += 1;
    }

    function settleRound(bytes32 roundId, Placement[] calldata placements, bytes32 seed, bytes calldata signature)
        external
        override
        onlyOperator
        whenNotPaused
    {
        Round storage r = rounds[roundId];
        if (r.seedCommit == bytes32(0)) revert RoundNotOpen();
        if (r.settled) revert AlreadySettled();
        if (placements.length > MAX_PLACEMENTS) revert TooManyPlacements();
        if (commitFor(seed) != r.seedCommit) revert BadCommit();
        // ECDSA.recover reverts on a malformed signature; a well formed one from the wrong
        // key, or over different placements, recovers to some other address.
        if (ECDSA.recover(settlementDigest(roundId, seed, placements), signature) != signer) revert BadSignature();

        uint256 total = 0;
        uint256 tierCount = _tiers.length;
        for (uint256 i = 0; i < placements.length; i++) {
            Placement calldata p = placements[i];
            // An address by type; on top of that: not the zero address, seated in this round,
            // and listed once. Bots and guests have no address and cannot be seated.
            if (p.player == address(0) || p.place == 0) revert BadPlacement(p.player, p.place);
            if (!entered[roundId][p.player]) revert NotEntered(p.player);
            if (placed[roundId][p.player]) revert DuplicatePlacement(p.player);
            placed[roundId][p.player] = true;
            uint256 amount = p.place <= tierCount ? _tiers[p.place - 1] : 0;
            if (amount == 0) continue;
            total += amount;
            if (total > maxPayoutPerRound) revert RoundCapExceeded(total, maxPayoutPerRound);
            _chargeWindow(p.player, amount);
            claimable[p.player] += amount;
            emit Credited(roundId, p.player, p.place, amount);
        }
        totalClaimable += total;
        uint256 held = usdc.balanceOf(address(this));
        if (totalClaimable > held) revert PoolInsufficient(totalClaimable, held);
        r.settled = true;
        emit RoundSettled(roundId, seed, total, placements.length);
    }

    function _chargeWindow(address player, uint256 amount) internal {
        Window storage w = windows[player];
        if (w.startBlock == 0 || block.number >= uint256(w.startBlock) + windowBlocks) {
            // forge-lint: disable-next-line(unsafe-typecast)
            w.startBlock = uint64(block.number);
            w.paid = 0;
        }
        uint256 next = uint256(w.paid) + amount;
        if (next > maxPayoutPerPlayerPerWindow) revert PlayerWindowCapExceeded(player, next, maxPayoutPerPlayerPerWindow);
        // next is at most maxPayoutPerPlayerPerWindow, which _setCaps bounds to uint192
        // forge-lint: disable-next-line(unsafe-typecast)
        w.paid = uint192(next);
    }

    // ---- withdrawals ----

    function withdraw() external override whenNotPaused nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---- pool ----

    /// @notice Anyone may fund the pool. The owner does, in practice.
    function fundPool(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit PoolFunded(msg.sender, amount);
    }

    /// @notice Owner only. Never what players are owed.
    function withdrawPool(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 free = freePool();
        if (amount > free) revert ExceedsFreePool(amount, free);
        usdc.safeTransfer(to, amount);
        emit PoolWithdrawn(to, amount);
    }

    // ---- owner: roles, parameters, pause ----

    function setOperator(address operator_) external onlyOwner {
        _setRoles(owner(), operator_, signer);
    }

    function setSigner(address signer_) external onlyOwner {
        _setRoles(owner(), operator, signer_);
    }

    function setEntryAmount(uint256 entryAmount_) external onlyOwner {
        _setEntryAmount(entryAmount_);
    }

    function setTiers(uint256[] calldata tiers_) external onlyOwner {
        _setTiers(tiers_);
    }

    function setCaps(uint256 maxPayoutPerRound_, uint256 maxPayoutPerPlayerPerWindow_, uint256 windowBlocks_)
        external
        onlyOwner
    {
        _setCaps(maxPayoutPerRound_, maxPayoutPerPlayerPerWindow_, windowBlocks_);
        if (_tiers.length != 0) _checkTiersAgainstCap(_tiers);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _setRoles(address owner_, address operator_, address signer_) internal {
        if (owner_ == address(0) || operator_ == address(0) || signer_ == address(0)) revert ZeroAddress();
        if (owner_ == operator_ || owner_ == signer_ || operator_ == signer_) revert RolesMustDiffer();
        if (operator_ != operator) {
            operator = operator_;
            emit OperatorSet(operator_);
        }
        if (signer_ != signer) {
            signer = signer_;
            emit SignerSet(signer_);
        }
    }

    function _setEntryAmount(uint256 entryAmount_) internal {
        if (entryAmount_ == 0) revert BadEntryAmount();
        entryAmount = entryAmount_;
        emit EntryAmountSet(entryAmount_);
    }

    function _setCaps(uint256 maxPayoutPerRound_, uint256 maxPayoutPerPlayerPerWindow_, uint256 windowBlocks_) internal {
        if (maxPayoutPerRound_ == 0 || maxPayoutPerPlayerPerWindow_ == 0 || windowBlocks_ == 0) revert BadCaps();
        if (maxPayoutPerPlayerPerWindow_ > type(uint192).max) revert BadCaps();
        maxPayoutPerRound = maxPayoutPerRound_;
        maxPayoutPerPlayerPerWindow = maxPayoutPerPlayerPerWindow_;
        windowBlocks = windowBlocks_;
        emit CapsSet(maxPayoutPerRound_, maxPayoutPerPlayerPerWindow_, windowBlocks_);
    }

    function _setTiers(uint256[] memory tiers_) internal {
        if (tiers_.length == 0 || tiers_.length > MAX_TIERS) revert BadTiers();
        _checkTiersAgainstCap(tiers_);
        delete _tiers;
        for (uint256 i = 0; i < tiers_.length; i++) {
            if (tiers_[i] == 0) revert BadTiers();
            _tiers.push(tiers_[i]);
        }
        emit TiersSet(tiers_);
    }

    /// @dev The whole table paid at once must fit the round cap, so the cap is the true bound
    ///      and a tier change cannot loosen it.
    function _checkTiersAgainstCap(uint256[] memory tiers_) internal view {
        uint256 sum = 0;
        for (uint256 i = 0; i < tiers_.length; i++) {
            sum += tiers_[i];
        }
        if (sum > maxPayoutPerRound) revert BadTiers();
    }
}
