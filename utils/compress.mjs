#!/usr/bin/env node
/* 视频增量压缩：node utils/compress.mjs <视频路径> [--step 2] [--crf N]
 * 每跑一次多压一点点（CRF +step，默认起点 24、步长 2、上限 42），原地替换。
 * 首次运行会把原片备份到项目的 originals/ 下（assets 之外，不进打包产物），之后每次都【从原片】重编码——
 * 反复运行不会叠加画质损失，只是压缩档位逐次加深；想回退：cp .orig/<名字> 覆盖回去即可。
 * 音轨原样拷贝（不重编码）；分辨率/帧率不动，只调 CRF。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync, renameSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, basename, resolve } from 'node:path';

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--'));
if (!file) { console.error('用法：node utils/compress.mjs <视频路径> [--step 2] [--crf 强制档位]'); process.exit(1); }
const getOpt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? +args[i + 1] : dflt; };
const STEP = getOpt('step', 2), FORCE = getOpt('crf', null), START = 24, MAX = 42;

const target = resolve(file);
if (!existsSync(target)) { console.error('找不到', target); process.exit(1); }
const dir = dirname(target), name = basename(target);
// 原片与档位状态放到 assets 之外：…/assets/xx/91.mp4 → …/originals/xx/91.mp4（不会被打包脚本拷进 build）
const origDir = dir.includes('/assets') ? dir.replace(/\/assets(\/|$)/, '/originals$1') : join(dir, '..', 'originals');
const orig = join(origDir, name), stateFile = join(origDir, name + '.json');

mkdirSync(origDir, { recursive: true });
if (!existsSync(orig)) { copyFileSync(target, orig); console.log(`首次运行：原片已备份到 ${orig}`); }
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { crf: null, pass: 0 };
const crf = FORCE != null ? FORCE : (state.crf == null ? START : Math.min(state.crf + STEP, MAX));
if (crf === state.crf && FORCE == null) console.log(`已到上限 CRF ${MAX}，再压请用 --crf 手动指定或降分辨率`);

const tmp = join(dir, `.${name}.tmp.mp4`);
const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', orig,
  '-c:v', 'libx264', '-preset', 'veryslow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', '-movflags', '+faststart', tmp], { stdio: 'inherit' });
if (r.status !== 0) { console.error('ffmpeg 失败'); process.exit(1); }

const kb = f => (statSync(f).size / 1024).toFixed(0);
const before = kb(target), origKb = kb(orig);
renameSync(tmp, target);
state.crf = crf; state.pass++;
writeFileSync(stateFile, JSON.stringify(state));
console.log(`第 ${state.pass} 档 · CRF ${crf}：${before}KB → ${kb(target)}KB（原片 ${origKb}KB）`);
console.log(`不满意画质回退：cp '${orig}' '${target}'（并删 originals/ 下的 ${basename(stateFile)} 重置档位）`);
