#!/bin/sh
# Local second-copy backup. Destination should be a second disk or machine-mounted volume.
# Usage: backup.sh <fleet.db> <data-directory> <backup-root> [--drill]
set -eu
[ "$#" -ge 3 ] || { echo 'usage: backup.sh <fleet.db> <data-dir> <backup-root> [--drill]' >&2; exit 1; }
db=$1; data=$2; dest=$3
[ -f "$db" ] && [ -d "$data" ] || { echo 'database or data directory missing' >&2; exit 1; }
mkdir -p "$dest/daily" "$dest/weekly"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
stage="$dest/.pending-$stamp-$$"
mkdir "$stage"
lock="$data/repos/.fleet-operation.lock"
mkdir -p "$data/repos"
locked=0
cleanup() { rm -rf "$stage"; if [ "$locked" = 1 ]; then rm -rf "$lock"; fi; }
trap cleanup EXIT HUP INT TERM
attempt=0
while ! mkdir "$lock" 2>/dev/null; do
 attempt=$((attempt + 1))
 [ "$attempt" -lt 30 ] || { echo 'repository maintenance is busy; retry backup shortly' >&2; exit 1; }
 if [ -f "$lock/pid" ]; then
  holder=$(cat "$lock/pid")
  case "$holder" in ''|*[!0-9]*) ;; *) if ! kill -0 "$holder" 2>/dev/null; then rm -rf "$lock"; fi ;; esac
 fi
 sleep 1
done
locked=1
printf '%s' "$$" > "$lock/pid"
# SQLite handles live WAL safely; never copy just fleet.db while it is open.
python3 - "$db" "$stage/fleet.db" <<'PY'
import sqlite3,sys
with sqlite3.connect(sys.argv[1]) as source, sqlite3.connect(sys.argv[2]) as target:
 source.backup(target)
 if target.execute('pragma integrity_check').fetchone()[0]!='ok': raise RuntimeError('database integrity failed')
PY
for kind in repos artifacts; do
 if [ -d "$data/$kind" ]; then rsync -a --exclude='*.lock' --exclude='tmp_objdir-*' "$data/$kind" "$stage/"; else mkdir "$stage/$kind"; fi
done
: > "$stage/main-shas.txt"
for repo in "$stage"/repos/*.git; do
 [ -d "$repo" ] || continue
 git -C "$repo" fsck --full
 sha=$(git -C "$repo" rev-parse --verify refs/heads/main 2>/dev/null || true)
 printf '%s %s\n' "$(basename "$repo")" "${sha:-unseeded}" >> "$stage/main-shas.txt"
 if [ "${4:-}" = '--drill' ] && [ -n "$sha" ]; then
  git clone --quiet --no-hardlinks "$repo" "$stage/restore-drill"
  [ "$(git -C "$stage/restore-drill" rev-parse HEAD)" = "$sha" ] || exit 1
  rm -rf "$stage/restore-drill"
 fi
done
mv "$stage" "$dest/daily/$stamp"
# One weekly copy per ISO week. Keep four weekly and seven daily complete snapshots.
week=$(date -u +%G-W%V)
if [ ! -d "$dest/weekly/$week" ]; then mkdir "$dest/weekly/$week"; rsync -a "$dest/daily/$stamp/" "$dest/weekly/$week/"; fi
python3 - "$dest" <<'PY'
from pathlib import Path
import shutil,sys
for kind,keep in [('daily',7),('weekly',4)]:
 for p in sorted((Path(sys.argv[1])/kind).iterdir(),reverse=True)[keep:]:
  if p.is_dir() and not p.is_symlink(): shutil.rmtree(p)
PY
printf 'Backup complete: %s/daily/%s\n' "$dest" "$stamp"
