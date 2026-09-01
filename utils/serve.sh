#!/usr/bin/env bash
# 用途：起本地开发服务（utils/serve.py：静态 + 保存关键帧接口），打开预览台调试任意项目。<video autoplay> 在 file:// 下不可靠，必须走 http。
# 用法：utils/serve.sh [projectname] [port=8080]
#   预览台： http://localhost:<port>/utils/preview.html?p=<projectname>
#   裸页面： http://localhost:<port>/artifacts/<projectname>/src/index.html
set -euo pipefail
name="${1:-}"
port="${2:-8080}"
root="$(cd "$(dirname "$0")/.." && pwd)"
echo "预览台:  http://localhost:$port/utils/preview.html${name:+?p=$name}"
[ -n "$name" ] && echo "裸页面:  http://localhost:$port/artifacts/$name/src/index.html"
exec python3 "$root/utils/serve.py" "$port"
