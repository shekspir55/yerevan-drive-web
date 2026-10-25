#!/bin/sh
# Run the original Windows game under Wine, using the Wine prefix kept in this folder.
# The game switches the monitor to 1024x768; this restores every output's mode/position afterwards.
HERE="$(cd "$(dirname "$0")" && pwd)"
export WINEPREFIX="$HERE/wineprefix"
export WINEDEBUG=${WINEDEBUG:--all}

SAVED=""
if command -v xrandr >/dev/null 2>&1 && [ -n "$DISPLAY" ]; then
  SAVED=$(xrandr --current | awk '/ connected/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+[0-9]+\+[0-9]+$/) { split($i, a, /[x+]/); print $1, a[1] "x" a[2], a[3] "x" a[4] } }')
fi
restore() {
  [ -n "$SAVED" ] || return
  echo "$SAVED" | while read -r o m p; do xrandr --output "$o" --mode "$m" --pos "$p" >/dev/null 2>&1; done
}
trap restore EXIT INT TERM

cd "$WINEPREFIX/drive_c/Program Files (x86)/Emergency/Yerevan Drive version 1.1" || exit 1
wine "Yerevan Drive.exe"
