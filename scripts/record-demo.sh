#!/bin/bash
# Records docs/media/fleet-tour-silent.mp4: a guided tour of the hub, run against a throwaway hub with demo agents.
# Needs: bun, node, ffmpeg (with ffprobe), and a Playwright install (PLAYWRIGHT_CORE) with a Chromium or Chrome (CHROME).
#
# TOUR_SPEED=8 runs a fast rehearsal. Default (1) keeps the published captions readable.
# Per-scene stills and scenes.json stay in QA (printed at the end) for visual QA; they are not part of the repo.
# The video is converted to a temporary file beside the target and moved into place only when it is complete, so a
# failed run leaves the previous video in place. On failure the hub log and partial clips stay in WORK for diagnosis.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$PATH"
PORT="${PORT:-18791}"
WORK="$(mktemp -d)"
QA="${QA_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/fleet-tour-qa.XXXXXX")}"
mkdir -p "$QA"
export HUB_HOST=127.0.0.1 HUB_DB="$WORK/hub.db" HUB_PORT="$PORT" HUB_HUMAN_TOKEN=demo-human HUB_OWNER=alex
export PLAYWRIGHT_CORE="${PLAYWRIGHT_CORE:-/opt/homebrew/lib/node_modules/@playwright/mcp/node_modules/playwright-core}"

if [ -z "${CHROME:-}" ]; then
  CHROME="$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/*/chrome-headless-shell 2>/dev/null | tail -1 || true)"
  # No cached headless shell: fall back to an installed Google Chrome, which records video the same way.
  [ -n "$CHROME" ] || CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
fi
export CHROME
if [ ! -x "$CHROME" ]; then
  echo "No browser to record with. Set CHROME to a Chrome or Chromium binary (tried: $CHROME)." >&2
  exit 1
fi

PARTIAL="docs/media/.fleet-tour-silent.mp4.partial"
HUB_PID=""
cleanup() {
  local status=$?
  if [ -n "$HUB_PID" ]; then
    kill "$HUB_PID" 2>/dev/null || true
    pkill -P "$HUB_PID" 2>/dev/null || true
    wait "$HUB_PID" 2>/dev/null || true
  fi
  if [ "$status" -ne 0 ]; then
    rm -f "$PARTIAL"
    echo "recording failed (exit $status)." >&2
    echo "  hub log and partial clips kept in: $WORK" >&2
    echo "  stills and scene timestamps kept in: $QA" >&2
    tail -20 "$WORK/hub.log" 2>/dev/null >&2 || true
  else
    rm -rf "$WORK"
  fi
  exit "$status"
}
trap cleanup EXIT

bun run src/server.ts > "$WORK/hub.log" 2>&1 &
HUB_PID=$!

# Wait for the hub to answer, but never for ever, and stop at once if it died while starting.
ready=0
for _ in $(seq 1 120); do
  if ! kill -0 "$HUB_PID" 2>/dev/null; then
    echo "the hub stopped while starting. Log:" >&2
    cat "$WORK/hub.log" >&2
    exit 1
  fi
  if curl -fsS -H "Authorization: Bearer demo-human" "http://127.0.0.1:$PORT/api/state" > /dev/null 2>&1; then ready=1; break; fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  echo "the hub did not answer on port $PORT within 30s. Log:" >&2
  tail -40 "$WORK/hub.log" >&2
  exit 1
fi

add() { bun run src/admin.ts add-agent "$1" --owner "$2" --device "$3" | tail -1; }
printf '{"claude":"%s","opencode":"%s","friend":"%s"}' \
  "$(add claude-laptop alex laptop)" "$(add opencode-mac alex mac)" "$(add friend-agent sam sams-pc)" > "$WORK/tokens.json"
for name in claude opencode friend; do
  if ! grep -q "\"$name\":\"[^\"]" "$WORK/tokens.json"; then
    echo "could not create the demo agents. Tokens file and hub log:" >&2
    cat "$WORK/tokens.json" >&2
    tail -20 "$WORK/hub.log" >&2
    exit 1
  fi
done

OUT="$WORK/out"
HUB_URL="http://127.0.0.1:$PORT" HUMAN_TOKEN=demo-human TOKENS="$WORK/tokens.json" OUT="$OUT" QA="$QA" node scripts/record-demo.mjs

mkdir -p docs/media
# Main tour: skip the blank first frames. Phone clip: centred on a dark canvas so it matches the tour's size.
# Rendered next to the target, then moved into place, so an older video survives a failed conversion.
ffmpeg -y -loglevel error \
  -ss 0.7 -i "$OUT/main.webm" -i "$OUT/phone.webm" \
  -filter_complex "[0:v]scale=1280:720,fps=25,format=yuv420p[a];[1:v]scale=-2:720,pad=1280:720:(ow-iw)/2:0:color=0x0c0c0b,fps=25,format=yuv420p[b];[a][b]concat=n=2:v=1:a=0[v]" \
  -map "[v]" -c:v libx264 -crf 22 -preset medium -movflags +faststart -f mp4 "$PARTIAL"
mv -f "$PARTIAL" docs/media/fleet-tour-silent.mp4
ls -la docs/media/fleet-tour-silent.mp4
ffprobe -v error -show_entries format=duration -of csv=p=0 docs/media/fleet-tour-silent.mp4
echo "audio streams (must be empty):"
ffprobe -v error -select_streams a -show_entries stream=codec_type -of csv=p=0 docs/media/fleet-tour-silent.mp4

echo "stills and scene timestamps: $QA"
