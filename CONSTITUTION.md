# Deckhand — what it is, and how we decide

Read this before PLAN, before AGENTS, before the code. It is short on purpose.

PLAN says what the system *is*. AGENTS says how work *lands*. This says what to do
when those two do not settle an argument — which is most arguments worth having.

---

## The one sentence

**One Mac turns any branch into a live, controllable device in a browser, reachable
from anywhere, driven by an agent.**

Everything else is in service of that. If a change does not make that sentence more
true, or more reliable, it needs a reason.

## Who it is for

One developer, on their own Mac, who wants to see their branch running on a phone
without building it themselves — and an agent that can drive it for them.

Teams are a real case and the code supports them (token roles, owner scoping). They
are **never the default**. A person setting deckhand up alone must not have to learn
that other people exist.

---

## The seven

Each of these was paid for. The parenthetical is what it cost.

### 1. An instruction that cannot be followed is worse than none

The reader assumes the mistake is theirs, and stops.

*(`deckhand` was not a command while every document said to type it. `token list`
"shows the connector URL" — it did not. `init` needed a hostname you could not have
yet. Three in one day, all found by a person typing what we told them to.)*

**So:** run it yourself, as written, from where the reader will be. Docs are claims
to verify, not prose to compose.

### 2. Never destroy what you did not create

Config files, checkouts, lockfiles, someone else's tunnel rules. Merge, never
generate. Back up before writing. When you cannot proceed safely, refuse and say
why — the file is the operator's, and their work is not ours to lose.

*(A setup command that generated `~/.cloudflared/config.yml` would have deleted an
unrelated service. `pod install` rewrote a tracked file in a borrowed checkout. A
corrupt `state.json` was overwritten, taking every PIN hash with it.)*

### 3. An empty result and a failed lookup must not be the same value

The archetype, and the most expensive class in this codebase.

*(`loadAppsSafe()` → `[]` erased the app registry. `describe` → `""` told an agent
the screen was blank. `state.json` unreadable → empty → overwritten. Four bugs,
same shape.)*

**So:** for every `catch {}`, `?? []`, `|| false`, or unchecked exit code, ask which
direction it fails in, and whether that is the safe one.

### 4. Fail closed at the boundary, fail open at the door

A security decision refuses when uncertain. **Boot does not.** A server that cannot
start cannot be repaired through its own onboarding — and `add_app`, the setup URL
and `list_apps` all live inside it.

*(The PIN gate now rejects an unresolvable share id. A bad `apps.yaml` used to make
the server refuse to start, which is unfixable remotely.)*

### 5. A test that has never failed proves nothing

Write it, break the thing it guards, watch it fail, put it back. Say in the commit
that you saw it fail.

*(Mutation testing caught six checks passing for the wrong reason in one day —
including one that read its own explanatory comment as if it were code, and one
that scanned `.ts` while the bug lived in `.tsx`.)*

### 6. Say what you did not verify

A green suite that implies more than it proves is worse than a red one. Name the
gap: which check covers which half, what needs hardware, what you could not run.

*(A guard was kept as defence in depth and the PR said so, because mutation showed
it was no longer independently observable.)*

### 7. The simple path is the default; the powerful path is opt-in

Ceremony a solo user cannot skip is a bug. Hide the general case behind the obvious
one — do not remove it.

*(`deckhand token` prints your URL. `token list` and `token url <name>` still exist,
for the team that needs them.)*

---

## The bar for setup

**Anyone should get deckhand running on the first attempt.**

That is a testable claim, not an aspiration. It means:

- one command does the install, and is safe to run again
- every prerequisite it cannot install is named with the exact command
- nothing in the shipped product mentions one particular install — no hostnames,
  no private repos, no usernames
- the first thing a new user is told to type must work from *their* directory

When you change setup, wipe `~/.deckhand`, uninstall the services, and do it for
real. `DECKHAND_HOME` makes the rehearsal free; the real thing catches what the
rehearsal cannot.

---

## When these conflict

Safety of someone's data beats convenience. Convenience for the solo user beats
generality. Generality beats elegance. Elegance is not a reason.
