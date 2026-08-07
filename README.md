# Deckhand

**Ask Claude for your app on any device — get a link.**

Deckhand is an MCP server that runs on a Mac. Connect it to Claude (claude.ai, Claude
Code, Routines — any MCP client) and ask:

> "Test the onboarding screens on iOS 26 and Android 14 for PR #42"

You get back one calm page showing every device live, with full touch control —
shareable publicly or behind a PIN. Claude can also see and drive the devices itself
(screenshot, accessibility tree, tap/type) before it hands you the link.

## How it works

1. **You ask** — Claude calls `start_preview` with an app id, a ref/PR, and devices.
2. **Deckhand builds** — checks out the branch into a worktree (or builds a registered
   local checkout in place), builds once per platform, installs on every device.
3. **Devices boot in parallel** — iOS simulators via `simctl`, Android emulators via
   `avdmanager`/`adb`.
4. **You get a link** — a stable per-app share URL streaming all devices live, riding a
   Cloudflare tunnel. No VPN, no WebRTC, no TURN — if a network can reach claude.ai, it
   can view and control a preview.

## Architecture

One Node process owns everything. Nothing but `cloudflared` is reachable from outside
the machine.

```
 claude.ai / Claude Code / any MCP client      share-link viewers (any browser)
        │ HTTPS                                        │ HTTPS/WSS
        └───────────────────┬──────────────────────────┘
                            ▼
          cloudflared named tunnel → http://127.0.0.1:4300
                            │
┌───────────────────────────▼── deckhand server (loopback only) ──┐
│                                                                 │
│  /mcp                    MCP tools, bearer-authenticated       │
│  /oauth/*                per-person sign-in (Cloudflare Access) │
│  /s/<shareId>            viewer page (device grid + controls)   │
│  /s/<shareId>/dev/<id>/* scoped proxy → that device's stream    │
│                                                                 │
│  auth → mcp tools → preview engine → devices → streaming        │
│           │             │               │          │            │
│       audit log    git worktrees    simctl /   serve-sim (iOS)  │
│                    + build recipes  adb        screenrecord     │
│                                                (Android)        │
└─────────────────────────────────────────────────────────────────┘

 on-disk: ~/.deckhand/{config.yaml, apps.yaml, tokens.yaml, oauth.json, state.json, audit.jsonl}
```

## Building blocks

| Module | What it does |
|---|---|
| `server/src/mcp/` | The MCP surface: previews, screenshots, UI tree, test runs, app registration |
| `server/src/engine/` | Preview state machine, build recipes (Expo / RN / NativeScript), app-type detection, worktrees, dev-server lifecycle |
| `server/src/devices/` | iOS (`simctl`) and Android (`avdmanager`/`emulator`/`adb`) control, tool env resolution |
| `server/src/streaming/` | Swappable `StreamingBackend` seam — H.264 both sides: serve-sim on iOS, `adb screenrecord` repackaged Annex-B→AVCC on Android, with an `adb screencap` PNG fallback for system images whose encoder is broken |
| `server/src/share/` | Share ids, PIN protection, and the scoped HTTP+WS proxy (video + input, nothing else) |
| `server/src/github/` | Credential ladder: PAT → GitHub App → ambient `gh` → anonymous (public repos) |
| `server/src/cli.ts` | `deckhand` CLI: setup, serve, doctor, token, app, env |
| `viewer/` | The single calm page: WebCodecs stream client, touch/keyboard input, device picker |

Stack: **Node ≥ 22, TypeScript, ESM**. No database, no SPA framework beyond the one
viewer page, a ruthlessly short dependency list.

## Two ways to run an app

- **Git mode** — Deckhand clones the repo, fetches any ref or PR into a detached
  worktree, and builds there. Fully self-contained.
- **Local mode** (daily dev loop) — register an existing checkout with
  `deckhand app add <id> --path <dir>`. Built in place, never mutated: Deckhand reads
  the checkout's git state but never writes to it. `restart_preview` (or the viewer's
  Rebuild button) rebuilds on the same booted devices.

## Security model

- Everything binds **loopback**; the only way in is the Cloudflare named tunnel.
- Nothing that touches a device or a repo is reachable without a credential: a
  per-person MCP credential (OAuth behind a Cloudflare Access email allowlist, or a
  local bearer token), per-app share links (optionally PIN-gated). The OAuth
  discovery, registration and sign-in endpoints are open by construction — a client
  with no credential has to start somewhere — and grant nothing on their own.
