import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { ethers } from 'ethers'
import {
  type DelegatorInfo,
  getBlockTimeMs,
  getDelegationTarget,
  getDelegator,
  getEpoch,
  nextBoundary,
  resolveValidatorId,
} from './chain.js'
import { DELEGATE_ABI, env, getOwner, getProvider, OWNER_MIN_BALANCE } from './config.js'
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
// Log lines read to fill the screen once the heartbeat is dropped: a few days of it
const JOURNAL_SCAN = 1_000

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
  active: string
  sub: string
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
  return { active: props.ActiveState, sub: props.SubState ?? '', since }
}

let journal: { at: number; entries: [ string, string ][] | string } | null = null

/** systemd's own lines about the unit: starts, stops and failures, without the rest of its chatter */
function systemdMessage(message: string): string | null {
  if (message.startsWith('Started ')) return 'Service started'
  if (message.startsWith('Stopped ')) return 'Service stopped'
  if (/FAILURE|Failed with result/.test(message)) return `Error: ${message.replace(`${SERVICE}.service: `, '')}`
  return null
}

/**
 * Recent service log lines as [time, message], without the keeper's "Next window" heartbeat that
 * would push the compounds off the screen; a string explains why there are none
 */
function readJournal(): [ string, string ][] | string {
  if (journal && Date.now() - journal.at < REFRESH_MS) return journal.entries
  const result = spawnSync('journalctl', [ '-u', SERVICE, '-n', String(JOURNAL_SCAN), '-o', 'short-iso', '--no-pager', '-q' ], { encoding: 'utf-8' })
  let entries: [ string, string ][] | string
  if (result.error) entries = 'journalctl not available here'
  else if (result.status !== 0) entries = `No access to the journal of ${SERVICE} (run as root or a member of systemd-journal)`
  else entries = result.stdout.split('\n').filter(Boolean).flatMap((line): [ string, string ][] => {
    const match = line.match(/^(\S+) \S+ ([^:\[]+)(?:\[\d+\])?: (?:\[[^\]]+\] )?(.*)$/)
    if (!match) return [ [ '', line ] ]
    const message = match[2] === 'systemd' ? systemdMessage(match[3]) : match[3]
    if (message === null || message.startsWith('Next window')) return []
    const time = new Date(match[1])
    return [ [ isNaN(time.getTime()) ? match[1] : `${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${clock(time)}`, message ] ]
  })
  journal = { at: Date.now(), entries }
  return entries
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

const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '').length
const epochs = (n: number) => `${n} epoch${n === 1 ? '' : 's'}`
const mon = (wei: bigint) => `${Number(ethers.formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 4 })} ${c.dim('MON')}`

function bar(fraction: number, width: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, fraction)) * width)
  return c.cyan('█'.repeat(filled)) + c.dim('░'.repeat(width - filled))
}

type Row = [ label: string, value: string ]

/** A group of values in a rounded box with its title in the top edge */
interface Panel {
  title: string
  rows: Row[]
}

// Space between a label and its value
const GAP = 2
// Widest each panel has been, so a value gaining a digit does not shift the panels to its right on
// every frame; forgotten when the terminal width changes
const widest = { cols: 0, inner: new Map<string, number>() }

const labelWidth = (p: Panel) => Math.max(0, ...p.rows.map(([ label ]) => label.length))

function box(p: Panel, height: number, inner: number): string[] {
  const labelW = labelWidth(p)
  const lines = [ c.dim('╭─ ') + c.cyan(p.title) + c.dim(` ${'─'.repeat(inner - p.title.length - 1)}╮`) ]
  for (let i = 0; i < height; i++) {
    const row = p.rows[i]
    const content = row
      ? c.dim(row[0].padEnd(labelW)) + ' '.repeat(GAP) + row[1] + ' '.repeat(inner - labelW - GAP - visLen(row[1]))
      : ' '.repeat(inner)
    lines.push(c.dim('│ ') + content + c.dim(' │'))
  }
  lines.push(c.dim(`╰${'─'.repeat(inner + 2)}╯`))
  return lines
}

