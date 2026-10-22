# Mainnet with Ledger

`authorize --ledger` and `revoke --ledger` sign on the device. Both also ask you to confirm an
ordinary transfer first: `authorize` funds the keeper, `revoke` funds a one-time sender with
0.1 MON (the remainder comes back).

## The stock Ethereum app won't sign `authorize`

The Ledger Ethereum app signs EIP-7702 authorizations only for delegates on its built-in
whitelist, which currently contains just `Simple7702Account`. It rejects `CompoundDelegate`.
Revocations (delegate `0x0`) need no whitelist, so **`revoke --ledger` works with the stock app**.

You can still authorize in one of two ways.

### Custom build of the Ethereum app

1. Get the delegate address: `bun run delegate-address`.
2. Add it to `EIP7702_WHITELIST` in
   [`whitelist_7702.c`](https://github.com/LedgerHQ/app-ethereum/blob/develop/src/features/sign_authorization_eip7702/whitelist_7702.c)
   with `chain_id = 143`.
3. Build and sideload the app. Sideloading works on Nano S Plus, Stax and Flex, not on Nano X.
4. Run `bun run authorize --ledger`.

The CLI talks to the app directly over `SIGN EIP 7702 AUTHORIZATION` (APDU `0x34`), so it needs
no other changes.

### Seed on an offline machine

Run `bun run authorize` without `OWNER_SECRET`, and it will ask for the private key or mnemonic
with hidden input. Use an air-gapped machine if you can. Once a seed has been typed into a
computer, the account is effectively a hot wallet.

`setup --ledger` also sends `claimRewards` to the staking precompile. The app
has no metadata for those calls, so enable **Blind signing** in its settings.

## Chain ID

The CLI always signs for a specific `CHAIN_ID`, never `0`. A chain ID of `0` would make the
authorization valid on every chain where the delegate address might hold different code.
