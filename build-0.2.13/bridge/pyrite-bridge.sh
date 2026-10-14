#!/bin/sh
# Edge starts this with the extension's origin as $1; `pyrite-bridge.sh --selftest` runs the
# self-test. A native host inherits no shell PATH, so it runs the absolute node the installer
# recorded in config.json. That file lives in Pyrite's own folder, not here; PYRITE_CONFIG names
# another one, for the live test harness.
DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${PYRITE_CONFIG:-$HOME/Library/Application Support/Pyrite/config.json}"
NODE="$(/usr/bin/plutil -extract node raw -o - "$CONFIG" 2>/dev/null)"
case "$NODE" in
  /*) ;;
  *)
    # Edge gets no output from a host that cannot start; the self-test says why
    [ "${1:-}" = "--selftest" ] && echo "FAIL config: no usable config.json; run install-mac.sh"
    exit 1 ;;
esac
exec "$NODE" "$DIR/pyrite-bridge.mjs" "$@"
