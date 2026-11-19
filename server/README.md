# Hannibal server (always on)

Hannibal without the Mac, running 24/7 on GEX131 in Docker. It answers on
Telegram, sends the morning brief and reminders to the phone (text and a voice
note), listens to voice notes, and uses the tools that need no Mac: calendar,
mail (read), web search and fetch, world/news, server health, reminders, saved
facts and the Qdrant memory. Mac-only tools (apps, camera, screen, WhatsApp,
sending mail through Mail.app) are not offered here.

## Install or update

On the Mac, in the project folder:

    ./server/deploy.sh

It copies the code to `~/hannibal-server` on the server (over the same ssh host
the desk uses, `GEX131`), builds the `hannibal-server` image and starts it with
`--restart unless-stopped`. The first time it also brings over the Mac's saved
facts and reminders. Then it sets `HANNIBAL_SERVER_TELEGRAM=1` in the Mac's
`.env` (one Telegram listener per bot) and restarts the desk app.

## Day to day

    ssh GEX131 docker logs -f hannibal-server      # watch it
    ssh GEX131 docker restart hannibal-server      # restart it

Its facts, reminders and brief state live in `~/hannibal-server/data` on the
server. Its `.env` is the Mac's, copied at each deploy.

## Undo

Set `HANNIBAL_SERVER_TELEGRAM=0` in the Mac's `.env`, restart Hannibal, and
run `ssh GEX131 docker stop hannibal-server`.

## Test

    node server/test-server.js
