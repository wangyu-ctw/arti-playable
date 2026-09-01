// selftest-preview.mjs — 预览台编辑模式的端到端自检：用 Chrome DevTools 协议发真实鼠标事件，
//   验证 拖动 / 滚轮缩放 / 记关键帧 / 动画插值 / 保存到 tracks.js。改过 preview.html 或 player.js 的轨道部分后跑一下。
// 用法：先 utils/serve.sh 起服务（8080），然后 node utils/selftest-preview.mjs [project=hotd-1] [scene=s02]
//   会临时改写该项目的 src/tracks.js，结束后自动恢复（退出码 0 = 全部通过）。需要本机有 Google Chrome，Node ≥ 22。
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PROJECT = process.argv[2] || 'hotd-1', SCENE = process.argv[3] || 's02';
const S = path.join(os.tmpdir(), 'playable-selftest'); fs.rmSync(S, { recursive: true, force: true }); fs.mkdirSync(S, { recursive: true });
const TRACKS_PATH = `${ROOT}/artifacts/${PROJECT}/src/tracks.js`;
const backup = fs.readFileSync(TRACKS_PATH, 'utf8');
process.on('exit', () => { try { fs.writeFileSync(TRACKS_PATH, backup); } catch (_) {} });   // 无论怎么退出都恢复用户数据
// 写入确定的测试夹具（1 层 bg = 2-scene.png，单关键帧），使测试与磁盘上用户的实际数据无关；结束后恢复 backup
const FIXTURE = `window.TRACKS = ${JSON.stringify({ [SCENE]: { layers: [{ name: 'bg', src: '../assets/2-scene.png' }], keys: { bg: [{ t: 0, x: -1181.3, y: 0, s: 1.158, label: '' }] } }}, null, 2)};\n`;
fs.writeFileSync(TRACKS_PATH, FIXTURE);
const PORT = 9222, CH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const url = `http://127.0.0.1:8080/utils/preview.html?p=${PROJECT}&s=${SCENE}&edit=1`;
const chrome = spawn(CH, ['--headless=new', '--disable-gpu', '--no-first-run', `--remote-debugging-port=${PORT}`, `--user-data-dir=${S}/chrome`, '--window-size=1700,1000', '--hide-scrollbars', url], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let targets; for (let i = 0; i < 50; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); if (targets.find(t => t.type === 'page')) break; } catch {} await sleep(200); }
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pending = new Map();
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails)); return r.result.result.value; };
const log = (...a) => console.log(...a);

await send('Page.enable'); await send('Runtime.enable');
for (let i = 0; i < 60; i++) { if (await ev(`!!document.body && document.body.classList.contains('editing') && !!document.querySelector('#trackList .tr.cur')`)) break; await sleep(200); }
log('1 编辑模式已进入, 轨道:', await ev(`document.querySelector('#trackList .tr.cur')?.innerText`));
const pose = async () => ({ x: +await ev(`document.querySelector('#px').value`), y: +await ev(`document.querySelector('#py').value`), s: +await ev(`document.querySelector('#ps').value`) });
const p0 = await pose(); log('   初始姿态', p0);
const rect = JSON.parse(await ev(`JSON.stringify(document.querySelector('#hit').getBoundingClientRect())`));
const scale = rect.width / 750; const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
log('   舞台缩放', scale.toFixed(3));

// 拖动：屏幕移动 (+60, -40) → 舞台 (+60/scale, -40/scale)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
for (let i = 1; i <= 6; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx + 10 * i, y: cy - 40 / 6 * i, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx + 60, y: cy - 40, button: 'left', clickCount: 1 });
const p1 = await pose(); log('2 拖动后', p1, '期望 dx≈', (60 / scale).toFixed(1), 'dy≈', (-40 / scale).toFixed(1));
const dragOk = Math.abs((p1.x - p0.x) - 60 / scale) < 1.5 && Math.abs((p1.y - p0.y) + 40 / scale) < 1.5;

// 滚轮：deltaY=-200 → s *= exp(0.3)
await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: cx, y: cy, deltaX: 0, deltaY: -200 });
await sleep(100);
let p2 = await pose(); log('3 滚轮后', p2, '期望 s≈', (p1.s * Math.exp(0.3)).toFixed(4));
const wheelOk = Math.abs(p2.s - p1.s * Math.exp(0.3)) < 0.002;

