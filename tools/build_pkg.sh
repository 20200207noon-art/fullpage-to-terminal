#!/usr/bin/env bash
# Build a macOS .pkg installer for the Fullpage to Terminal native messaging host.
#
# Drops on install:
#   /Library/Application Support/FullpageToTerminal/copy_file_to_clipboard.sh
#   /Library/Application Support/FullpageToTerminal/uninstall.sh
#   /Library/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json
#
# Usage:
#   ./tools/build_pkg.sh                      # only the unpacked-dev extension ID baked in
#   ./tools/build_pkg.sh <PROD_ID>            # production ID + dev ID both allowed
#   ./tools/build_pkg.sh <PROD_ID> <DEV_ID>   # override dev ID too
#
# Production ID = the one Chrome Web Store assigns after first listing upload.
# Until you have it, run with no args to test the installer locally.

set -euo pipefail

DEV_ID_DEFAULT="akodjdhihjilmccamjcoaglkliolcllo"
PROD_ID="${1:-}"
DEV_ID="${2:-$DEV_ID_DEFAULT}"

VERSION="1.23.3"
IDENTIFIER="com.fullpageshot.nativehost"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_SH="$REPO_DIR/native-host/copy_file_to_clipboard.sh"
BUILD_DIR="$REPO_DIR/build"
PAYLOAD_DIR="$BUILD_DIR/payload"

if [ ! -f "$SRC_SH" ]; then
  echo "ERROR: $SRC_SH not found" >&2
  exit 1
fi

rm -rf "$BUILD_DIR"
mkdir -p "$PAYLOAD_DIR/Library/Application Support/FullpageToTerminal"
mkdir -p "$PAYLOAD_DIR/Library/Google/Chrome/NativeMessagingHosts"

INSTALLED_SH="/Library/Application Support/FullpageToTerminal/copy_file_to_clipboard.sh"
cp "$SRC_SH" "$PAYLOAD_DIR$INSTALLED_SH"
chmod 755 "$PAYLOAD_DIR$INSTALLED_SH"

# Build allowed_origins JSON array. Production ID first if supplied, then dev ID.
if [ -n "$PROD_ID" ]; then
  ALLOWED_ORIGINS="\"chrome-extension://${PROD_ID}/\", \"chrome-extension://${DEV_ID}/\""
else
  ALLOWED_ORIGINS="\"chrome-extension://${DEV_ID}/\""
fi

cat > "$PAYLOAD_DIR/Library/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json" <<EOF
{
  "name": "com.fullpageshot.copyfile",
  "description": "Fullpage to Terminal: write image as clipboard file reference",
  "path": "${INSTALLED_SH}",
  "type": "stdio",
  "allowed_origins": [${ALLOWED_ORIGINS}]
}
EOF

cat > "$PAYLOAD_DIR/Library/Application Support/FullpageToTerminal/uninstall.sh" <<'EOF'
#!/usr/bin/env bash
# Uninstall: sudo bash "/Library/Application Support/FullpageToTerminal/uninstall.sh"
set -e
rm -f "/Library/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json"
rm -rf "/Library/Application Support/FullpageToTerminal"
echo "Fullpage to Terminal native host uninstalled."
EOF
chmod 755 "$PAYLOAD_DIR/Library/Application Support/FullpageToTerminal/uninstall.sh"

PKG_OUT="$BUILD_DIR/FullpageToTerminal-NativeHost-${VERSION}.pkg"

pkgbuild \
  --root "$PAYLOAD_DIR" \
  --identifier "$IDENTIFIER" \
  --version "$VERSION" \
  --install-location "/" \
  "$PKG_OUT"

echo ""
echo "✓ Built: $PKG_OUT"
echo ""
if [ -n "$PROD_ID" ]; then
  echo "  allowed_origins: production + dev"
  echo "    prod: $PROD_ID"
  echo "    dev:  $DEV_ID"
else
  echo "  allowed_origins: dev only ($DEV_ID)"
  echo "  ⚠️  No production ID supplied. Re-run before publishing the .pkg:"
  echo "       ./tools/build_pkg.sh <production_extension_id>"
fi

PER_USER_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json"
if [ -f "$PER_USER_MANIFEST" ]; then
  echo ""
  echo "  ⚠️  You have a per-user manifest installed (from install.sh):"
  echo "       $PER_USER_MANIFEST"
  echo "     Chrome reads per-user FIRST, so it will override the .pkg's system-wide one."
  echo "     To test the .pkg cleanly, remove it first:"
  echo "       rm \"\$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.fullpageshot.copyfile.json\""
fi

echo ""
echo "  Test install:  sudo installer -pkg \"$PKG_OUT\" -target /"
echo "  Or double-click the .pkg in Finder (right-click → Open to bypass Gatekeeper for unsigned)."