/** Panels side by side, wrapping onto another band when the terminal is narrow */
function layout(panels: Panel[], cols: number): string[] {
  if (widest.cols !== cols) {
    widest.cols = cols
    widest.inner.clear()
  }
  const inner = panels.map(p => {
    const width = Math.max(labelWidth(p) + GAP + Math.max(0, ...p.rows.map(([ , value ]) => visLen(value))), p.title.length + 2, widest.inner.get(p.title) ?? 0)
    widest.inner.set(p.title, width)
    return width
  })
  const lines: string[] = []
  for (let start = 0; start < panels.length;) {
    let end = start + 1
    let width = inner[start] + 4
    while (end < panels.length && width + 1 + inner[end] + 4 <= cols) width += 1 + inner[end++] + 4
    const band = panels.slice(start, end)
    const height = Math.max(...band.map(p => p.rows.length))
    const boxes = band.map((p, i) => box(p, height, inner[start + i]))
    for (let i = 0; i < height + 2; i++) lines.push(boxes.map(b => b[i]).join(' '))
    start = end
  }
  return lines
}

function logIcon(message: string): string {
  if (message.startsWith('Error')) return c.red('✗')
  if (message.startsWith('Warning')) return c.yellow('▲')
  if (message.startsWith('Confirmed')) return c.green('✓')
  if (message.startsWith('Compound ')) return c.cyan('↑')
  return c.dim('·')
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

function panels(view: View, s: Snapshot): Panel[] {
  const { period, lead, blockTimeMs } = view
  // Blocks keep coming between refreshes; extrapolate so the countdown moves every second
  const head = s.head + Math.floor((Date.now() - s.at) / blockTimeMs)
  const boundary = nextBoundary(head, period)
  const windowStart = boundary - lead
  const progress = ((head + 1) % period) / period

  const epoch: Row[] = [
    [ 'block', blocks(head) ],
    [ 'epoch', `${s.epoch}${s.inDelayPeriod ? c.yellow(' delay period') : ''}` ],
    [ 'progress', `${bar(progress, 16)} ${Math.floor(progress * 100)}%` ],
    [ 'boundary', `in ${duration((boundary - head) * blockTimeMs)}` ],
    [ 'pace', `${blockTimeMs.toFixed(0)} ${c.dim('ms/block')}` ],
  ]

  // A plan made for an earlier window is stale until the next refresh
  const plan = view.plan?.window === windowStart ? view.plan : null
  const next = plan && !plan.due ? plan.next : windowStart
  const every = compoundEvery()
  const auto = every === 'auto' ? c.dim(' auto') : ''
  const compound: Row[] = [
    [ 'next', head < next ? `in ${c.bold(duration((next - head) * blockTimeMs))}` : c.green('window open') ],
    [ 'at', blocks(next) ],
    [ 'interval', plan?.every ? `every ${epochs(plan.every)}${auto}` : every === 'auto' ? 'auto' : `every ${epochs(every)}` ],
  ]
  const stats = plan?.stats
  if (stats) {
    compound.push([ 'last', stats.epochsSince === 0 ? 'this epoch' : `${stats.estimated ? '~' : ''}${epochs(stats.epochsSince)} ago` ])
    compound.push([ 'accrues', `${stats.perEpoch.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${c.dim('MON/epoch')}` ])
    if (stats.stakeYield !== undefined) compound.push([ 'yield', `${(stats.stakeYield * 100).toPrecision(3)}%${c.dim('/epoch')}` ])
    if (stats.cost !== undefined) compound.push([ 'tx cost', `${stats.cost.toFixed(4)} ${c.dim('MON')}` ])
  } else if (plan && plan.every !== 1) {
    compound.push([ 'plan', plan.note ])
  } else if (!plan && every !== 1) {
    compound.push([ 'plan', view.planError ? c.red('failed') : c.dim('estimating…') ])
  }

  const d = s.delegate
  const owner: Row[] = [
    [ 'address', short(view.owner) ],
    [ 'balance', s.ownerBalance < OWNER_MIN_BALANCE ? c.yellow(mon(s.ownerBalance)) : mon(s.ownerBalance) ],
  ]
  if (d?.ownerKeeps != null) owner.push([ 'keeps', mon(d.ownerKeeps) ])
  owner.push([ 'stake', mon(s.delegator.stake) ])
  if (s.delegator.pendingStake > 0n) owner.push([ 'activating', c.cyan(`+${mon(s.delegator.pendingStake)}`) ])
  owner.push([ 'rewards', mon(s.delegator.rewards) ])
  owner.push([ 'delegate', !d ? c.red('none') : d.validatorId === null ? c.yellow(`${short(d.address)} older build`) : c.green(`→ ${short(d.address)}`) ])

  const result = [ { title: 'epoch', rows: epoch }, { title: 'compound', rows: compound }, { title: 'owner', rows: owner } ]
  if (d && s.keeperBalance !== null) {
    const low = d.keeperTarget !== null && s.keeperBalance + ethers.parseEther('0.5') < d.keeperTarget
    const keeper: Row[] = [ [ 'address', short(d.keeper) ], [ 'balance', low ? c.yellow(mon(s.keeperBalance)) : mon(s.keeperBalance) ] ]
    if (d.keeperTarget !== null) keeper.push([ 'target', mon(d.keeperTarget) ])
    if (d.lastTopUp !== null) keeper.push([ 'top-up', d.lastTopUp ? `${duration((s.head - Number(d.lastTopUp)) * blockTimeMs)} ago` : c.dim('never') ])
    result.push({ title: 'keeper', rows: keeper })
  }
  return result
}

/** One line: everything fine, or what needs attention */
function status(view: View, service: Service | null): string {
  const s = view.snapshot
  const crit: string[] = []
  const warn: string[] = []
  if (view.error) crit.push(`RPC: ${view.error}${s ? ` (data from ${duration(Date.now() - s.at)} ago)` : ''}`)
  if (service && service.active !== 'active') {
    (service.active === 'activating' ? warn : crit).push(`service ${service.active}${service.sub && service.sub !== service.active ? ` (${service.sub})` : ''}`)
  }
  const d = s?.delegate
  if (s && !d) crit.push('owner is not delegated, run authorize')
  if (d && d.validatorId === null) warn.push('older delegate build, run authorize')
  if (s && d && s.keeperBalance !== null && d.keeperTarget !== null && s.keeperBalance + ethers.parseEther('0.5') < d.keeperTarget) warn.push('keeper balance low')
  if (s && s.ownerBalance < OWNER_MIN_BALANCE) warn.push(`owner balance below ${Number(ethers.formatEther(OWNER_MIN_BALANCE))} MON`)
  if (view.planError) warn.push(`plan: ${view.planError}`)
  const problems = [ ...crit, ...warn ].join(c.dim(' · '))
  if (crit.length) return `${c.red('● CRITICAL')}  ${problems}`
  if (warn.length) return `${c.yellow('▲ WARNING')}  ${problems}`
  return s ? c.green('● OK') : c.dim('● loading…')
}

function render(view: View): string[] {
  const s = view.snapshot
  const width = process.stdout.columns || 80
  const height = process.stdout.rows || 30
  const now = new Date()
  const service = readService()

  const about = [ `chain ${view.chainId}`, view.rpc ]
  if (s) about.push(`validator ${s.validatorId}`)
  if (service) {
    const up = service.since && !isNaN(service.since.getTime()) ? ` ${duration(now.getTime() - service.since.getTime())}` : ''
    about.push(`service ${service.active}${up}`)
  }
  const lines = [ `${c.cyan('monad-keeper')}  ${c.dim(clock(now))}  ${c.dim(about.join(' · '))}`, '' ]
  if (s) lines.push(...layout(panels(view, s), width), '')
  lines.push(status(view, service), '')

  // The log takes the rest of the screen, the footer the last row
  const logRows = height - lines.length - 3
  if (logRows > 0) {
    lines.push(c.dim('Recent log'))
    const journal = readJournal()
    if (typeof journal === 'string') {
      lines.push(c.dim(journal))
    } else if (journal.length === 0) {
      // Without access journalctl just shows nothing instead of failing
      const privileged = process.getuid?.() === 0 || /\bsystemd-journal\b|\badm\b/.test(spawnSync('id', [ '-Gn' ], { encoding: 'utf-8' }).stdout ?? '')
      lines.push(c.dim(privileged ? 'No log entries yet' : 'Log hidden: run as root or add this user to systemd-journal'))
    } else {
      for (const [ time, message ] of journal.slice(-logRows)) {
        const text = /^(Skip|Plan)/.test(message) ? c.dim(message) : message
        lines.push(`${c.dim(time)} ${logIcon(message)} ${text}`)
      }
    }
  }
  const body = lines.slice(0, height - 1)
  body.push(...Array(Math.max(0, height - 1 - body.length)).fill(''), c.dim('q quit  r refresh'))
  return body.map(line => fit(line, width))
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
