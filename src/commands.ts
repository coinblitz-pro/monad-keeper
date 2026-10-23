import { chmodSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { ethers } from 'ethers'
import { formatMon, getBlockTimeMs, getDelegationTarget, getEpoch, getRewards, log, nextBoundary, resolveValidatorId } from './chain.js'
import {
  BOUNDARY_PERIOD,
  CLAIM_REWARDS,
  COMPOUND_GAS_MARGIN,
  CONFIRM_TIMEOUT_MS,
  DELEGATE_ABI,
  DELEGATED_RESERVE,
  DERIVATION_PATH,
  env,
  getKeeper,
  getOwner,
  getProvider,
  KEEPER_BALANCE,
  LEAD_BLOCKS,
  MAX_GAS_LIMIT,
  MAX_PRIORITY_FEE,
  MAX_TOP_UP,
  MIN_COMPOUND_INTERVAL_MS,
  MIN_REWARDS,
  OWNER_BALANCE,
  OWNER_MIN_BALANCE,
  REVOKE_GAS_FUND,
  STAKING_CONTRACT,
  TOP_UP_INTERVAL,
} from './config.js'
import { compoundEvery, planCompound } from './plan.js'
import { connectLedger, connectSecret, type OwnerSigner } from './signers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ARTIFACT = join(__dirname, '..', 'out', 'CompoundDelegate.sol', 'CompoundDelegate.json')

const L = (label: string) => `${label}:`.padEnd(20)

// Deterministic deployment proxy (Arachnid), present on Monad mainnet and testnet
const CREATE2_DEPLOYER = '0x4e59b44847b379578588920ca78fbf26c0b4956c'

function delegateInitCode(keeper: string, validatorId: number): string {
  if (OWNER_BALANCE < OWNER_MIN_BALANCE) {
    throw new Error(`OWNER_BALANCE_MON must be at least ${formatMon(OWNER_MIN_BALANCE)}: a delegated owner can't go below ${formatMon(DELEGATED_RESERVE)} and needs gas on top`)
  }
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf-8'))
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    [ 'address', 'uint64', 'uint256', 'uint256', 'uint256', 'uint256' ],
    [ keeper, validatorId, OWNER_BALANCE, KEEPER_BALANCE, MAX_TOP_UP, TOP_UP_INTERVAL ],
  )
  return ethers.concat([ artifact.bytecode.object, args ])
}

function delegateAddress(initCode: string): string {
  return ethers.getCreate2Address(CREATE2_DEPLOYER, ethers.ZeroHash, ethers.keccak256(initCode))
}

/** CompoundDelegate lives at a CREATE2 address derived from the keeper and validator; deployed on first use */
async function ensureDelegate(provider: ethers.Provider, keeper: ethers.Wallet, validatorId: number): Promise<string> {
  const initCode = delegateInitCode(keeper.address, validatorId)
  const address = delegateAddress(initCode)
  if (await provider.getCode(address) !== '0x') return address

  console.log(`Deploying CompoundDelegate for keeper ${keeper.address}...`)
  const tx = await keeper.sendTransaction({ to: CREATE2_DEPLOYER, data: ethers.concat([ ethers.ZeroHash, initCode ]) })
  await tx.wait()
  if (await provider.getCode(address) === '0x') throw new Error(`CompoundDelegate deployment failed: ${tx.hash}`)
  return address
}

/** keeper() of the owner's current 7702 delegate, null if not delegated or not a CompoundDelegate */
async function getDelegateKeeper(provider: ethers.Provider, target: string | null): Promise<string | null> {
  if (!target) return null
  return new ethers.Contract(target, DELEGATE_ABI, provider).keeper().catch(() => null)
}

