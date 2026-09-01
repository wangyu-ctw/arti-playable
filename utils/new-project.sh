#!/usr/bin/env bash
# 用途：按 artifacts/PLAYABLE_BRIEF.md §4 创建新项目骨架，并从 utils/template/ 拷入共用 player（已存在的文件不覆盖；不建 playable/）
# 用法：utils/new-project.sh <projectname>
set -euo pipefail
name="${1:?用法: utils/new-project.sh <projectname>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/artifacts/$name"
tpl="$root/utils/template"
mkdir -p "$dir/assets" "$dir/src/scenes"
copy() { # copy <src> <dst>  —— 目标已存在则跳过
  if [ -e "$2" ]; then echo "skip (exists): ${2#$root/}"; else mkdir -p "$(dirname "$2")"; cp "$1" "$2"; echo "create: ${2#$root/}"; fi; }
copy "$tpl/player.js"   "$dir/src/player.js"
copy "$tpl/styles.css"  "$dir/src/styles.css"
copy "$tpl/tracks.js"   "$dir/src/tracks.js"
copy "$tpl/scenes/_demo.js" "$dir/src/scenes/_demo.js"
if [ ! -e "$dir/src/index.html" ]; then sed "s/__PROJECT__/$name/g" "$tpl/index.html" > "$dir/src/index.html"; echo "create: artifacts/$name/src/index.html"; else echo "skip (exists): artifacts/$name/src/index.html"; fi
[ -f "$dir/ASSETS.md" ] || { cat > "$dir/ASSETS.md" <<MD
# $name — 资源清单

## 已有（assets/ 下）
| 文件 | 规格 | 用在哪 |
|---|---|---|

## 待生成
| 文件名 | 规格（尺寸/时长/透明/循环） | 用在哪 | 生成提示词 |
|---|---|---|---|
MD
echo "create: artifacts/$name/ASSETS.md"; }
[ -f "$dir/NOTES.md" ] || { cat > "$dir/NOTES.md" <<MD
# $name — 项目笔记

本项目特有的决定、口头补充的要求。通用要求见 ../PLAYABLE_BRIEF.md。

## 题材

## 场景一览

## 决定记录
MD
echo "create: artifacts/$name/NOTES.md"; }
echo "done: $dir"
echo "预览: utils/serve.sh $name  →  http://localhost:8080/utils/preview.html?p=$name"
