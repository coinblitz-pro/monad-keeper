import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { ethers } from 'ethers'
import {
  type DelegatorInfo,
  formatMon,
  getBlockTimeMs,
  getDelegationTarget,
  getDelegator,
  getEpoch,
  nextBoundary,
  resolveValidatorId,
} from './chain.js'
import { DELEGATE_ABI, env, getOwner, getProvider } from './config.js'
import { compoundEvery, type Plan, planCompound } from './plan.js'

// Read-only dashboard: chain state plus the service's journal. Needs no keys, only RPC_URL and
// OWNER_ADDRESS, so on the server it can run as any user that can read them

// public.env is world-readable, env holds the key and is root-only; older installs keep everything in env
const SERVER_ENV_FILES = [ '/etc/monad-keeper/public.env', '/etc/monad-keeper/env' ]
const PUBLIC_SETTINGS = [ 'RPC_URL', 'OWNER_ADDRESS', 'BOUNDARY_PERIOD', 'LEAD_BLOCKS', 'COMPOUND_EVERY' ]
const SERVICE = 'monad-keeper'
const REFRESH_MS = 3_000
const BLOCK_TIME_REFRESH_MS = 5 * 60_000
// The plan reads a few epochs of state history, so it is refreshed rarely
const PLAN_REFRESH_MS = 5 * 60_000

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
}

interface Delegate {
  address: string
  keeper: string
  /** null for an older CompoundDelegate build without these getters */
  validatorId: number | null
  ownerKeeps: bigint | null
  keeperTarget: bigint | null
  lastTopUp: bigint | null
}

interface Snapshot {
  at: number
  head: number
  epoch: bigint
  inDelayPeriod: boolean
  ownerBalance: bigint
  delegate: Delegate | null
  keeperBalance: bigint | null
  validatorId: number
  delegator: DelegatorInfo
}

interface Service {
  state: string
  since: Date | null
}

/** On the server the config is in the systemd env files; only the public settings are taken from them */
function loadServerSettings() {
  for (const file of SERVER_ENV_FILES) {
    if (process.env.RPC_URL && (process.env.OWNER_ADDRESS || process.env.OWNER_SECRET)) return
    let text: string
    try {
      text = readFileSync(file, 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
      if (!match || !PUBLIC_SETTINGS.includes(match[1]) || process.env[match[1]]) continue
      process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2')
    }
  }
}

async function readDelegate(provider: ethers.Provider, owner: string, address: string): Promise<Delegate | null> {
  const keeper = await new ethers.Contract(address, DELEGATE_ABI, provider).keeper().catch(() => null)
  if (!keeper) return null
  const account = new ethers.Contract(owner, DELEGATE_ABI, provider)
  const params = await Promise.all([
    account.validatorId(), account.ownerBalance(), account.keeperBalance(), account.lastTopUp(),
  ]).catch(() => null)
  return {
    address,
    keeper,
    validatorId: params ? Number(params[0]) : null,
    ownerKeeps: params?.[1] ?? null,
    keeperTarget: params?.[2] ?? null,
    lastTopUp: params?.[3] ?? null,
  }
}

async function readSnapshot(provider: ethers.Provider, owner: string, fallbackValidator: () => Promise<number>): Promise<Snapshot> {
  const [ head, { epoch, inDelayPeriod }, ownerBalance, target ] = await Promise.all([
    provider.getBlockNumber(), getEpoch(provider), provider.getBalance(owner), getDelegationTarget(provider, owner),
  ])
  const delegate = target ? await readDelegate(provider, owner, target) : null
  const validatorId = delegate?.validatorId ?? await fallbackValidator()
  const [ keeperBalance, delegator ] = await Promise.all([
    delegate ? provider.getBalance(delegate.keeper) : null,
    getDelegator(provider, validatorId, owner),
  ])
  return { at: Date.now(), head, epoch, inDelayPeriod, ownerBalance, delegate, keeperBalance, validatorId, delegator }
}

function readService(): Service | null {
  const result = spawnSync('systemctl', [ 'show', SERVICE, '-p', 'ActiveState,SubState,ActiveEnterTimestamp' ], { encoding: 'utf-8' })
  if (result.status !== 0 || !result.stdout) return null
  const props = Object.fromEntries(result.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)))
  if (props.ActiveState === undefined) return null
  const since = props.ActiveEnterTimestamp ? new Date(props.ActiveEnterTimestamp.replace(/^\w+ /, '').replace(/ \w+$/, '')) : null
  return { state: `${props.ActiveState}${props.SubState && props.SubState !== props.ActiveState ? ` (${props.SubState})` : ''}`, since }
}