// 旋转输入 30° → 实际渲染角度；变换框可见
await ev(`(() => { const el = document.querySelector('#pr'); el.value = 30; el.dispatchEvent(new Event('input')); })(); true`);
await sleep(100);
const ang = await ev(`(() => { const doc = document.querySelector('#frame').contentWindow.document; const m = new DOMMatrix(getComputedStyle(doc.querySelector('.track[data-track="bg"]')).transform); return Math.round(Math.atan2(m.b, m.a) * 180 / Math.PI); })()`);
const tboxVis = await ev(`!document.querySelector('#tbox').hidden`);
log('   输入 30° 后实际角度 =', ang, '; 变换框可见 =', tboxVis);
// 变换框测试前先把 bg 归位缩小（此前滚轮测试把它移出了舞台，且原尺寸手柄在可视区外点不到）
await ev(`(() => { const set = (id, v) => { const el = document.querySelector(id); el.value = v; el.dispatchEvent(new Event('input')); }; set('#px', 0); set('#py', 0); set('#ps', 0.3); })(); true`);
await sleep(150);
// 变换框：角柄(se)外拉 1.2 倍 → s ×1.2；边柄(e)外拉 1.3 倍 → s 再 ×1.3 且出现 sy(=拉伸前 s)
const hrect = async k => JSON.parse(await ev(`JSON.stringify(document.querySelector('#tbox .h[data-k="${k}"]').getBoundingClientRect())`));
const brect = async () => JSON.parse(await ev(`JSON.stringify(document.querySelector('#tbox').getBoundingClientRect())`));
async function dragHandle(k, factor) {
  const h = await hrect(k), b = await brect();
  const hcx = h.x + h.width / 2, hcy = h.y + h.height / 2, bcx = b.x + b.width / 2, bcy = b.y + b.height / 2;
  const tx = bcx + (hcx - bcx) * factor, ty = bcy + (hcy - bcy) * factor;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hcx, y: hcy, button: 'left', clickCount: 1 });
  for (let i = 1; i <= 4; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hcx + (tx - hcx) * i / 4, y: hcy + (ty - hcy) * i / 4, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: tx, y: ty, button: 'left', clickCount: 1 });
  await sleep(120);
}
const s0 = +await ev(`document.querySelector('#ps').value`);
await dragHandle('se', 1.2);
const s1 = +await ev(`document.querySelector('#ps').value`);
await dragHandle('e', 1.3);
const s2 = +await ev(`document.querySelector('#ps').value`);
const sy2 = +await ev(`document.querySelector('#psy').value`);
log('   角柄×1.2:', s0, '→', s1, '; 边柄×1.3:', s1, '→', s2, 'sy=', sy2);
const cornerOk = Math.abs(s1 / s0 - 1.2) < 0.05, deformOk = Math.abs(s2 / s1 - 1.3) < 0.06 && Math.abs(sy2 - s1) < 0.02;
const rotOk = Math.abs(ang - 30) < 1 && tboxVis && cornerOk && deformOk;
// 复位：r=0、清 sy
await ev(`(() => { const r = document.querySelector('#pr'); r.value = 0; r.dispatchEvent(new Event('input')); const y = document.querySelector('#psy'); y.value = ''; y.dispatchEvent(new Event('input')); })(); true`);
await sleep(50);
p2 = await pose();   // 变换框测试改过 kf[0]，刷新供后续中点断言使用

// 记第二个关键帧 t=2000
await ev(`document.querySelector('#kfT').value = 2000; document.querySelector('#kfAdd').click(); true`);
const rows = await ev(`document.querySelectorAll('#kfTable tr[data-i]').length`);
log('4 关键帧行数', rows, await ev(`document.querySelector('#kfTable').innerText.replace(/\\n/g,' | ')`));

// 第 2 帧（已自动选中）再往左拖 120 屏幕像素
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx - 120, y: cy, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx - 120, y: cy, button: 'left', clickCount: 1 });
const p3 = await pose(); log('   第 2 帧拖动后', p3);
const tlKf = await ev(`document.querySelectorAll('#tlRows .kf').length`); log('   时间轴关键帧菱形数', tlKf);
// 播放预览：t=1000 处应在两帧之间（ease-in-out 中点 = 均值）
await ev(`document.querySelector('#kfPlay').click(); true`);
await sleep(1000);
const midPose = JSON.parse(await ev(`JSON.stringify(document.querySelector('#frame').contentWindow.__playable.getPose(document.querySelector('#trackList .tr.cur b').innerText))`));
log('5 播放至 ~1000ms 姿态', midPose, '两帧 x:', p2.x, p3.x);
const between = midPose.x < Math.max(p2.x, p3.x) - 5 && midPose.x > Math.min(p2.x, p3.x) + 5;
await sleep(1800);
const playOk = !(await ev(`document.querySelector('#kfPlay').disabled`)) && between;

