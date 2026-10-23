import { ethers } from 'ethers'
import { type DelegatorInfo, formatMon, getDelegator, getValidator } from './chain.js'
import { COMPOUND_GAS_MARGIN, DELEGATE_ABI } from './config.js'

// accRewardPerToken and commission scales in the staking precompile
const ACC_UNIT = 1e36
const COMMISSION_UNIT = 1e18
// How far back to look for the last compound; beyond that the time since it is estimated
const MAX_SCAN_EPOCHS = 16
// Rewards per block depend on how often the validator leads, which is noisy over a single epoch
const YIELD_EPOCHS = 8

const epochs = (n: number) => `${n} epoch${n === 1 ? '' : 's'}`

/** COMPOUND_EVERY: a whole number of epochs, or auto. Read at call time, `top` loads it from the server env */
export function compoundEvery(): number | 'auto' {
  const value = process.env.COMPOUND_EVERY || 'auto'
  if (value === 'auto') return value
  const epochs = Number(value)
  if (!Number.isInteger(epochs) || epochs < 1) throw new Error(`COMPOUND_EVERY must be auto or a whole number of epochs, got ${value}`)
  return epochs
}

export interface PlanInput {
  owner: string
  keeper: string
  validatorId: number
  /** Liquid balance the delegate leaves on the owner, the rest is staked at the compound */
  ownerKeeps: bigint
  head: number
  /** Block the upcoming compound window opens at, LEAD_BLOCKS before a boundary */
  window: number
  period: number
}

export interface Plan {
  window: number
  /** Epochs between compounds, fixed or picked by auto; null when auto has nothing to go on */
  every: number | null
  /** Compound at this window */
  due: boolean
  /** Window of the next compound */
  next: number
  note: string
}

const totalStake = (d: DelegatorInfo) => d.stake + d.pendingStake

/**
 * Whether to compound at the upcoming window. The last compound (or claim) is the last change of the
 * owner's stake or drop of its rewards in the RPC's state history; when it is older than the history,
 * the time since it is estimated from how fast rewards accrue.
 *
 * Compounding every n epochs costs a tx per n epochs, and leaves rewards accrued in the meantime
 * unstaked for (n - 1) / 2 epochs on average. Per epoch that is cost / n + y * R * (n - 1) / 2, with
 * R everything the owner accrues per epoch (own rewards, commission from other delegators when the
 * owner is the validator's auth address, fees sent to it) and y what one more staked MON earns the
 * owner per epoch: the delegators' rate, plus the commission on it when the commission comes back.
 * Minimum at n ≈ √(2 · cost / (y · R))
 */
export async function planCompound(provider: ethers.Provider, p: PlanInput): Promise<Plan> {
  const setting = compoundEvery()
  const plan = (every: number | null, due: boolean, note: string, wait = 1): Plan =>
    ({ window: p.window, every, due, next: due ? p.window : p.window + Math.max(1, wait) * p.period, note })
  if (setting === 1) return plan(1, true, 'every epoch')

  // Compounds land at windows, so sampling mid-epoch tells which window the last stake change was at
  const [ now, balance ] = await Promise.all([
    getDelegator(provider, p.validatorId, p.owner, p.head), provider.getBalance(p.owner, p.head),
  ])
  let since: number | null = null
  let oldest: { block: number; delegator: DelegatorInfo } | null = null
  let newer = now
  for (let j = 1; j <= MAX_SCAN_EPOCHS; j++) {
    const block = p.window - j * p.period + Math.floor(p.period / 2)
    if (block >= p.head) continue
    let past: DelegatorInfo
    try {
      past = await getDelegator(provider, p.validatorId, p.owner, block)
    } catch {
      break // beyond the RPC's state history
    }
    // A compound moves rewards into stake, a claim zeroes them; otherwise rewards only grow
    if (totalStake(past) !== totalStake(now) || past.rewards > newer.rewards) {
      since = j - 1
      break
    }
    oldest = { block, delegator: past }
    newer = past
  }
  if (since === 0) return plan(null, false, 'compounded or claimed this epoch, checking again at the next window')

  const accrued = now.rewards + (balance > p.ownerKeeps ? balance - p.ownerKeeps : 0n)
  const accruedMon = Number(ethers.formatEther(accrued))
  // R: since the last compound when it is in the history, otherwise over the history without one
  let R: number
  let epochsSince: number
  if (since !== null) {
    epochsSince = since
    R = accruedMon * p.period / (p.head - (p.window - since * p.period))
  } else if (oldest) {
    const pastBalance = await provider.getBalance(p.owner, oldest.block)
    const gained = now.rewards - oldest.delegator.rewards + (balance > pastBalance ? balance - pastBalance : 0n)
    R = Number(ethers.formatEther(gained)) * p.period / (p.head - oldest.block)
    // Nothing accrues any more (e.g. the stake was withdrawn): compound what is left, once
    if (!(R > 0)) return plan(null, true, `${formatMon(accrued)} left, nothing accrued over the state history`)
    epochsSince = Math.round(accruedMon / R)
  } else {
    return plan(null, true, 'RPC keeps no state history, compounding every epoch')
  }
  const beyond = since === null ? ' (the last compound is beyond state history)' : ''

  if (setting !== 'auto') {
    const note = `${since === null ? '~' : ''}${epochsSince} of ${epochs(setting)} since the last compound${beyond}`
    return plan(setting, epochsSince >= setting, note, setting - epochsSince)
  }

  const account = new ethers.Contract(p.owner, DELEGATE_ABI, provider)
  // Deepest block known to be in the history: the oldest sample, or the one that found the change
  const sampled = oldest?.block ?? p.window - (since! + 1) * p.period + Math.floor(p.period / 2)
  const yieldFrom = Math.min(sampled, p.head - YIELD_EPOCHS * p.period)
  const [ validatorNow, [ validatorThen, yieldStart ], gas, fee ] = await Promise.all([
    getValidator(provider, p.validatorId, p.head),
    getValidator(provider, p.validatorId, yieldFrom).then(v => [ v, yieldFrom ] as const)
      .catch(() => getValidator(provider, p.validatorId, sampled).then(v => [ v, sampled ] as const)),
    account.compound.estimateGas({ from: p.keeper }),
    provider.getFeeData(),
  ])

  const netYield = Number(validatorNow.accRewardPerToken - validatorThen.accRewardPerToken) / ACC_UNIT * p.period / (p.head - yieldStart)
  const commission = Number(validatorNow.commission) / COMMISSION_UNIT
  const y = validatorNow.authAddress === p.owner && commission < 1 ? netYield / (1 - commission) : netYield
  const cost = Number(ethers.formatEther((gas + COMPOUND_GAS_MARGIN) * (fee.gasPrice ?? fee.maxFeePerGas ?? 0n)))

  const stats = `${formatMon(accrued)} accrued in ${since === null ? '~' : ''}${epochs(epochsSince)}${beyond} (~${R.toLocaleString('en-US', { maximumFractionDigits: 4 })} MON/epoch), ` +
    `stake earns ${(y * 100).toPrecision(3)}%/epoch, compound costs ${cost.toFixed(4)} MON`
  if (!(y > 0) || !(R > 0)) return plan(null, false, `${stats}, nothing to gain, waiting`)

  const lossPerEpoch = (n: number) => cost / n + y * R * (n - 1) / 2
  const floor = Math.max(1, Math.floor(Math.sqrt(2 * cost / (y * R))))
  const every = lossPerEpoch(floor) <= lossPerEpoch(floor + 1) ? floor : floor + 1
  return plan(every, epochsSince >= every, `${stats} → every ${epochs(every)}`, every - epochsSince)
}
