---
name: waiting-for-a-preview
description: Use when an agent running ON the deckhand host needs to wait for a preview to finish building. Reads state.json directly instead of sleep-looping preview_status, and names the phase traps that make a half-broken preview look ready.
---

# waiting-for-a-preview

For an agent **co-located on the deckhand Mac**. A remote agent driving deckhand
over the tunnel cannot use any of this — `state.json` is on the host — and must
poll the `preview_status` tool instead.

Originally written by @nixolas1 as a section of `AGENTS.md` (PR #4). It lives
here because it is operational how-to for one scenario, while AGENTS.md is the
workflow and guardrail contract every agent reads on every task.

## Read state.json, not a sleep-loop

Do not sleep-loop `preview_status` to wait for a build. The `StateStore` (`server/src/state.ts`) persists
live per-preview/per-device phases to `$DECKHAND_HOME/state.json` (default
`~/.deckhand/state.json` — `server/src/paths.ts`), rewritten via temp-file + rename on
every phase change, so a reader never sees a torn file. Poll that file instead of the tool.

Read the state, don't trust one field of it:

- **Device phases** (`DEVICE_PHASES`, `state.ts`): `pending`, `preparing`, `building`,
  `booting`, `installing-app`, `launching`, `ready`, `failed`. The order varies by platform
  (a `web` preview skips the simulator phases), so match on the terminal states, not on a
  presumed walk. There is no `error` *phase* — a failed build sets `devices[].error`.
- **Preview phases** (`PREVIEW_PHASES`): `pending`, `running`, `ready`, `stopping`,
  `stopped`, `failed`.
- **The trap:** `recomputePreviewPhase` (`engine/preview.ts`) reports a preview as `ready`
  when *some* devices failed and the rest are ready. Watching the preview phase alone
  therefore calls a half-broken preview a success — and watching `devices[0]` alone calls
  a multi-device preview (iPhone + iPad, or iOS + Android) ready while device 2 is still
  building. **Require all devices `ready`, and scan every device for `error` first.**

Use `Bash` with `run_in_background: true` for one notification when it finishes, or the
`Monitor` tool for a line per transition. Either way this is a 3s poll of a local file
(cheap), not an event subscription — sub-3s transitions are simply not observed, which is
fine because the terminal states are sticky:

```sh
app=<app-id>; state="${DECKHAND_HOME:-$HOME/.deckhand}/state.json"
prev=""; polls=0; max=800   # 800 × 3s ≈ 40 min ceiling — never loop unbounded
while :; do
  line=$(python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    print("unreadable||"); sys.exit()
ps = [p for p in d.get("previews", []) if p.get("appId") == sys.argv[2]]
if not ps:
    print("absent||"); sys.exit()
devs = ps[-1].get("devices") or []
errs, per = [], []
for v in devs:
    e = v.get("error")
    if e:
        errs.append(str(v.get("deviceId")) + ": " + e.splitlines()[0])
    per.append(str(v.get("deviceId")) + "=" + str(v.get("phase")))
allready = bool(devs) and all(v.get("phase") == "ready" for v in devs)
phase = "ready" if allready else (ps[-1].get("phase") or "unknown")
print(phase + "|" + "; ".join(errs) + "|" + " ".join(per))
' "$state" "$app")
  IFS='|' read -r phase errs per <<EOF
$line
EOF
  [ "$per|$phase" != "$prev" ] && { echo "$app: $phase — ${per:-no devices yet}"; prev="$per|$phase"; }
  # Errors first: a part-failed preview still reports phase=ready.
  [ -n "$errs" ] && { echo "$app DEVICE ERROR — $errs"; exit 1; }
  case $phase in
    ready) echo "$app: READY"; exit 0;;
    failed|stopped) echo "$app: $phase — ${errs:-no device error recorded}"; exit 1;;
  esac
  polls=$((polls + 1))
  [ "$polls" -ge "$max" ] && { echo "$app: TIMED OUT — last $phase ($per)"; exit 1; }
  sleep 3
done
```

`absent` (no preview for that app id) and `unreadable` are not terminal — a typo'd app id,
or a preview that was idle-swept out of the array, leaves the loop reporting one of those
until the poll ceiling fires. That ceiling is why the loop can't hang forever.

**Host-local only.** `state.json` lives on the deckhand machine, so this works only for an
agent running on that machine. A **remote** agent driving deckhand over the tunnel can't
read it — it must poll the `preview_status` MCP tool. (This is why the readiness hint stays
here and not in the MCP tool descriptions, which every remote client also reads.)

