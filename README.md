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
│  /mcp                    MCP tools, bearer-authenticated        │
│  /oauth/*                per-client sign-in (pairing code)      │
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
| `server/src/streaming/` | Swappable `StreamingBackend` seam — H.264 both sides: serve-sim on iOS (`stream.avcc`, AVCC over a chunked HTTP response, not a WebSocket; a browser with WebCodecs probes it and reads a 404 as "this helper isn't encoding — use `stream.mjpeg`", one without starts on MJPEG and never probes), `adb screenrecord` repackaged Annex-B→AVCC on Android, with an `adb screencap` PNG fallback for system images whose encoder is broken |
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
  per-client MCP credential (an OAuth grant, or a local bearer token), per-app share
  links (optionally PIN-gated). The OAuth discovery,
  registration and sign-in endpoints are open by construction — a client with no
  credential has to start somewhere — and grant nothing on their own: a request that
  reaches them needs a pairing code minted on the Mac with `deckhand pair`.
- The MCP surface is capability-bounded — no arbitrary commands, only pre-registered
  apps and their repos' refs. Every call lands in an append-only audit log.
- Secrets never travel through MCP; tokens never appear in argv, URLs, or logs.

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

If the preflight asked for `cloudflared tunnel login`, run that yourself first — it
opens a browser and needs your own Cloudflare account, so it is the one step nothing
here can do for you. Then:

```sh
npx tsx server/src/cli.ts setup \
  --hostname deckhand.yourdomain.com \
  --web-host previews.yourdomain.com            # optional, for web previews
```

### If you are the agent

- Run `setup` with no arguments first. It labels every line with who acts, and
  `fix:` is the only one of the four you may run:
  - `fix:` — yours to run.
  - `you:` — a fix only a person at this Mac can do (an App Store install, an
    Apple ID, a `sudo` licence accept, the machine's default Node). Relay the
    line as written and stop; re-run `setup` once they say it is done.
  - **BLOCKED** — also relay-and-stop, but an errand off this machine: a browser
    and their Cloudflare account. Never attempt it — `cloudflared tunnel login`
    opens a browser and will hang you forever.
  - **ASK THE USER** — one question to ask in the words given, not a report to
    paste at them.
- Install what it says you can install. Then ask the user for a hostname on a
  domain they have on Cloudflare, and run `setup --hostname <that>`.
- At the end, run `deckhand pair` yourself and give the user the code it prints;
  they type it into the page Claude opens. Typing the command is yours, typing the
  code into their own browser is theirs.
- Xcode is a ~10 GB App Store download needing an Apple ID and a `sudo` licence
  accept. Ask; do not claim to have done it.
- Android is optional. Without it, iOS previews work and Android does not —
  `doctor` says so as a warning rather than a failure.

`setup` creates the Cloudflare tunnel and DNS route, merges your cloudflared
config (rules for other services are carried through the merge, and the previous
file is copied to `config.yml.bak` before anything is written — so the one case
the merge cannot preserve, a config.yml that will not parse and so comes back as
nothing to merge with, is still recoverable by hand), links `deckhand` onto your
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
connector is visible to everyone in it, so deckhand puts no secret in the URL —
and admits nobody because they have it. Clicking Connect opens a page that ASKS for a
pairing code — and the only place one exists is your Mac:

```sh
deckhand pair                      # mint a code; type it into the page Claude opens
deckhand connections               # who holds a grant now
deckhand revoke <client-id>        # take it back, effective next call, no restart
```

A colleague who pastes the same URL is asked for a code they do not have. Nothing
waits, nothing queues, and there is no list for a stranger to fill — the code exists
only on your machine, for ten minutes, for one use.

Claude Code on the same Mac has no browser to sign in with, so it uses a local
credential instead: `deckhand token add <name>`, sent as an
`Authorization: Bearer` header. That one *is* a password — `token list` shows
which exist with the values masked, `token url <name>` prints one in full, and
`token rm <name>` revokes it on the running server.
