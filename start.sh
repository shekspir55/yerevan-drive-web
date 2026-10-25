#!/bin/sh
# Serve the web port (+ multiplayer relay) and open it. Needs node. Game files are read from web/game (a link to the installed game).
cd "$(dirname "$0")" || exit 1
PORT=${1:-8099}
URL="http://localhost:$PORT/"
if curl -s -o /dev/null --max-time 1 "${URL}index.html"; then
  echo "Server already running at $URL"
  xdg-open "$URL" >/dev/null 2>&1
  exit 0
fi
echo "Yerevan Drive web port: $URL  (Ctrl+C to stop)"
(sleep 1; xdg-open "$URL" >/dev/null 2>&1) &
exec node server.js "$PORT"