/** Last service log lines as [time, message]; a string explains why there are none */
function readJournal(lines: number): [ string, string ][] | string {
  const result = spawnSync('journalctl', [ '-u', SERVICE, '-n', String(lines), '-o', 'short-iso', '--no-pager', '-q' ], { encoding: 'utf-8' })
  if (result.error) return 'journalctl not available here'
  if (result.status !== 0) return `No access to the journal of ${SERVICE} (run as root or a member of systemd-journal)`
  return result.stdout.split('\n').filter(Boolean).map(line => {
    const match = line.match(/^(\S+) \S+ [^:]+: (?:\[[^\]]+\] )?(.*)$/)
    if (!match) return [ '', line ]
    const time = new Date(match[1])
    return [ isNaN(time.getTime()) ? match[1] : `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock(time)}`, match[2] ]
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`
const blocks = (n: number) => n.toLocaleString('en-US')

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${pad(s % 60)}s`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${pad(m % 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Cuts a line to the terminal width without breaking color codes */
function fit(line: string, width: number): string {
  let visible = 0
  let out = ''
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\x1b') {
      const end = line.indexOf('m', i)
      out += line.slice(i, end + 1)
      i = end
      continue
    }
    if (visible === width) return out + '\x1b[0m'
    out += line[i]
    visible++
  }
  return out
}

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return c.cyan('█'.repeat(filled)) + c.dim('░'.repeat(width - filled))
}

interface View {
  snapshot: Snapshot | null
  error: string | null
  plan: Plan | null
  planAt: number
  planError: string | null
  blockTimeMs: number
  chainId: bigint
  owner: string
  rpc: string
  period: number
  lead: number
}

function render(view: View): string[] {
  const { snapshot: s, period, lead, blockTimeMs } = view
  const width = process.stdout.columns || 80
  const height = process.stdout.rows || 30
  const label = (text: string) => c.dim(text.padEnd(12))
  const lines: string[] = []

  const now = new Date()
  const title = `${c.bold('monad-keeper')}  ${c.dim(`chain ${view.chainId} · ${view.rpc}`)}`
  lines.push(`${title}${' '.repeat(Math.max(1, width - 14 - `chain ${view.chainId} · ${view.rpc}`.length - 8))}${clock(now)}`)
  lines.push(c.dim('─'.repeat(width)))

  const service = readService()
  if (!service) {
    lines.push(`${label('Service')}${c.dim('systemd not available here')}`)
  } else {
    const color = service.state.startsWith('active') ? c.green : service.state.startsWith('activating') ? c.yellow : c.red
    const since = service.since && !isNaN(service.since.getTime()) ? c.dim(`  since ${service.since.toLocaleString('en-GB')} (${duration(now.getTime() - service.since.getTime())})`) : ''
    lines.push(`${label('Service')}${color(service.state)}${since}`)
  }

  if (!s) {
    lines.push('', view.error ? c.red(view.error) : c.dim('Loading...'))
    return lines.map(line => fit(line, width))
  }

  // Blocks keep coming between refreshes; extrapolate so the countdown moves every second
  const elapsedBlocks = Math.floor((Date.now() - s.at) / blockTimeMs)
  const head = s.head + elapsedBlocks
  const boundary = nextBoundary(head, period)
  const windowStart = boundary - lead
  const progress = ((head + 1) % period) / period

  lines.push(`${label('Block')}${blocks(head)}   ${c.dim('epoch')} ${s.epoch}${s.inDelayPeriod ? c.yellow('  (delay period)') : ''}   ${c.dim(`${blockTimeMs.toFixed(0)} ms/block`)}`)
  // A plan made for an earlier window is stale until the next refresh
  const plan = view.plan?.window === windowStart ? view.plan : null
  const next = plan && !plan.due ? plan.next : windowStart
  if (head < next) {
    lines.push(`${label('Next')}compound at ${blocks(next)} ${c.dim(`(boundary ${blocks(next + lead)})`)}  in ${c.bold(duration((next - head) * blockTimeMs))}`)
  } else {
    lines.push(`${label('Next')}${c.green('window open')}, boundary ${blocks(boundary)} in ${blocks(boundary - head)} blocks`)
  }
  lines.push(`${label('')}${bar(progress, Math.min(40, width - 22))} ${c.dim(`${Math.floor(progress * 100)}% of epoch`)}`)
  lines.push('')

  const d = s.delegate
  const ownerColor = s.ownerBalance < ethers.parseEther('11') ? c.yellow : (x: string) => x
  let delegation: string
  if (!d) delegation = c.red('not delegated')
  else if (d.validatorId === null) delegation = c.yellow(`→ ${short(d.address)} (older build, run authorize)`)
  else delegation = c.green(`→ ${short(d.address)}`)
  lines.push(`${label('Owner')}${short(view.owner)}   ${ownerColor(formatMon(s.ownerBalance))}   ${delegation}`)

  const pending = s.delegator.pendingStake > 0n ? `   ${c.cyan(`+${formatMon(s.delegator.pendingStake)}`)} ${c.dim('activating')}` : ''
  lines.push(`${label('Stake')}${formatMon(s.delegator.stake)} ${c.dim(`on validator ${s.validatorId}`)}${pending}`)
  lines.push(`${label('Rewards')}${formatMon(s.delegator.rewards)} ${c.dim('pending compound')}`)

  if (d && s.keeperBalance !== null) {
    const low = d.keeperTarget !== null && s.keeperBalance + ethers.parseEther('0.5') < d.keeperTarget
    let topUp = ''
    if (d.lastTopUp) {
      const ago = s.head - Number(d.lastTopUp)
      topUp = c.dim(`   last top-up ${blocks(ago)} blocks ago (~${duration(ago * blockTimeMs)})`)
    }
    lines.push(`${label('Keeper')}${short(d.keeper)}   ${(low ? c.yellow : (x: string) => x)(formatMon(s.keeperBalance))}${topUp}`)
  }
  if (d?.ownerKeeps != null && d.keeperTarget != null) {
    lines.push(`${label('Policy')}${c.dim(`owner keeps ${formatMon(d.ownerKeeps)}, the rest is staked; keeper refilled to ${formatMon(d.keeperTarget)}`)}`)
  }
  const every = compoundEvery()
  const interval = plan?.every ? `every ${plan.every} epoch${plan.every === 1 ? '' : 's'}${every === 'auto' ? ' (auto)' : ''}` : every === 'auto' ? 'auto' : `every ${every} epochs`
  lines.push(`${label('Interval')}${interval}`)
  if (every !== 1) lines.push(`${label('')}${plan ? c.dim(plan.note) : view.planError ? c.red(view.planError) : c.dim('estimating...')}`)
  if (view.error) lines.push(c.red(`RPC error: ${view.error} (showing data from ${duration(Date.now() - s.at)} ago)`))

  lines.push('')
  const logRows = Math.max(3, height - lines.length - 2)
  lines.push(`${c.dim('Log ')}${c.dim('─'.repeat(Math.max(0, width - 4)))}`)
  const journal = readJournal(logRows)
  if (typeof journal === 'string') {
    lines.push(c.dim(journal))
  } else if (journal.length === 0) {
    // Without access journalctl just shows nothing instead of failing
    const privileged = process.getuid?.() === 0 || /\bsystemd-journal\b|\badm\b/.test(spawnSync('id', [ '-Gn' ], { encoding: 'utf-8' }).stdout ?? '')
    lines.push(c.dim(privileged ? 'No log entries yet' : `Log hidden: run as root or add this user to systemd-journal`))
  } else {
    for (const [ time, message ] of journal) {
      const color = /error/i.test(message) ? c.red : /warning|skip/i.test(message) ? c.yellow : /Confirmed|Compound /.test(message) ? c.green : (x: string) => x
      lines.push(`${c.dim(time)}  ${color(message)}`)
    }
  }
  lines.push(...Array(Math.max(0, height - lines.length - 1)).fill(''))
  lines.push(c.dim('q quit · r refresh'))
  return lines.slice(0, height).map(line => fit(line, width))
}

/** Moves every thread of this process onto the service's cores, off the node's caches and interrupts */
function pinToServiceCpus() {
  if (process.platform !== 'linux') return
  const cpus = spawnSync('systemctl', [ 'show', SERVICE, '-p', 'CPUAffinity', '--value' ], { encoding: 'utf-8' }).stdout?.trim()
  if (cpus) spawnSync('taskset', [ '-a', '-cp', cpus.replace(/ /g, ','), String(process.pid) ], { stdio: 'ignore' })
}

export async function topCommand() {
  pinToServiceCpus()
  loadServerSettings()
  compoundEvery() // fails on a bad COMPOUND_EVERY before the screen is taken over
  const provider = getProvider()
  const owner = getOwner()
  const period = parseInt(process.env.BOUNDARY_PERIOD || '50000', 10)
  const lead = parseInt(process.env.LEAD_BLOCKS || '300', 10)
  const rpc = env('RPC_URL').replace(/^https?:\/\//, '')
  const { chainId } = await provider.getNetwork()

  let validatorId: number | null = null
  const fallbackValidator = async () => validatorId ??= await resolveValidatorId(provider, owner)

  const view: View = { snapshot: null, error: null, plan: null, planAt: 0, planError: null, blockTimeMs: 400, chainId, owner, rpc, period, lead }
  const draw = () => process.stdout.write('\x1b[H' + render(view).join('\x1b[K\n') + '\x1b[K\x1b[J')

  let refreshing = false
  const refresh = async () => {
    if (refreshing) return
    refreshing = true
    try {
      view.snapshot = await readSnapshot(provider, owner, fallbackValidator)
      view.error = null
      await refreshPlan(view.snapshot)
    } catch (e: any) {
      view.error = e.shortMessage ?? e.message
    } finally {
      refreshing = false
    }
    draw()
  }
  const refreshPlan = async (s: Snapshot) => {
    const window = nextBoundary(s.head, period) - lead
    const d = s.delegate
    if (!d || d.ownerKeeps === null) return
    if (view.plan?.window === window && Date.now() - view.planAt < PLAN_REFRESH_MS) return
    view.planAt = Date.now()
    try {
      view.plan = await planCompound(provider, {
        owner, keeper: d.keeper, validatorId: s.validatorId, ownerKeeps: d.ownerKeeps, head: s.head, window, period,
      })
      view.planError = null
    } catch (e: any) {
      view.planError = e.shortMessage ?? e.message
    }
  }
  const refreshBlockTime = async () => {
    view.blockTimeMs = await getBlockTimeMs(provider).catch(() => view.blockTimeMs)
  }

  const exit = () => {
    process.stdout.write('\x1b[?25h\x1b[?1049l')
    process.exit(0)
  }
  process.stdout.write('\x1b[?1049h\x1b[?25l')
  process.on('SIGINT', exit)
  process.on('SIGTERM', exit)
  process.stdout.on('resize', draw)
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.on('data', key => {
      const k = key.toString()
      if (k === 'q' || k === '\x03') exit()
      if (k === 'r') refresh()
    })
  }

  draw()
  await Promise.all([ refreshBlockTime(), refresh() ])
  setInterval(refresh, REFRESH_MS)
  setInterval(refreshBlockTime, BLOCK_TIME_REFRESH_MS)
  setInterval(draw, 1_000)
}
