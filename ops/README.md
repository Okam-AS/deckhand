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
templates in `ops/launchd/`, stops any hand-started copies, and loads the user
agents:

- **`no.deckhand.server`** — `deckhand serve`, `KeepAlive` on.
- **`no.deckhand.tunnel`** — `cloudflared tunnel --protocol http2 run <id>`,
  `KeepAlive` on. Installed only when cloudflared and a tunnel id are both
  found; otherwise the script says it skipped this one.

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

`--protocol http2` in the tunnel template is there for the observed case of
this: all four QUIC edge connections died together on a UDP timeout and took
38 seconds to come back while the process stayed up. The plist comment carries
the captured log. It does not close the gap in general — nothing here
health-checks the tunnel, so a silent edge drop is still found by a person.
