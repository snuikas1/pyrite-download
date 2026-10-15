#!/bin/sh
# Installs the Pyrite bridge for Microsoft Edge and Google Chrome on macOS, for this user only. It records the
# absolute node and claude paths, creates the folder claude runs in, and registers the bridge for
# the one pinned extension. It writes only Pyrite's own files, none of them inside bridge/:
#   ~/Library/Application Support/Pyrite/config.json
#   ~/Library/Application Support/Pyrite/cwd
#   ~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.pyrite.bridge.json
#   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.pyrite.bridge.json, only
#     when Chrome's folder is there
# There is no uninstaller yet (0.2.13: the uninstall-mac.sh this line used to name was never
# shipped). To remove Pyrite, delete the files above and remove the extension in the browser.
#
#   sh install-mac.sh             install
#   sh install-mac.sh --dry-run   print everything, and write it under a temp folder instead
#   MODEL=... sh install-mac.sh   another model than the pinned one
set -eu

# Must equal EXTENSION_ID in pyrite-bridge.mjs; a unit test keeps the two equal.
EXTENSION_ID=hegfbajilkihmgclmnajpkhckogfplni
HOST=com.pyrite.bridge
# The pinned model (PLAN.md, Claude bridge): Opus 5.5 by the ruling of 2026-09-26. The deep check
# runs it at its own effort (DEEP_EFFORT in pyrite-bridge.mjs), so the config names no effort.
MODEL="${MODEL:-claude-opus-5-5}"

DRY=0
case "${1:-}" in
  --dry-run) DRY=1 ;;
  "") ;;
  *) echo "usage: sh install-mac.sh [--dry-run]" >&2; exit 2 ;;
esac

DIR="$(cd "$(dirname "$0")" && pwd -P)"
case "${HOME:-}" in /*) ;; *) echo "HOME is not an absolute path" >&2; exit 1 ;; esac

# Edge starts the bridge with no shell PATH, so both are recorded as absolute paths.
NODE="$(command -v node || true)"
CLAUDE="$(command -v claude || true)"
case "$NODE" in /*) ;; *) echo "node is not on PATH: install Node, then run this again" >&2; exit 1 ;; esac
case "$CLAUDE" in /*) ;; *) echo "claude is not on PATH: install Claude Code, then run this again" >&2; exit 1 ;; esac
"$NODE" --version >/dev/null 2>&1 || { echo "node at $NODE does not run" >&2; exit 1; }
"$CLAUDE" --version >/dev/null 2>&1 || { echo "claude at $CLAUDE does not run" >&2; exit 1; }

APP="$HOME/Library/Application Support/Pyrite"
CWD="$APP/cwd"
CONFIG="$APP/config.json"
MANIFEST="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$HOST.json"
# Chrome's own folder is looked for, never made: the Chrome manifest goes in only where Chrome runs.
CHROME="$HOME/Library/Application Support/Google/Chrome"
CHROME_MANIFEST="$CHROME/NativeMessagingHosts/$HOST.json"

# A dry run writes the same files at the same paths, below a temp folder.
ROOT=""
if [ "$DRY" = 1 ]; then ROOT="$(mktemp -d "${TMPDIR:-/tmp}/pyrite-dry-run.XXXXXX")"; fi

# node writes the JSON, so any character in a path is escaped correctly
CONFIG_JSON="$("$NODE" -e '
  const [node, claude, cwd, model] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ node, claude, cwd, model }, null, 2));
' "$NODE" "$CLAUDE" "$CWD" "$MODEL")"
MANIFEST_JSON="$("$NODE" -e '
  const [name, path, id] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({ name, description: "Pyrite bridge", path, type: "stdio", allowed_origins: ["chrome-extension://" + id + "/"] }, null, 2));
' "$HOST" "$DIR/pyrite-bridge.sh" "$EXTENSION_ID")"

echo "Pyrite bridge install"
if [ "$DRY" = 1 ]; then echo "Dry run: every file below is written under $ROOT instead"; fi
echo "node:   $NODE"
echo "claude: $CLAUDE"
echo

echo "create $CWD"
mkdir -p "$ROOT$CWD"

echo "write  $CONFIG"
printf '%s\n' "$CONFIG_JSON" > "$ROOT$CONFIG"
printf '%s\n\n' "$CONFIG_JSON"

echo "write  $MANIFEST"
mkdir -p "$ROOT$(dirname "$MANIFEST")"
printf '%s\n' "$MANIFEST_JSON" > "$ROOT$MANIFEST"
printf '%s\n\n' "$MANIFEST_JSON"

if [ -d "$CHROME" ]; then
  echo "write  $CHROME_MANIFEST"
  mkdir -p "$ROOT$(dirname "$CHROME_MANIFEST")"
  printf '%s\n' "$MANIFEST_JSON" > "$ROOT$CHROME_MANIFEST"
  printf '%s\n\n' "$MANIFEST_JSON"
fi

if [ "$DRY" = 1 ]; then
  echo "chmod  u+x $DIR/pyrite-bridge.sh (skipped in a dry run)"
  echo
  echo "Dry run done. Nothing outside $ROOT was written."
else
  chmod u+x "$DIR/pyrite-bridge.sh"
  echo "Done. Run the self-test next:"
  echo "  \"$DIR/pyrite-bridge.sh\" --selftest"
fi
