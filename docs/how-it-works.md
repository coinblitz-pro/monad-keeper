# How it works

## Delegation

Monad's staking precompile (`0x1000`) compounds rewards for `msg.sender` only, and there is no
operator role. With EIP-7702 the owner EOA can run contract code while staying an ordinary EOA:

1. `authorize` deploys [`CompoundDelegate`](../contracts/CompoundDelegate.sol), and the owner
   signs an authorization pointing at it. The keeper submits that authorization in a type-4
   transaction and pays the gas.
2. The owner's code becomes `0xef0100 || CompoundDelegate`. The keeper calls `compound()` on
   the owner's address, the code runs in the owner's context, and the precompile sees the owner
   as `msg.sender`.

Transactions the owner signs itself work exactly as before, including validator operations such
as `changeCommission`. Incoming transfers are accepted through `receive()`.

## Timing

Staking changes are snapshotted at boundary blocks every 50,000 blocks (~4 hours). A compound
before the boundary activates in the next epoch, and one after it waits an extra epoch.
Compounding more often than once per epoch gains nothing.

The keeper therefore compounds once per epoch, `LEAD_BLOCKS` (300) blocks before the boundary.
On chain, `getEpoch()` enters the delay period right after blocks numbered `≡ 49,999 mod 50,000`.
Before sending, the keeper checks `getEpoch()`. If the epoch is already in the delay period, it
skips this window and waits for the next one.

## Gas refund

Monad charges the full gas limit and refunds nothing after execution. So inside the transaction
the keeper's balance is already final, and the delegate tops it up to exactly `KEEPER_BALANCE_MON`
(42 by default). The top-up is bounded:

| Limit | Value |
|---|---|
| Per call | 0.2 MON, about 3× the cost of a compound at the minimum base fee |
| Frequency | once per 40,000 blocks, so once per epoch |
| Owner reserve | skipped if the owner would drop below 11 MON: the chain's 10 MON floor plus gas for its own transactions |

Top-ups come out of the owner's liquid balance, not its rewards: at the 100 gwei base fee a
compound costs ~0.04 MON, ~0.25 MON a day. If the owner is also the node's beneficiary, priority
fees cover that many times over. Otherwise, once the owner nears the 10 MON reserve, top-ups
stop and the keeper slowly spends its own balance.

## Staking the liquid balance

After the top-up, the delegate stakes the owner's liquid balance above `OWNER_BALANCE_MON`
(20 by default) with the same validator, if the excess is at least 1 MON. For a validator whose
beneficiary is the owner, that covers priority fees; `setup` relies on it to stake the claimed
rewards back.

The validator ID is fixed in the delegate when it is deployed, so neither `compound()` nor the
keeper can choose where the stake goes. If the precompile rejects the delegation, the compound
still goes through: the excess stays liquid, the delegate emits `DelegateSkipped` and the keeper
logs a warning. The precompile burns all forwarded gas when it reverts, so the delegate holds
back 30k gas for that path.

A compound costs about 0.07 MON at the minimum base fee: the precompile's `compound` takes
~290k gas and `delegate` ~270k. `eth_estimateGas` simulates with a zero gas price, so the top-up
branch doesn't run in the estimate. The keeper adds 100,000 gas on top, about 0.01 MON.
Because the whole limit is charged, the keeper refuses to send above 1M gas, caps the priority
fee at 50 gwei and never sends two compounds within 30 minutes by its own clock, so a wrong
estimate or an RPC that lies about blocks can't burn its balance quickly. Still, use your own node.

## Addresses

`CompoundDelegate` is deployed with CREATE2 through the
[deterministic deployment proxy](https://github.com/Arachnid/deterministic-deployment-proxy)
at `0x4e59…956c`. Its address is derived from the keeper, the validator ID, `OWNER_BALANCE_MON`
and the top-up parameters, so `authorize` deploys it once and reuses it after that. The keeper doesn't need the delegate's
address in its config: it reads the owner's code and calls only a delegate whose `keeper()` is
its own address.

## Threat model

| If leaked | Impact |
|---|---|
| Keeper key | The keeper's own balance (`KEEPER_BALANCE_MON`) is lost outright. The attacker can trigger compounds at any time, which is harmless, and stake the owner's liquid balance above `OWNER_BALANCE_MON` with your validator before you spend it: not a loss, but locked until you undelegate and withdraw. They can pull up to 0.2 MON from the owner per 40,000 blocks (~1.4 MON a day), and stall compounding, until you `revoke` or re-authorize a new keeper |
| Server | Same as the keeper key. The owner key is never on the server |
| Owner key | Full control, unchanged by this project |

Monad specifics to keep in mind:

- A 7702-delegated EOA can't drop below 10 MON. Any transaction that would take it lower
  reverts, so keep at least 10 MON on the owner, plus whatever you plan to spend.
- While delegated, the owner has code (`EXTCODESIZE` is 23), so contracts that treat accounts
  with code differently (`isContract` checks, NFT `safeTransfer`) see a contract. Plain transfers
  and calls with data are accepted as before.
- `revoke` doesn't touch the keeper key: a one-time key funded with 0.1 MON by the owner submits
  the revocation and returns the remainder, so a leaked keeper key can't get in the way. If the
  return itself fails, the CLI prints that key so the MON can be swept by hand.
- MON sent to the `CompoundDelegate` address itself (not the owner) is stuck: the contract has no
  rescue path, and `compound()` refuses to run there. To
  rotate the keeper after a leak: `revoke`, `keygen --force`, then `setup` (the owner keeps only
  `OWNER_BALANCE_MON` liquid, so funding a new keeper means claiming rewards first).
