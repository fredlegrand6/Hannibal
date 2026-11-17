#!/usr/bin/env bash
# Start Hannibal automatically when you log in to your Mac.
#
#   scripts/autostart.sh on      Hannibal starts by itself at every login
#   scripts/autostart.sh off     stop doing that
#   scripts/autostart.sh status  is it on?
#
# It adds a small macOS "LaunchAgent" that runs start.sh once at login, so the
# app starts exactly as if you had run start.sh yourself (same mic permission).
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.revalis.hannibal"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

case "${1:-status}" in
  on)
    mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs/Hannibal"
    cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/start.sh</string></array>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/Hannibal/autostart.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/Hannibal/autostart.log</string>
</dict>
</plist>
PL
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "Done. Hannibal will now start by itself every time you log in."
    ;;
  off)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Done. Hannibal will no longer start by itself at login."
    ;;
  status)
    [ -f "$PLIST" ] && echo "Auto-start is ON." || echo "Auto-start is OFF."
    ;;
  *) echo "Use: $0 on | off | status"; exit 1 ;;
esac