// 保存
await ev(`document.querySelector('#save').click(); true`);
await sleep(500);
log('6 保存提示:', await ev(`document.querySelector('#saveMsg').innerText`));
const saved = fs.readFileSync(`${TRACKS_PATH}`, 'utf8');
const body = saved.slice(saved.indexOf('window.TRACKS = ') + 'window.TRACKS = '.length).trim().replace(/;$/, '');
const savedScene = Object.values(JSON.parse(body))[0]; const savedKf = Object.values(savedScene.keys || savedScene)[0];
log('   磁盘上的关键帧:', JSON.stringify(savedKf));

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(`${S}/edit2.png`, Buffer.from(shot.result.data, 'base64'));
// 时间轴：加第 3 帧 t=3000，然后把第 2 帧菱形右拖 5 格(500ms)：期望 kf2=2500、kf3 跟随到 3500（ripple）
await ev(`document.querySelector('#kfT').value = 3000; document.querySelector('#kfAdd').click(); true`);
const kfEl = JSON.parse(await ev(`JSON.stringify(document.querySelector('#tlRows .kf[data-i="1"]').getBoundingClientRect())`));
const kx = kfEl.x + kfEl.width / 2, ky = kfEl.y + kfEl.height / 2;
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: kx, y: ky, button: 'left', clickCount: 1 });
for (let i = 1; i <= 5; i++) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: kx + 12 * i, y: ky, button: 'left', buttons: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: kx + 60, y: ky, button: 'left', clickCount: 1 });
await sleep(100);
const tsAfter = JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#kfTable .kt')].map(i => +i.value))`));
log('   拖第 2 帧 +500ms 后各帧 t:', tsAfter);
const rippleOk = tsAfter.join() === '0,2500,3500';
// 删掉第 3 帧、把第 2 帧拖回 2000，恢复到 2 帧供后续测试
await ev(`document.querySelectorAll('#kfTable .kd')[2].click(); true`);
await ev(`(() => { const el = document.querySelectorAll('#kfTable .kt')[1]; el.value = 2000; el.dispatchEvent(new Event('change')); })(); true`);
log('   恢复后各帧 t:', JSON.parse(await ev(`JSON.stringify([...document.querySelectorAll('#kfTable .kt')].map(i => +i.value))`)));
// 图层管理：添加 assets/1.mp4 → 图层列表与时间轴各 2 行；改名；删除（点两次）→ 回到 1 行
await ev(`document.querySelector('#addLayer').click(); true`);
for (let i = 0; i < 30 && !(await ev(`!!document.querySelector('#chooserList .ch-item[data-file="1.mp4"]')`)); i++) await sleep(100);
await ev(`document.querySelector('#chooserList .ch-item[data-file="1.mp4"]').click(); document.querySelector('#chooserAdd').click(); true`);
for (let i = 0; i < 30 && (await ev(`document.querySelectorAll('#trackList .tr').length`)) < 2; i++) await sleep(100);
const layers2 = await ev(`document.querySelectorAll('#trackList .tr').length`), rows2 = await ev(`document.querySelectorAll('#tlRows .rw').length`);
const topName = await ev(`document.querySelector('#trackList .tr .nm').innerText`);
log('8 添加素材后 图层数', layers2, '时间轴行数', rows2, '最上层', topName);
const shotL = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(`${S}/layers.png`, Buffer.from(shotL.result.data, 'base64'));
await ev(`document.querySelector('#trackList .tr[data-name="1"] .del').click(); true`);   // 第一次：变「确认?」
await sleep(120);
await ev(`document.querySelector('#trackList .tr[data-name="1"] .del').click(); true`);   // 第二次：确认删除
await sleep(200);
const layers3 = await ev(`document.querySelectorAll('#trackList .tr').length`);
log('   删除后 图层数', layers3);
const layerOk = layers2 === 2 && rows2 === 2 && topName === '1' && layers3 === 1;
// 关键帧命名：给第 2 帧取名
await ev(`(() => { const el = document.querySelectorAll('#kfTable .kl')[1]; el.value = '终点'; el.dispatchEvent(new Event('change')); })(); true`);
const labelOk = (await ev(`document.querySelectorAll('#tlRows .klb').length`)) === 1;
log('   关键帧命名后时间轴标签数', labelOk ? 1 : 0);
// 命名后再保存一次，用最终磁盘内容做校验
await ev(`document.querySelector('#save').click(); true`);
await sleep(500);
const saved2 = fs.readFileSync(TRACKS_PATH, 'utf8');
const body2 = saved2.slice(saved2.indexOf('window.TRACKS = ') + 'window.TRACKS = '.length).trim().replace(/;$/, '');
const scene2 = Object.values(JSON.parse(body2))[0];
const savedKf2 = (scene2.keys || scene2).bg;
log('   最终磁盘 bg 关键帧:', JSON.stringify(savedKf2));
const savedLayers = (scene2.layers || []).map(l => l.name);
log('   最终磁盘 layers:', JSON.stringify(savedLayers));
// 从播放头 1500ms 开始播放：应在 ~600ms 内播完并停在末帧
await ev(`document.querySelector('#kfT').value = 1500; document.querySelector('#kfT').dispatchEvent(new Event('change')); document.querySelector('#tlPlay').click(); true`);
await sleep(1200);
const headEnd = +await ev(`document.querySelector('#kfT').value`);
const fromOk = headEnd === 2000 && !(await ev(`document.querySelector('#tlPlay').classList.contains('on')`));
log('7 从 1500ms 播放后播放头停在', headEnd, 'ms');
const resultJson = JSON.stringify({ dragOk, wheelOk, rotOk, kfRows: rows === 2, tlKf: tlKf === 2, playOk, rippleOk, layerOk, labelOk, fromOk, savedTwoFrames: savedKf.length === 2 && savedKf2.length === 2 && savedKf2[1].label === '终点' && savedLayers.join() === 'bg' }); log('RESULT', resultJson);
fs.writeFileSync(TRACKS_PATH, backup); log('tracks.js 已恢复');
await send('Browser.close').catch(() => {}); chrome.kill('SIGKILL'); process.exit(Object.values(JSON.parse(resultJson)).every(Boolean) ? 0 : 1);
