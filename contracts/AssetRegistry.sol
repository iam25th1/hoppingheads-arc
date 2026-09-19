// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title AssetRegistry
 * @notice ERC-1155 token contract for Mint Rush game assets.
 *         Each token represents a discovered and minted asset from a game round.
 *         Only the authorized GameManager contract can mint or burn tokens.
 */
contract AssetRegistry is ERC1155, Ownable, ReentrancyGuard {

    // ---------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------

    enum Rarity { Common, Uncommon, Rare, Epic, Legendary }

    struct AssetData {
        uint256 roundId;
        Rarity  rarity;
        bytes32 themeHash;    // keccak256 of the theme string
        address discoverer;   // first player to reveal this asset
        address minter;       // player who successfully minted it
        uint64  mintedAt;     // block.timestamp of mint
        string  metadataURI;  // IPFS hash or URL for asset metadata
    }

    // ---------------------------------------------------------------
    // State
    // ---------------------------------------------------------------

    /// @notice The GameManager contract authorized to mint/burn
    address public gameManager;

    /// @notice Auto-incrementing token ID counter
    uint256 public nextTokenId;

    /// @notice Token ID -> asset metadata
    mapping(uint256 => AssetData) public assets;

    /// @notice roundId -> list of token IDs minted in that round
    mapping(uint256 => uint256[]) public roundTokens;

    /// @notice player -> list of all token IDs they have minted
    mapping(address => uint256[]) public playerTokens;

    /// @notice Tracks total supply per token ID (each is unique so max 1)
    mapping(uint256 => uint256) private _totalSupply;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event AssetMinted(
        uint256 indexed tokenId,
        uint256 indexed roundId,
        address indexed minter,
        Rarity  rarity,
        bytes32 themeHash
    );

    event AssetBurned(
        uint256 indexed tokenId,
        uint256 indexed roundId,
        address indexed owner
    );

    event GameManagerUpdated(address indexed oldManager, address indexed newManager);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error Unauthorized();
    error ZeroAddress();
    error TokenDoesNotExist(uint256 tokenId);

    // ---------------------------------------------------------------
    // Modifiers
    // ---------------------------------------------------------------

    modifier onlyGameManager() {
        if (msg.sender != gameManager) revert Unauthorized();
        _;
    }

    // ---------------------------------------------------------------
    // Constructor
    // ---------------------------------------------------------------

    constructor(string memory baseURI) ERC1155(baseURI) Ownable(msg.sender) {
        nextTokenId = 1; // start at 1, reserve 0 as invalid
    }

    // ---------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------

    /**
     * @notice Set the GameManager contract address. Only callable by owner.
     * @param _gameManager Address of the deployed GameManager contract.
     */
    function setGameManager(address _gameManager) external onlyOwner {
        if (_gameManager == address(0)) revert ZeroAddress();
        address old = gameManager;
        gameManager = _gameManager;
        emit GameManagerUpdated(old, _gameManager);
    }

    /**
     * @notice Update the base URI for token metadata. Only callable by owner.
     */
    function setBaseURI(string memory newURI) external onlyOwner {
        _setURI(newURI);
    }

    // ---------------------------------------------------------------
    // Minting (GameManager only)
    // ---------------------------------------------------------------

    /**
     * @notice Mint a new asset token. Only callable by GameManager.
     * @param to         Recipient (the minting player)
     * @param roundId    The game round this asset belongs to
     * @param rarity     Rarity tier of the asset
     * @param themeHash  keccak256 of the round theme string
     * @param discoverer Address of the player who first revealed this asset
     * @param metadataURI IPFS or URL for the asset's metadata JSON
     * @return tokenId   The newly minted token ID
     */
    function mint(
        address to,
        uint256 roundId,
        Rarity  rarity,
        bytes32 themeHash,
        address discoverer,
        string calldata metadataURI
    )
        external
        onlyGameManager
        nonReentrant
        returns (uint256 tokenId)
    {
        if (to == address(0)) revert ZeroAddress();

        tokenId = nextTokenId++;

        assets[tokenId] = AssetData({
            roundId:     roundId,
            rarity:      rarity,
            themeHash:   themeHash,
            discoverer:  discoverer,
            minter:      to,
            mintedAt:    uint64(block.timestamp),
            metadataURI: metadataURI
        });

        _totalSupply[tokenId] = 1;
        roundTokens[roundId].push(tokenId);
        playerTokens[to].push(tokenId);

        _mint(to, tokenId, 1, "");

        emit AssetMinted(tokenId, roundId, to, rarity, themeHash);
    }

    // ---------------------------------------------------------------
    // Burning (GameManager only -- for sabotage mechanic)
    // ---------------------------------------------------------------

    /**
     * @notice Burn an asset token. Used by the sabotage mechanic.
     *         Only callable by GameManager.
     * @param owner   Current owner of the token
     * @param tokenId The token to burn
     */
    function burn(address owner, uint256 tokenId)
        external
        onlyGameManager
        nonReentrant
    {
        if (assets[tokenId].mintedAt == 0) revert TokenDoesNotExist(tokenId);

        _totalSupply[tokenId] = 0;
        _burn(owner, tokenId, 1);

        emit AssetBurned(tokenId, assets[tokenId].roundId, owner);
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /**
     * @notice Returns the full metadata for a token.
     */
    function getAsset(uint256 tokenId) external view returns (AssetData memory) {
        if (assets[tokenId].mintedAt == 0) revert TokenDoesNotExist(tokenId);
        return assets[tokenId];
    }

    /**
     * @notice Returns the per-token URI. Falls back to base URI if no
     *         per-token URI is set.
     */
    function uri(uint256 tokenId) public view override returns (string memory) {
        if (bytes(assets[tokenId].metadataURI).length > 0) {
            return assets[tokenId].metadataURI;
        }
        return super.uri(tokenId);
    }

    /**
     * @notice Returns all token IDs minted in a given round.
     */
    function getRoundTokens(uint256 roundId) external view returns (uint256[] memory) {
        return roundTokens[roundId];
    }

    /**
     * @notice Returns all token IDs a player has minted across all rounds.
     */
    function getPlayerTokens(address player) external view returns (uint256[] memory) {
        return playerTokens[player];
    }

    /**
     * @notice Returns the total supply for a given token ID (0 or 1).
     */
    function totalSupply(uint256 tokenId) external view returns (uint256) {
        return _totalSupply[tokenId];
    }

    /**
     * @notice Returns the rarity point value for a given rarity tier.
     */
    function rarityPoints(Rarity rarity) public pure returns (uint256) {
        if (rarity == Rarity.Common)    return 10;
        if (rarity == Rarity.Uncommon)  return 25;
        if (rarity == Rarity.Rare)      return 50;
        if (rarity == Rarity.Epic)      return 100;
        if (rarity == Rarity.Legendary) return 250;
        return 0;
    }
}
