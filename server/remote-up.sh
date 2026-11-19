#!/bin/bash
# Runs ON the server (called by server/deploy.sh): builds and (re)starts the
# hannibal-server container. Uses sudo for docker only if needed.
set -e
cd ~/hannibal-server
for f in memory-facts.json reminders.json; do
  if [ -f "seed/$f" ] && [ ! -f "data/$f" ]; then cp "seed/$f" "data/$f"; echo "     brought over your $f"; fi
done
# The phone app over https (the phone only allows the microphone on https):
# Tailscale serves it on this machine's private tailnet name, port 8443.
if command -v tailscale >/dev/null 2>&1; then
  T=tailscale; tailscale status >/dev/null 2>&1 || T="sudo tailscale"
  if $T serve --bg --https=8443 http://127.0.0.1:8791 >/dev/null 2>&1; then
    NAME=$($T status --json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null || true)
    [ -n "$NAME" ] && echo "https://$NAME:8443" > data/phone-url.txt && echo "     phone app: https://$NAME:8443"
  else
    echo "     phone app: https not set up (turn on HTTPS certificates in the Tailscale admin, then deploy again)."
    echo "http://100.99.70.113:8791" > data/phone-url.txt
  fi
fi
D=docker; $D ps >/dev/null 2>&1 || D="sudo docker"
$D build -q -t hannibal-server -f server/Dockerfile . >/dev/null
$D rm -f hannibal-server >/dev/null 2>&1 || true
$D run -d --name hannibal-server --restart unless-stopped --network host \
  -v "$HOME/hannibal-server/data:/app/data" -v "$HOME/hannibal-server/.env:/app/.env:ro" \
  hannibal-server >/dev/null
sleep 8
$D logs --tail 8 hannibal-server
$D ps --filter name=hannibal-server --format '     container: {{.Status}}'
