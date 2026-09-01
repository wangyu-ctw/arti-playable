# arti-playable

把视频脚本还原成可互动 playable 广告的手工工作台。项目放在 `artifacts/<projectname>/`（当前：`hotd-1`），需求与引擎约定见 `artifacts/PLAYABLE_BRIEF.md`，工具说明见 `utils/README.md`。

## 常用指令

```bash
# 开发服务（静态 + 保存接口 + artifex 代理 + 视频 Range），跑在 :8080
python3 utils/serve.py

# 预览 / 编辑器
open http://localhost:8080/utils/preview.html?p=hotd-1

# 打包构建：生成 artifacts/hotd-1/build/ = index.html（全部 CSS/JS 压缩内联）+ assets/
node utils/build.mjs hotd-1

# 构建产物本地预览
open http://localhost:8080/artifacts/hotd-1/build/index.html
```
