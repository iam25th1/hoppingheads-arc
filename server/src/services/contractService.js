/**
 * Contract Service
 *
 * Handles all onchain interactions: creating rounds, submitting
 * mints, resolving rounds, and reading contract state.
 * Uses the operator wallet to sign transactions.
 */

import { ethers } from "ethers";

let provider;
let operatorWallet;
let gameManagerContract;
let assetRegistryContract;
let seasonManagerContract;

// ABIs (minimal -- only the functions we call)
const GAME_MANAGER_ABI = [
  "function createRound(bytes32 themeHash, uint256 entryFee, uint8 maxPlayers, uint64 duration) returns (uint256)",
  "function startRound(uint256 roundId)",
  "function cancelRound(uint256 roundId)",
  "function mintAsset(uint256 roundId, address player, uint8 rarity, address discoverer, string metadataURI) returns (uint256)",
  "function resolveRound(uint256 roundId, uint256[] scores, uint256 winnerIdx, uint256 runnerUpIdx)",
  "function isRoundActive(uint256 roundId) view returns (bool)",
  "function getRoundTimeRemaining(uint256 roundId) view returns (uint256)",
  "function nextRoundId() view returns (uint256)",
];

const ASSET_REGISTRY_ABI = [
  "function getAsset(uint256 tokenId) view returns (tuple(uint256 roundId, uint8 rarity, bytes32 themeHash, address discoverer, address minter, uint64 mintedAt, string metadataURI))",
  "function getRoundTokens(uint256 roundId) view returns (uint256[])",
  "function getPlayerTokens(address player) view returns (uint256[])",
];

const SEASON_MANAGER_ABI = [
  "function reportRoundResult(uint256 seasonId, address player, uint8 placement)",
  "function getActiveSeasonId() view returns (uint256)",
  "function getPlayerSeason(uint256 seasonId, address player) view returns (tuple(uint256 points, uint256 roundsPlayed, uint256 roundsWon, uint16 currentStreak, uint16 bestStreak, bool rewardClaimed))",
];

export function initContracts() {
  const rpcUrl = process.env.BASE_RPC_URL;
  const operatorKey = process.env.OPERATOR_PRIVATE_KEY;
  const gmAddress = process.env.GAME_MANAGER_ADDRESS;
  const arAddress = process.env.ASSET_REGISTRY_ADDRESS;
  const smAddress = process.env.SEASON_MANAGER_ADDRESS;

  if (!rpcUrl || !operatorKey || !gmAddress) {
    console.warn("[Contracts] Missing config -- running in offline mode");
    return;
  }

  provider = new ethers.JsonRpcProvider(rpcUrl);
  operatorWallet = new ethers.Wallet(operatorKey, provider);

  gameManagerContract = new ethers.Contract(gmAddress, GAME_MANAGER_ABI, operatorWallet);

  if (arAddress && arAddress !== "0x") {
    assetRegistryContract = new ethers.Contract(arAddress, ASSET_REGISTRY_ABI, provider);
  }

  if (smAddress && smAddress !== "0x") {
    seasonManagerContract = new ethers.Contract(smAddress, SEASON_MANAGER_ABI, operatorWallet);
  }

  console.log("[Contracts] Initialized");
  console.log(`  Operator: ${operatorWallet.address}`);
  console.log(`  GameManager: ${gmAddress}`);
}

// -- Round lifecycle -------------------------------------------

export async function createRoundOnchain(themeHash, entryFeeWei, maxPlayers, durationSecs) {
  if (!gameManagerContract) return null;

  const tx = await gameManagerContract.createRound(
    themeHash,
    entryFeeWei,
    maxPlayers,
    durationSecs,
    { gasLimit: 300000 }
  );
  const receipt = await tx.wait();

  // Parse RoundCreated event to get roundId
  const iface = gameManagerContract.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "RoundCreated") {
        return Number(parsed.args.roundId);
      }
    } catch (_) {
      // not our event
    }
  }
  return null;
}

export async function startRoundOnchain(onchainRoundId) {
  if (!gameManagerContract) return null;
  const tx = await gameManagerContract.startRound(onchainRoundId, { gasLimit: 200000 });
  return tx.wait();
}

export async function mintAssetOnchain(onchainRoundId, playerAddress, rarity, discoverer, metadataURI) {
  if (!gameManagerContract) return null;
  const tx = await gameManagerContract.mintAsset(
    onchainRoundId,
    playerAddress,
    rarity,
    discoverer,
    metadataURI,
    { gasLimit: 400000 }
  );
  const receipt = await tx.wait();

  // Parse AssetMintedInRound event
  const iface = gameManagerContract.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed?.name === "AssetMintedInRound") {
        return Number(parsed.args.tokenId);
      }
    } catch (_) {}
  }
  return null;
}

export async function resolveRoundOnchain(onchainRoundId, scores, winnerIdx, runnerUpIdx) {
  if (!gameManagerContract) return null;
  const tx = await gameManagerContract.resolveRound(
    onchainRoundId,
    scores,
    winnerIdx,
    runnerUpIdx,
    { gasLimit: 500000 }
  );
  return tx.wait();
}

// -- Season reporting -----------------------------------------

export async function reportSeasonResult(playerAddress, placement) {
  if (!seasonManagerContract) return null;
  try {
    const seasonId = await seasonManagerContract.getActiveSeasonId();
    if (seasonId === 0n) return null;

    const tx = await seasonManagerContract.reportRoundResult(seasonId, playerAddress, placement);
    return tx.wait();
  } catch (err) {
    console.error("[Contracts] Season report failed:", err.message);
    return null;
  }
}

// -- Read helpers ---------------------------------------------

export async function getPlayerTokens(playerAddress) {
  if (!assetRegistryContract) return [];
  return assetRegistryContract.getPlayerTokens(playerAddress);
}

export async function getPlayerSeasonStats(playerAddress) {
  if (!seasonManagerContract) return null;
  try {
    const seasonId = await seasonManagerContract.getActiveSeasonId();
    if (seasonId === 0n) return null;
    return seasonManagerContract.getPlayerSeason(seasonId, playerAddress);
  } catch (_) {
    return null;
  }
}

export { provider, operatorWallet };
