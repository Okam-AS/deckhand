#!/usr/bin/env bash
# Install (or reinstall) the deckhand LaunchAgents so the server and the
# Cloudflare tunnel survive crashes, sleep, and reboots — the thing a
# hand-started `deckhand serve` / `cloudflared tunnel run` does NOT do.
#
# Idempotent: run it again to pick up moved paths or a new tunnel id.
# Fills the templates in ops/launchd/ with THIS machine's paths and loads them
# as user agents (no sudo). Undo with ops/uninstall-services.sh.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/.deckhand/logs"
TEMPLATES="$REPO/ops/launchd"

# --- resolve this machine's specifics -------------------------------------
NODE="$(command -v node || true)"
case "$NODE" in
  /*) [ -x "$NODE" ] || NODE="" ;;
  *) NODE="" ;;
esac
[ -n "$NODE" ] || { echo "error: node not on PATH — install Node (nvm) first" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE")"

# The agent's PATH: a LaunchAgent inherits nothing from the user's shell, so
# every build tool has to be named. Resolve the ones that live outside the
# standard prefixes on this machine — CocoaPods (a Ruby gem bin dir; without it
# `ns run ios` exits 127 at "Installing pods..."), the Android SDK tools, and
# every package manager install-deps dispatches to.
AGENT_PATH="$NODE_DIR"

tool_dir() {
  local path
  path="$(command -v "$1" 2>/dev/null)" || return 0
  case "$path" in
    /*)
      [ -x "$path" ] || return 0
      dirname "$path"
      ;;
  esac
}

package_manager_names() {
  "$NODE" -e '
    const source = require("node:fs").readFileSync(process.argv[1], "utf8");
    const start = source.indexOf("const PACKAGE_MANAGERS = [");
    const end = source.indexOf("] as const;", start);
    if (start < 0 || end < start) process.exit(1);
    const names = [...source.slice(start, end).matchAll(/\{\s*name:\s*"([a-z]+)"/g)].map((m) => m[1]);
    if (names.length === 0) process.exit(1);
    process.stdout.write(`${names.join("\n")}\n`);
  ' "$REPO/server/src/engine/recipes.ts"
}

for d in \
  "$(tool_dir pod)" \
  "$(tool_dir ruby)" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/cmdline-tools/latest/bin"
do
  [ -n "$d" ] || continue
  case ":$AGENT_PATH:" in *":$d:"*) continue ;; esac   # de-dupe
  [ -d "$d" ] && AGENT_PATH="$AGENT_PATH:$d"
done

# Keep the SDK ahead of a user-installed manager: yarn, pnpm, or npm can live
# under /opt/homebrew/bin, which must not outrank the configured adb.
PACKAGE_MANAGERS="$(package_manager_names)" || { echo "error: could not read the package managers deckhand supports" >&2; exit 1; }
[ -n "$PACKAGE_MANAGERS" ] || { echo "error: could not read the package managers deckhand supports" >&2; exit 1; }
while IFS= read -r manager; do
  d="$(tool_dir "$manager")"
  [ -n "$d" ] || continue
  case ":$AGENT_PATH:" in *":$d:"*) continue ;; esac
  [ -d "$d" ] && AGENT_PATH="$AGENT_PATH:$d"
done <<< "$PACKAGE_MANAGERS"

for d in /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin
do
  case ":$AGENT_PATH:" in *":$d:"*) continue ;; esac
  [ -d "$d" ] && AGENT_PATH="$AGENT_PATH:$d"
done

CLOUDFLARED="$(command -v cloudflared || true)"
CONFIG="$HOME/.cloudflared/config.yml"
TUNNEL_ID=""
[ -f "$CONFIG" ] && TUNNEL_ID="$(awk '/^tunnel:/{print $2; exit}' "$CONFIG")"

mkdir -p "$AGENTS" "$LOG_DIR"

fill() { # template -> installed plist, substituting placeholders
  local tmpl="$1" out="$2"
  sed -e "s#__NODE__#$NODE#g" \
      -e "s#__NODE_DIR__#$NODE_DIR#g" \
      -e "s#__PATH__#$AGENT_PATH#g" \
      -e "s#__REPO__#$REPO#g" \
      -e "s#__LOG_DIR__#$LOG_DIR#g" \
      -e "s#__CLOUDFLARED__#$CLOUDFLARED#g" \
      -e "s#__TUNNEL_ID__#$TUNNEL_ID#g" \
      "$tmpl" > "$out"
}

load() { # label plist — stop any prior copy (agent or hand-started), then load
  local label="$1" plist="$2"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
  launchctl enable "gui/$(id -u)/$label"
  echo "  loaded $label"
}

# --- deckhand server -------------------------------------------------------
# A hand-started server would hold the port and make the agent fail on
# EADDRINUSE, so stop it first.
pkill -f "cli.ts serve" 2>/dev/null || true
fill "$TEMPLATES/no.deckhand.server.plist.template" "$AGENTS/no.deckhand.server.plist"
load "no.deckhand.server" "$AGENTS/no.deckhand.server.plist"

# --- cloudflare tunnel -----------------------------------------------------
if [ -n "$CLOUDFLARED" ] && [ -n "$TUNNEL_ID" ]; then
  # Only a hand-started copy, as documented in ops/README.md. It deliberately does
  # not match deckhand's own agent, whose argv is `tunnel --protocol http2 run <id>`;
  # that one is stopped by the `launchctl bootout` in load(), by label, not by argv.
  pkill -f "cloudflared tunnel run" 2>/dev/null || true
  fill "$TEMPLATES/no.deckhand.tunnel.plist.template" "$AGENTS/no.deckhand.tunnel.plist"
  load "no.deckhand.tunnel" "$AGENTS/no.deckhand.tunnel.plist"
else
  echo "  skipped tunnel: cloudflared or ~/.cloudflared/config.yml (tunnel id) not found"
fi

echo "done. logs: $LOG_DIR/{server,tunnel}.log"
echo "status: launchctl list | grep no.deckhand"
