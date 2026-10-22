// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CompoundDelegate} from "../contracts/CompoundDelegate.sol";

/// Stand-in for the staking precompile: records who called compound() and delegate()
contract MockStaking {
    address public lastCaller;
    uint64 public lastValidator;
    bool public fail;
    bool public failDelegate;
    bool public revertDelegate;
    bool public burnOnDelegate;
    address public lastDelegator;
    uint256 public delegated;

    function setFail(bool f) external {
        fail = f;
    }

    function setFailDelegate(bool f) external {
        failDelegate = f;
    }

    function setRevertDelegate(bool f) external {
        revertDelegate = f;
    }

    function setBurnOnDelegate(bool f) external {
        burnOnDelegate = f;
    }

    function compound(uint64 validatorId) external returns (bool) {
        lastCaller = msg.sender;
        lastValidator = validatorId;
        return !fail;
    }

    function delegate(uint64 validatorId) external payable returns (bool) {
        // The real precompile consumes all forwarded gas when it fails, but still returns a reason
        if (burnOnDelegate) {
            while (gasleft() > 3_000) {}
            revert("unknown validator");
        }
        require(!revertDelegate, "delegation is too small");
        lastDelegator = msg.sender;
        lastValidator = validatorId;
        delegated += msg.value;
        return !failDelegate;
    }
}

/// Precompile stand-in whose delegate() needs ~200k gas, like the real one
contract GasHungryStaking {
    function compound(uint64) external pure returns (bool) {
        return true;
    }

    function delegate(uint64) external payable returns (bool) {
        uint256 start = gasleft();
        while (start - gasleft() < 200_000) {}
        return true;
    }
}

/// A keeper whose key holder made it refuse transfers
contract RefusingKeeper {
    receive() external payable {
        revert("no");
    }
}

/// A keeper that is a contract and reenters compound() from the top-up
contract ReentrantKeeper {
    address payable owner;

    constructor(address payable owner_) {
        owner = owner_;
    }

    function go() external {
        CompoundDelegate(owner).compound();
    }

    receive() external payable {
        try CompoundDelegate(owner).compound() {} catch {}
    }
}

