import hre from "hardhat";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = hre.network.name;

  console.log(`\nDeploying Hopping Heads contracts on ${network}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${hre.ethers.formatEther(await deployer.provider.getBalance(deployer.address))} ETH\n`);

  // 1. Deploy AssetRegistry
  console.log("1/3 Deploying AssetRegistry...");
  const AssetRegistry = await hre.ethers.getContractFactory("AssetRegistry");
  const baseURI = "https://api.hoppingheads.gg/metadata/{id}";
  const assetRegistry = await AssetRegistry.deploy(baseURI);
  await assetRegistry.waitForDeployment();
  const assetAddr = await assetRegistry.getAddress();
  console.log(`    AssetRegistry deployed: ${assetAddr}`);

  // 2. Deploy GameManager
  console.log("2/3 Deploying GameManager...");
  const GameManager = await hre.ethers.getContractFactory("GameManager");
  const gameManager = await GameManager.deploy(assetAddr);
  await gameManager.waitForDeployment();
  const gmAddr = await gameManager.getAddress();
  console.log(`    GameManager deployed:   ${gmAddr}`);

  // 3. Deploy SeasonManager
  console.log("3/3 Deploying SeasonManager...");
  const SeasonManager = await hre.ethers.getContractFactory("SeasonManager");
  const seasonManager = await SeasonManager.deploy();
  await seasonManager.waitForDeployment();
  const smAddr = await seasonManager.getAddress();
  console.log(`    SeasonManager deployed: ${smAddr}`);

  // 4. Wire contracts together
  console.log("\nWiring contracts...");

  const tx1 = await assetRegistry.setGameManager(gmAddr);
  await tx1.wait();
  console.log("    AssetRegistry -> GameManager set");

  const tx2 = await seasonManager.setGameManager(gmAddr);
  await tx2.wait();
  console.log("    SeasonManager -> GameManager set");

  // Summary
  console.log("\n--- DEPLOYMENT COMPLETE ---");
  console.log(`Network:        ${network}`);
  console.log(`AssetRegistry:  ${assetAddr}`);
  console.log(`GameManager:    ${gmAddr}`);
  console.log(`SeasonManager:  ${smAddr}`);
  console.log(`Deployer/Owner: ${deployer.address}`);
  console.log("---------------------------\n");

  // Verify on BaseScan if not local
  if (network !== "hardhat" && network !== "localhost") {
    console.log("Waiting 30s for block confirmations before verification...");
    await new Promise((r) => setTimeout(r, 30000));

    try {
      await hre.run("verify:verify", { address: assetAddr, constructorArguments: [baseURI] });
      console.log("AssetRegistry verified");
    } catch (e) { console.log(`AssetRegistry verification: ${e.message}`); }

    try {
      await hre.run("verify:verify", { address: gmAddr, constructorArguments: [assetAddr] });
      console.log("GameManager verified");
    } catch (e) { console.log(`GameManager verification: ${e.message}`); }

    try {
      await hre.run("verify:verify", { address: smAddr, constructorArguments: [] });
      console.log("SeasonManager verified");
    } catch (e) { console.log(`SeasonManager verification: ${e.message}`); }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
