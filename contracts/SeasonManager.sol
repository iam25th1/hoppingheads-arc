// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SeasonManager
 * @notice Manages competitive seasons, leaderboard tracking,
 *         streak bonuses, and season reward distribution.
 *
 *         Seasons run for a fixed block range. Points accumulate
 *         from round wins/placements. Top players earn Curator
 *         status and claimable rewards at season end.
 */
contract SeasonManager is Ownable, ReentrancyGuard {

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    enum SeasonStatus { Upcoming, Active, Ended }

    struct Season {
        uint256 seasonId;
        SeasonStatus status;
        uint64  startTime;
        uint64  endTime;
        uint256 rewardPool;        // total ETH allocated for season rewards
        uint256 totalPointsAwarded;
        bool    rewardsDistributed;
    }

    struct PlayerSeason {
        uint256 points;
        uint256 roundsPlayed;
        uint256 roundsWon;
        uint16  currentStreak;     // consecutive wins
        uint16  bestStreak;
        bool    rewardClaimed;
    }

    struct LeaderboardEntry {
        address player;
        uint256 points;
    }

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    uint256 public constant POINTS_WIN       = 100;
    uint256 public constant POINTS_SECOND    = 50;
    uint256 public constant POINTS_THIRD     = 25;
    uint256 public constant POINTS_PLAYED    = 10;
    uint256 public constant STREAK_BONUS_PER = 15; // bonus per consecutive win

    uint8   public constant TOP_REWARDS_COUNT = 10; // top N players get rewards

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /// @notice The GameManager contract authorized to report results
    address public gameManager;

    uint256 public nextSeasonId;

    mapping(uint256 => Season) public seasons;
    mapping(uint256 => mapping(address => PlayerSeason)) public playerSeasons;

    /// @notice seasonId -> top players sorted by points (maintained off-chain, submitted at resolution)
    mapping(uint256 => LeaderboardEntry[]) public finalLeaderboards;

    /// @notice Pull-pattern withdrawal balances for season rewards
    mapping(address => uint256) public pendingRewards;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event SeasonCreated(uint256 indexed seasonId, uint64 startTime, uint64 endTime);
    event SeasonStarted(uint256 indexed seasonId);
    event SeasonEnded(uint256 indexed seasonId);
    event PointsAwarded(uint256 indexed seasonId, address indexed player, uint256 points, uint256 totalPoints);
    event StreakUpdated(address indexed player, uint256 indexed seasonId, uint16 streak);
    event RewardsDistributed(uint256 indexed seasonId, uint256 totalDistributed);
    event RewardClaimed(address indexed player, uint256 amount);
    event GameManagerUpdated(address indexed oldManager, address indexed newManager);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error Unauthorized();
    error InvalidParameters();
    error SeasonNotActive(uint256 seasonId);
    error SeasonNotEnded(uint256 seasonId);
    error AlreadyDistributed(uint256 seasonId);
    error NothingToClaim();
    error TransferFailed();

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyGameManager() {
        if (msg.sender != gameManager && msg.sender != owner()) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    constructor() Ownable(msg.sender) {
        nextSeasonId = 1;
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    function setGameManager(address _gameManager) external onlyOwner {
        if (_gameManager == address(0)) revert InvalidParameters();
        address old = gameManager;
        gameManager = _gameManager;
        emit GameManagerUpdated(old, _gameManager);
    }

    // ---------------------------------------------------------------
    // Season lifecycle
    // ---------------------------------------------------------------

    /**
     * @notice Create a new season with defined start and end times.
     *         Send ETH with this call to fund the reward pool.
     */
    function createSeason(uint64 startTime, uint64 endTime)
        external
        payable
        onlyOwner
        returns (uint256 seasonId)
    {
        if (startTime >= endTime) revert InvalidParameters();
        if (startTime < block.timestamp) revert InvalidParameters();

        seasonId = nextSeasonId++;

        seasons[seasonId] = Season({
            seasonId:           seasonId,
            status:             SeasonStatus.Upcoming,
            startTime:          startTime,
            endTime:            endTime,
            rewardPool:         msg.value,
            totalPointsAwarded: 0,
            rewardsDistributed: false
        });

        emit SeasonCreated(seasonId, startTime, endTime);
    }

    /**
     * @notice Activate a season when its start time is reached.
     */
    function startSeason(uint256 seasonId) external onlyOwner {
        Season storage s = seasons[seasonId];
        if (s.status != SeasonStatus.Upcoming) revert InvalidParameters();
        if (block.timestamp < s.startTime) revert InvalidParameters();

        s.status = SeasonStatus.Active;
        emit SeasonStarted(seasonId);
    }

    /**
     * @notice End a season when its end time is reached.
     */
    function endSeason(uint256 seasonId) external onlyOwner {
        Season storage s = seasons[seasonId];
        if (s.status != SeasonStatus.Active) revert SeasonNotActive(seasonId);
        if (block.timestamp < s.endTime) revert SeasonNotEnded(seasonId);

        s.status = SeasonStatus.Ended;
        emit SeasonEnded(seasonId);
    }

    /**
     * @notice Add ETH to a season's reward pool.
     */
    function fundSeason(uint256 seasonId) external payable onlyOwner {
        if (seasons[seasonId].status == SeasonStatus.Ended) revert InvalidParameters();
        seasons[seasonId].rewardPool += msg.value;
    }

    // ---------------------------------------------------------------
    // Point reporting (from GameManager or operator)
    // ---------------------------------------------------------------

    /**
     * @notice Report round results for a player in the active season.
     * @param seasonId  The current active season
     * @param player    The player to award points to
     * @param placement 1 = winner, 2 = second, 3 = third, 0 = participated
     */
    function reportRoundResult(
        uint256 seasonId,
        address player,
        uint8   placement
    )
        external
        onlyGameManager
    {
        Season storage s = seasons[seasonId];
        if (s.status != SeasonStatus.Active) revert SeasonNotActive(seasonId);

        PlayerSeason storage ps = playerSeasons[seasonId][player];
        ps.roundsPlayed++;

        uint256 points = POINTS_PLAYED;

        if (placement == 1) {
            points = POINTS_WIN;
            ps.roundsWon++;
            ps.currentStreak++;
            if (ps.currentStreak > ps.bestStreak) {
                ps.bestStreak = ps.currentStreak;
            }
            // Streak bonus: +15 per consecutive win beyond the first
            if (ps.currentStreak > 1) {
                points += STREAK_BONUS_PER * (ps.currentStreak - 1);
            }
            emit StreakUpdated(player, seasonId, ps.currentStreak);
        } else if (placement == 2) {
            points = POINTS_SECOND;
            ps.currentStreak = 0;
        } else if (placement == 3) {
            points = POINTS_THIRD;
            ps.currentStreak = 0;
        } else {
            ps.currentStreak = 0;
        }

        ps.points += points;
        s.totalPointsAwarded += points;

        emit PointsAwarded(seasonId, player, points, ps.points);
    }

    // ---------------------------------------------------------------
    // Reward distribution
    // ---------------------------------------------------------------

    /**
     * @notice Distribute season rewards to top players.
     *         Called by owner after season ends with the final leaderboard.
     *
     * @param seasonId    The ended season
     * @param topPlayers  Addresses of top players, sorted by rank (1st first)
     * @param topPoints   Points of each top player (same order)
     *
     * Reward formula: proportional to points among top N.
     * e.g., if top 3 have 500, 300, 200 points = total 1000,
     *        they get 50%, 30%, 20% of the reward pool respectively.
     */
    function distributeRewards(
        uint256 seasonId,
        address[] calldata topPlayers,
        uint256[] calldata topPoints
    )
        external
        onlyOwner
        nonReentrant
    {
        Season storage s = seasons[seasonId];
        if (s.status != SeasonStatus.Ended) revert SeasonNotEnded(seasonId);
        if (s.rewardsDistributed) revert AlreadyDistributed(seasonId);
        if (topPlayers.length != topPoints.length) revert InvalidParameters();
        if (topPlayers.length == 0 || topPlayers.length > TOP_REWARDS_COUNT) revert InvalidParameters();

        s.rewardsDistributed = true;

        // Calculate total points among top players
        uint256 totalTopPoints;
        for (uint256 i = 0; i < topPoints.length; i++) {
            totalTopPoints += topPoints[i];
        }

        if (totalTopPoints == 0) revert InvalidParameters();

        // Store final leaderboard
        uint256 totalDistributed;
        for (uint256 i = 0; i < topPlayers.length; i++) {
            finalLeaderboards[seasonId].push(LeaderboardEntry({
                player: topPlayers[i],
                points: topPoints[i]
            }));

            uint256 reward = (s.rewardPool * topPoints[i]) / totalTopPoints;
            pendingRewards[topPlayers[i]] += reward;
            totalDistributed += reward;
        }

        // Any dust from integer division goes to first place
        uint256 dust = s.rewardPool - totalDistributed;
        if (dust > 0) {
            pendingRewards[topPlayers[0]] += dust;
        }

        emit RewardsDistributed(seasonId, s.rewardPool);
    }

    /**
     * @notice Claim accumulated season rewards. Pull pattern.
     */
    function claimRewards() external nonReentrant {
        uint256 amount = pendingRewards[msg.sender];
        if (amount == 0) revert NothingToClaim();

        pendingRewards[msg.sender] = 0;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if (!success) revert TransferFailed();

        emit RewardClaimed(msg.sender, amount);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    function getSeason(uint256 seasonId) external view returns (Season memory) {
        return seasons[seasonId];
    }

    function getPlayerSeason(uint256 seasonId, address player)
        external
        view
        returns (PlayerSeason memory)
    {
        return playerSeasons[seasonId][player];
    }

    function getFinalLeaderboard(uint256 seasonId)
        external
        view
        returns (LeaderboardEntry[] memory)
    {
        return finalLeaderboards[seasonId];
    }

    function getActiveSeasonId() external view returns (uint256) {
        // Simple linear scan -- acceptable for small number of seasons
        for (uint256 i = nextSeasonId - 1; i >= 1; i--) {
            if (seasons[i].status == SeasonStatus.Active) return i;
            if (i == 1) break;
        }
        return 0; // no active season
    }
}
