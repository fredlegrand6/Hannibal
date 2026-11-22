#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────
# Put Hannibal on the always-on server. Run on the Mac, from the project folder:
#     ./server/deploy.sh
# It copies the code (and, the first time, your facts and reminders) to the
# server, builds and starts the hannibal-server container, then tells the Mac
# app to leave Telegram to the server and restarts it. Safe to run again to
# update: the server keeps its own facts, reminders and brief state.
#   HANNIBAL_SERVER_SSH  ssh host (default GEX131, the same one the desk uses)
#   --auto  used by Hannibal's self-update (electron/services/self-update.js):
#           no terminal, and the Mac app is not restarted (it does that itself).
# ─────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")/.."
HOST="${HANNIBAL_SERVER_SSH:-GEX131}"
AUTO=0; [ "${1:-}" = "--auto" ] && AUTO=1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
REMOTE_DIR='hannibal-server'

[ -f .env ] || { echo "No .env here. Run this from the hannibal-v2 folder."; exit 1; }
grep -q '^TELEGRAM_BOT_TOKEN=' .env || { echo "TELEGRAM_BOT_TOKEN is missing from .env."; exit 1; }

# The secret the Mac uses to link to the server (made once, kept in .env).
if ! grep -q '^BODY_LINK_TOKEN=' .env; then
  printf '\nBODY_LINK_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env
fi
# The key for the phone app (made once, kept in .env).
if ! grep -q '^PHONE_APP_TOKEN=' .env; then
  printf '\nPHONE_APP_TOKEN=%s\n' "$(openssl rand -hex 24)" >> .env
fi

echo "1/4  Copying Hannibal to $HOST ..."
export COPYFILE_DISABLE=1   # no macOS extended attributes in the copy
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/app/seed"
tar cf - package.json package-lock.json server electron/services | tar xf - -C "$STAGE/app"
for f in memory-facts.json reminders.json; do [ -f "data/$f" ] && cp "data/$f" "$STAGE/app/seed/"; done
# The server's own .env: the Mac's, with the server's short name turned into its IP
# and Telegram on (the Mac switch below is for the Mac only).
grep -v '^HANNIBAL_SERVER_TELEGRAM=' .env | sed 's#//gex131-1:#//100.99.70.113:#g' > "$STAGE/app/.env"
printf '\nBODY_LINK_HOST=100.99.70.113\n' >> "$STAGE/app/.env"
chmod 600 "$STAGE/app/.env"
printf ".env\ndata\nseed\n" > "$STAGE/app/.dockerignore"
tar czf - -C "$STAGE/app" . | ssh "$HOST" "mkdir -p ~/$REMOTE_DIR/data && tar xzf - -C ~/$REMOTE_DIR && chmod 600 ~/$REMOTE_DIR/.env"

echo "2/4  Building and starting the server (first time takes a few minutes) ..."
if [ -t 0 ] && [ "$AUTO" = 0 ]; then ssh -t "$HOST" "bash ~/$REMOTE_DIR/server/remote-up.sh"
else ssh -o BatchMode=yes "$HOST" "bash ~/$REMOTE_DIR/server/remote-up.sh"; fi

echo "3/4  Handing Telegram over to the server ..."
if grep -q '^HANNIBAL_SERVER_TELEGRAM=' .env; then
  sed -i '' 's/^HANNIBAL_SERVER_TELEGRAM=.*/HANNIBAL_SERVER_TELEGRAM=1/' .env
else
  printf '\nHANNIBAL_SERVER_TELEGRAM=1\n' >> .env
fi

if [ "$AUTO" = 1 ]; then echo "Done (server updated; the Mac app restarts itself when Fred is away)."; exit 0; fi
echo "4/4  Restarting Hannibal on the Mac ..."
./start.sh --stop >/dev/null 2>&1 || true
sleep 2
open ~/Applications/Hannibal.app 2>/dev/null || ./start.sh
echo
echo "Done. Hannibal now answers on Telegram from the server, even with the Mac off."
echo "The phone app link was sent to you on Telegram (once): open it on your phone."
echo "Undo: set HANNIBAL_SERVER_TELEGRAM=0 in .env, restart Hannibal, and run: ssh $HOST docker stop hannibal-server"
