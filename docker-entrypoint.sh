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
  # The virtual screen has to be at least as large as the largest viewport we
  # will ever ask a window for. A window cannot be bigger than the screen it is
  # on, and a screencast of a viewport bigger than its window comes back BLACK -
  # which is exactly what zooming out used to produce. Derived from the same
  # numbers rather than hardcoded, so the two cannot disagree.
  # Times the device scale factor: viewports are CSS pixels but a screen is real
  # ones, so at DEVICE_SCALE_FACTOR=2 a 1920-wide window covers 3840 of them and
  # a screen sized for 1920 would clip it - back to black frames.
  DSF="${DEVICE_SCALE_FACTOR:-1}"
  # awk rather than $(( )): the scale factor is allowed to be fractional, and
  # shell arithmetic is integer-only - "1.5" makes it fail and leaves the
  # geometry empty, which surfaces as "Xvfb failed to start" with no hint why.
  # Anything unparseable falls back to 1x instead of a zero-sized screen.
  # Clamped to 1..3 exactly as config.ts does (see scaleFactor there): if the
  # server scaled by more than this screen allows, the window would be larger
  # than the screen it is on and every frame would come back black. The `+ 0`
  # coercions matter - awk compares a non-numeric -v as a string, and "abc" > "3"
  # is true, which would silently pick 3x for a typo.
  scaled() { awk -v v="$1" -v d="$DSF" 'BEGIN { v = v + 0; d = d + 0; if (!(d > 1)) d = 1; if (d > 3) d = 3; printf "%d", (v * d) + 0.999 }'; }
  SCREEN_W=$(scaled "${MAX_VIEWPORT_WIDTH:-1920}")
  SCREEN_H=$(scaled "${MAX_VIEWPORT_HEIGHT:-1080}")
  echo "{\"level\":\"info\",\"msg\":\"virtual screen\",\"geometry\":\"${XVFB_GEOMETRY:-${SCREEN_W}x${SCREEN_H}x24}\"}"
  Xvfb "${DISPLAY}" -screen 0 "${XVFB_GEOMETRY:-${SCREEN_W}x${SCREEN_H}x24}" -nolisten tcp -dpi 96 &
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
