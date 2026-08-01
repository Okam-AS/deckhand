#!/bin/sh
# Print the version tag for the current commit, e.g. `v0.1.40`.
#
# Deckhand's identity is the commit sha (server/src/version.ts) — that is what the update
# check compares, and it cannot drift because it IS the code. This tag exists only so a human
# has something to say out loud: "v0.1.40" rather than "ab2362c".
#
# The number is `git rev-list --count HEAD`: commits on the branch, which on main only ever
# grows because main is protected against force-push and requires linear history. So it needs
# no stored state, no file to bump, no API call, and no discipline from anyone — which is the
# whole point. A version somebody has to remember to change is a version that lies.
#
# It lives in a script rather than inside the workflow YAML so it can be RUN by a test.
# Logic buried in CI configuration is logic nobody checks until it is wrong in production.
set -e

MAJOR_MINOR="${DECKHAND_VERSION_SERIES:-v0.1}"

count=$(git rev-list --count HEAD)
echo "${MAJOR_MINOR}.${count}"
