#!/usr/bin/env bun

import { program } from 'commander'
import { topCommand } from './top.js'
import { authorizeCommand, delegateAddressCommand, keygenCommand, revokeCommand, runCommand, setupCommand, statusCommand } from './commands.js'

program
  .name('monad-keeper')
  .description('Compound Monad staking rewards through an EIP-7702 delegate')

program
  .command('keygen')
  .description('Generate a random keeper key and save it to .env')
  .option('--force', 'Replace an existing KEEPER_PRIVATE_KEY')
  .action(keygenCommand)

program
  .command('status')
  .description('Show owner delegation, balances and pending rewards')
  .action(statusCommand)

program
  .command('delegate-address')
  .description('Print the CompoundDelegate address authorize will use (run `forge build` first)')
  .action(delegateAddressCommand)

program
  .command('authorize')
  .description('Deploy CompoundDelegate if needed (run `forge build` first), owner signs 7702 authorization, keeper submits it')
  .option('--ledger', 'Sign on Ledger (stock app only signs whitelisted delegates)')
  .action(authorizeCommand)

program
  .command('setup')
  .description('Claim rewards, authorize, then delegate everything above OWNER_BALANCE_MON back')
  .option('--ledger', 'Sign on Ledger (stock app only signs whitelisted delegates)')
  .action(setupCommand)

program
  .command('revoke')
  .description('Remove 7702 delegation from the owner (works with stock Ledger app, does not use the keeper key)')
  .option('--ledger', 'Sign on Ledger')
  .action(revokeCommand)

program
  .command('top')
  .description('Live dashboard: next compound, balances, stake and the service log (no keys needed)')
  .action(topCommand)

program
  .command('run')
  .description('Compound every COMPOUND_EVERY epochs (auto by default), LEAD_BLOCKS before the boundary block')
  .option('--once', 'Compound right now and exit')
  .action(runCommand)

program.parseAsync().catch(e => {
  console.error(e.shortMessage ?? e.message)
  process.exit(1)
})
