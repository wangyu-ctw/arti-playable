# Mintegral 试玩素材：接入与打包指南（供各项目 agent 参考）

> 适用范围：本仓库 `artifacts/<项目>/` 下、基于 `utils/template/player.js` 骨架的任何项目。
> 渠道接口、资源内联、生命周期都已做进骨架，**新项目几乎不用写渠道代码**，只需按 §3 清单自检，然后跑 §4 的命令。
> 本文来自 hotd-1 的实际接入过程（2026-09），踩过的坑见 §6。

## 1. Mintegral 规范要点（他们文档的原话摘要）

| # | 要求 | 骨架如何满足 |
|---|---|---|
| 1 | HTML 结构：必须有 `<!DOCTYPE html>` / html / head / body，`<meta charset="utf-8">`；推荐 viewport `width=device-width,user-scalable=no,initial-scale=1.0,minimum-scale=1.0,maximum-scale=1.0` | 模板 `index.html` 已按此写；build 时统一大写 DOCTYPE、按 `--lang` 烙 `<html lang>`，缺项打 ⚠️ |
| 2 | 上传 **zip**，根目录必须有 `index.html`；全部资源内联、**零外部网络请求**；≤ 5MB（建议 ≤ 3MB） | `build.mjs --single` 产出全内联单文件 + 同名 zip（zip 里只有一个 `index.html`） |
| 3 | 结束时（出结束画面）必须调 `window.gameEnd && window.gameEnd()` | `Playable.gameEnd()`：只报一次；cta-link 行为按标签帧上报；点 CTA 时若未报会**先补报再 install** |
| 4 | 资源加载完调 `window.gameReady && window.gameReady()` | `Playable.start()` 先 `preloadAll()`（图片解码 / 视频音频可播 / Spine 解析 / 字体，单项 8s 超时兜底）再调 |
| 5 | 公开 `window.gameStart()`，容器开始展示时调 | 已公开；gameReady 后等它最多 **1s**，没等到自行开播（检测工具不一定调） |
| 6 | 兼容 PC 浏览器：点击/滑动在鼠标下可触发（检测工具是网页 + 鼠标） | 骨架与行为全部用 `pointerdown`，无 touch-only 监听；**这条不禁止自动推进**，自动推进反而帮检测工具走完流程 |
| 7 | 公开 `window.gameClose()`，容器结束时调 | 已公开，空实现（只向调试事件流打点） |
| — | CTA 跳转调 `window.install()`，不许写外链跳转 | `Playable.cta(href)`：`window.install` → `mraid.open` → 开发期 `window.open` |

源码里这几处刻意写成规范原文的 `window.xxx && window.xxx()` 形态（压缩后 `window.gameEnd&&window.gameEnd()`），别改成 `typeof` 判断——检测工具可能同时做静态扫描。

## 2. 骨架里对应的机制（改骨架时别弄坏）

- **资源解析器 `A(path)`**（player.js）：`--single` 打包时 build 往页面注入 `window.__ASSETS = { 'assets/x.mp4': 'data:…' }`，运行时所有 `src`/`fetch` 经 `A()` 换成内联数据；文件夹模式 `__ASSETS` 不存在，原路径照走。**新增任何加载点都要过 `A()`**（video/img/audio/SFX fetch/BGM/CSS 变量）。
- **Spine**：`spineLoad()` 里把 `__ASSETS` 中同目录的 json/atlas/图集页用 `assets.setRawDataURI(文件名, dataURI)` 注册；键 = `pathPrefix + 文件名`，与 atlas 里图集页的请求路径一致。
- **i18n**：`--lang xx` 把该语言字典（含 en 回落）编译期内联为 `window.__I18N_INLINE`，运行时不 fetch、不看 `?lang`，编辑器 iframe 守卫在内联模式下跳过。
- **生命周期**（`Playable.start()`）：`preloadAll()` → `emit('ready')` → `window.gameReady && window.gameReady()` → 等 `gameStart` ≤ 1s → `goto(第一场景)`。没有 `window.gameReady` 的环境（开发服务、预览台、普通托管）就绪后直接开播。
- **宽屏两侧底图**（可选）：`<body data-bg="../assets/xx.webp">`（9:16 竖图），仅视口宽高比 ≥ 舞台时铺（高度撑满、横向平铺、居中），竖屏纯黑；经 `A()` 设 `--page-bg`，单文件自动内联。

## 3. 新项目接入清单（agent 自检）

