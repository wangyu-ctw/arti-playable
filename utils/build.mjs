#!/usr/bin/env node
/* 打包构建：node utils/build.mjs <projectname>
 * 产物 artifacts/<p>/build/ = 可直接分发的「HTML + 资源」结构：
 *   build/index.html   —— src/index.html 里引用的 CSS 与全部 JS（vendor/player/tracks/behaviors/scenes）
 *                         压缩后按原顺序内联成单个 HTML（.min.js 不再二次压缩）
 *   build/assets/      —— artifacts/<p>/assets 整目录拷贝
 * 所有代码里的 ../assets/ 引用改写为 assets/（index.html 与 assets 同级）。
 * 本地预览：http://localhost:8080/artifacts/<p>/build/index.html（视频 seek 需要支持 Range 的服务，如 serve.py）
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('esbuild');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const proj = process.argv[2];
if (!proj) { console.error('用法：node utils/build.mjs <projectname>'); process.exit(1); }
const srcDir = join(root, 'artifacts', proj, 'src');
const assetDir = join(root, 'artifacts', proj, 'assets');
const out = join(root, 'artifacts', proj, 'build');

const rewrite = s => s.split('../assets/').join('assets/');
const minify = (code, label) => {
  const r = esbuild.transformSync(code, { minify: true, charset: 'utf8' });
  console.log(`  内联 ${label.padEnd(30)} ${(code.length / 1024).toFixed(1)}KB → ${(r.code.length / 1024).toFixed(1)}KB`);
  return r.code;
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) index.html：CSS/JS 内联
let html = readFileSync(join(srcDir, 'index.html'), 'utf8');
html = html.replace(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"[^>]*>/g, (_, href) => {
  const css = readFileSync(join(srcDir, href), 'utf8');
  const min = esbuild.transformSync(css, { loader: 'css', minify: true }).code;
  console.log(`  内联 ${href.padEnd(30)} ${(css.length / 1024).toFixed(1)}KB → ${(min.length / 1024).toFixed(1)}KB`);
  return `<style>${min}</style>`;
});
html = html.replace(/<script src="([^"]+)"><\/script>/g, (_, src) => {
  const code = readFileSync(join(srcDir, src), 'utf8');
  const js = src.endsWith('.min.js') ? (console.log(`  内联 ${src.padEnd(30)} ${(code.length / 1024).toFixed(1)}KB（已压缩）`), code) : minify(code, src);
  return `<script>${rewrite(js)}\n</script>`;
});
html = rewrite(html);
writeFileSync(join(out, 'index.html'), html);

// 2) assets 整目录拷贝
let assetBytes = 0, assetCount = 0;
(function cp(from, to) {
  mkdirSync(to, { recursive: true });
  for (const f of readdirSync(from)) {
    const a = join(from, f), b = join(to, f);
    if (statSync(a).isDirectory()) cp(a, b);
    else { copyFileSync(a, b); assetBytes += statSync(a).size; assetCount++; }
  }
})(assetDir, join(out, 'assets'));

const htmlKB = statSync(join(out, 'index.html')).size / 1024;
console.log(`\nbuild/index.html：${htmlKB.toFixed(1)}KB（含全部代码内联）`);
console.log(`build/assets/：${assetCount} 个文件，${(assetBytes / 1048576).toFixed(2)}MB`);
console.log(`合计：${((htmlKB * 1024 + assetBytes) / 1048576).toFixed(2)}MB → artifacts/${proj}/build/`);
if (html.includes('../assets/')) console.warn('⚠️ 仍有未改写的 ../assets/ 引用，请检查');
