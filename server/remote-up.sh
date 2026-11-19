#!/bin/bash
# Runs ON the server (called by server/deploy.sh): builds and (re)starts the
# hannibal-server container. Uses sudo for docker only if needed.
set -e
cd ~/hannibal-server
for f in memory-facts.json reminders.json; do
  if [ -f "seed/$f" ] && [ ! -f "data/$f" ]; then cp "seed/$f" "data/$f"; echo "     brought over your $f"; fi
done
# Fallback link (plain http, works without the https step below).
echo "http://100.99.70.113:8791" > data/phone-url.txt
D=docker; $D ps >/dev/null 2>&1 || D="sudo docker"
$D build -q -t hannibal-server -f server/Dockerfile . >/dev/null
$D rm -f hannibal-server >/dev/null 2>&1 || true
$D run -d --name hannibal-server --restart unless-stopped --network host \
  -v "$HOME/hannibal-server/data:/app/data" -v "$HOME/hannibal-server/.env:/app/.env:ro" \
  hannibal-server >/dev/null
sleep 8
$D logs --tail 8 hannibal-server
$D ps --filter name=hannibal-server --format '     container: {{.Status}}'
# The phone app over https (the phone only allows the microphone on https):
# Tailscale serves it on this machine's private tailnet name, port 8443.
# Done AFTER the container is up, and with a time limit: when Serve/HTTPS is
# not switched on for the tailnet, `tailscale serve` waits forever for you to
# click a link, which used to freeze the whole deploy at step 2/4.
if command -v tailscale >/dev/null 2>&1; then
  T=tailscale; tailscale status >/dev/null 2>&1 || T="sudo -n tailscale"
  OUT=$(timeout 20 $T serve --bg --https=8443 http://127.0.0.1:8791 2>&1 </dev/null) && OK=1 || OK=0
  if [ "$OK" = 1 ]; then
    NAME=$($T status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
    [ -n "$NAME" ] && echo "https://$NAME:8443" > data/phone-url.txt && echo "     phone app: https://$NAME:8443" || true
  else
    echo "     phone app: https is not switched on yet, so for now it runs on http://100.99.70.113:8791"
    LINK=$(printf '%s\n' "$OUT" | grep -Eo 'https://login\.tailscale\.com[^ ]*' | head -1)
    [ -n "$LINK" ] && echo "     To switch https on, open: $LINK  (then run ./server/deploy.sh again)" || true
  fi
fi
exit 0
