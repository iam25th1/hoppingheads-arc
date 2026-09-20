// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IArenaSettlement
/// @notice The settlement surface every Arena payout model implements. Phase 3 ships one
///         implementation, ArenaEscrow (house backed: an operator funded pool pays on
///         placement). The pooled pot and the personal best models arrive in later phases
///         behind this same interface, so the game, the CLI and the settlement service talk
///         to one shape.
///
///         Money in: a player enters a round by staking the entry amount in USDC through the
///         ERC-20 interface (never msg.value, never payable). Money out: a settlement, signed
///         off chain by the signer role and submitted by the operator, credits claimable
///         balances; players pull their own balance with withdraw. Nothing pushes funds.
interface IArenaSettlement {
    /// @notice One seat's result. `player` is an address by type: the off chain seat ids for
    ///         bots (bot:) and guests (guest:) cannot be encoded here at all.
    struct Placement {
        address player;
        uint8 place; // 1 is first; 0 is invalid
    }

    event RoundOpened(bytes32 indexed roundId, bytes32 seedCommit, uint256 entryAmount, uint256 blockNumber);
    event Entered(bytes32 indexed roundId, address indexed player, uint256 amount, bool viaPermit2);
    event Credited(bytes32 indexed roundId, address indexed player, uint8 place, uint256 amount);
    event RoundSettled(bytes32 indexed roundId, bytes32 seed, uint256 credited, uint256 placements);
    event Withdrawn(address indexed player, uint256 amount);

    /// @notice Operator only. Opens a round under a commitment to its seed. A roundId is single
    ///         use for the life of the contract.
    function openRound(bytes32 roundId, bytes32 seedCommit) external;

    /// @notice Stake the entry amount with a prior ERC-20 approval.
    function enter(bytes32 roundId) external;

    /// @notice Stake the entry amount with one Permit2 signature, no prior approval.
    function enterWithPermit2(bytes32 roundId, uint256 nonce, uint256 deadline, bytes calldata signature) external;

    /// @notice Operator only. Verifies the signer's EIP-712 signature over the placements,
    ///         the revealed seed against the commit, and credits claimable balances under the
    ///         contract's caps. Transfers nothing.
    function settleRound(bytes32 roundId, Placement[] calldata placements, bytes32 seed, bytes calldata signature)
        external;

    /// @notice What a player can pull right now.
    function claimable(address player) external view returns (uint256);

    /// @notice Pull the caller's whole claimable balance.
    function withdraw() external;

    /// @notice The stake per seat, USDC 6 decimals.
    function entryAmount() external view returns (uint256);
}
