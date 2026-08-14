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
[ -n "$NODE" ] || { echo "error: node not on PATH — install Node (nvm) first" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE")"

# The agent's PATH: a LaunchAgent inherits nothing from the user's shell, so
# every build tool has to be named. Resolve the ones that live outside the
# standard prefixes on this machine — CocoaPods (a Ruby gem bin dir; without it
# `ns run ios` exits 127 at "Installing pods..."), the Android SDK tools, and
# every package manager install-deps dispatches to (bun's own installer uses
# ~/.bun/bin and pnpm's ~/Library/pnpm, so a lockfile for either exits 127 under
# the agent while the same build works in a terminal).
AGENT_PATH="$NODE_DIR"
# `dirname` of a missing tool used to yield "/", which is a directory — so a Mac
# without CocoaPods got a bare "/" component in the agent's PATH.
tool_dir() { p="$(command -v "$1" 2>/dev/null)" && dirname "$p" || echo ""; }
# The package managers come after the SDK dirs: one of them usually resolves to
# /opt/homebrew/bin, and hoisting that prefix would let a brewed adb outrank the
# SDK's.
for d in \
  "$(tool_dir pod)" \
  "$(tool_dir ruby)" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/platform-tools" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/emulator" \
  "${ANDROID_HOME:-$HOME/Library/Android/sdk}/cmdline-tools/latest/bin" \
  "$(tool_dir bun)" \
  "$(tool_dir yarn)" \
  "$(tool_dir pnpm)" \
  "$(tool_dir npm)" \
  /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin
do
  [ -n "$d" ] || continue
  case ":$AGENT_PATH:" in *":$d:"*) continue ;; esac   # de-dupe
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
