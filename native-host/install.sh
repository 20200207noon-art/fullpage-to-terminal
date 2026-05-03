#!/bin/bash
# 一键安装：把 Native Messaging host 注册到 Chrome
# 跑这个之前先在 chrome://extensions 装好扩展，记下扩展 ID（页面上每个扩展卡片右下角有）
# 然后：./install.sh <扩展ID>
#
# 例：./install.sh abcdefghijklmnopqrstuvwxyzabcdef

set -euo pipefail

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "用法：./install.sh <Chrome 扩展 ID>"
  echo ""
  echo "怎么拿扩展 ID："
  echo "  1. chrome://extensions"
  echo "  2. 右上角开「开发者模式」"
  echo "  3. 找到 Fullpage Shot 卡片，右下角那串小字就是 ID（32 个字母）"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="${SCRIPT_DIR}/copy_file_to_clipboard.sh"

if [ ! -f "$HOST_SCRIPT" ]; then
  echo "错误：找不到 ${HOST_SCRIPT}"
  exit 1
fi

chmod +x "$HOST_SCRIPT"

# Chrome 在 macOS 上读取 Native Messaging host manifest 的位置
NMH_DIR="${HOME}/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$NMH_DIR"

MANIFEST="${NMH_DIR}/com.fullpageshot.copyfile.json"

cat > "$MANIFEST" <<EOF
{
  "name": "com.fullpageshot.copyfile",
  "description": "Fullpage Shot: 把图片作为文件引用写入剪贴板",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXT_ID}/"
  ]
}
EOF

echo "✅ 装好了"
echo ""
echo "Manifest 位置：${MANIFEST}"
echo "Host 脚本位置：${HOST_SCRIPT}"
echo "扩展 ID：${EXT_ID}"
echo ""
echo "下一步："
echo "  1. chrome://extensions 找到 Fullpage Shot 点 🔄 刷新"
echo "  2. 试一次 Option+A → 应该自动落盘 + 自动复制文件 → Claude Code ⌘V 直接出图"
