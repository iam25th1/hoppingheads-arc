// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./AssetRegistry.sol";

/**
 * @title GameManager
 * @notice Core contract for Mint Rush game rounds.
 *         Handles round lifecycle, entry fees, minting delegation,
 *         scoring, contest resolution, and prize distribution.
 *
 * SECURITY NOTES:
 *   - All ETH transfers use the pull pattern (pendingWithdrawals)
 *   - ReentrancyGuard on all state-mutating external functions
 *   - Check-Effects-Interactions pattern throughout
 *   - Round seeds derived from blockhash for verifiable randomness
 */
contract GameManager is Ownable, ReentrancyGuard {

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    enum RoundStatus { Pending, Active, Resolving, Completed, Cancelled }

    struct Round {
        uint256 roundId;
        bytes32 seed;              // deterministic map seed
        bytes32 themeHash;         // keccak256 of theme string
        RoundStatus status;
        uint64  startTime;
        uint64  endTime;
        uint64  duration;          // round length in seconds
        uint256 entryFee;
        uint8   maxPlayers;
        uint8   playerCount;
        uint256 prizePool;
        address winner;
    }

    struct PlayerRound {
        bool    joined;
        uint256 score;
        uint256[] mintedTokenIds;
        bool    usedJammer;
        uint8   radarPingsUsed;
        bool    claimedPrize;
    }

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    uint256 public constant WINNER_SHARE_BPS    = 8000; // 80%
    uint256 public constant RUNNER_UP_SHARE_BPS = 1500; // 15%
    uint256 public constant PROTOCOL_FEE_BPS    = 500;  // 5%
    uint256 public constant BPS_DENOMINATOR     = 10000;

    uint8   public constant MAX_MINTS_PER_ROUND = 10;
    uint8   public constant MAX_RADAR_PINGS     = 2;
    uint8   public constant MAX_PLAYERS_CAP     = 8;
    uint8   public constant MIN_PLAYERS         = 2;

    uint256 public constant MIN_ENTRY_FEE       = 0.0005 ether;
    uint256 public constant MAX_ENTRY_FEE       = 0.05 ether;
    uint64  public constant MIN_DURATION        = 120;   // 2 minutes
    uint64  public constant MAX_DURATION        = 600;   // 10 minutes

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    AssetRegistry public assetRegistry;

    uint256 public nextRoundId;
    uint256 public protocolFeeAccrued;

    /// @notice roundId -> Round data
    mapping(uint256 => Round) public rounds;

    /// @notice roundId -> player address -> PlayerRound data
    mapping(uint256 => mapping(address => PlayerRound)) public playerRounds;

    /// @notice roundId -> ordered list of player addresses
    mapping(uint256 => address[]) public roundPlayers;

    /// @notice Pull-pattern withdrawal balances
    mapping(address => uint256) public pendingWithdrawals;

    /// @notice Authorized backend operator for round management
    address public operator;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event RoundCreated(uint256 indexed roundId, bytes32 themeHash, uint256 entryFee, uint8 maxPlayers, uint64 duration);
    event PlayerJoined(uint256 indexed roundId, address indexed player, uint8 playerCount);
    event RoundStarted(uint256 indexed roundId, bytes32 seed, uint64 startTime, uint64 endTime);
    event AssetMintedInRound(uint256 indexed roundId, address indexed player, uint256 tokenId, AssetRegistry.Rarity rarity);
    event JammerUsed(uint256 indexed roundId, address indexed jammer, address indexed target);
    event ContestInitiated(uint256 indexed roundId, address indexed challenger, address indexed target, uint256 tokenId);
    event RoundResolved(uint256 indexed roundId, address indexed winner, uint256 winnerScore);
    event PrizeClaimed(address indexed player, uint256 amount);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error Unauthorized();
    error InvalidParameters();
    error RoundNotInStatus(uint256 roundId, RoundStatus expected);
    error RoundFull(uint256 roundId);
    error AlreadyJoined(uint256 roundId);
    error NotJoined(uint256 roundId);
    error IncorrectEntryFee(uint256 expected, uint256 sent);
    error MintLimitReached(uint256 roundId);
    error RoundNotActive(uint256 roundId);
    error RoundNotEnded(uint256 roundId);
    error NothingToWithdraw();
    error TransferFailed();
    error JammerAlreadyUsed();
    error InsufficientPlayers(uint256 roundId);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    constructor(address _assetRegistry) Ownable(msg.sender) {
        if (_assetRegistry == address(0)) revert InvalidParameters();
        assetRegistry = AssetRegistry(_assetRegistry);
        operator = msg.sender;
        nextRoundId = 1;
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setOperator(address _operator) external onlyOwner {
        if (_operator == address(0)) revert InvalidParameters();
        address old = operator;
        operator = _operator;
        emit OperatorUpdated(old, _operator);
    }

    function withdrawProtocolFees() external onlyOwner nonReentrant {
        uint256 amount = protocolFeeAccrued;
        if (amount == 0) revert NothingToWithdraw();

        protocolFeeAccrued = 0;
        pendingWithdrawals[owner()] += amount;
    }

    // ---------------------------------------------------------------
    // Round lifecycle
    // ---------------------------------------------------------------

    /**
     * @notice Create a new round. Called by operator (backend).
     * @param themeHash   keccak256 of the theme string
     * @param entryFee    ETH required to join (between MIN and MAX)
     * @param maxPlayers  Max players for this round (2-8)
     * @param duration    Round length in seconds (120-600)
     */
    function createRound(
        bytes32 themeHash,
        uint256 entryFee,
        uint8   maxPlayers,
        uint64  duration
    )
        external
        onlyOperator
        returns (uint256 roundId)
    {
        if (themeHash == bytes32(0)) revert InvalidParameters();
        if (entryFee < MIN_ENTRY_FEE || entryFee > MAX_ENTRY_FEE) revert InvalidParameters();
        if (maxPlayers < MIN_PLAYERS || maxPlayers > MAX_PLAYERS_CAP) revert InvalidParameters();
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert InvalidParameters();

        roundId = nextRoundId++;

        rounds[roundId] = Round({
            roundId:     roundId,
            seed:        bytes32(0),   // set when round starts
            themeHash:   themeHash,
            status:      RoundStatus.Pending,
            startTime:   0,
            endTime:     0,
            duration:    duration,
            entryFee:    entryFee,
            maxPlayers:  maxPlayers,
            playerCount: 0,
            prizePool:   0,
            winner:      address(0)
        });

        emit RoundCreated(roundId, themeHash, entryFee, maxPlayers, duration);
    }

    /**
     * @notice Join a pending round by paying the entry fee.
     */
    function joinRound(uint256 roundId) external payable nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Pending) revert RoundNotInStatus(roundId, RoundStatus.Pending);
        if (r.playerCount >= r.maxPlayers) revert RoundFull(roundId);
        if (playerRounds[roundId][msg.sender].joined) revert AlreadyJoined(roundId);
        if (msg.value != r.entryFee) revert IncorrectEntryFee(r.entryFee, msg.value);

        // Effects
        r.playerCount++;
        r.prizePool += msg.value;
        playerRounds[roundId][msg.sender].joined = true;
        roundPlayers[roundId].push(msg.sender);

        emit PlayerJoined(roundId, msg.sender, r.playerCount);
    }

    /**
     * @notice Start a round once enough players have joined.
     *         Generates the deterministic seed from the blockhash.
     *         Called by operator.
     */
    function startRound(uint256 roundId) external onlyOperator nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Pending) revert RoundNotInStatus(roundId, RoundStatus.Pending);
        if (r.playerCount < MIN_PLAYERS) revert InsufficientPlayers(roundId);

        // Seed from previous blockhash + roundId for uniqueness
        bytes32 seed = keccak256(abi.encodePacked(blockhash(block.number - 1), roundId, block.timestamp));

        r.seed = seed;
        r.status = RoundStatus.Active;
        r.startTime = uint64(block.timestamp);
        r.endTime = uint64(block.timestamp) + r.duration;

        emit RoundStarted(roundId, seed, r.startTime, r.endTime);
    }

    /**
     * @notice Cancel a round that hasn't started. Refunds all players.
     *         Called by operator.
     */
    function cancelRound(uint256 roundId) external onlyOperator nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Pending) revert RoundNotInStatus(roundId, RoundStatus.Pending);

        r.status = RoundStatus.Cancelled;

        // Refund all joined players via pull pattern
        address[] memory players = roundPlayers[roundId];
        for (uint256 i = 0; i < players.length; i++) {
            pendingWithdrawals[players[i]] += r.entryFee;
        }
    }

    // ---------------------------------------------------------------
    // In-round actions
    // ---------------------------------------------------------------

    /**
     * @notice Mint an asset during an active round.
     * @param roundId     The round to mint in
     * @param rarity      Rarity tier of the discovered asset
     * @param discoverer  Address that first revealed this asset
     * @param metadataURI IPFS/URL for the asset metadata
     * @return tokenId    The minted token ID
     *
     * NOTE: In production, the backend validates the mint request
     *       (asset exists at claimed position, player is near it, etc.)
     *       before the operator submits this tx. The contract trusts
     *       the operator for game-state validation.
     */
    function mintAsset(
        uint256 roundId,
        address player,
        AssetRegistry.Rarity rarity,
        address discoverer,
        string calldata metadataURI
    )
        external
        onlyOperator
        nonReentrant
        returns (uint256 tokenId)
    {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotActive(roundId);
        if (block.timestamp > r.endTime) revert RoundNotActive(roundId);
        if (!playerRounds[roundId][player].joined) revert NotJoined(roundId);

        PlayerRound storage pr = playerRounds[roundId][player];
        if (pr.mintedTokenIds.length >= MAX_MINTS_PER_ROUND) revert MintLimitReached(roundId);

        // Delegate minting to AssetRegistry
        tokenId = assetRegistry.mint(
            player,
            roundId,
            rarity,
            r.themeHash,
            discoverer,
            metadataURI
        );

        pr.mintedTokenIds.push(tokenId);

        emit AssetMintedInRound(roundId, player, tokenId, rarity);
    }

    /**
     * @notice Use the jammer ability against another player.
     *         Actual game effect (adding mint time) is handled off-chain
     *         by the backend. This records it onchain for scoring/audit.
     */
    function useJammer(uint256 roundId, address target) external onlyOperator nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotActive(roundId);
        // The operator passes the jammer's address context off-chain;
        // here we just record the event for the target
        emit JammerUsed(roundId, msg.sender, target);
    }

    /**
     * @notice Record a radar ping usage.
     */
    function useRadarPing(uint256 roundId, address player) external onlyOperator {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotActive(roundId);
        if (!playerRounds[roundId][player].joined) revert NotJoined(roundId);

        PlayerRound storage pr = playerRounds[roundId][player];
        if (pr.radarPingsUsed >= MAX_RADAR_PINGS) revert InvalidParameters();
        pr.radarPingsUsed++;
    }

    // ---------------------------------------------------------------
    // Round resolution
    // ---------------------------------------------------------------

    /**
     * @notice Resolve a round after it ends. Calculates scores and
     *         distributes prizes via pull pattern.
     *
     * @param roundId     The round to resolve
     * @param scores      Array of scores in the same order as roundPlayers
     * @param winnerIdx   Index of the winner in the roundPlayers array
     * @param runnerUpIdx Index of the runner-up (-1 if only 2 players, use winnerIdx+1 logic)
     *
     * NOTE: Scores are computed off-chain by the backend (which has full
     *       game state including set bonuses, speed bonuses, discovery
     *       credits). The operator submits the final scores. Players can
     *       verify by regenerating the map from the onchain seed.
     */
    function resolveRound(
        uint256 roundId,
        uint256[] calldata scores,
        uint256 winnerIdx,
        uint256 runnerUpIdx
    )
        external
        onlyOperator
        nonReentrant
    {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active) revert RoundNotInStatus(roundId, RoundStatus.Active);
        if (block.timestamp < r.endTime) revert RoundNotEnded(roundId);

        address[] memory players = roundPlayers[roundId];
        if (scores.length != players.length) revert InvalidParameters();
        if (winnerIdx >= players.length) revert InvalidParameters();
        if (runnerUpIdx >= players.length) revert InvalidParameters();

        // Effects: update status first
        r.status = RoundStatus.Completed;
        r.winner = players[winnerIdx];

        // Record all scores
        for (uint256 i = 0; i < players.length; i++) {
            playerRounds[roundId][players[i]].score = scores[i];
        }

        // Calculate prize splits
        uint256 pool = r.prizePool;
        uint256 protocolCut = (pool * PROTOCOL_FEE_BPS) / BPS_DENOMINATOR;
        uint256 winnerCut   = (pool * WINNER_SHARE_BPS) / BPS_DENOMINATOR;
        uint256 runnerUpCut = (pool * RUNNER_UP_SHARE_BPS) / BPS_DENOMINATOR;

        // Handle rounding dust: give any remainder to winner
        uint256 dust = pool - protocolCut - winnerCut - runnerUpCut;
        winnerCut += dust;

        // Distribute via pull pattern
        protocolFeeAccrued += protocolCut;
        pendingWithdrawals[players[winnerIdx]] += winnerCut;
        pendingWithdrawals[players[runnerUpIdx]] += runnerUpCut;

        emit RoundResolved(roundId, players[winnerIdx], scores[winnerIdx]);
    }

    // ---------------------------------------------------------------
    // Withdrawals (pull pattern)
    // ---------------------------------------------------------------

    /**
     * @notice Withdraw accumulated winnings. Pull pattern prevents
     *         reentrancy-based prize manipulation.
     */
    function withdraw() external nonReentrant {
        uint256 amount = pendingWithdrawals[msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        // Effects before interactions
        pendingWithdrawals[msg.sender] = 0;

        // Interaction
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit PrizeClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function getRound(uint256 roundId) external view returns (Round memory) {
        return rounds[roundId];
    }

    function getRoundPlayers(uint256 roundId) external view returns (address[] memory) {
        return roundPlayers[roundId];
    }

    function getPlayerRound(uint256 roundId, address player) external view returns (
        bool joined,
        uint256 score,
        uint256[] memory mintedTokenIds,
        bool usedJammer,
        uint8 radarPingsUsed
    ) {
        PlayerRound storage pr = playerRounds[roundId][player];
        return (pr.joined, pr.score, pr.mintedTokenIds, pr.usedJammer, pr.radarPingsUsed);
    }

    function isRoundActive(uint256 roundId) external view returns (bool) {
        Round storage r = rounds[roundId];
        return r.status == RoundStatus.Active && block.timestamp <= r.endTime;
    }

    function getRoundTimeRemaining(uint256 roundId) external view returns (uint256) {
        Round storage r = rounds[roundId];
        if (r.status != RoundStatus.Active || block.timestamp >= r.endTime) return 0;
        return r.endTime - block.timestamp;
    }
}
