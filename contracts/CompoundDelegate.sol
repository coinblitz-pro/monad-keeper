// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// EIP-7702 delegate for a staking EOA. The only thing it adds to the account:
/// a single keeper address may trigger compound() on the Monad staking precompile.
/// The precompile sees the EOA itself as msg.sender, so rewards are compounded
/// into the EOA's own delegation. Everything else the EOA does (signed txs) is unaffected.
///
/// Liquid balance above ownerBalance (e.g. priority fees when the EOA is the node's
/// beneficiary) is delegated too. The validator is fixed at deployment, so a leaked
/// keeper key can't move stake to another validator.
///
/// After compounding, the EOA tops the keeper back up to keeperBalance. Monad charges
/// the full gas limit with no refund, so the keeper's balance during execution is already
/// final and the top-up makes it exact. Bounded by maxTopUp per call and one top-up per
/// topUpInterval blocks, so a leaked keeper key can't drain the owner.
contract CompoundDelegate {
    address constant STAKING = 0x0000000000000000000000000000000000001000;

    // Monad reverts any tx that takes a delegated EOA below this balance; the owner needs
    // some gas on top of it for its own transactions
    uint256 constant OWNER_RESERVE = 10 ether;
    uint256 constant OWNER_MIN_BALANCE = OWNER_RESERVE + 1 ether;

    // Smaller excess stays liquid until the next compound
    uint256 constant MIN_DELEGATION = 1 ether;

    // The precompile burns all forwarded gas when it reverts (measured on testnet), so this much
    // is held back for the skip path after a failed delegate()
    uint256 constant SKIP_GAS_RESERVE = 30_000;

    // ERC-7201 slot in the owner's storage: block number of the last top-up. The owner's
    // storage outlives this delegate, so the rate limit also carries over to a re-authorization
    bytes32 constant LAST_TOP_UP_SLOT =
        keccak256(abi.encode(uint256(keccak256("monad-keeper.CompoundDelegate.lastTopUp")) - 1)) & ~bytes32(uint256(0xff));

    address private immutable self;

    address public immutable keeper;
    uint64 public immutable validatorId;
    uint256 public immutable ownerBalance;
    uint256 public immutable keeperBalance;
    uint256 public immutable maxTopUp;
    uint256 public immutable topUpInterval;

    event Compounded(uint64 indexed validatorId);
    event KeeperToppedUp(uint256 amount);
    event Delegated(uint64 indexed validatorId, uint256 amount);
    event DelegateSkipped(bytes reason);
    event TopUpSkipped();

    error ZeroKeeper();
    error OwnerBalanceBelowReserve();
    error InvalidParams();
    error NotDelegated();
    error NotKeeper();
    error CompoundFailed(bytes reason);
    error DelegateFailed(bytes reason);

    constructor(
        address keeper_,
        uint64 validatorId_,
        uint256 ownerBalance_,
        uint256 keeperBalance_,
        uint256 maxTopUp_,
        uint256 topUpInterval_
    ) {
        if (keeper_ == address(0)) revert ZeroKeeper();
        if (ownerBalance_ < OWNER_MIN_BALANCE) revert OwnerBalanceBelowReserve();
        // Keep the additions below overflow-free; 0 would disable the top-up rate limit
        if (
            ownerBalance_ > type(uint128).max || keeperBalance_ > type(uint128).max || maxTopUp_ > type(uint128).max
                || topUpInterval_ == 0 || topUpInterval_ > type(uint64).max
        ) revert InvalidParams();
        self = address(this);
        keeper = keeper_;
        validatorId = validatorId_;
        ownerBalance = ownerBalance_;
        keeperBalance = keeperBalance_;
        maxTopUp = maxTopUp_;
        topUpInterval = topUpInterval_;
    }

    function compound() external {
        // Funds mistakenly sent to this contract itself must not be staked from here
        if (address(this) == self) revert NotDelegated();
        if (msg.sender != keeper) revert NotKeeper();

        // Events go before external calls; a failed call reverts them anyway
        emit Compounded(validatorId);

        // compound(uint64) returns (bool); precompile only accepts CALL
        (bool ok, bytes memory ret) = STAKING.call(abi.encodeWithSelector(0xb34fea67, validatorId));
        if (!ok || !_returnedTrue(ret)) revert CompoundFailed(ret);

        _topUpKeeper();
        _delegateExcess();
    }

    function lastTopUp() public view returns (uint256 blockNumber) {
        bytes32 slot = LAST_TOP_UP_SLOT;
        assembly {
            blockNumber := sload(slot)
        }
    }

    // Exactly one abi-encoded true. Anything else (e.g. empty data from an address without
    // code) must not pass as success, or value sent along with the call would be lost
    function _returnedTrue(bytes memory ret) private pure returns (bool) {
        return ret.length == 32 && abi.decode(ret, (bool));
    }

    function _topUpKeeper() private {
        uint256 balance = keeper.balance;
        if (balance >= keeperBalance) return;

        // The slot may hold anything an earlier delegate of this owner wrote; only a plausible
        // block number rate-limits, so a stale or hostile value can't brick compounding
        uint256 last = lastTopUp();
        if (last != 0 && last <= block.number && block.number - last < topUpInterval) return;

        uint256 amount = keeperBalance - balance;
        if (amount > maxTopUp) amount = maxTopUp;
        if (address(this).balance < OWNER_MIN_BALANCE + amount) return;

        bytes32 slot = LAST_TOP_UP_SLOT;
        assembly {
            sstore(slot, number())
        }
        // Follows the precompile call, which runs no user code and can't reenter
        // forge-lint: disable-start(reentrancy-events)
        (bool ok,) = keeper.call{value: amount}("");
        // A failed call returns the value; a keeper that can't receive (only possible with its
        // own key) must not block compounding, it just forfeits this interval
        if (ok) emit KeeperToppedUp(amount);
        else emit TopUpSkipped();
        // forge-lint: disable-end(reentrancy-events)
    }

    function _delegateExcess() private {
        uint256 balance = address(this).balance;
        if (balance < ownerBalance + MIN_DELEGATION) return;

        uint256 amount = balance - ownerBalance;
        uint256 forward = gasleft() > SKIP_GAS_RESERVE ? gasleft() - SKIP_GAS_RESERVE : 0;
        // delegate(uint64) payable returns (bool); the precompile is native code, its return data is bounded
        // forge-lint: disable-start(return-bomb)
        (bool ok, bytes memory ret) =
            STAKING.call{value: amount, gas: forward}(abi.encodeWithSelector(0x84994fec, validatorId));
        // forge-lint: disable-end(return-bomb)
        // A precompile revert (it always carries a reason) returns the value and must not cost
        // the owner its compound: the excess just stays liquid. Out of gas comes back empty and
        // reverts, so eth_estimateGas can't settle on a limit that starves delegate() every time.
        // A false without a revert would keep the value, so that one reverts too
        // forge-lint: disable-start(reentrancy-events)
        if (!ok) {
            if (ret.length == 0) revert DelegateFailed(ret);
            emit DelegateSkipped(ret);
            return;
        }
        if (!_returnedTrue(ret)) revert DelegateFailed(ret);
        emit Delegated(validatorId, amount);
        // forge-lint: disable-end(reentrancy-events)
    }

    // Without code the EOA accepted any call, with or without data; keep it that way
    receive() external payable {}

    fallback() external payable {}
}
