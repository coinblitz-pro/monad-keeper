# Configuration

The CLI reads `.env` in the project directory. The server binary reads the process environment
only (see [server.md](server.md)).

| Variable | Default | |
|---|---|---|
| `RPC_URL` | required | JSON-RPC endpoint. On a server, prefer your node's local RPC |
| `KEEPER_PRIVATE_KEY` | required | Hot key that sends compounds and pays gas. `bun run keygen` generates one |
| `OWNER_ADDRESS` | from `OWNER_SECRET` | Account whose rewards are compounded. Required on the server |
| `CHAIN_ID` | required for `authorize`/`revoke` | `143` mainnet, `10143` testnet. Guards against signing for the wrong chain |
| `VALIDATOR_ID` | auto | Detected from the owner's delegations: the only one, or the validator whose auth address is the owner. Part of the delegate's address |
| `KEEPER_BALANCE_MON` | `42` | Keeper balance after each top-up. Part of the delegate's address, so changing it requires `authorize` again |
| `OWNER_BALANCE_MON` | `20` | Liquid balance kept on the owner, the rest is delegated at each compound. At least 11. Part of the delegate's address |
| `COMPOUND_EVERY` | `auto` | Epochs between compounds. `auto` picks the interval from measured rewards, stake yield and gas cost (see [how it works](how-it-works.md#interval)); it needs an RPC with state history |
| `MIN_REWARDS_MON` | `1` | Skip compounding below this amount |
| `LEAD_BLOCKS` | `300` | How many blocks before the boundary to compound |
| `BOUNDARY_PERIOD` | `50000` | Blocks between boundary blocks |
| `OWNER_SECRET` | prompted | Owner private key or mnemonic for `authorize`/`revoke` without a Ledger. Testnet only |
| `DERIVATION_PATH` | `44'/60'/0'/0/0` | Owner account on a Ledger or in a mnemonic. Quote it in `.env` |

Public Monad RPCs reject JSON-RPC batch requests, so the CLI sends requests one at a time.
