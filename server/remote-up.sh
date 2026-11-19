#!/bin/bash
# Runs ON the server (called by server/deploy.sh): builds and (re)starts the
# hannibal-server container. Uses sudo for docker only if needed.
set -e
cd ~/hannibal-server
for f in memory-facts.json reminders.json; do
  if [ -f "seed/$f" ] && [ ! -f "data/$f" ]; then cp "seed/$f" "data/$f"; echo "     brought over your $f"; fi
done
D=docker; $D ps >/dev/null 2>&1 || D="sudo docker"
$D build -q -t hannibal-server -f server/Dockerfile . >/dev/null
$D rm -f hannibal-server >/dev/null 2>&1 || true
$D run -d --name hannibal-server --restart unless-stopped --network host \
  -v "$HOME/hannibal-server/data:/app/data" -v "$HOME/hannibal-server/.env:/app/.env:ro" \
  hannibal-server >/dev/null
sleep 8
$D logs --tail 8 hannibal-server
$D ps --filter name=hannibal-server --format '     container: {{.Status}}'
