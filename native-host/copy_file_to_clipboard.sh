#!/bin/bash
# Native Messaging host：从 Chrome 扩展接收图片绝对路径，把它作为「文件引用」写进 macOS 剪贴板
# 等价于你在 Finder 里 ⌘C 那个文件。Claude Code TUI ⌘V 会自动 attach 这个图片。

set -euo pipefail

LOG=/tmp/fullpage-shot-host.log
echo "=== $(date) host called ===" >> "$LOG"

# Chrome Native Messaging 协议：先读 4 字节小端无符号整数（消息长度），再读那么多字节的 JSON 消息
read_message() {
  local length_bytes
  length_bytes=$(dd bs=4 count=1 2>/dev/null | xxd -p)
  if [ -z "$length_bytes" ]; then return 1; fi
  # 小端 → 十进制
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

# 从 JSON 抠 path（简单实现：jq 可选，没有 jq 就用 sed）
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

# 写「完整剪贴板」，模拟 Finder ⌘C 一个图片文件的状态：
# 同时写 furl（文件引用）+ PNGf（PNG 字节）+ plain text（路径），
# macOS 会自动衍生 JPEG / TIFF / AVIF 等格式。
# 关键：plain text 必须存在，否则终端 ⌘V 啥也粘不出来。
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