1. **index.html 用模板**（`utils/template/index.html`）。脚本顺序：vendor → `i18n/i18n.js` → `player.js` → `tracks.js` → behaviors → scenes → 启动：`I18N.load().then(() => { I18N.applyTracks(window.TRACKS); Playable.start(); })`。
2. **素材路径写字面量** `../assets/<文件>`（tracks.js 的 `src`、行为参数如 `sound:'../assets/gunshot.mp3'`、`data-bg`）。build 靠字符串匹配 `assets/<相对路径>` 收集"被引用"资源——**运行时拼接出来的路径收集不到**，就会内联不进去、上线 404。Spine 只要引用 `.json/.skel`，同目录整套自动带上。
3. **结束场景**：用 `Behaviors.ctaLink(ctx, { track, label, href, gameEndLabel })`——`gameEndLabel` 指向"结束画面/CTA 出现"的那一帧（hotd-1 用 text_6 的 `jump`）。gameEnd 要**早于**用户能点 CTA 的时刻；别放在 CTA 之后（检测工具点了 install 就停跑，之后的 gameEnd 它看不到）。
4. **不要依赖 URL 参数**：生产环境没有 `?lang` / `?s`；语言靠 `--lang` 烙进去、每种语言各出一个 zip。
5. **交互**：只用 `pointerdown`/`pointermove`/`pointerup`，不写 touch-only；每个需要用户操作的节点都要有**自动推进**（超时随机选、自动开火……），否则检测工具可能卡住走不到 gameEnd。
6. **流程时长**：从开播到 gameEnd 越短越好。检测工具有运行时间预算（具体数字他们没写，按 30–60s 量级准备）；hotd-1 无人操作约 68s 曾经是风险点。自动推进的等待别设太长。
7. **体积预算**：单文件 ≈ 代码 0.3MB + 素材原始体积 × 4/3（base64）。要压在 5MB 硬线内，**素材原始总量 ≤ 约 3.5MB**；zip 大小 ≈ 素材原始体积 + 代码（deflate 把 base64 压回去）。视频用 `utils/compress.mjs` 逐档压；图片用 webp，单张控制在 100–150KB（hotd-1 的 1080×1920 底图 265KB → 101KB 才回到线内）。未被引用的素材不会打进单文件（build 日志会列出来），删不删不影响体积。
8. **视频**：muted 自动播（骨架默认）；结尾定格/循环等依赖 `ended` 事件的逻辑在检测环境下同样成立。
9. **声音**：首次真实点击解锁；合成事件（`isTrusted=false`）不解锁但不影响流程。

## 4. 打包与产物

```bash
node utils/build.mjs <项目> --single --lang ja     # → artifacts/<项目>/build/single/<项目>-ja.zip（上传）+ 同名 .html（双击预览）
node utils/build.mjs <项目> --single --lang en
node utils/build.mjs <项目> --single --lang zh-TW
node utils/build.mjs <项目>                        # 文件夹模式 → build/（index.html + assets/ + i18n/），托管用；不会清掉 build/single/
```

看日志：`内联资源 N 个（原始 X → base64 约 Y）；未被引用未打入：…`（确认该进的都进了、不该进的没进）、`单文件：Z MB`（> 5MB ⚠️、> 3MB ℹ️）、`上传包：… .zip`、`⚠️ 结构检查：缺少 …`。

## 5. 验证方法

**本地预览**：双击 `build/single/<项目>-ja.html`（`file://` 直接能跑，说明零网络依赖）。DevTools Network 里除 document 外不应有任何请求。

**模拟容器**：预览页控制台先粘这段再刷新（或放进检测前的 stub 页）：

```js
window.gameReady = () => console.log('[sdk] gameReady');
window.gameEnd   = () => console.log('[sdk] gameEnd');
window.install   = () => console.log('[sdk] install');
// 想验证 gameStart 路径就调一下 window.gameStart()；不调则 1s 后自启
```

预期顺序：`gameReady` →（开播）→ 到结束帧 `gameEnd` 一次 → 点 CTA `install`（若 gameEnd 还没报，会先报再 install；不重复）。

**自动化**：hotd-1 的做法是 headless Chrome + CDP（`Page.addScriptToEvaluateOnNewDocument` 注入上面的 stub，`Network.requestWillBeSent` 统计非 data:/file: 请求，`Input.dispatchMouseEvent` 用鼠标点 CTA）。注意 `__playable.goto(id)` 返回的 promise 要等该场景 `enter()` 跑完整条时间轴才 resolve，**不要 await 它**来"等场景切换"。

**检测工具常见失败 → 原因**：

| 报告 | 常见原因 |
|---|---|
| 关闭游戏调用（gameEnd）未检测到 | gameEnd 放在 CTA 之后（工具点了 install 就停）；死等 gameStart 没开播；流程太长超出预算；写法不是 `window.gameEnd && window.gameEnd()` |
| 资源加载调用未检测到 | `gameReady` 没调 / 调太早失败抛错；preload 卡死（单项 8s 超时已兜底） |
| 试玩流程无法完成 | touch-only 监听；需要点击但无自动推进；依赖 URL 参数 |
| 存在外部请求 | 素材路径拼接导致没内联；CSS `url()` 直接写了路径（应走 `data-bg`/`A()`）；第三方脚本 |

## 6. 踩过的坑（改工具时对照）

- build 注入 `__ASSETS` 曾按字面 `<body>` 匹配，body 一带属性（`data-bg`）就注不进去、zip 只剩 0.09MB——已改为正则匹配开标签并在缺失时报错。
- 单文件模式不加 `?v=` 指纹（键要与 `__ASSETS` 精确匹配）；文件夹模式才加。
- `esbuild` 压缩会把 `typeof window.gameEnd === 'function'` 改写成别的形态，静态扫描不认；源码直接写 `window.gameEnd && window.gameEnd()`。
- `<!doctype html>` 小写虽合法，但对方示例是大写，build 统一改写，别赌检测器的大小写敏感性。
- `?lang` 在 Mintegral 容器里不存在；编辑器 iframe 的 i18n 守卫（`frameElement`）必须在内联模式下跳过，否则打出来的包没翻译。
- Spine `setRawDataURI` 的键必须带 `pathPrefix`（即 `new spine.AssetManager(gl, base)` 的 base），否则 atlas 图集页找不到。
- 1080×1920 的 webp 底图两侧面板实际只显示 ~608×1080，用 720×1280/质量 80 足够，体积能砍一半以上。
- 折叠屏/平板/PC 都是"宽视口"，会露出两侧底图；比 9:16 更高的手机是"高视口"，底图不铺（媒体查询 `min-aspect-ratio: 750/1334`）。
