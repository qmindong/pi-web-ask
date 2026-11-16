#!/usr/bin/env bash
# 安装 systemd --user 服务并启动 daemon。
# 用法： ./install.sh            安装 + 启动
#        ./install.sh --dry-run  只打印将要写入的 unit
set -euo pipefail

REPO="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/pi-web-ask.service"

if [[ -z "$NODE" ]]; then
  echo "找不到 node，请先安装 Node.js 18+" >&2
  exit 1
fi

content="$(sed -e "s|@NODE@|$NODE|g" -e "s|@REPO@|$REPO|g" "$REPO/systemd/pi-web-ask.service.in")"

if [[ "${1:-}" == "--dry-run" ]]; then
  echo "→ $UNIT"
  echo "$content"
  exit 0
fi

mkdir -p "$UNIT_DIR"
printf '%s\n' "$content" > "$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now pi-web-ask.service
sleep 1
systemctl --user --no-pager status pi-web-ask.service | head -12 || true

echo
echo "自检： curl -s http://127.0.0.1:7649/health"
echo "扩展： about:debugging#/runtime/this-firefox → 临时载入附加组件 → $REPO/extension/manifest.json"
