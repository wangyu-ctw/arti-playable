#!/usr/bin/env node
/* 打包构建：node utils/build.mjs <projectname> [--single] [--lang ja] [--out zip名]
 *
 * 默认（文件夹模式）→ artifacts/<p>/build/：
 *   index.html（src/index.html 引用的 CSS/JS 压缩内联）+ assets/ 整目录 + i18n/*.json；
 *   ../assets/ 改写为 assets/，被引用资源加内容指纹 ?v=hash（spine/ 除外）。可托管到任意静态服务。
 *
 * --single（渠道上传包，Mintegral 等"全内联、零网络请求"渠道）→ artifacts/<p>/build/single/<p>-<lang>.zip（根目录一个全内联 index.html）：
 *   在文件夹模式基础上，把被引用的全部资源（视频/图/音频/Spine 三件套）转成 data URI 注入 window.__ASSETS，
 *   运行时 player 通过解析器把路径换成内联数据（Spine 走 setRawDataURI）；不加指纹、不拷 assets。
 *   --lang ja：把该语言字典（含 en 回落）编译期内联为 window.__I18N_INLINE，运行时不 fetch、不看 URL 参数。
 *   不传 --lang 则内联 en。产物 > 5MB 会警告（Mintegral 硬上限 5MB，建议 ≤ 3MB）。
 *   CTA/结束上报：运行时按环境自动适配（Mintegral window.install()/gameEnd() → MRAID → window.open），见 player.js。
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const args = process.argv.slice(2);
const proj = args.find(a => !a.startsWith('--'));
if (!proj) { console.error('用法：node utils/build.mjs <projectname> [--single] [--lang ja] [--out zip名]'); process.exit(1); }
const opt = name => { const i = args.indexOf('--' + name); return i >= 0 ? (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true) : null; };
const SINGLE = !!opt('single');
const LANG = typeof opt('lang') === 'string' ? opt('lang') : (SINGLE ? 'en' : null);
const OUT_NAME = typeof opt('out') === 'string' ? opt('out') : null;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'artifacts', proj, 'src');
const assetDir = join(root, 'artifacts', proj, 'assets');
const out = join(root, 'artifacts', proj, 'build');

const rewrite = s => s.split('../assets/').join('assets/');
const kb = n => (n / 1024).toFixed(1) + 'KB';
const minify = (code, label) => {
  const r = esbuild.transformSync(code, { minify: true, charset: 'utf8' });
  console.log(`  内联 ${label.padEnd(30)} ${kb(code.length)} → ${kb(r.code.length)}`);
  return r.code;
};

// ---- 1) index.html：CSS/JS 内联（+ 单文件模式内联语言字典）----
let html = readFileSync(join(srcDir, 'index.html'), 'utf8');
html = html.replace(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g, (_, href) => {
  const css = readFileSync(join(srcDir, href), 'utf8');
  const min = esbuild.transformSync(css, { loader: 'css', minify: true }).code;
  console.log(`  内联 ${href.padEnd(30)} ${kb(css.length)} → ${kb(min.length)}`);
  return `<style>${min}</style>`;
});
let inlineI18n = '';
if (SINGLE && LANG) {
  const rd = l => { const f = join(srcDir, 'i18n', l + '.json'); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null; };
  const dict = rd(LANG), fallback = rd('en');
  if (!dict) { console.error(`找不到语言字典 src/i18n/${LANG}.json`); process.exit(1); }
  inlineI18n = `<script>window.__I18N_INLINE=${JSON.stringify({ lang: LANG, dict, fallback: fallback || dict })};</script>`;
  console.log(`  内联语言字典 ${LANG}（回落 en）`);
}
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = readFileSync(join(srcDir, src), 'utf8');
  const js = src.endsWith('.min.js') ? (console.log(`  内联 ${src.padEnd(30)} ${kb(code.length)}（已压缩）`), code) : minify(code, src);
  const pre = (src.endsWith('i18n/i18n.js') && inlineI18n) ? inlineI18n : '';   // 字典须在 i18n.js 之前
  return `${pre}<script>${rewrite(js)}\n</script>`;
});
html = rewrite(html);
// 渠道结构检查（Mintegral）：DOCTYPE 统一大写字面；单文件模式把 <html lang> 烙成打包语言
html = html.replace(/^﻿?\s*<!doctype html>/i, '<!DOCTYPE html>');
if (SINGLE && LANG) html = html.replace(/<html\b[^>]*>/, `<html lang="${LANG}">`);
for (const [tag, re] of [['<!DOCTYPE html>', /^<!DOCTYPE html>/], ['<html>', /<html\b/], ['<head>', /<head\b/], ['<body>', /<body\b/], ['<meta charset="utf-8">', /<meta\s+charset=["']?utf-8["']?/i], ['viewport', /<meta\s+name=["']viewport["']/i]])
  if (!re.test(html)) console.warn(`⚠️ 结构检查：缺少 ${tag}`);

// ---- 2) 收集 assets ----
const assetFiles = [];
(function walk(from, rel) {
  for (const f of readdirSync(from)) {
    const a = join(from, f), r = rel ? rel + '/' + f : f;
    if (statSync(a).isDirectory()) walk(a, r); else assetFiles.push(r);
  }
})(assetDir, '');

if (!SINGLE) {
  // ================= 文件夹模式 =================
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) if (f !== 'single') rmSync(join(out, f), { recursive: true, force: true });   // 保留单文件产物目录
  let assetBytes = 0;
  for (const r of assetFiles) { const dst = join(out, 'assets', r); mkdirSync(dirname(dst), { recursive: true }); copyFileSync(join(assetDir, r), dst); assetBytes += statSync(dst).size; }
  // i18n 字典拷入（运行时 fetch）
  try {
    const i18nDir = join(srcDir, 'i18n');
    const files = readdirSync(i18nDir).filter(f => f.endsWith('.json'));
    if (files.length) { mkdirSync(join(out, 'i18n'), { recursive: true }); for (const f of files) copyFileSync(join(i18nDir, f), join(out, 'i18n', f)); console.log(`  拷贝 i18n/ ${files.length} 个语言字典`); }
  } catch (_) { /* 无 i18n 目录 */ }
  // 资源指纹（spine/ 除外：atlas/图集路径由运行时推导）
  let hashed = 0;
  for (const r of assetFiles) {
    if (r.startsWith('spine/')) continue;
    const h = createHash('md5').update(readFileSync(join(assetDir, r))).digest('hex').slice(0, 8);
    const before = html; html = html.split(`assets/${r}`).join(`assets/${r}?v=${h}`); if (html !== before) hashed++;
  }
  console.log(`  资源指纹：${hashed} 个被引用的资源已加 ?v=hash（spine/ 除外）`);
  writeFileSync(join(out, 'index.html'), html);
  const htmlB = statSync(join(out, 'index.html')).size;
  console.log(`\nbuild/index.html：${kb(htmlB)}（含全部代码内联）`);
  console.log(`build/assets/：${assetFiles.length} 个文件，${(assetBytes / 1048576).toFixed(2)}MB`);
  console.log(`合计：${((htmlB + assetBytes) / 1048576).toFixed(2)}MB → artifacts/${proj}/build/`);
  if (html.includes('../assets/')) console.warn('⚠️ 仍有未改写的 ../assets/ 引用，请检查');
} else {
  // ================= 单文件模式 =================
  const MIME = { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', webp: 'image/webp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', json: 'application/json', atlas: 'text/plain', skel: 'application/octet-stream' };
  // 被引用的资源：字符串 'assets/<rel>' 出现在 HTML 里；Spine 只会引用 .json/.skel/.atlas，其同目录三件套整套带上
  // （目录判定：任一层叫 spine/，或文件本身是 .skel/.atlas——hotd-2 的角色骨架在 <code>/spine/battle/ 下）
  const referenced = new Set(assetFiles.filter(r => html.includes(`assets/${r}`)));
  for (const r of [...referenced]) if (/(^|\/)spine\//.test(r) || /\.(skel|atlas)$/i.test(r)) { const dir = r.slice(0, r.lastIndexOf('/') + 1); assetFiles.filter(x => x.startsWith(dir)).forEach(x => referenced.add(x)); }
  const map = {}; let rawBytes = 0;
  for (const r of [...referenced].sort()) {
    const buf = readFileSync(join(assetDir, r)); rawBytes += buf.length;
    const mime = MIME[extname(r).slice(1).toLowerCase()] || 'application/octet-stream';
    map[`assets/${r}`] = `data:${mime};base64,${buf.toString('base64')}`;
  }
  const unused = assetFiles.filter(r => !referenced.has(r));
  const assetsScript = `<script>window.__ASSETS=${JSON.stringify(map)};</script>`;
  if (!/<body\b[^>]*>/.test(html)) { console.error('找不到 <body> 开标签，无法注入资源表'); process.exit(1); }
  html = html.replace(/<body\b[^>]*>/, m => m + assetsScript);   // 资源表紧跟 body 开标签（可带属性，如 data-bg），须在 player 之前
  const outDir = join(out, 'single'); mkdirSync(outDir, { recursive: true });
  const zipName = (OUT_NAME || `${proj}-${LANG}`).replace(/\.(zip|html?)$/i, '') + '.zip';
  // 只产出 zip（根目录一个全内联的 index.html）：HTML 在临时目录生成、打包后即删，不留散落的单文件
  const tmp = join(outDir, '.zip-tmp'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
  writeFileSync(join(tmp, 'index.html'), html);
  const size = Buffer.byteLength(html);
  console.log(`  内联资源 ${referenced.size} 个（原始 ${(rawBytes / 1048576).toFixed(2)}MB → base64 约 ${(rawBytes * 4 / 3 / 1048576).toFixed(2)}MB）${unused.length ? `；未被引用未打入：${unused.join(', ')}` : ''}`);
  console.log(`  index.html（全内联，解压后体积）：${(size / 1048576).toFixed(2)}MB`);
  if (size > 5 * 1048576) console.warn('⚠️ 解压后超过 5MB（Mintegral 硬上限），请先压缩素材');
  else if (size > 3 * 1048576) console.warn('ℹ️ 解压后超过 3MB（Mintegral 建议值），可考虑再压素材');
  if (html.includes('../assets/')) console.warn('⚠️ 仍有未改写的 ../assets/ 引用，请检查');
  rmSync(join(outDir, zipName), { force: true });
  const z = spawnSync('zip', ['-q', '-X', '-9', join(outDir, zipName), 'index.html'], { cwd: tmp, stdio: 'inherit' });
  rmSync(tmp, { recursive: true, force: true });
  if (z.status !== 0) { console.error('zip 失败（缺少 zip 命令？）'); process.exit(1); }
  console.log(`\n上传包：${(statSync(join(outDir, zipName)).size / 1048576).toFixed(2)}MB → artifacts/${proj}/build/single/${zipName}（根目录 index.html）`);
}
