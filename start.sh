#!/usr/bin/env bash
# Hannibal V2 launcher — runnable from anywhere:  ~/hannibal-v2/start.sh
#
#   start.sh         start Hannibal as a normal Mac app (same as the Dock icon)
#   start.sh --fg    run in this Terminal with live log output (for debugging)
#   start.sh --stop  quit Hannibal
#   start.sh --log   follow the log of the running app
#
# Why it starts through `open`: macOS then treats Hannibal as its own app, so the
# microphone permission belongs to Hannibal itself and works the same no matter
# how it was started (Terminal, background script, Dock).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

APP="$DIR/node_modules/electron/dist/Electron.app"
LOGDIR="$HOME/Library/Logs/Hannibal"
LOG="$LOGDIR/hannibal.log"
mkdir -p "$LOGDIR"

case "${1:-}" in
  --stop) pkill -f "$APP/Contents/MacOS/Electron" && echo "Hannibal stopped." || echo "Hannibal was not running."; exit 0 ;;
  --log)  exec tail -n 50 -f "$LOG" ;;
esac

# First run (or after `npm install`): fetch dependencies and the Electron binary.
[ -d node_modules/electron ] || npm install
[ -d "$APP" ] || node node_modules/electron/install.js

if [ "${1:-}" = "--fg" ]; then
  shift
  exec "$APP/Contents/MacOS/Electron" "$DIR" "$@"
fi

# Already running? Just bring it to the front (never a second copy).
if pgrep -f "$APP/Contents/MacOS/Electron" >/dev/null; then
  open -a "$APP"
  echo "Hannibal is already running — brought it to the front."
  exit 0
fi

# Keep the previous log, start a fresh one.
[ -f "$LOG" ] && mv -f "$LOG" "$LOG.1"
open -n -a "$APP" --stdout "$LOG" --stderr "$LOG" --args "$DIR" "$@"
echo "Hannibal started.  Log: $LOG   (stop with: $DIR/start.sh --stop)"
