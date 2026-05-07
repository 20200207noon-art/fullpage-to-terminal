#!/bin/bash
# Native Messaging host: receive an absolute image path from the Chrome extension
# and write it to the macOS clipboard as a file reference (equivalent to Finder ⌘C). Claude Code TUI ⌘V auto-attaches.

set -euo pipefail

LOG=/tmp/fullpage-shot-host.log
echo "=== $(date) host called ===" >> "$LOG"

# Chrome Native Messaging protocol: read 4-byte little-endian uint32 (length), then that many bytes of JSON
read_message() {
  local length_bytes
  length_bytes=$(dd bs=4 count=1 2>/dev/null | xxd -p)
  if [ -z "$length_bytes" ]; then return 1; fi
  # little-endian → decimal
  local b0 b1 b2 b3
  b0=$((16#${length_bytes:0:2}))
  b1=$((16#${length_bytes:2:2}))
  b2=$((16#${length_bytes:4:2}))
  b3=$((16#${length_bytes:6:2}))
  local len=$((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)))
  dd bs=1 count="$len" 2>/dev/null
}

send_message() {
  local msg="$1"
  local len=${#msg}
  printf "$(printf '\\x%02x\\x%02x\\x%02x\\x%02x' \
    $((len & 0xff)) $(((len >> 8) & 0xff)) $(((len >> 16) & 0xff)) $(((len >> 24) & 0xff)))"
  printf '%s' "$msg"
}

msg=$(read_message)
echo "received msg: $msg" >> "$LOG"

# Extract `path` from JSON (jq if available, fallback to sed)
if command -v jq >/dev/null 2>&1; then
  path=$(echo "$msg" | jq -r '.path // empty')
else
  path=$(echo "$msg" | sed -n 's/.*"path":[[:space:]]*"\([^"]*\)".*/\1/p')
fi

echo "extracted path: $path" >> "$LOG"

if [ -z "$path" ] || [ ! -f "$path" ]; then
  echo "file not found, exit" >> "$LOG"
  send_message "{\"ok\":false,\"error\":\"file not found: ${path}\"}"
  exit 0
fi

# Write "full clipboard" mimicking Finder ⌘C on an image file:
# simultaneously sets furl (file reference) + PNGf (PNG bytes) + plain text (path string).
# macOS auto-derives JPEG / TIFF / AVIF formats from these.
# Critical: plain text must be present, otherwise terminal ⌘V pastes nothing.
osascript 2>/tmp/fullpage-shot-host.err <<EOF
set p to "${path}"
set fileRef to (POSIX file p)
set imgData to (read fileRef as «class PNGf»)
set the clipboard to {«class furl»:fileRef, «class PNGf»:imgData, string:p}
EOF
ec=$?

if [ $ec -ne 0 ]; then
  err=$(cat /tmp/fullpage-shot-host.err 2>/dev/null || echo "osascript failed")
  echo "osascript FAILED: $err" >> "$LOG"
  send_message "{\"ok\":false,\"error\":\"${err}\"}"
  exit 0
fi

echo "osascript OK, clipboard set to file ref of $path" >> "$LOG"
send_message "{\"ok\":true,\"path\":\"${path}\"}"