/** Random keeper key written straight into .env, so it never appears in the terminal */
export function keygenCommand(options: { force?: boolean }) {
  const current = process.env.KEEPER_PRIVATE_KEY
  if (current && !options.force) {
    throw new Error(`KEEPER_PRIVATE_KEY is already set (keeper ${new ethers.Wallet(current).address}), use --force to replace it`)
  }

  const keeper = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)))
  const path = join(process.cwd(), '.env')
  const source = readFileSync(existsSync(path) ? path : join(__dirname, '..', '.env.example'), 'utf-8')
  const line = `KEEPER_PRIVATE_KEY=${keeper.privateKey}`
  const pattern = /^KEEPER_PRIVATE_KEY=.*$/m
  writeFileSync(path, pattern.test(source) ? source.replace(pattern, line) : `${source.trimEnd()}\n${line}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)

  console.log(`${L('Keeper')}${keeper.address}`)
  console.log(`Saved KEEPER_PRIVATE_KEY to ${path}`)
}

/** Where authorize will point the owner, e.g. to whitelist it in a custom Ledger app before signing */
export async function delegateAddressCommand() {
  const provider = getProvider()
  const keeper = getKeeper(provider)
  const validatorId = await resolveValidatorId(provider, getOwner())
  const address = delegateAddress(delegateInitCode(keeper.address, validatorId))
  const deployed = await provider.getCode(address) !== '0x'
  console.log(`${L('Keeper')}${keeper.address}`)
  console.log(`${L('Validator ID')}${validatorId}`)
  console.log(`${L('CompoundDelegate')}${address} (${deployed ? 'deployed' : 'not deployed yet'})`)
}

export async function statusCommand() {
  const provider = getProvider()
  const owner = getOwner()
  const keeper = getKeeper(provider)
  const validatorId = await resolveValidatorId(provider, owner)

  const [ target, ownerBalance, keeperBalance, rewards ] = await Promise.all([
    getDelegationTarget(provider, owner),
    provider.getBalance(owner),
    provider.getBalance(keeper.address),
    getRewards(provider, validatorId, owner),
  ])

  console.log(`${L('Owner')}${owner}`)
  console.log(`${L('Delegated to')}${target ?? 'none'}`)
  if (target) {
    const delegateKeeper = await getDelegateKeeper(provider, target)
    const match = delegateKeeper === keeper.address ? 'ok' : 'MISMATCH'
    console.log(`${L('Delegate keeper')}${delegateKeeper ?? 'unknown'} (${match})`)
    if (delegateKeeper) {
      const account = new ethers.Contract(owner, DELEGATE_ABI, provider)
      const params = await Promise.all([
        account.keeperBalance(), account.lastTopUp(), account.validatorId(), account.ownerBalance(),
      ]).catch(() => null)
      if (params) {
        const [ target, last, delegateValidator, ownerKeeps ] = params
        console.log(`${L('Keeper top-up')}to ${formatMon(target)}, last at block ${last || 'never'}`)
        console.log(`${L('Stakes excess')}above ${formatMon(ownerKeeps)} into validator ${delegateValidator}`)
      } else {
        console.log(`${L('Delegate')}older CompoundDelegate build, run authorize to replace it`)
      }
    }
  }
  console.log(`${L('Owner balance')}${formatMon(ownerBalance)}`)
  if (target && ownerBalance < DELEGATED_RESERVE) {
    console.log(`Warning: delegated EOA below ${formatMon(DELEGATED_RESERVE)}, its txs that lower the balance will revert`)
  }
  console.log(`${L('Keeper')}${keeper.address}`)
  console.log(`${L('Keeper balance')}${formatMon(keeperBalance)}`)
  console.log(`${L('Validator ID')}${validatorId}`)
  console.log(`${L('Staking rewards')}${formatMon(rewards)}`)
}

/** Owner tops the keeper up to KEEPER_BALANCE, so it can pay for deploy and the type-4 tx */
async function fundKeeper(provider: ethers.Provider, signer: OwnerSigner, keeper: string, useLedger: boolean) {
  const balance = await provider.getBalance(keeper)
  if (balance >= KEEPER_BALANCE) return

  const amount = KEEPER_BALANCE - balance
  console.log(`Funding keeper ${keeper} with ${formatMon(amount)} from owner...`)
  if (useLedger) console.log('Confirm transfer on Ledger...')
  const receipt = await signer.send(provider, { to: keeper, value: amount })
  console.log(`Tx ${receipt.hash}\n`)
}

/** Owner's staking call, e.g. claimRewards */
async function sendStaking(provider: ethers.Provider, signer: OwnerSigner, selector: string, validatorId: number, useLedger: boolean) {
  if (useLedger) console.log('Confirm on Ledger (blind signing)...')
  const data = selector + ethers.AbiCoder.defaultAbiCoder().encode([ 'uint64' ], [ validatorId ]).slice(2)
  const receipt = await signer.send(provider, { to: STAKING_CONTRACT, data })
  console.log(`Tx ${receipt.hash}\n`)
}

async function connectOwner(provider: ethers.Provider, useLedger: boolean): Promise<OwnerSigner> {
  const { chainId } = await provider.getNetwork()
  if (chainId !== BigInt(env('CHAIN_ID'))) {
    throw new Error(`RPC chain ID ${chainId} does not match CHAIN_ID ${env('CHAIN_ID')}`)
  }

  const signer = useLedger ? await connectLedger(DERIVATION_PATH) : await connectSecret(DERIVATION_PATH)
  // OWNER_ADDRESS is optional here, the signer defines the owner; if set, it must match
  if (process.env.OWNER_ADDRESS && getOwner() !== signer.address) {
    await signer.close()
    throw new Error(`Signer address ${signer.address} does not match OWNER_ADDRESS ${getOwner()}`)
  }
  return signer
}

/**
 * Owner signs a 7702 authorization and someone else submits it in a type-4 tx, paying the gas:
 * the keeper on authorize, a one-time key funded by the owner on revoke
 */
async function setDelegation(provider: ethers.Provider, signer: OwnerSigner, revoke: boolean, useLedger: boolean) {
  const owner = signer.address
  const { chainId } = await provider.getNetwork()
  let target = ethers.ZeroAddress
  let sender: ethers.Wallet

  if (revoke) {
    // The keeper key may be the reason for revoking, and its holder could keep the keeper empty
    sender = new ethers.Wallet(ethers.hexlify(ethers.randomBytes(32)), provider)
    console.log(`Funding one-time sender ${sender.address} with ${formatMon(REVOKE_GAS_FUND)} from owner...`)
    if (useLedger) console.log('Confirm transfer on Ledger...')
    const receipt = await signer.send(provider, { to: sender.address, value: REVOKE_GAS_FUND })
    console.log(`Tx ${receipt.hash}\n`)
  } else {
    sender = getKeeper(provider)
    const validatorId = await resolveValidatorId(provider, owner)
    await fundKeeper(provider, signer, sender.address, useLedger)
    target = await ensureDelegate(provider, sender, validatorId)
  }

  try {
    await submitAuthorization(provider, signer, sender, owner, target, chainId, useLedger)
  } finally {
    // Whatever happened after the funding, the one-time sender's MON goes back to the owner
    if (revoke) await returnRemainder(provider, sender, owner)
  }
}

async function submitAuthorization(
  provider: ethers.Provider, signer: OwnerSigner, sender: ethers.Wallet, owner: string, target: string, chainId: bigint, useLedger: boolean,
) {
  const balance = await provider.getBalance(owner)
  if (target !== ethers.ZeroAddress && balance < DELEGATED_RESERVE) {
    console.log(`Warning: owner balance ${formatMon(balance)} < ${formatMon(DELEGATED_RESERVE)}, its outgoing txs will revert until topped up`)
  }

  // The owner is not the sender, so its nonce is not bumped by this tx
  const nonce = BigInt(await provider.getTransactionCount(owner, 'pending'))
  const request = { address: target, nonce, chainId }

  console.log(`${L('Owner')}${owner}`)
  console.log(`${L('Delegate')}${target === ethers.ZeroAddress ? 'none (revoke)' : target}`)
  if (target !== ethers.ZeroAddress) {
    // What the owner is about to sign for; these are baked into the delegate's address
    const delegate = new ethers.Contract(target, DELEGATE_ABI, provider)
    console.log(`${L('Keeper')}${sender.address}`)
    console.log(`${L('Validator ID')}${await delegate.validatorId()}`)
    console.log(`${L('Owner keeps')}${formatMon(await delegate.ownerBalance())}, the rest is staked at each compound`)
    console.log(`${L('Keeper top-up')}to ${formatMon(await delegate.keeperBalance())}, at most ${formatMon(MAX_TOP_UP)} per ${TOP_UP_INTERVAL} blocks`)
  }
  console.log(`${L('Chain ID')}${chainId}`)
  console.log(`${L('Nonce')}${nonce}`)
  if (useLedger) console.log('\nConfirm authorization on Ledger...')

  const signature = await signer.signAuthorization(request)
  if (ethers.verifyAuthorization(request, signature) !== owner) {
    throw new Error('Authorization signature does not recover to owner')
  }

  const tx = await sender.sendTransaction({
    type: 4,
    to: owner,
    data: '0x',
    authorizationList: [ { ...request, signature } ],
  })
  console.log(`\nTx ${tx.hash}`)
  await tx.wait()

  // An authorization with a stale nonce is skipped silently, the tx itself still succeeds
  const current = await getDelegationTarget(provider, owner)
  const expected = target === ethers.ZeroAddress ? null : target
  if (current !== expected) {
    throw new Error(`Delegation not applied: owner code points to ${current ?? 'none'} (nonce changed?)`)
  }
  console.log(`${L('Delegated to')}${current ?? 'none'}`)
}

/** Sends whatever the one-time sender has left back to the owner, minus the transfer's own gas */
async function returnRemainder(provider: ethers.Provider, sender: ethers.Wallet, owner: string) {
  try {
    const [ balance, fee, gasLimit ] = await Promise.all([
      provider.getBalance(sender.address),
      provider.getFeeData(),
      provider.estimateGas({ from: sender.address, to: owner, value: 1n }),
    ])
    const maxFeePerGas = fee.maxFeePerGas!
    if (balance <= gasLimit * maxFeePerGas) return
    const tx = await sender.sendTransaction({
      to: owner,
      value: balance - gasLimit * maxFeePerGas,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
    })
    await tx.wait()
    console.log(`Returned the remainder to owner: ${tx.hash}`)
  } catch (e: any) {
    // Not worth failing the revoke over; the key is only printed so the MON isn't lost
    console.error(`Could not return the remainder (${e.shortMessage ?? e.message}), sweep ${sender.address} with key ${sender.privateKey}`)
  }
}

async function withOwner(useLedger: boolean, action: (provider: ethers.Provider, signer: OwnerSigner) => Promise<void>) {
  const provider = getProvider()
  const signer = await connectOwner(provider, useLedger)
  try {
    await action(provider, signer)
  } finally {
    await signer.close()
  }
}

export async function authorizeCommand(options: { ledger?: boolean }) {
  const useLedger = !!options.ledger
  await withOwner(useLedger, (provider, signer) => setDelegation(provider, signer, false, useLedger))
}

export async function revokeCommand(options: { ledger?: boolean }) {
  const useLedger = !!options.ledger
  await withOwner(useLedger, (provider, signer) => setDelegation(provider, signer, true, useLedger))
}

/**
 * First-time setup when the owner's balance can't fund the keeper: claims all staking rewards,
 * then authorizes. The first compound delegates the claimed rewards back
 */
export async function setupCommand(options: { ledger?: boolean }) {
  const useLedger = !!options.ledger
  await withOwner(useLedger, async (provider, signer) => {
    const validatorId = await resolveValidatorId(provider, signer.address)
    const rewards = await getRewards(provider, validatorId, signer.address)
    if (rewards > 0n) {
      console.log(`Claiming ${formatMon(rewards)} rewards from validator ${validatorId}...`)
      await sendStaking(provider, signer, CLAIM_REWARDS, validatorId, useLedger)
    }

    await setDelegation(provider, signer, false, useLedger)
  })
}

/** Block the compound landed in; `sent` without a block when it couldn't be confirmed */
type CompoundResult = { sent: false } | { sent: true; block: number | null }

/** With `window`, only compounds if COMPOUND_EVERY says this window is due */
async function compoundOnce(provider: ethers.JsonRpcProvider, keeper: ethers.Wallet, window?: number): Promise<CompoundResult> {
  const owner = getOwner()

  // Whatever the owner delegated to, only call it if it is a CompoundDelegate bound to this keeper
  const target = await getDelegationTarget(provider, owner)
  const delegateKeeper = await getDelegateKeeper(provider, target)
  if (delegateKeeper !== keeper.address) {
    log(`Skip: owner delegated to ${target ?? 'none'}, keeper ${delegateKeeper ?? 'unknown'}, expected ${keeper.address}`)
    return { sent: false }
  }

  const account = new ethers.Contract(owner, DELEGATE_ABI, keeper)
  const validatorId = Number(await account.validatorId().catch(() => -1))
  if (validatorId < 0) {
    log(`Skip: delegate ${target} is an older CompoundDelegate build, run authorize to replace it`)
    return { sent: false }
  }
  const rewards = await getRewards(provider, validatorId, owner)
  if (rewards < MIN_REWARDS) {
    log(`Skip: rewards ${formatMon(rewards)} < ${formatMon(MIN_REWARDS)}`)
    return { sent: false }
  }
  if (window !== undefined) {
    const plan = await planCompound(provider, {
      owner, keeper: keeper.address, validatorId, ownerKeeps: await account.ownerBalance(),
      head: await provider.getBlockNumber(), window, period: BOUNDARY_PERIOD,
    })
    if (!plan.due) {
      log(`Skip: ${plan.note}, next compound at block ${plan.next}`)
      return { sent: false }
    }
    log(`Plan: ${plan.note}`)
  }

  const [ balance, ownerKeeps, estimate, fee ] = await Promise.all([
    provider.getBalance(owner), account.ownerBalance(), account.compound.estimateGas(), provider.getFeeData(),
  ])
  const excess = balance > ownerKeeps ? `, stake ~${formatMon(balance - ownerKeeps)} liquid` : ''
  const gasLimit = estimate + COMPOUND_GAS_MARGIN
  if (gasLimit > MAX_GAS_LIMIT) throw new Error(`Gas estimate ${estimate} is above the ${MAX_GAS_LIMIT} cap, not sending`)
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas! < MAX_PRIORITY_FEE ? fee.maxPriorityFeePerGas! : MAX_PRIORITY_FEE
  const maxFeePerGas = fee.maxFeePerGas! - fee.maxPriorityFeePerGas! + maxPriorityFeePerGas

  const tx = await account.compound({ gasLimit, maxFeePerGas, maxPriorityFeePerGas })
  log(`Compound ${formatMon(rewards)} into validator ${validatorId}${excess} → ${tx.hash}`)

  // From here on this window is done: a retry would be a second compound paid by the keeper
  try {
    const receipt = await tx.wait(1, CONFIRM_TIMEOUT_MS)
    log(`Confirmed in block ${receipt.blockNumber}, keeper balance ${formatMon(await provider.getBalance(keeper.address))}`)
    for (const entry of receipt.logs) {
      if (entry.topics.length === 0) continue
      const parsed = account.interface.parseLog(entry)
      if (parsed?.name === 'DelegateSkipped') log(`Warning: staking the liquid balance failed, it stays on the owner: ${decodeRevert(parsed.args.reason)}`)
    }
    return { sent: true, block: receipt.blockNumber }
  } catch (e: any) {
    log(`Warning: ${tx.hash} not confirmed: ${e.shortMessage ?? e.message}`)
    return { sent: true, block: null }
  }
}

/** Error(string) as Solidity encodes it, or the raw string the precompile returns */
function decodeRevert(data: string): string {
  try {
    return ethers.AbiCoder.defaultAbiCoder().decode([ 'string' ], ethers.dataSlice(data, 4))[0]
  } catch {
    const text = ethers.toUtf8String(data, () => -1)
    return /^[\x20-\x7e]+$/.test(text) ? text : data
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const MAX_SLEEP_MS = 10 * 60_000
const RETRY_MS = 5_000
// A reverted compound still costs the keeper its full gas limit, so don't retry a window forever
const MAX_ATTEMPTS = 3

/**
 * Checks once per epoch, LEAD_BLOCKS before the boundary block, and compounds every COMPOUND_EVERY
 * epochs. Compounding more often than once per epoch gains nothing: new stake only activates at
 * the next snapshot, and anything compounded after the boundary waits an extra epoch
 */
async function runEpochs(provider: ethers.JsonRpcProvider, keeper: ethers.Wallet) {
  let blockTimeMs = await getBlockTimeMs(provider)
  let done = -1
  let current = -1
  let attempts = 0
  let lastSentAt = 0
  const every = compoundEvery()
  log(`Block time ${blockTimeMs.toFixed(0)} ms, compound ${LEAD_BLOCKS} blocks before a boundary (period ${BOUNDARY_PERIOD}), ${every === 'auto' ? 'interval picked automatically' : `every ${every} epochs`}`)

  while (true) {
    let boundary = -1
    try {
      const head = await provider.getBlockNumber()
      boundary = nextBoundary(head, BOUNDARY_PERIOD)
      if (boundary !== current) {
        current = boundary
        attempts = 0
      }
      const windowStart = boundary - LEAD_BLOCKS

      if (head < windowStart || done === boundary) {
        const waitBlocks = done === boundary ? boundary + 1 - head : windowStart - head
        if (waitBlocks > 1000) log(`Next window at block ${windowStart} (boundary ${boundary}), ~${Math.round(waitBlocks * blockTimeMs / 60_000)} min`)
        await sleep(Math.min(waitBlocks * blockTimeMs, MAX_SLEEP_MS))
        continue
      }

      const { epoch, inDelayPeriod } = await getEpoch(provider)
      if (inDelayPeriod) {
        // Boundary prediction is off (BOUNDARY_PERIOD changed?); next window will catch up
        log(`Warning: epoch ${epoch} already in delay period at block ${head}, expected boundary ${boundary}`)
        done = boundary
        continue
      }

      if (Date.now() - lastSentAt < MIN_COMPOUND_INTERVAL_MS) {
        log(`Warning: a compound was sent ${Math.round((Date.now() - lastSentAt) / 60_000)} min ago, skipping boundary ${boundary} (RPC block numbers off?)`)
        done = boundary
        continue
      }

      const result = await compoundOnce(provider, keeper, windowStart)
      if (result.sent) lastSentAt = Date.now()
      if (result.sent && result.block !== null && result.block >= boundary) {
        log(`Warning: included at ${result.block}, after boundary ${boundary}; increase LEAD_BLOCKS`)
      }
      done = boundary
      attempts = 0
      blockTimeMs = await getBlockTimeMs(provider)
    } catch (e: any) {
      log(`Error: ${e.shortMessage ?? e.message}`)
      // Only failures inside an unfinished window count towards giving up on it
      if (boundary >= 0 && boundary !== done && ++attempts >= MAX_ATTEMPTS) {
        log(`Skipping boundary ${boundary} after ${attempts} failed attempts`)
        done = boundary
        attempts = 0
      }
      await sleep(RETRY_MS)
    }
  }
}

export async function runCommand(options: { once?: boolean }) {
  const provider = getProvider()
  const keeper = getKeeper(provider)
  log(`Keeper ${keeper.address}, owner ${getOwner()}`)

  if (!options.once) return runEpochs(provider, keeper)

  try {
    await compoundOnce(provider, keeper)
  } catch (e: any) {
    log(`Error: ${e.shortMessage ?? e.message}`)
    process.exit(1)
  }
}
