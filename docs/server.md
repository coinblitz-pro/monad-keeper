# Running on a server

The keeper usually runs on the validator machine itself, next to the node's consensus keys.
So the goal is to add as little as possible to that machine and to keep the keeper away from
everything else on it.

- **No Bun or npm packages on the server.** You build a single binary locally. The Ledger code
  and its native HID dependencies are left out of it.
- **Sandboxed systemd service.** It runs as a throwaway user and can't read `/home` (where the
  node's keys usually live) or its own config file.

## 1. Build

```sh
bun run build:linux-x64     # or build:linux-arm64
```

This produces `dist/monad-keeper-linux-x64`. The binary ignores any `.env` and reads only its
environment.

## 2. Install

```sh
scp dist/monad-keeper-linux-x64 deploy/monad-keeper.service server:/tmp/
```

On the server:

```sh
sudo install -m 755 /tmp/monad-keeper-linux-x64 /usr/local/bin/monad-keeper
sudo install -m 644 /tmp/monad-keeper.service /etc/systemd/system/
sudo install -d -m 755 /etc/monad-keeper
sudo install -m 644 /dev/null /etc/monad-keeper/public.env
sudo install -m 600 /dev/null /etc/monad-keeper/env
sudoedit /etc/monad-keeper/public.env /etc/monad-keeper/env
```

`public.env`, readable by everyone:

```sh
RPC_URL=http://127.0.0.1:8080
OWNER_ADDRESS=0x...
```

`env`, root only:

```sh
KEEPER_PRIVATE_KEY=0x...
```

Use your node's local RPC. Copy `KEEPER_PRIVATE_KEY` from your local `.env`. Leave the owner key off the server and run `authorize` from your own
machine.

## 3. Run

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now monad-keeper
journalctl -u monad-keeper -f
```

```
Validator ID 126
Block time 302 ms, compound 300 blocks before each boundary (period 50000)
Next compound at block 73299699 (boundary 73299999), ~202 min
```

To watch it live:

```sh
sudo monad-keeper top
```

`top` moves itself onto the same cores as the service and only reads the chain and the
service's journal. It takes `RPC_URL` and `OWNER_ADDRESS` from `public.env`, so it needs no root;
the log needs root or the `systemd-journal` group.

## Sandbox

[`deploy/monad-keeper.service`](../deploy/monad-keeper.service) uses `DynamicUser`,
`ProtectHome`, `ProtectSystem=strict`, an empty capability set and a restricted set of address
families. systemd reads the config as root before dropping privileges, so the service itself
can't read `/etc/monad-keeper/env`. `systemd-analyze security monad-keeper` rates it 2.8 (OK).

## CPU

The service is pinned to core 0 with a low priority, so it never competes with the node's
execution, consensus or RPC cores. Check your layout with
`systemctl show monad-execution monad-bft monad-rpc -p CPUAffinity`; if core 0 is taken, override
it with `sudo systemctl edit monad-keeper`:

```ini
[Service]
CPUAffinity=15
AllowedCPUs=15
```

## Updating

Rebuild, then `install` the new binary over the old one and run
`sudo systemctl restart monad-keeper`.
