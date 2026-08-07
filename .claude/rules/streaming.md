---
paths:
  - "server/src/streaming/**/*.ts"
---

The swappable streaming seam (PLAN §8). iOS = serve-sim, Android = adb, web = a proxy to the dev server.

Hardest rules, each with the check that enforces it:

- **Nothing outside this directory may import a concrete backend.** Callers see `StreamingBackend` (`backend.ts`). Two composition roots are named exceptions: `server.ts` and `cli/doctor.ts`. → `invariants.test.ts` "keeps concrete backends out of everything but the composition root"
- **Every listening socket binds `127.0.0.1`.** The per-device Android helper is a real HTTP server, not an internal detail. → `invariants.test.ts` "binds every listening socket to loopback"
- **serve-sim's version is pinned exactly and patched.** The patch strips `/exec` and `/exec-ws`, which are reachable from inside the simulator over the host's shared loopback. A caret range drifts past the patch. → `invariants.test.ts` "pins serve-sim exactly"

- **No WebRTC, no TURN, and this is not a performance opinion.** Tried and rejected 2026-07-09 (PLAN §2): TURN costs $0.05/GB and adds a credential and relay subsystem to a product whose whole distribution story is one Cloudflare tunnel. H.264 over the tunnel is free and **exactly as firewall-proof as claude.ai itself** — a network that can reach the connector can reach the video, which is the property WebRTC would be adopted to buy. Reaching for a peer connection trades that away for a bill.

What the tests cannot tell you, and cost real debugging:

- **`serve-sim --detach -p <port>` is a request, not an instruction.** When a helper for that udid already exists it ignores `-p` and returns the running one. Believe the port it REPORTS. Recording the requested port aimed every probe at a port nothing served, surfacing 20s later as "no first frame" with no helper in `ps` to explain it.
- **Helpers outlive the server.** serve-sim daemonizes itself, so it carries no env marker and the marker sweep cannot see it. `reapOrphans(keep)` is its only owner, and it must spare live devices — the boot sweep runs *after* the port is bound, so a `start_preview` can be mid-attach.
- **The host H.264 encoder is single-instance across emulators.** Whichever process holds `screenrecord` wins; the others produce zero bytes, silently. Not a bug you will find by reading.
- **A first-frame probe is the readiness signal, not `/health`.** Health lies.

Touching this path means `npm run test:device` before you call it tested — see AGENTS.md.
