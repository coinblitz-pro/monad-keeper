// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CompoundDelegate} from "../contracts/CompoundDelegate.sol";
import {MockStaking} from "./CompoundDelegate.t.sol";

/// Runs the owner's code in its own context through delegatecall
contract DelegatecallProxy {
    function forward(address target, bytes calldata data) external returns (bool ok) {
        (ok,) = target.delegatecall(data);
    }

    receive() external payable {}
}

/// A keeper that sends every top-up away before reentering, so its balance never looks full
contract DrainingKeeper {
    CompoundDelegate immutable owner;
    address payable immutable recipient;
    uint256 public callbacks;

    constructor(address payable owner_, address payable recipient_) {
        owner = CompoundDelegate(owner_);
        recipient = recipient_;
    }

    function go() external {
        owner.compound();
    }

    receive() external payable {
        ++callbacks;
        (bool ok,) = recipient.call{value: address(this).balance}("");
        require(ok);
        if (callbacks < 8) owner.compound();
    }
}

/// Invariants a leaked keeper key or an arbitrary caller must not break
contract CompoundDelegateSecurityTest is Test {
    address constant STAKING = 0x0000000000000000000000000000000000001000;
    uint256 constant MAX_TOP_UP = 0.2 ether;
    uint256 constant TOP_UP_INTERVAL = 40_000;

    uint256 ownerKey = 0xA11CE;
    address owner = vm.addr(ownerKey);
    address keeper = makeAddr("keeper");
    address attacker = makeAddr("attacker");

    MockStaking staking = MockStaking(STAKING);

    function setUp() public {
        vm.etch(STAKING, type(MockStaking).runtimeCode);

        CompoundDelegate impl = new CompoundDelegate(keeper, 42, 20 ether, 42 ether, MAX_TOP_UP, TOP_UP_INTERVAL);
        vm.signAndAttachDelegation(address(impl), ownerKey);
        vm.roll(100_000);
        vm.deal(owner, 1_000_000 ether);
        vm.deal(keeper, 0);
    }

    function testFuzz_keeperOriginIsNotEnough(address caller) public {
        vm.assume(caller != keeper);
        vm.prank(caller, keeper);
        vm.expectRevert(CompoundDelegate.NotKeeper.selector);
        CompoundDelegate(payable(owner)).compound();
        assertEq(owner.balance, 1_000_000 ether);
        assertEq(STAKING.balance, 0);
    }

    function testFuzz_arbitraryCallsDontSpendOwnerFunds(bytes calldata data, uint96 value) public {
        vm.deal(attacker, value);
        vm.prank(attacker);
        (bool ok,) = owner.call{value: value}(data);
        assertEq(owner.balance, 1_000_000 ether + (ok ? uint256(value) : 0));
        assertEq(keeper.balance, 0);
        assertEq(STAKING.balance, 0);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 0);
        assertEq(staking.lastCaller(), address(0));
    }

    function test_delegatecallOnlySpendsCallerFunds() public {
        // The code runs in the proxy's context: it stakes the proxy's own funds, the owner is untouched
        DelegatecallProxy proxy = new DelegatecallProxy();
        vm.deal(address(proxy), 100 ether);
        vm.prank(keeper);
        assertTrue(proxy.forward(owner, abi.encodeCall(CompoundDelegate.compound, ())));
        assertEq(owner.balance, 1_000_000 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 0);
        assertEq(staking.lastCaller(), address(proxy));
        assertEq(staking.lastDelegator(), address(proxy));
        assertEq(address(proxy).balance, 20 ether);
    }

    function test_drainingKeeperGetsOneTopUp() public {
        DrainingKeeper dk = new DrainingKeeper(payable(owner), payable(attacker));
        CompoundDelegate impl = new CompoundDelegate(address(dk), 42, 20 ether, 42 ether, MAX_TOP_UP, TOP_UP_INTERVAL);
        vm.signAndAttachDelegation(address(impl), ownerKey);

        dk.go();
        dk.go();
        assertEq(attacker.balance, MAX_TOP_UP);
        assertEq(dk.callbacks(), 1);
        assertEq(owner.balance, 20 ether);
        assertEq(STAKING.balance, 1_000_000 ether - 20 ether - MAX_TOP_UP);
        assertEq(staking.lastDelegator(), owner);
    }

    function testFuzz_delegateNotReturningTrueRevertsEverything(bytes calldata response) public {
        vm.assume(keccak256(response) != keccak256(abi.encode(true)));
        vm.mockCall(STAKING, abi.encodeWithSelector(bytes4(0x84994fec), uint64(42)), response);
        vm.prank(keeper);
        vm.expectRevert();
        CompoundDelegate(payable(owner)).compound();

        assertEq(owner.balance, 1_000_000 ether);
        assertEq(keeper.balance, 0);
        assertEq(STAKING.balance, 0);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), 0);
        assertEq(staking.lastCaller(), address(0));
    }

    function test_reauthorizationKeepsTopUpLimit() public {
        vm.prank(keeper);
        CompoundDelegate(payable(owner)).compound();
        vm.deal(keeper, 0);

        // A fresh delegate reads the same slot in the owner's storage
        CompoundDelegate replacement = new CompoundDelegate(keeper, 42, 20 ether, 42 ether, MAX_TOP_UP, TOP_UP_INTERVAL);
        vm.signAndAttachDelegation(address(replacement), ownerKey);
        vm.prank(keeper);
        CompoundDelegate(payable(owner)).compound();

        assertEq(keeper.balance, 0);
        assertEq(owner.balance, 20 ether);
        assertEq(CompoundDelegate(payable(owner)).lastTopUp(), block.number);
    }
}
