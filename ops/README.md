# Ops — keeping deckhand up

A hand-started `deckhand serve` and `cloudflared tunnel run` do not survive a
crash, a logout, or a wake-from-sleep — when they die, deckhand goes dark until
someone restarts them by hand. These LaunchAgents fix that.

## Install (or reinstall)

```sh
./ops/install-services.sh
```

Idempotent and needs no sudo. It resolves this machine's node path, repo dir,
cloudflared path, and tunnel id (from `~/.cloudflared/config.yml`), fills the
templates in `ops/launchd/`, stops any hand-started copies, and loads two user
agents:

- **`no.deckhand.server`** — `deckhand serve`, `KeepAlive` on.
- **`no.deckhand.tunnel`** — `cloudflared tunnel run <id>`, `KeepAlive` on.

Run it again any time paths move or the tunnel id changes.

## Check / logs / remove

```sh
launchctl list | grep no.deckhand          # PID + last exit code
tail -f ~/.deckhand/logs/server.log        # deckhand
tail -f ~/.deckhand/logs/tunnel.log        # cloudflared
./ops/uninstall-services.sh                # stop + remove
```

## Caveat — Error 1033

`KeepAlive` restarts a process that *exits*. cloudflared can instead keep
running while its edge connection drops (the public URL 1033s with nothing
crashed). The agent restarts it on sleep/reboot/crash, but a silent edge drop
still needs a manual `launchctl kickstart -k gui/$(id -u)/no.deckhand.tunnel`.
A health-check watchdog for that is future Phase-4 work.