- The MCP surface is capability-bounded — no arbitrary commands, only pre-registered
  apps and their repos' refs. Every call lands in an append-only audit log.
- Secrets never travel through MCP; tokens never appear in argv, URLs, or logs.

## Status

**Phases 0–2.5 done, most of Phase 3 landed** — iOS + Android multi-device previews,
local dev mode, agent-driven test runs (`describe`/`ui`/`logs`), agent-led onboarding
(`add_app`, PIN-gated shares), multi-source pages (`alongside`) with an app→app
migration parity harness, and physical-device detection (paired iPhones/iPads and
adb-connected Android hardware in `list_devices` — detection only; previews still run
on simulators/emulators). Validated end-to-end on real hardware over a live tunnel
(734 tests, CI green). Next: the rest of Phase 3, then Phase 4 (ops hardening + AI
setup runbook).

[PLAN.md](./PLAN.md) describes what the system is — architecture, the MCP surface,
the security model; background knowledge in [docs/reference/](./docs/reference/).

## Install it

Hand an agent this repo URL and it can do most of it. Two things it cannot, and
they are both yours: **a Cloudflare login** (a browser and your account) and
**a hostname** on a domain you own.

```sh
git clone https://github.com/Okam-AS/deckhand && cd deckhand
npm install
npm run build                                   # viewer + landing
npx tsx server/src/cli.ts setup                 # ← run this first, with no arguments
```

With no arguments, `setup` checks the machine and prints exactly what is missing
and **who can fix it** — the things it can install itself, and the things it
needs you for. Do those, then run it again with your hostname:

```sh
cloudflared tunnel login                        # only if the preflight asked for it
npx tsx server/src/cli.ts setup \
  --hostname deckhand.yourdomain.com \
  --web-host previews.yourdomain.com            # optional, for web previews
```

### If you are the agent

- Run `setup` with no arguments first. Relay its **NEEDS YOU** list verbatim and
  stop; do not attempt those steps. `cloudflared tunnel login` opens a browser
  and will hang you forever.
- Install what it says you can install. Then ask the user for a hostname on a
  domain they have on Cloudflare, and run `setup --hostname <that>`.
- Xcode is a ~10 GB App Store download needing an Apple ID and a `sudo` licence
  accept. Ask; do not claim to have done it.
- Android is optional. Without it, iOS previews work and Android does not —
  `doctor` says so as a warning rather than a failure.

`setup` creates the Cloudflare tunnel and DNS route, merges your cloudflared
config (it never overwrites rules for other services), links `deckhand` onto your
PATH, writes deckhand's config, prints your **connector URL**, installs the
LaunchAgents so it survives sleep and reboot, and runs `doctor`.

Re-run it any time: every step reports what it found and changes only what is
missing, so it doubles as a repair tool.

Then register something to preview:

```sh
deckhand app add myapp --path /abs/path/to/a/checkout    # local — no GitHub needed
deckhand app add myapp github.com/owner/repo             # from git
deckhand doctor --device-only                            # boots a real sim + emulator
```

Then paste your connector URL into claude.ai → Settings → Connectors:

```sh
deckhand token          # prints https://<your-hostname>/mcp
```

**The URL is not a credential.** In a Claude team or Enterprise organisation a
connector is visible to everyone in it, so deckhand does not put a secret in the
URL — it authenticates each person individually. Clicking Connect sends them to a
Cloudflare Access sign-in, which emails a one-time code, and only addresses on
your allowlist get through:

```sh
deckhand allow you@example.com     # who may connect
deckhand allow                     # who may connect today
deckhand allow rm them@example.com # revoked on their next call, no restart
```

`setup` walks you through creating the Cloudflare Access application (it needs
your Zero Trust dashboard, so it prints the steps rather than doing it for you)
and `deckhand doctor` fails if the allowlist or the Access application is missing
— either one means nobody can connect.

Claude Code on the same Mac has no browser to sign in with, so it uses a local
credential instead: `deckhand token add <name>`, sent as an
`Authorization: Bearer` header. That one *is* a password — `token list` shows
which exist with the values masked, `token url <name>` prints one in full, and
`token rm <name>` revokes it on the running server.
