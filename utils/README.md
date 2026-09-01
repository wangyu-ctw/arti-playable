# utils — 过程工具

制作 playable 过程中用到的辅助工具，跨项目复用。文件可以是 `.py` / `.js` / `.sh` / `.html`。
每个工具文件头部有一行用途 + 用法，这里只维护清单。

| 文件 | 用途 | 用法 |
|---|---|---|
| `serve.sh` | 起本地开发服务（调 `serve.py`）；`<video autoplay>` 在 `file://` 下不可靠，预览必须走 http | `utils/serve.sh [projectname] [port=8080]` |
| `serve.py` | 开发服务本体：静态托管仓库根目录（no-store）+ `POST /__save` 写 `artifacts/<p>/src/tracks.js`（预览台保存关键帧用；只允许这一类路径） | `python3 utils/serve.py [port]` |
| `preview.html` | **预览/调试/素材编辑台**：750×1334 舞台按比例预览、场景列表点选跳转、上/下一场、暂停、关闭闲置自动选、事件日志、三分网格 + 9:16 参考线、项目下拉切换、`?s=` 起始场景、其余参数透传。**✎ 编辑模式**：素材（图层）面板——从 assets/ 添加、改名、显隐、移层、删除；舞台上拖动=移动、滚轮=缩放（Shift 细调）；自由变换框（四角等比/四边拉伸/顶柄旋转，Shift 吸附 15°）；四角变形（◇ 逐角拖成任意四边形）；跟随绑定（子素材嵌入父坐标系，父运镜子自动跟随，切换时关键帧自动换算）；内部动效（浮动/摇摆/呼吸/闪烁/抖动/旋转循环，可叠加）；文字素材（＋添加文字）；纯色素材（＋添加纯色：关键帧可动画透明度/颜色/位置大小）；底部 Flash 式时间轴（100ms 刻度，每素材一行）：拖播放头 scrub、拖关键帧改时间（后续帧跟随，Alt 只动一帧）、双击插帧、双击菱形命名、从播放头播放；段选（Shift+点）/复制/粘贴/删除（⌘C/⌘V/Del）；轨迹复制（⧉：整轨关键帧+属性复制到新图层，可换素材）；保存到 `tracks.js` | 起服务后打开 `http://localhost:8080/utils/preview.html?p=<projectname>`；快捷键：空格暂停（编辑中=从播放头播放/停）、Shift+R 重载、⌘/Ctrl+C/V 复制粘贴帧段、Delete 删除帧段 |
| `new-project.sh` | 按简报 §4 建项目骨架，并从 `template/` 拷入共用 player（已有文件不覆盖） | `utils/new-project.sh <projectname>` |
| `template/` | 共用骨架源文件：`player.js`（场景切换/选项/闲置/CTA/缩放/素材轨道/调试接口）、`styles.css`、`index.html`、`tracks.js`（空，结构见文件头）、`scenes/_demo.js`（示例，正式项目删） | 由 `new-project.sh` 拷贝；改骨架时改这里，再同步到已有项目 |
| `selftest-preview.mjs` | 预览台编辑模式端到端自检（CDP 真实鼠标事件：拖动/滚轮/记帧/插值/ripple/图层增删/命名/保存），改过 preview.html 或 player.js 轨道部分后跑；临时改写并自动恢复项目的 tracks.js | 先起服务，再 `node utils/selftest-preview.mjs [project] [scene]`（需 Chrome、Node ≥22） |
| `seedance.html` | Seedance 2.5 视频生成台：提交生成 + 轮询结果（状态/预览/unified_info JSON）；请求经 serve.py 的 `/artifex/*` 代理转发到内部 artifex 服务（域名在 `utils/artifex.host` 或环境变量 `ARTIFEX_HOST` 配置，不入库），JSESSIONID 在页面填写（localStorage） | 起服务后打开 `http://localhost:8080/utils/seedance.html` |

新工具加进来时在这张表补一行。
- `spine-slow.mjs` — 缩放 Spine JSON 某动作的时间轴（慢放/加速）：`node utils/spine-slow.mjs <骨架.json> <动作名> <倍率> [新动作名]`，不给新名则原地改。
- `audio.html` — OpenRouter 音频生成页：Google Lyria 3（音乐，文+图输入）/ OpenAI gpt-audio（语音，文+音频输入），key 存 localStorage["openrouter_key"]。
- `build.mjs` — 打包构建：`node utils/build.mjs <projectname>` → `artifacts/<p>/build/` = 单个 index.html（全部 CSS/JS 压缩内联，../assets 改写为 assets/）+ assets/ 整目录，可直接分发/托管。
