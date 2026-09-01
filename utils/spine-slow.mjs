#!/usr/bin/env node
// 把 Spine 4.x JSON 里某个动作的时间轴整体缩放（慢放/加速）。
// 用法：node utils/spine-slow.mjs <骨架.json 路径> <动作名> <倍率> [新动作名]
//   倍率 2 = 时长变两倍（慢一倍）；给了新动作名则克隆，不给则原地改。
// 处理范围：所有 timeline 帧的 time 字段 + curve 贝塞尔数组的时间分量
//   （4.x 曲线是绝对时间：每 4 个数一组 [cx1, cy1, cx2, cy2]，cx 是时间、cy 是值，只缩 cx）。
import { readFileSync, writeFileSync } from 'node:fs';

const [file, animName, factorArg, newName] = process.argv.slice(2);
const factor = +factorArg;
if (!file || !animName || !(factor > 0)) {
  console.error('用法：node utils/spine-slow.mjs <骨架.json> <动作名> <倍率> [新动作名]');
  process.exit(1);
}
const data = JSON.parse(readFileSync(file, 'utf8'));
const anim = data.animations && data.animations[animName];
if (!anim) { console.error(`没有动作「${animName}」，现有：${Object.keys(data.animations || {}).join(', ')}`); process.exit(1); }

let maxT = 0, nTime = 0, nCurve = 0;
function scale(node) {
  if (Array.isArray(node)) { node.forEach(scale); return; }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'time' && typeof v === 'number') { node.time = v * factor; maxT = Math.max(maxT, node.time); nTime++; }
    else if (k === 'curve' && Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (i % 4 === 0 || i % 4 === 2) v[i] *= factor; nCurve++; }
    else scale(v);
  }
}
const target = newName ? JSON.parse(JSON.stringify(anim)) : anim;
scale(target);
if (newName) data.animations[newName] = target;
writeFileSync(file, JSON.stringify(data));
console.log(`${file} 的「${animName}」×${factor}${newName ? ` → 克隆为「${newName}」` : '（原地）'}：缩放 ${nTime} 个 time、${nCurve} 条曲线，新时长 ≈ ${maxT.toFixed(3)}s`);
