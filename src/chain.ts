import { AbiCoder, ethers } from 'ethers'
import { GET_DELEGATIONS, GET_DELEGATOR, GET_EPOCH, GET_VALIDATOR, STAKING_CONTRACT } from './config.js'

const abiCoder = AbiCoder.defaultAbiCoder()

// EIP-7702 delegation designator: 0xef0100 || address
const DESIGNATOR_PREFIX = '0xef0100'

export interface DelegatorInfo {
  stake: bigint
  rewards: bigint
  /** Delegated or compounded, activates at the next snapshots */
  pendingStake: bigint
}

export async function getDelegator(provider: ethers.Provider, validatorId: number, delegator: string, blockTag?: number): Promise<DelegatorInfo> {
  const data = GET_DELEGATOR + abiCoder.encode([ 'uint64', 'address' ], [ validatorId, delegator ]).slice(2)
  const result = await provider.call({ to: STAKING_CONTRACT, data, blockTag })
  // stake, accRewardPerToken, unclaimedRewards, deltaStake, nextDeltaStake, deltaEpoch, nextDeltaEpoch
  const decoded = abiCoder.decode([ 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint64', 'uint64' ], result)
  return { stake: decoded[0], rewards: decoded[2], pendingStake: decoded[3] + decoded[4] }
}

export async function getRewards(provider: ethers.Provider, validatorId: number, delegator: string): Promise<bigint> {
  return (await getDelegator(provider, validatorId, delegator)).rewards
}

async function getDelegations(provider: ethers.Provider, delegator: string): Promise<number[]> {
  const ids: number[] = []
  let start = 0n
  while (true) {
    const data = GET_DELEGATIONS + abiCoder.encode([ 'address', 'uint64' ], [ delegator, start ]).slice(2)
    const [ isDone, nextValId, valIds ] = abiCoder.decode([ 'bool', 'uint64', 'uint64[]' ], await provider.call({ to: STAKING_CONTRACT, data }))
    ids.push(...valIds.map(Number))
    if (isDone) return ids
    start = nextValId
  }
}

export interface ValidatorInfo {
  authAddress: string
  /** Delegators' reward per staked token since genesis, after commission, scaled by 1e36 */
  accRewardPerToken: bigint
  /** Share of rewards the auth address takes from every delegator, scaled by 1e18 */
  commission: bigint
}

export async function getValidator(provider: ethers.Provider, validatorId: number, blockTag?: number): Promise<ValidatorInfo> {
  const data = GET_VALIDATOR + abiCoder.encode([ 'uint64' ], [ validatorId ]).slice(2)
  // authAddress, flags, stake, accRewardPerToken, commission, ...
  const [ authAddress, , , accRewardPerToken, commission ] = abiCoder.decode(
    [ 'address', 'uint64', 'uint256', 'uint256', 'uint256' ], await provider.call({ to: STAKING_CONTRACT, data, blockTag }))
  return { authAddress, accRewardPerToken, commission }
}

/**
 * VALIDATOR_ID from env, otherwise detected from the owner's delegations:
 * the only one, or the validator whose auth address is the owner
 */
export async function resolveValidatorId(provider: ethers.Provider, owner: string): Promise<number> {
  if (process.env.VALIDATOR_ID) return parseInt(process.env.VALIDATOR_ID, 10)

  const ids = await getDelegations(provider, owner)
  if (ids.length === 1) return ids[0]
  for (const id of ids) {
    if ((await getValidator(provider, id)).authAddress === owner) return id
  }
  throw new Error(ids.length === 0
    ? `${owner} has no delegations, set VALIDATOR_ID`
    : `${owner} delegates to validators ${ids.join(', ')}, set VALIDATOR_ID`)
}

export async function getEpoch(provider: ethers.Provider): Promise<{ epoch: bigint; inDelayPeriod: boolean }> {
  const result = await provider.call({ to: STAKING_CONTRACT, data: GET_EPOCH })
  const [ epoch, inDelayPeriod ] = abiCoder.decode([ 'uint64', 'bool' ], result)
  return { epoch, inDelayPeriod }
}

/**
 * Last block before the next staking snapshot. Observed on testnet: getEpoch() flips to the
 * delay period right after blocks ≡ BOUNDARY_PERIOD - 1, so a compound must land before it
 */
export function nextBoundary(head: number, period: number): number {
  return (Math.floor((head + 1) / period) + 1) * period - 1
}

export async function getBlockTimeMs(provider: ethers.Provider, sample = 10_000): Promise<number> {
  const head = await provider.getBlock('latest')
  const past = await provider.getBlock(head!.number - sample)
  return (head!.timestamp - past!.timestamp) * 1000 / sample
}

/** Returns the 7702 delegate of an EOA, null if it has no code */
export async function getDelegationTarget(provider: ethers.Provider, address: string): Promise<string | null> {
  const code = await provider.getCode(address)
  if (code === '0x') return null
  if (!code.startsWith(DESIGNATOR_PREFIX) || code.length !== 2 + 23 * 2) {
    throw new Error(`${address} has non-7702 code: ${code.slice(0, 20)}...`)
  }
  return ethers.getAddress('0x' + code.slice(DESIGNATOR_PREFIX.length))
}

export function formatMon(wei: bigint): string {
  return `${Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} MON`
}

export function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}
