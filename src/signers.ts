import { ethers } from 'ethers'
import { createInterface } from 'readline'

export interface AuthRequest {
  address: string
  nonce: bigint
  chainId: bigint
}

export interface OwnerTx {
  to: string
  data?: string
  value?: bigint
}

export interface OwnerSigner {
  address: string
  signAuthorization: (auth: AuthRequest) => Promise<ethers.Signature>
  /** Transaction from the owner, waits for inclusion */
  send: (provider: ethers.Provider, tx: OwnerTx) => Promise<ethers.TransactionReceipt>
  close: () => Promise<void>
}

// --- Ledger: SIGN EIP 7702 AUTHORIZATION (INS 0x34) ---
// https://github.com/LedgerHQ/app-ethereum/blob/develop/doc/apdu.md
// Stock app only signs delegates from its whitelist (Simple7702Account) and revocations (0x0)

function encodePath(path: string): Buffer {
  const parts = path.replace(/^m\//, '').split('/')
  const buf = Buffer.alloc(1 + parts.length * 4)
  buf[0] = parts.length
  parts.forEach((part, i) => {
    const hardened = part.endsWith(`'`)
    const index = parseInt(hardened ? part.slice(0, -1) : part, 10)
    buf.writeUInt32BE((hardened ? 0x80000000 : 0) + index, 1 + i * 4)
  })
  return buf
}

function tlv(tag: number, value: Uint8Array): Buffer {
  return Buffer.concat([ Buffer.from([ tag, value.length ]), value ])
}

function uintBE(value: bigint): Buffer {
  const hex = value.toString(16)
  return Buffer.from(hex.length % 2 ? '0' + hex : hex, 'hex')
}

function encodeAuth7702(auth: AuthRequest): Buffer {
  return Buffer.concat([
    tlv(0x00, Buffer.from([ 1 ])), // STRUCT_VERSION
    tlv(0x01, ethers.getBytes(auth.address)), // DELEGATE_ADDR
    tlv(0x02, uintBE(auth.chainId)), // CHAIN_ID
    tlv(0x03, uintBE(auth.nonce)), // NONCE
  ])
}

export async function connectLedger(derivationPath: string): Promise<OwnerSigner> {
  // Loaded lazily so the server binary (run/status) is built without Ledger and native HID deps
  const { default: Eth } = await import('@ledgerhq/hw-app-eth')
  const { default: TransportNodeHid } = await import('@ledgerhq/hw-transport-node-hid-noevents')

  const devices = await TransportNodeHid.list()
  if (devices.length === 0) throw new Error('Ledger not found: connect it and open Ethereum app')
  const transport = await TransportNodeHid.open(devices[0])
  const eth = new Eth(transport)
  const { address } = await eth.getAddress(derivationPath)

  return {
    address: ethers.getAddress(address),

    async signAuthorization(auth) {
      const struct = encodeAuth7702(auth)
      const size = Buffer.alloc(2)
      size.writeUInt16BE(struct.length)
      const payload = Buffer.concat([ encodePath(derivationPath), size, struct ])

      let response: Buffer = Buffer.alloc(0)
      for (let offset = 0; offset < payload.length; offset += 255) {
        const p1 = offset === 0 ? 0x01 : 0x00
        response = await transport.send(0xe0, 0x34, p1, 0x00, payload.subarray(offset, offset + 255))
      }

      return ethers.Signature.from({
        yParity: response[0] as 0 | 1,
        r: '0x' + response.subarray(1, 33).toString('hex'),
        s: '0x' + response.subarray(33, 65).toString('hex'),
      })
    },

    async send(provider, { to, data = '0x', value = 0n }) {
      const [ nonce, fee, { chainId }, gasLimit ] = await Promise.all([
        provider.getTransactionCount(address, 'pending'),
        provider.getFeeData(),
        provider.getNetwork(),
        provider.estimateGas({ from: address, to, data, value }),
      ])
      const tx = ethers.Transaction.from({
        type: 2,
        to,
        data,
        value,
        nonce,
        chainId,
        gasLimit,
        maxFeePerGas: fee.maxFeePerGas,
        maxPriorityFeePerGas: fee.maxPriorityFeePerGas,
      })
      // Staking calls carry no ERC-7730 metadata, so they need blind signing enabled in the app
      const sig = await eth.signTransaction(derivationPath, tx.unsignedSerialized.slice(2), null)
      tx.signature = { r: '0x' + sig.r, s: '0x' + sig.s, v: parseInt(sig.v, 16) }
      const response = await provider.broadcastTransaction(tx.serialized)
      return (await response.wait())!
    },

    async close() {
      await transport.close()
    },
  }
}

// --- Private key or mnemonic, entered interactively (or OWNER_SECRET for testnet) ---

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  let muted = false
  ;(rl as any)._writeToOutput = (s: string) => {
    if (!muted) process.stdout.write(s)
  }
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer.trim())
    })
    muted = true
  })
}

export function walletFromSecret(secret: string, derivationPath: string): ethers.Wallet | ethers.HDNodeWallet {
  return secret.includes(' ')
    ? ethers.HDNodeWallet.fromPhrase(secret, undefined, `m/${derivationPath.replace(/^m\//, '')}`)
    : new ethers.Wallet(secret)
}

export async function connectSecret(derivationPath: string): Promise<OwnerSigner> {
  const secret = process.env.OWNER_SECRET || await promptHidden('Owner private key or mnemonic: ')
  const wallet = walletFromSecret(secret, derivationPath)

  return {
    address: wallet.address,
    async signAuthorization(auth) {
      return wallet.signingKey.sign(ethers.hashAuthorization(auth))
    },
    async send(provider, tx) {
      const response = await wallet.connect(provider).sendTransaction(tx)
      return (await response.wait())!
    },
    async close() {},
  }
}
