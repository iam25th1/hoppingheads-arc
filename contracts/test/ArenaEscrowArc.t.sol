// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ArenaEscrow} from "../src/ArenaEscrow.sol";
import {IArenaSettlement} from "../src/IArenaSettlement.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";

interface IMemo {
    event Memo(
        address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex
    );

    function memo(address target, bytes calldata data, bytes32 memoId, bytes calldata memoData) external;
    function memoIndex() external view returns (uint256);
}

/// Against Arc's own predeploys on a fork of arc-anvil --network arc: the real USDC (one balance,
/// two views), the real Permit2, the real Memo. Set ARC_FORK_URL; without it every test here is
/// skipped, loudly, by the gate script that starts arc-anvil.
contract ArenaEscrowArcTest is Test {
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant MEMO = 0x5294E9927c3306DcBaDb03fe70b92e01cCede505;
    // arc-anvil's first funded account, 1,000,000 USDC
    address constant BANK = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

    bytes32 constant PTF_TYPEHASH = keccak256(
        "PermitTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline)TokenPermissions(address token,uint256 amount)"
    );
    bytes32 constant TP_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");

    bool forked;
    bool memoUsable; // the callFrom precompile behind Memo exists on this node
    ArenaEscrow esc;
    IERC20 usdc = IERC20(USDC);
    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    uint256 signerKey = 0xA11CE;
    address signer;
    uint256 playerKey = 0xB1A7E4;
    address player;
    bytes32 constant ROUND = keccak256("arc-round-1");
    bytes32 constant SEED = keccak256("arc-seed-1");

    function setUp() public {
        string memory url = vm.envOr("ARC_FORK_URL", string(""));
        if (bytes(url).length == 0) return;
        vm.createSelectFork(url);
        forked = true;
        signer = vm.addr(signerKey);
        player = vm.addr(playerKey);
        uint256[] memory t = new uint256[](3);
        t[0] = 1_200_000;
        t[1] = 700_000;
        t[2] = 400_000;
        esc = new ArenaEscrow(USDC, PERMIT2, owner, operator, signer, 500_000, t, 2_300_000, 20_000_000, 43200);
        vm.startPrank(BANK);
        require(usdc.transfer(owner, 100e6), "fund owner");
        require(usdc.transfer(player, 5e6), "fund player");
        vm.stopPrank();
        vm.startPrank(owner);
        usdc.approve(address(esc), type(uint256).max);
        esc.fundPool(50e6);
        vm.stopPrank();
        // Probe the Memo predeploy with a harmless forwarded call. arc-anvil v0.8.0-1 ships the
        // Memo contract but not the callFrom precompile (0x18..03) it forwards through, and a
        // test may only skip at its top, so the probe lives here.
        vm.prank(operator, operator);
        try IMemo(MEMO).memo(USDC, abi.encodeCall(IERC20.balanceOf, (operator)), bytes32(uint256(1)), "") {
            memoUsable = true;
        } catch {
            memoUsable = false;
        }
    }

    modifier onlyFork() {
        if (!forked) {
            vm.skip(true);
            return;
        }
        _;
    }

    function test_arc_predeploysArePresent() public onlyFork {
        assertGt(USDC.code.length, 0, "USDC predeploy");
        assertGt(PERMIT2.code.length, 0, "Permit2 predeploy");
        assertGt(MEMO.code.length, 0, "Memo predeploy");
    }

    function test_arc_oneBalanceTwoViews() public onlyFork {
        // The escrow holds 50 USDC through the ERC-20 view (6 decimals). The native view of
        // the same address is the same balance at 18 decimals. Never summed, never converted
        // in this code base; shown here so the difference is on record.
        assertEq(usdc.balanceOf(address(esc)), 50e6);
        assertEq(address(esc).balance, 50e6 * 1e12);
    }

    function test_arc_enterWithPermit2IsOneSignature() public onlyFork {
        bytes32 commit = esc.commitFor(SEED);
        vm.prank(operator);
        esc.openRound(ROUND, commit);
        // One time: the token approval to Permit2 itself. After that every entry is a signature.
        vm.prank(player);
        usdc.approve(PERMIT2, type(uint256).max);
        uint256 nonce = 7;
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash = keccak256(
            abi.encode(
                PTF_TYPEHASH, keccak256(abi.encode(TP_TYPEHASH, USDC, 500_000)), address(esc), nonce, deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(PERMIT2).DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(playerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);

        vm.prank(player);
        esc.enterWithPermit2(ROUND, nonce, deadline, sig);
        assertTrue(esc.entered(ROUND, player));
        assertEq(usdc.balanceOf(player), 5e6 - 500_000);
        assertEq(usdc.balanceOf(address(esc)), 50e6 + 500_000);

        // the same permit cannot seat twice (nonce spent at Permit2, and the seat is taken)
        vm.prank(player);
        vm.expectRevert();
        esc.enterWithPermit2(ROUND, nonce, deadline, sig);
    }

    function test_arc_settleThroughMemoLeavesAReceipt() public onlyFork {
        if (!memoUsable) {
            emit log("callFrom precompile not available on this node; Memo path skipped (proven on testnet by cli/settle.mjs)");
            vm.skip(true);
            return;
        }
        bytes32 commit = esc.commitFor(SEED);
        vm.prank(operator);
        esc.openRound(ROUND, commit);
        vm.startPrank(player);
        usdc.approve(address(esc), type(uint256).max);
        esc.enter(ROUND);
        vm.stopPrank();
        IArenaSettlement.Placement[] memory ps = new IArenaSettlement.Placement[](1);
        ps[0] = IArenaSettlement.Placement(player, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, esc.settlementDigest(ROUND, SEED, ps));
        bytes memory data = abi.encodeCall(esc.settleRound, (ROUND, ps, SEED, abi.encodePacked(r, s, v)));

        // The Memo predeploy forwards through the callFrom precompile (0x18..03) with the caller
        // as sender, so the escrow still sees the operator. arc-anvil v0.8.0-1 ships the Memo
        // contract but not that precompile (OpcodeNotFound), so this path is proven on testnet
        // by the CLI and skipped here when the precompile is missing.
        uint256 before = IMemo(MEMO).memoIndex();
        vm.prank(operator, operator);
        IMemo(MEMO).memo(address(esc), data, ROUND, bytes("hh-arc settle"));
        assertEq(IMemo(MEMO).memoIndex(), before + 1, "memo index advanced");
        (,, bool settled,) = esc.rounds(ROUND);
        assertTrue(settled, "settled through the memo call");
        assertEq(esc.claimable(player), 1_200_000);
    }
}
