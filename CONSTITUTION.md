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

**One operator per install. There is no team model, and adding one back is a
constitutional change, not a feature.** One Mac holds one person's devices — the
default cap is six in total, and two concurrent builds are felt — so a shared install
does not reach a team however the permissions are written; a second person gets their
own deckhand. What DOES cross people is the share link: that is how a colleague
watches, and it needs no token. So authenticating IS authorizing. Every token is the
operator's; a second one is a second CLIENT (the desktop app, another machine).

*(Roles and `owners` scoping existed until 2026-08-05. `owners` returned "allowed"
whenever it was unset — which is how every token the CLI ever minted looked — so the
scope read as a protection while granting everything, and the gates built on it read
as a permission system that was not there. Same lesson as `allowForkPRs`: a
protection that only reads as one is worse than none.)*

---

## The ten

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
for the install that runs more than one client.)*

### 8. Lead with the action, not the report

The reader stops after three lines. If the thing they must do is item four in a
list of green ticks, it did not happen.

*(A setup run ended by listing three next steps; the only one that mattered — paste
the connector URL — came third, and the install sat unusable.)*

**So:** one action, first, in the fewest words that can be acted on. Status after,
or not at all.

### 9. Whatever a human catches, a check must catch next time

A defect found by a person reading, not a test running, is unfinished work. Fix it,
then write the check — and if it cannot be mechanical, say so where the next reader
will be.

*(Every guardrail in this repo was born this way. Four were born in one day, from
things a user found by typing what we had told them to.)*

**So:** the `shipping-a-change` skill runs before every PR, and step 5 of it is that
conversion. Skipping it is how the docs went stale four times in a day.

### 10. What you worked out belongs in deckhand, not in your memory

An agent's session ends. The next one starts with nothing, and re-learns the same
thing at the same cost — or worse, does not, and gets it wrong the way the last one
did before it figured it out.

So a working answer is not finished when it works. It is finished when it is
somewhere the next agent reads without being told to look: a tool's output at the
moment it is needed, `AGENTS.md`, a check that fails. "I know to do X" is a note in
a transcript nobody will open.

The test is simple and unkind: **if this session's transcript were deleted, would a
fresh agent still do the right thing?** If the answer is no, the work is not done.

*(Every recurring cost in this repo was once something an agent knew and did not
write down. The dev menu covering the app's top-right corner was rediscovered three
times — twice reported as an app bug — before it became something `describe` says.)*

**So:** when you find the way through something, the PR is not the fix alone. It is
the fix plus the place the next agent will meet it.

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
