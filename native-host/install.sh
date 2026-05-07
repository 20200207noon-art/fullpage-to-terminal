#!/bin/bash
# One-shot install: register the Native Messaging host with Chrome.
# Run AFTER you've loaded the extension in chrome://extensions and noted its ID
# (the 32-letter string shown on the extension card).
#
# Usage: ./install.sh <EXTENSION_ID>
# Example: ./install.sh abcdefghijklmnopqrstuvwxyzabcdef

set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: ./install.sh <Chrome extension ID>"
  echo ""
  echo "How to find the extension ID:"
  echo "  1. Open chrome://extensions"
  echo "  2. Toggle 'Developer mode' (top right)"
  echo "  3. Find the Fullpage to Terminal card — the 32-letter string is the ID"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="${SCRIPT_DIR}/copy_file_to_clipboard.sh"

if [ ! -f "$HOST_SCRIPT" ]; then
  echo "Error: cannot find ${HOST_SCRIPT}"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

# Where Chrome reads Native Messaging host manifests on macOS
NMH_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$NMH_DIR"

MANIFEST="${NMH_DIR}/com.fullpageshot.copyfile.json"

cat > "$MANIFEST" <<EOF
{
  "name": "com.fullpageshot.copyfile",
  "description": "Fullpage to Terminal: write image to clipboard as a file reference",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF

echo "✅ Installed"
echo ""
echo "Manifest:    ${MANIFEST}"
echo "Host script: ${HOST_SCRIPT}"
echo "Extension:   ${EXT_ID}"
echo ""
echo "Next:"
echo "  1. In chrome://extensions, click 🔄 on the Fullpage to Terminal card"
echo "  2. Try Option+A — capture should auto-save and auto-copy as file ref"
echo "     so ⌘V in Claude Code attaches the image directly"
