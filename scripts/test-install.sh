#!/usr/bin/env bash
# scripts/test-install.sh <export-dir>
# End-to-end install test from a clean machine state: temp HOME and data dir, the README's own commands, a real agent
# with the trivial custom harness in scripts/test-harness.sh, a DM, and the agent's reply. No listener is exposed beyond
# 127.0.0.1 and a random port; everything is removed on exit.
set -euo pipefail

EXPORT=${1:?usage: test-install.sh <export-dir>}
EXPORT=$(cd "$EXPORT" && pwd)
TMP=$(mktemp -d "${TMPDIR:-/tmp}/fleet-install-XXXXXX")
PORT=$(( (RANDOM % 20000) + 24000 ))
export HOME="$TMP/home"
# The running fleet helper may export FLEET_HOME/FLEET_TOKEN into this shell. The test must not touch the real ~/.fleet,
# or it would overwrite the person's login.json and hub.json.
unset FLEET_HOME FLEET_URL FLEET_TOKEN FLEET_HARNESS FLEET_MODEL FLEET_WORKDIR FLEET_EXTRA_ARGS FLEET_UNTRUSTED
export FLEET_HOME="$TMP/home/.fleet"
mkdir -p "$HOME" "$FLEET_HOME"

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }
cleanup() {
  set +e
  if [ -x "$HOME/.local/bin/fleet" ]; then "$HOME/.local/bin/fleet" hub stop >/dev/null 2>&1; fi
  [ -n "${HUB_PID:-}" ] && kill "$HUB_PID" >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

# The README is the contract: every command this script runs must still appear there. Uses the literal text, so a README
# rewrite that drops or renames a command fails this test instead of surprising a new user.
readme_has() { grep -Fq -- "$1" "$EXPORT/README.md" || fail "README.md no longer contains: $1"; }

step "clone the exported release using the README URL (local-only URL rewrite)"
PUBLIC_REPO=https://github.com/alperiox/defleet
git -C "$TMP" -c "url.file://$EXPORT.insteadOf=$PUBLIC_REPO" clone "$PUBLIC_REPO"
cd "$TMP/defleet"

step "README commands this test exercises"
readme_has 'git clone https://github.com/alperiox/defleet'
readme_has 'cd defleet'
readme_has 'bun install'
readme_has 'bun cli/fleet.ts hub init'
readme_has 'fleet hub status'
readme_has 'fleet hub token'
readme_has 'fleet login http://<hub-host>:8787 <human-token>'
readme_has 'Connect my own tool'
readme_has 'Start agent'
readme_has '/install.sh | sh'
echo "README still documents every step used here."

step "bun install"
bun install >/dev/null

step "bun cli/fleet.ts hub init --owner tester --host 127.0.0.1 --port $PORT --dir $TMP/data"
bun cli/fleet.ts hub init --owner tester --host 127.0.0.1 --port "$PORT" --dir "$TMP/data" >"$TMP/init.log" 2>&1 \
  || { cat "$TMP/init.log"; fail "hub init failed"; }
FLEET="$HOME/.local/bin/fleet"
[ -x "$FLEET" ] || fail "hub init did not install the fleet command at $FLEET"
grep -q "Fleet is running" "$TMP/init.log" || { cat "$TMP/init.log"; fail "hub init did not report a running hub"; }
TOKEN=$("$FLEET" hub token) || fail "fleet hub token failed"
[ -n "$TOKEN" ] || fail "fleet hub token printed nothing"

step "the hub answers on 127.0.0.1:$PORT"
for i in $(seq 1 40); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.25; done
CODE_UI=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
CODE_ANON=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/state")
CODE_AUTH=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/state")
echo "GET /            -> $CODE_UI"
echo "GET /api/state   -> $CODE_ANON without a token, $CODE_AUTH with the master token"
[ "$CODE_UI" = 200 ] || fail "the UI did not answer 200"
[ "$CODE_ANON" = 401 ] || fail "api/state did not refuse an anonymous request"
[ "$CODE_AUTH" = 200 ] || fail "api/state did not accept the master token"

step "README served installer (isolated home)"
curl -fsSL "http://127.0.0.1:$PORT/install.sh" | sh >"$TMP/installer.log" 2>&1 \
  || { cat "$TMP/installer.log"; fail "served installer failed"; }

step "fleet login (the README's sign-in path)"
"$FLEET" login "http://127.0.0.1:$PORT" "$TOKEN" >/dev/null || fail "fleet login failed"

step "fleet agent add demo --harness custom (self-check included)"
mkdir -p "$TMP/work"
"$FLEET" hub status >/dev/null
"$FLEET" agent add demo --harness custom \
  --run-cmd "bash $TMP/defleet/scripts/test-harness.sh {prompt}" --dir "$TMP/work" --permissions open >"$TMP/add.log" 2>&1 \
  || { cat "$TMP/add.log"; fail "fleet agent add failed"; }
grep -q "is online" "$TMP/add.log" || { cat "$TMP/add.log"; fail "the agent did not come online"; }

step "send a DM through the API and wait for the agent's reply"
curl -fsS -X POST "http://127.0.0.1:$PORT/api/dm/demo" -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"hello from the install test"}' >/dev/null || fail "the DM request failed"
for i in $(seq 1 120); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/state" | grep -Fq "pong from the install test"; then
    echo "the agent replied: pong from the install test"
    break
  fi
  [ "$i" = 120 ] && fail "no reply from the agent after 60s (see fleet logs demo)"
  sleep 0.5
done

step "teardown"
"$FLEET" agent rm demo >/dev/null 2>&1 || true
"$FLEET" hub stop >/dev/null || true
trap - EXIT
rm -rf "$TMP"
printf '\ninstall test passed\n'
