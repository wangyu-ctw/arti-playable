# arti-playable

把视频脚本还原成可互动 playable 广告的手工工作台。项目放在 `artifacts/<projectname>/`（当前：`hotd-1`），需求与引擎约定见 `artifacts/PLAYABLE_BRIEF.md`，工具说明见 `utils/README.md`。

## 常用指令

```bash
# 开发服务（静态 + 保存接口 + artifex 代理 + 视频 Range），跑在 :8080
python3 utils/serve.py

# 预览 / 编辑器
open http://localhost:8080/utils/preview.html?p=hotd-1

# 打包构建：生成 artifacts/hotd-1/build/ = index.html（全部 CSS/JS 压缩内联）+ assets/ + i18n/
node utils/build.mjs hotd-1

# Mintegral 上传包（全部素材 base64 内联进一个 index.html、零网络请求、按语言各出一份）→ build/single/hotd-1-ja.zip；预览：解压后双击 index.html
node utils/build.mjs hotd-1 --single --lang ja      # --lang 可选 en / ja / zh-TW，不传为 en
# 渠道生命周期（Mintegral）：素材全部就绪 → window.gameReady()；容器调 window.gameStart() 才开播（无 SDK 的环境直接开播）；
#   结束画面出现时调一次 window.gameEnd()；CTA 调 window.install()（无则 mraid.open → window.open）；公开 window.gameClose()（空实现）。
#   交互全走 pointer 事件，PC 鼠标可用。接入清单 / 体积预算 / 验证方法 / 踩坑：utils/MINTEGRAL_GUIDE.md

# 构建产物本地预览
open http://localhost:8080/artifacts/hotd-1/build/index.html
```

## 仓库

本目录同时是两个仓的工作区：`git` 操作公开的打包产物仓（`artifacts/*/build` + `utils`），`utils/gito` 操作私有的源码仓 `arti-playable-origin`（`artifacts/*/src、assets、originals` + `utils`）。新 clone 先跑 `sh utils/repo/setup.sh`。详见 [utils/repo/README.md](utils/repo/README.md)。
