#!/bin/sh
# Start a virtual display when running a headed browser.
#
# Headed Chromium is the configuration real people run, and websites treat
# headless as unusual. Running on Xvfb is not a disguise: it is a genuine
# browser with a genuine display. The cost is measured in docs/performance.md -
# headed Chromium composites windows differently, which affects multi-tab
# streaming, so headless remains the default.
set -e

if [ "${CHROMIUM_HEADLESS}" = "false" ]; then
  DISPLAY="${DISPLAY:-:99}"
  export DISPLAY
  echo "{\"level\":\"info\",\"msg\":\"starting Xvfb\",\"display\":\"${DISPLAY}\"}"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_GEOMETRY:-1920x1080x24}" -nolisten tcp -dpi 96 &
  # Wait for the X socket rather than sleeping a fixed amount.
  i=0
  while [ "$i" -lt 100 ]; do
    [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] && break
    i=$((i + 1))
    sleep 0.1
  done
  [ -e "/tmp/.X11-unix/X${DISPLAY#:}" ] || { echo "Xvfb failed to start" >&2; exit 1; }

  # A window manager is required, not cosmetic: without one, X ignores the
  # window resizes Chromium requests, so a tab's window stays the size it was
  # created at. A headed renderer cannot exceed its window and anything smaller
  # than the window arrives as black padding - so the viewport could never
  # change. openbox is ~1MB and does nothing else.
  echo "{\"level\":\"info\",\"msg\":\"starting window manager\"}"
  openbox --sm-disable >/dev/null 2>&1 &
  sleep 0.3
fi

exec "$@"
