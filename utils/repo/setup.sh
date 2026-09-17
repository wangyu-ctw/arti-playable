#!/bin/sh
# 双仓初始化（幂等，clone 任一仓后先跑一次）：同一工作区、两个 git 目录
#   .git        → arti-playable（公开）：打包产物 artifacts/*/build + utils          → 用 git
#   .git-origin → arti-playable-origin（私有）：广告源码 src/assets/originals + utils → 用 utils/gito
# 做三件事：建 .git-origin（缺则建）并挂远端；把 utils/repo/exclude-* 装进两仓的 info/exclude。
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ORIGIN_URL="${ORIGIN_URL:-git@github.com:wangyu-ctw/arti-playable-origin.git}"
BUILD_URL="${BUILD_URL:-git@github.com:wangyu-ctw/arti-playable.git}"
cd "$ROOT"
G="git --git-dir=$ROOT/.git-origin --work-tree=$ROOT"
if [ ! -d .git-origin ]; then
  $G init -q
  $G symbolic-ref HEAD refs/heads/main
fi
$G config core.worktree "$ROOT"
$G remote get-url origin >/dev/null 2>&1 || $G remote add origin "$ORIGIN_URL"
if [ ! -d .git ]; then git init -q; git symbolic-ref HEAD refs/heads/main; fi
git remote get-url origin >/dev/null 2>&1 || git remote add origin "$BUILD_URL"
mkdir -p .git/info .git-origin/info
cp utils/repo/exclude-build .git/info/exclude
cp utils/repo/exclude-origin .git-origin/info/exclude
echo "ok  .git        → $(git remote get-url origin)"
echo "ok  .git-origin → $($G remote get-url origin)"
