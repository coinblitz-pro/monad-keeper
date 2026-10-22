import { ethers } from 'ethers'
import { walletFromSecret } from './signers.js'

export const STAKING_CONTRACT = '0x0000000000000000000000000000000000001000'
export const GET_DELEGATOR = '0x573c1ce0'
export const GET_EPOCH = '0x757991a8'
export const GET_DELEGATIONS = '0x4fd66050'
export const GET_VALIDATOR = '0x2b6d639a'
export const CLAIM_REWARDS = '0xa76e2ca5'

// Monad reverts any tx that takes a delegated (7702) EOA below this balance; the delegate keeps
// the owner at least 1 MON above it for its own transactions
export const DELEGATED_RESERVE = ethers.parseEther('10')
export const OWNER_MIN_BALANCE = DELEGATED_RESERVE + ethers.parseEther('1')

export const DELEGATE_ABI = [
  'function keeper() view returns (address)',
  'function validatorId() view returns (uint64)',
  'function ownerBalance() view returns (uint256)',
  'function keeperBalance() view returns (uint256)',
  'function lastTopUp() view returns (uint256)',
  'function compound()',
  'event DelegateSkipped(bytes reason)',
]

// CompoundDelegate constructor params (part of its CREATE2 address): after each compound the owner
// tops the keeper up to KEEPER_BALANCE, at most MAX_TOP_UP once per TOP_UP_INTERVAL blocks, then
// delegates its liquid balance above OWNER_BALANCE
export const OWNER_BALANCE = ethers.parseEther(process.env.OWNER_BALANCE_MON || '20')
export const KEEPER_BALANCE = ethers.parseEther(process.env.KEEPER_BALANCE_MON || '42')
// A compound costs ~0.07 MON at the minimum base fee (compound ≈ 290k gas, delegate ≈ 270k) and
// happens once per 50,000 blocks, so these bound what a leaked keeper key can pull from the owner
// (~1.4 MON a day) without starving a real one
export const MAX_TOP_UP = ethers.parseEther('0.2')
export const TOP_UP_INTERVAL = 40_000

// eth_estimateGas simulates with a zero gas price, so the keeper's balance isn't debited and the
// top-up branch is skipped; without a margin the real tx runs out of gas. Monad charges the limit,
// so this is ~0.01 MON per compound at the minimum base fee
export const COMPOUND_GAS_MARGIN = 100_000n
// Monad charges the whole limit, so a wrong estimate (or a lying RPC) must not cost more than this;
// a full compound with top-up and delegation measures ~660k
export const MAX_GAS_LIMIT = 1_000_000n
// Local clock, not RPC data: an RPC that fakes block numbers can't make the loop send more often
export const MIN_COMPOUND_INTERVAL_MS = 30 * 60_000
export const MAX_PRIORITY_FEE = ethers.parseUnits('50', 'gwei')
// A compound that hasn't landed by then is written off for this window instead of blocking the loop
export const CONFIRM_TIMEOUT_MS = 5 * 60_000
// Owner funds a one-time sender with this for the revoke tx; the remainder comes back
export const REVOKE_GAS_FUND = ethers.parseEther('0.1')

export const DERIVATION_PATH = process.env.DERIVATION_PATH || `44'/60'/0'/0/0`
export const MIN_REWARDS = ethers.parseEther(process.env.MIN_REWARDS_MON || '1')
// Staking changes are snapshotted every BOUNDARY_PERIOD blocks; compound lands LEAD_BLOCKS before that
export const BOUNDARY_PERIOD = parseInt(process.env.BOUNDARY_PERIOD || '50000', 10)
export const LEAD_BLOCKS = parseInt(process.env.LEAD_BLOCKS || '300', 10)

export function env(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`${name} is required (set it in .env or the environment)`)
    process.exit(1)
  }
  return value
}

export function getProvider(): ethers.JsonRpcProvider {
  // Monad public RPCs reject JSON-RPC batches ("Restricted JSON RPC method"). ethers also reuses
  // identical requests for 250 ms, which returns a stale nonce or code right after a fast block
  return new ethers.JsonRpcProvider(env('RPC_URL'), undefined, { batchMaxCount: 1, cacheTimeout: -1 })
}

export function getKeeper(provider: ethers.Provider): ethers.Wallet {
  return new ethers.Wallet(env('KEEPER_PRIVATE_KEY'), provider)
}

/** OWNER_ADDRESS, or derived from OWNER_SECRET when only the secret is set (testnet) */
export function getOwner(): string {
  if (!process.env.OWNER_ADDRESS && process.env.OWNER_SECRET) {
    return walletFromSecret(process.env.OWNER_SECRET, DERIVATION_PATH).address
  }
  return ethers.getAddress(env('OWNER_ADDRESS'))
}