contract CompoundDelegateTest is Test {
    address constant STAKING = 0x0000000000000000000000000000000000001000;

    uint256 ownerKey = 0xA11CE;
    address owner = vm.addr(ownerKey);
    address keeper = makeAddr("keeper");

    CompoundDelegate impl;
    MockStaking staking = MockStaking(STAKING);

    function setUp() public {
        vm.etch(STAKING, type(MockStaking).runtimeCode);

        impl = new CompoundDelegate(keeper, 42, 20 ether, 42 ether, 1 ether, 10_000);
        vm.signAndAttachDelegation(address(impl), ownerKey);
        vm.deal(owner, 20 ether);
        vm.deal(keeper, 42 ether);
    }

    function compoundAsKeeper() internal {
        vm.prank(keeper);
        CompoundDelegate(payable(owner)).compound();
    }

    function test_keeperCompoundsAsOwner() public {
        compoundAsKeeper();

        assertEq(staking.lastCaller(), owner);
        assertEq(staking.lastValidator(), 42);
    }

    function test_revertsForNonKeeper() public {
        vm.prank(makeAddr("attacker"));
        vm.expectRevert(CompoundDelegate.NotKeeper.selector);
        CompoundDelegate(payable(owner)).compound();
    }

    function test_revertsOnImplementation() public {
        // Funds sent to the implementation by mistake must not be staked from it
        vm.deal(address(impl), 100 ether);
        vm.prank(keeper);
        vm.expectRevert(CompoundDelegate.NotDelegated.selector);
        impl.compound();
    }

    function test_revertsWhenPrecompileReturnsFalse() public {
        staking.setFail(true);
        vm.prank(keeper);
        vm.expectRevert();
        CompoundDelegate(payable(owner)).compound();
    }

    function test_revertsWithoutPrecompile() public {
        // An address without code answers any call with empty data, which must not pass as success
        vm.etch(STAKING, "");
        vm.deal(owner, 100 ether);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CompoundDelegate.CompoundFailed.selector, ""));
        CompoundDelegate(payable(owner)).compound();
        assertEq(STAKING.balance, 0);
    }

    function test_acceptsPlainTransfers() public {
        (bool ok,) = owner.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(owner.balance, 21 ether);
    }

    function test_acceptsCallsWithData() public {
        (bool ok,) = owner.call{value: 1 ether}(hex"01");
        assertTrue(ok);
        assertEq(owner.balance, 21 ether);
    }

    function test_ownerStillSendsTransactions() public {
        address to = makeAddr("to");
        vm.prank(owner);
        (bool ok,) = to.call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(to.balance, 1 ether);
    }

    function test_topsUpKeeperToExactBalance() public {
        vm.deal(keeper, 41.97 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
        assertEq(owner.balance, 19.97 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), block.number);
    }

    function test_noTopUpWhenKeeperFull() public {
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
        assertEq(owner.balance, 20 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 0);
    }

    function test_topUpCappedByMaxTopUp() public {
        vm.deal(keeper, 0);
        compoundAsKeeper();
        assertEq(keeper.balance, 1 ether);
    }

    function test_topUpRateLimited() public {
        vm.roll(100);
        vm.deal(keeper, 41 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);

        vm.deal(keeper, 41 ether);
        vm.roll(100 + 9_999);
        compoundAsKeeper();
        assertEq(keeper.balance, 41 ether);

        vm.roll(100 + 10_000);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
    }

    function test_topUpKeepsOwnerReserve() public {
        vm.deal(owner, 10.5 ether);
        vm.deal(keeper, 41 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 41 ether);
        assertEq(owner.balance, 10.5 ether);
        assertEq(staking.lastCaller(), owner);
    }

    function test_topUpLeavesOwnerGasAboveReserve() public {
        // 11.5 - 1 would leave the owner below 11 MON: no gas for its own txs, so skip
        vm.deal(owner, 11.5 ether);
        vm.deal(keeper, 41 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 41 ether);

        vm.deal(owner, 12 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
        assertEq(owner.balance, 11 ether);
    }

    function test_staleTopUpSlotIgnored() public {
        // Another delegate of the same owner may have left anything in the slot
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("monad-keeper.CompoundDelegate.lastTopUp")) - 1)) & ~bytes32(uint256(0xff));
        vm.store(owner, slot, bytes32(type(uint256).max));
        vm.roll(100);
        vm.deal(keeper, 41 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 100);
    }

    function test_reentrantKeeperGetsOneTopUp() public {
        ReentrantKeeper rk = new ReentrantKeeper(payable(owner));
        impl = new CompoundDelegate(address(rk), 42, 20 ether, 42 ether, 1 ether, 10_000);
        vm.signAndAttachDelegation(address(impl), ownerKey);
        vm.deal(owner, 100 ether);
        vm.roll(100);

        rk.go();
        assertEq(address(rk).balance, 1 ether);
        assertEq(owner.balance, 20 ether);
    }

    function test_delegatesExcessToFixedValidator() public {
        vm.deal(owner, 500 ether);
        vm.deal(keeper, 41.96 ether);
        compoundAsKeeper();
        assertEq(keeper.balance, 42 ether);
        assertEq(owner.balance, 20 ether);
        assertEq(staking.delegated(), 479.96 ether);
        assertEq(staking.lastDelegator(), owner);
        assertEq(staking.lastValidator(), 42);
    }

    function test_smallExcessStaysLiquid() public {
        vm.deal(owner, 20.9 ether);
        compoundAsKeeper();
        assertEq(owner.balance, 20.9 ether);
        assertEq(staking.delegated(), 0);
    }

    function test_delegateBurningAllGasKeepsCompound() public {
        vm.deal(owner, 500 ether);
        staking.setBurnOnDelegate(true);
        vm.expectEmit(true, true, true, true, owner);
        emit CompoundDelegate.DelegateSkipped(abi.encodeWithSignature("Error(string)", "unknown validator"));
        vm.prank(keeper);
        CompoundDelegate(payable(owner)).compound{gas: 100_000}();
        assertEq(staking.lastCaller(), owner);
        assertEq(owner.balance, 500 ether);
    }

    function test_delegateOutOfGasReverts() public {
        // Starving delegate() must fail the tx, otherwise estimateGas would pick such a limit
        vm.deal(owner, 500 ether);
        vm.etch(STAKING, type(GasHungryStaking).runtimeCode);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(CompoundDelegate.DelegateFailed.selector, ""));
        CompoundDelegate(payable(owner)).compound{gas: 150_000}();

        vm.prank(keeper);
        CompoundDelegate(payable(owner)).compound{gas: 400_000}();
        assertEq(owner.balance, 20 ether);
    }

    function test_refusingKeeperSkipsTopUp() public {
        RefusingKeeper rk = new RefusingKeeper();
        impl = new CompoundDelegate(address(rk), 42, 20 ether, 42 ether, 1 ether, 10_000);
        vm.signAndAttachDelegation(address(impl), ownerKey);
        vm.roll(100);
        vm.expectEmit(true, true, true, true, owner);
        emit CompoundDelegate.TopUpSkipped();
        vm.prank(address(rk));
        CompoundDelegate(payable(owner)).compound();
        assertEq(staking.lastCaller(), owner);
        assertEq(address(rk).balance, 0);
        assertEq(owner.balance, 20 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 100);
    }

    function test_delegateRevertKeepsCompound() public {
        // Anyone can push the owner above ownerBalance; a failing delegate() must not block compounding
        vm.deal(owner, 500 ether);
        staking.setRevertDelegate(true);
        vm.expectEmit(true, true, true, true, owner);
        emit CompoundDelegate.DelegateSkipped(abi.encodeWithSignature("Error(string)", "delegation is too small"));
        compoundAsKeeper();
        assertEq(staking.lastCaller(), owner);
        assertEq(owner.balance, 500 ether);
        assertEq(staking.delegated(), 0);
    }

    function test_revertsWhenDelegateReturnsFalse() public {
        vm.deal(owner, 500 ether);
        staking.setFailDelegate(true);
        vm.prank(keeper);
        vm.expectRevert();
        CompoundDelegate(payable(owner)).compound();
    }

    function test_rejectsOwnerBalanceAtReserve() public {
        vm.expectRevert(CompoundDelegate.OwnerBalanceBelowReserve.selector);
        new CompoundDelegate(keeper, 42, 10 ether, 42 ether, 1 ether, 10_000);
    }

    function test_rejectsZeroTopUpInterval() public {
        vm.expectRevert(CompoundDelegate.InvalidParams.selector);
        new CompoundDelegate(keeper, 42, 20 ether, 42 ether, 1 ether, 0);
    }

    function test_rejectsHugeKeeperBalance() public {
        vm.expectRevert(CompoundDelegate.InvalidParams.selector);
        new CompoundDelegate(keeper, 42, 20 ether, type(uint256).max, 1 ether, 10_000);
    }
}
