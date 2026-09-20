// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ArenaEscrow} from "../src/ArenaEscrow.sol";
import {IArenaSettlement} from "../src/IArenaSettlement.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Unit tests against the USDC mock (6 decimals, blocklist). Permit2, the native USDC view and
/// the Memo predeploy are exercised against arc-anvil in ArenaEscrowArc.t.sol.
///
/// A note on the harness: vm.prank applies to the next external call, and a view call made to
/// compute an argument counts. Every commit and signature is computed before the prank.
contract ArenaEscrowTest is Test {
    MockUSDC usdc;
    ArenaEscrow esc;

    address owner = makeAddr("owner");
    address operator = makeAddr("operator");
    uint256 signerKey = 0xA11CE;
    address signer;
    uint256 strangerKey = 0xB0B;
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address dave = makeAddr("dave");
    address permit2Stub = address(0xBEEF); // never called by the unit tests

    bytes32 constant ROUND = keccak256("round-1");
    bytes32 constant ROUND2 = keccak256("round-2");
    bytes32 constant SEED = keccak256("seed-1");
    uint256 constant ENTRY = 500_000; // 0.50 USDC
    uint256 constant CAP_ROUND = 2_300_000;
    uint256 constant CAP_PLAYER = 20_000_000;
    uint256 constant WINDOW = 100;

    function tiers() internal pure returns (uint256[] memory t) {
        t = new uint256[](3);
        t[0] = 1_200_000;
        t[1] = 700_000;
        t[2] = 400_000;
    }

    function setUp() public {
        signer = vm.addr(signerKey);
        usdc = new MockUSDC();
        esc = new ArenaEscrow(
            address(usdc), permit2Stub, owner, operator, signer, ENTRY, tiers(), CAP_ROUND, CAP_PLAYER, WINDOW
        );
        usdc.mint(owner, 100e6);
        vm.startPrank(owner);
        usdc.approve(address(esc), type(uint256).max);
        esc.fundPool(50e6);
        vm.stopPrank();
        address[4] memory players = [alice, bob, carol, dave];
        for (uint256 i = 0; i < players.length; i++) {
            usdc.mint(players[i], 10e6);
            vm.prank(players[i]);
            usdc.approve(address(esc), type(uint256).max);
        }
    }

    // ---- helpers ----

    function _open(bytes32 round, bytes32 seed) internal {
        bytes32 commit = esc.commitFor(seed);
        vm.prank(operator);
        esc.openRound(round, commit);
    }

    function _enter(address player, bytes32 round) internal {
        vm.prank(player);
        esc.enter(round);
    }

    function _p(address a, uint8 pa, address b, uint8 pb, address c, uint8 pc)
        internal
        pure
        returns (IArenaSettlement.Placement[] memory ps)
    {
        ps = new IArenaSettlement.Placement[](3);
        ps[0] = IArenaSettlement.Placement(a, pa);
        ps[1] = IArenaSettlement.Placement(b, pb);
        ps[2] = IArenaSettlement.Placement(c, pc);
    }

    function _sign(uint256 key, bytes32 round, bytes32 seed, IArenaSettlement.Placement[] memory ps)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, esc.settlementDigest(round, seed, ps));
        return abi.encodePacked(r, s, v);
    }

    /// Operator submits a settlement; the signature is computed before the prank.
    function _settle(bytes32 round, IArenaSettlement.Placement[] memory ps, bytes32 seed, bytes memory sig) internal {
        vm.prank(operator);
        esc.settleRound(round, ps, seed, sig);
    }

    /// Operator submits and the call must revert with `err`.
    function _settleReverts(
        bytes32 round,
        IArenaSettlement.Placement[] memory ps,
        bytes32 seed,
        bytes memory sig,
        bytes memory err
    ) internal {
        vm.prank(operator);
        vm.expectRevert(err);
        esc.settleRound(round, ps, seed, sig);
    }

    function _threeSeated() internal returns (IArenaSettlement.Placement[] memory ps) {
        _open(ROUND, SEED);
        _enter(alice, ROUND);
        _enter(bob, ROUND);
        _enter(carol, ROUND);
        ps = _p(alice, 1, bob, 2, carol, 3);
    }

    // ---- happy path ----

    function test_happyPath_enterSettleWithdraw() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        assertEq(usdc.balanceOf(address(esc)), 50e6 + 3 * ENTRY);
        (, uint64 openedAt, bool settled, uint32 entrants) = esc.rounds(ROUND);
        assertGt(openedAt, 0);
        assertFalse(settled);
        assertEq(entrants, 3);

        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        vm.prank(operator);
        vm.expectEmit(true, true, false, true);
        emit IArenaSettlement.Credited(ROUND, alice, 1, 1_200_000);
        esc.settleRound(ROUND, ps, SEED, sig);

        assertEq(esc.claimable(alice), 1_200_000);
        assertEq(esc.claimable(bob), 700_000);
        assertEq(esc.claimable(carol), 400_000);
        assertEq(esc.totalClaimable(), 2_300_000);
        (,, settled,) = esc.rounds(ROUND);
        assertTrue(settled);
        // settlement transferred nothing
        assertEq(usdc.balanceOf(alice), 10e6 - ENTRY);

        vm.prank(alice);
        esc.withdraw();
        assertEq(usdc.balanceOf(alice), 10e6 - ENTRY + 1_200_000);
        assertEq(esc.claimable(alice), 0);
        vm.prank(bob);
        esc.withdraw();
        vm.prank(carol);
        esc.withdraw();
        assertEq(esc.totalClaimable(), 0);
        assertEq(esc.freePool(), 50e6 + 3 * ENTRY - 2_300_000);
    }

    function test_placeBeyondTiersCreditsNothing() public {
        _open(ROUND, SEED);
        _enter(alice, ROUND);
        _enter(bob, ROUND);
        _enter(carol, ROUND);
        _enter(dave, ROUND);
        IArenaSettlement.Placement[] memory ps = new IArenaSettlement.Placement[](4);
        ps[0] = IArenaSettlement.Placement(alice, 1);
        ps[1] = IArenaSettlement.Placement(bob, 2);
        ps[2] = IArenaSettlement.Placement(carol, 3);
        ps[3] = IArenaSettlement.Placement(dave, 4);
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));
        assertEq(esc.claimable(dave), 0);
        assertEq(esc.totalClaimable(), 2_300_000);
    }

    // ---- roundId replay ----

    function test_roundIdIsSingleUse() public {
        _open(ROUND, SEED);
        bytes32 commit = esc.commitFor(SEED);
        vm.prank(operator);
        vm.expectRevert(ArenaEscrow.RoundExists.selector);
        esc.openRound(ROUND, commit);
    }

    function test_settleReplayReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        _settle(ROUND, ps, SEED, sig);
        _settleReverts(ROUND, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.AlreadySettled.selector));
        // and a settled round cannot be reopened either
        bytes32 commit = esc.commitFor(SEED);
        vm.prank(operator);
        vm.expectRevert(ArenaEscrow.RoundExists.selector);
        esc.openRound(ROUND, commit);
    }

    // ---- signatures ----

    function test_wrongSignerReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes memory sig = _sign(strangerKey, ROUND, SEED, ps);
        _settleReverts(ROUND, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.BadSignature.selector));
    }

    function test_tamperedPlacementsReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        IArenaSettlement.Placement[] memory swapped = _p(bob, 1, alice, 2, carol, 3);
        _settleReverts(ROUND, swapped, SEED, sig, abi.encodeWithSelector(ArenaEscrow.BadSignature.selector));
        // a signature for one round does not settle another
        _open(ROUND2, SEED);
        _enter(alice, ROUND2);
        _enter(bob, ROUND2);
        _enter(carol, ROUND2);
        _settleReverts(ROUND2, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.BadSignature.selector));
    }

    function test_malformedSignatureReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        vm.prank(operator);
        vm.expectRevert();
        esc.settleRound(ROUND, ps, SEED, hex"deadbeef");
    }

    function test_digestBindsChainAndContract() public {
        IArenaSettlement.Placement[] memory ps = _p(alice, 1, bob, 2, carol, 3);
        bytes32 here = esc.settlementDigest(ROUND, SEED, ps);
        ArenaEscrow other = new ArenaEscrow(
            address(usdc), permit2Stub, owner, operator, signer, ENTRY, tiers(), CAP_ROUND, CAP_PLAYER, WINDOW
        );
        assertTrue(other.settlementDigest(ROUND, SEED, ps) != here, "another contract, another digest");
        vm.chainId(5042);
        assertTrue(esc.settlementDigest(ROUND, SEED, ps) != here, "another chain, another digest");
    }

    // ---- seed ----

    function test_seedNotMatchingCommitReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes32 wrong = keccak256("seed-2");
        bytes memory sig = _sign(signerKey, ROUND, wrong, ps);
        _settleReverts(ROUND, ps, wrong, sig, abi.encodeWithSelector(ArenaEscrow.BadCommit.selector));
    }

    // ---- caps ----

    function test_playerWindowCapReverts_thenClearsAfterWindow() public {
        vm.prank(owner);
        esc.setCaps(CAP_ROUND, 1_500_000, WINDOW); // one first place fits, two do not
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));

        _open(ROUND2, SEED);
        _enter(alice, ROUND2);
        _enter(bob, ROUND2);
        _enter(carol, ROUND2);
        bytes memory sig = _sign(signerKey, ROUND2, SEED, ps);
        _settleReverts(
            ROUND2,
            ps,
            SEED,
            sig,
            abi.encodeWithSelector(ArenaEscrow.PlayerWindowCapExceeded.selector, alice, 2_400_000, 1_500_000)
        );

        vm.roll(block.number + WINDOW);
        _settle(ROUND2, ps, SEED, sig);
        assertEq(esc.claimable(alice), 2_400_000);
    }

    function test_tiersCannotExceedRoundCap() public {
        uint256[] memory fat = new uint256[](2);
        fat[0] = 2_000_000;
        fat[1] = 1_000_000;
        vm.prank(owner);
        vm.expectRevert(ArenaEscrow.BadTiers.selector);
        esc.setTiers(fat);
        vm.prank(owner);
        vm.expectRevert(ArenaEscrow.BadTiers.selector);
        esc.setCaps(2_000_000, CAP_PLAYER, WINDOW); // the current table would no longer fit
    }

    function test_poolInsufficientReverts() public {
        // drain the free pool so the credits cannot be covered
        vm.prank(owner);
        esc.withdrawPool(owner, 50e6);
        IArenaSettlement.Placement[] memory ps = _threeSeated(); // pool now holds 1.5 USDC of entries
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        _settleReverts(
            ROUND, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.PoolInsufficient.selector, 2_300_000, 1_500_000)
        );
    }

    function test_ownerCannotTakeWhatPlayersAreOwed() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));
        uint256 free = esc.freePool();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ArenaEscrow.ExceedsFreePool.selector, free + 1, free));
        esc.withdrawPool(owner, free + 1);
        vm.prank(owner);
        esc.withdrawPool(owner, free);
        assertEq(usdc.balanceOf(address(esc)), esc.totalClaimable());
    }

    // ---- pause ----

    function test_pausedBlocksEveryPlayerPath() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        vm.prank(owner);
        esc.pause();
        vm.prank(dave);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.enter(ROUND);
        _settleReverts(ROUND, ps, SEED, sig, abi.encodeWithSelector(Pausable.EnforcedPause.selector));
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        esc.withdraw();
        vm.prank(owner);
        esc.unpause();
        _settle(ROUND, ps, SEED, sig);
        vm.prank(alice);
        esc.withdraw();
    }

    // ---- withdraw ----

    function test_doubleWithdrawReverts() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));
        vm.prank(alice);
        esc.withdraw();
        vm.prank(alice);
        vm.expectRevert(ArenaEscrow.NothingToWithdraw.selector);
        esc.withdraw();
    }

    function test_zeroBalanceWithdrawReverts() public {
        vm.prank(dave);
        vm.expectRevert(ArenaEscrow.NothingToWithdraw.selector);
        esc.withdraw();
    }

    function test_blocklistedRecipientRevertsAloneAndKeepsBalance() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));
        usdc.setBlocklisted(alice, true);
        vm.prank(alice);
        vm.expectRevert(bytes("USDC: blocklisted"));
        esc.withdraw();
        assertEq(esc.claimable(alice), 1_200_000, "credit intact");
        vm.prank(bob);
        esc.withdraw();
        assertEq(usdc.balanceOf(bob), 10e6 - ENTRY + 700_000, "others unaffected");
        usdc.setBlocklisted(alice, false);
        vm.prank(alice);
        esc.withdraw();
        assertEq(esc.claimable(alice), 0);
    }

    // ---- placements must be seated addresses ----

    function test_unseatedPlayerCannotBePaid() public {
        _open(ROUND, SEED);
        _enter(alice, ROUND);
        _enter(bob, ROUND);
        IArenaSettlement.Placement[] memory ps = _p(alice, 1, bob, 2, dave, 3);
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        _settleReverts(ROUND, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.NotEntered.selector, dave));
    }

    function test_zeroAddressAndZeroPlaceRejected() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        ps[2] = IArenaSettlement.Placement(address(0), 3);
        bytes memory sigA = _sign(signerKey, ROUND, SEED, ps);
        _settleReverts(
            ROUND, ps, SEED, sigA, abi.encodeWithSelector(ArenaEscrow.BadPlacement.selector, address(0), 3)
        );
        ps[2] = IArenaSettlement.Placement(carol, 0);
        bytes memory sigB = _sign(signerKey, ROUND, SEED, ps);
        _settleReverts(ROUND, ps, SEED, sigB, abi.encodeWithSelector(ArenaEscrow.BadPlacement.selector, carol, 0));
    }

    function test_duplicatePlacementRejected() public {
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        ps[2] = IArenaSettlement.Placement(alice, 3);
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        _settleReverts(ROUND, ps, SEED, sig, abi.encodeWithSelector(ArenaEscrow.DuplicatePlacement.selector, alice));
    }

    function test_tooManyPlacementsRejected() public {
        _open(ROUND, SEED);
        IArenaSettlement.Placement[] memory ps = new IArenaSettlement.Placement[](9);
        vm.prank(operator);
        vm.expectRevert(ArenaEscrow.TooManyPlacements.selector);
        esc.settleRound(ROUND, ps, SEED, "");
    }

    // ---- entry rules ----

    function test_entryRules() public {
        vm.prank(alice);
        vm.expectRevert(ArenaEscrow.RoundNotOpen.selector);
        esc.enter(ROUND);
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        vm.prank(alice);
        vm.expectRevert(ArenaEscrow.AlreadyEntered.selector);
        esc.enter(ROUND);
        _settle(ROUND, ps, SEED, _sign(signerKey, ROUND, SEED, ps));
        vm.prank(dave);
        vm.expectRevert(ArenaEscrow.AlreadySettled.selector);
        esc.enter(ROUND);
    }

    // ---- roles ----

    function test_rolesMustDiffer() public {
        vm.expectRevert(ArenaEscrow.RolesMustDiffer.selector);
        new ArenaEscrow(address(usdc), permit2Stub, owner, owner, signer, ENTRY, tiers(), CAP_ROUND, CAP_PLAYER, WINDOW);
        vm.prank(owner);
        vm.expectRevert(ArenaEscrow.RolesMustDiffer.selector);
        esc.setOperator(signer);
        vm.prank(owner);
        vm.expectRevert(ArenaEscrow.ZeroAddress.selector);
        esc.setSigner(address(0));
    }

    function test_onlyOperatorOpensAndSettles() public {
        bytes32 commit = esc.commitFor(SEED);
        vm.prank(alice);
        vm.expectRevert(ArenaEscrow.NotOperator.selector);
        esc.openRound(ROUND, commit);
        IArenaSettlement.Placement[] memory ps = _threeSeated();
        bytes memory sig = _sign(signerKey, ROUND, SEED, ps);
        vm.prank(signer);
        vm.expectRevert(ArenaEscrow.NotOperator.selector);
        esc.settleRound(ROUND, ps, SEED, sig);
        vm.prank(owner);
        vm.expectRevert(ArenaEscrow.NotOperator.selector);
        esc.settleRound(ROUND, ps, SEED, sig);
    }

    function test_onlyOwnerTunes() public {
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        esc.setEntryAmount(1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, operator));
        esc.pause();
    }

    function test_noNativeValueAccepted() public {
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        (bool ok,) = address(esc).call{value: 1}("");
        assertFalse(ok, "no receive, no fallback, no payable");
    }
}
