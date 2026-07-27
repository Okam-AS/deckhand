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
│  /mcp/<token>            MCP tools, per-person token, role-gated│
│  /s/<shareId>            viewer page (device grid + controls)   │
│  /s/<shareId>/dev/<id>/* scoped proxy → that device's stream    │
│                                                                 │
│  auth → mcp tools → preview engine → devices → streaming        │
│           │             │               │          │            │
│       audit log    git worktrees    simctl /   serve-sim (iOS)  │
│                    + build recipes  adb        screenrecord     │
│                                                (Android)        │
└─────────────────────────────────────────────────────────────────┘

 on-disk: ~/.deckhand/{config.yaml, apps.yaml, tokens.yaml, state.json, audit.jsonl}
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
| `server/src/cli.ts` | `deckhand` CLI: init, serve, doctor, token, app, env |
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
- No tokenless paths: per-person MCP tokens, per-app share links (optionally PIN-gated).
- The MCP surface is capability-bounded — no arbitrary commands, only pre-registered
  apps and their repos' refs. Every call lands in an append-only audit log.
- Secrets never travel through MCP; tokens never appear in argv, URLs, or logs.

## Status

**Phases 1, 2 & 2.5 done** — iOS + Android multi-device previews, local dev mode, and
agent-driven test runs, validated end-to-end on real hardware over a live tunnel
(168 tests, CI green). Next: Phase 3 (password shares, agent-led onboarding contract)
and Phase 4 (ops hardening + AI setup runbook).

The complete build plan lives in [PLAN.md](./PLAN.md); background knowledge in
[docs/reference/](./docs/reference/).

## Run it (dev)

```sh
npm install
npm run build --workspace @deckhand/viewer      # build the viewer once
deckhand init --hostname <host>                 # add --github-app-id/--github-app-pem
                                                # for a GitHub App; omit to use `gh`
deckhand token add <you> --role admin           # prints your connector URL
deckhand app add <id> github.com/owner/repo     # or: --path <local-checkout>
npm run dev                                     # or: deckhand serve
deckhand doctor --smoke                         # end-to-end check on the Mac
```
