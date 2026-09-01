/* player.js — 共用骨架（不含任何项目内容）。
 * 职责：舞台缩放适配、场景注册/切换/转场、选项与闲置超时自动选、结局 CTA、
 *      素材辅助（video/image 默认 contain）、素材轨道（sprite + 关键帧，数据来自 tracks.js）、
 *      对外调试接口 window.__playable（供 utils/preview.html 预览与编辑模式使用，协议见简报 §9）。
 */
(function () {
  'use strict';
  const STAGE = { w: 750, h: 1334 };          // 设计基准，与 styles.css 的 --stage-w/h 一致（简报 §7）
  const DEFAULT_IDLE_MS = 5000;                // 闲置多久自动随机选
  const TRANSITION_MS = 500;                   // 与 styles.css 中 .scene 转场时长匹配（取最长）

  const scenes = new Map();
  const order = [];
  const listeners = new Set();
  let stage, current = null, ctxNow = null, paused = false, idleEnabled = true, idleTimer = null, idleArgs = null;

  // ---------- 事件 ----------
  function emit(ev) {
    ev.t = performance.now() | 0;
    listeners.forEach(fn => { try { fn(ev); } catch (e) { /* 调试方错误不影响播放 */ } });
  }

  // ---------- 缩放适配：contain 到视口 ----------
  function fitStage() {
    const s = Math.min(window.innerWidth / STAGE.w, window.innerHeight / STAGE.h);
    stage.style.transform = `translate(-50%,-50%) scale(${s})`;
  }

  // ---------- 素材轨道：姿态 {x,y,s,sy?,r,o?} = 偏移(px) + 缩放 + 旋转(度) + 透明度(缺省1)；纯色素材(type:'rect')的关键帧还可带 c=颜色 ----------
  const tracksData = () => window.TRACKS || {};
  /** 场景数据归一化：{ layers:[{name,src,loop?,hidden?}] (顺序=叠放顺序，后者在上), keys:{ name:[{t,x,y,s,ease?,label?}] } }；兼容旧写法 { name:[kf] } */
  function sceneData(id) { const d = tracksData()[id]; if (!d) return { layers: [], keys: {} }; if (Array.isArray(d.layers) || d.keys) return { layers: d.layers || [], keys: d.keys || {} }; return { layers: [], keys: d }; }
  const keysOf = (id, name) => sceneData(id).keys[name] || null;
  const poseToTransform = p => `translate(${p.x}px, ${p.y}px) scale(${p.s}, ${p.sy ?? p.s}) rotate(${p.r || 0}deg)`;
  function sizeTrack(wrap, w, h) { wrap.style.width = w + 'px'; wrap.style.height = h + 'px'; wrap.style.marginLeft = (-w / 2) + 'px'; wrap.style.marginTop = (-h / 2) + 'px'; wrap.dataset.w = w; wrap.dataset.h = h; wrap.dataset.fit = Math.min(STAGE.w / w, STAGE.h / h); }
  function setPose(wrap, p) {
    wrap.getAnimations().forEach(a => a.cancel());
    if (wrap._colorAnim) { try { wrap._colorAnim.cancel(); } catch (e) {} wrap._colorAnim = null; }
    wrap.style.visibility = ''; wrap.style.transform = poseToTransform(p);
    wrap.style.opacity = p.o != null ? p.o : '';
    if (p.c && wrap.media && wrap.dataset.type === 'rect') wrap.media.style.backgroundColor = p.c;
    wrap._pose = { x: +p.x, y: +p.y, s: +p.s, sy: p.sy != null ? +p.sy : undefined, r: +(p.r || 0), o: p.o != null ? +p.o : undefined };
  }
  /** 图层时间窗：in 之前、out 之后不可见（win = {in?, out?}，ms）。返回控制显隐的动画（无窗口则 null） */
  function windowAnim(wrap, win, total) {
    const inT = Math.max(0, win.in || 0), outT = win.out == null ? null : Math.max(inT, win.out);
    if (!inT && outT == null) return null;
    const T = Math.max(total || 0, outT || 0, inT, 1);
    const frames = [{ offset: 0, visibility: inT > 0 ? 'hidden' : 'visible' }];
    if (inT > 0) frames.push({ offset: Math.min(1, inT / T), visibility: 'hidden' }, { offset: Math.min(1, inT / T), visibility: 'visible' });
    if (outT != null && outT / T <= 1) frames.push({ offset: outT / T, visibility: 'visible' }, { offset: outT / T, visibility: 'hidden' });
    frames.push({ offset: 1, visibility: (outT != null && outT <= T) ? 'hidden' : 'visible' });
    return bornPaused(wrap.animate(frames, { duration: T, fill: 'forwards' }));
  }
  function getPose(wrap) { const cs = getComputedStyle(wrap); const m = new DOMMatrix(cs.transform); const sx = Math.hypot(m.a, m.b) || 1e-6; return { x: m.e, y: m.f, s: sx, sy: (m.a * m.d - m.b * m.c) / sx, r: Math.atan2(m.b, m.a) * 180 / Math.PI, o: parseFloat(cs.opacity) }; }
  function animateTrack(wrap, kf) {
    const sorted = [...kf].sort((a, b) => a.t - b.t); const T = Math.max(1, sorted[sorted.length - 1].t);
    // ease 为"到达语义"：第 i 帧的 ease 描述 (i-1)→i 的过渡；WAAPI 的 easing 挂在段起点，所以取下一帧的 ease
    const anyO = sorted.some(k => k.o != null);
    const frames = sorted.map((k, i) => ({ offset: Math.min(1, Math.max(0, k.t / T)), transform: poseToTransform(k), easing: (sorted[i + 1] && sorted[i + 1].ease) || 'ease-in-out', ...(anyO ? { opacity: k.o != null ? +k.o : 1 } : {}) }));
    let colors = null;   // 纯色素材：颜色列表（缺省沿用前一帧）
    if (wrap.media && wrap.dataset.type === 'rect' && sorted.some(k => k.c)) {
      let cur = (sorted.find(k => k.c) || {}).c;
      colors = sorted.map(k => { if (k.c) cur = k.c; return cur; });
    }
    // 首帧不在 t=0 的轨道：0→首帧时刻保持首帧姿态不动（否则整段被拉成超长补间，首帧前位置全错）
    if (frames[0].offset > 0.0001) { frames.unshift({ ...frames[0], offset: 0, easing: 'linear' }); if (colors) colors.unshift(colors[0]); }
    else frames[0].offset = 0;
    frames[frames.length - 1].offset = 1;
    wrap.getAnimations().forEach(a => a.cancel());
    if (wrap._colorAnim) { try { wrap._colorAnim.cancel(); } catch (e) {} wrap._colorAnim = null; }
    const a = bornPaused(wrap.animate(frames, { duration: T, fill: 'forwards' }));
    if (colors) wrap._colorAnim = bornPaused(wrap.media.animate(frames.map((f, i) => ({ offset: f.offset, backgroundColor: colors[i], easing: f.easing })), { duration: T, fill: 'forwards' }));
    return a;
  }
  const findTrack = name => ctxNow && ctxNow.root.querySelector(`.track[data-track="${name}"]`);
  /** 播放器暂停期间创建的动画：出生即暂停，并打恢复标记（resume 时一并唤醒） */
  function bornPaused(a) { if (paused) { a.pause(); a._pausedByPlayer = true; } return a; }

  // ---------- 内部动效：素材自身的无限循环动画，嵌套在姿态容器内（与关键帧运动叠加） ----------
  // 数据：layer.fx = [{ type, amp?, period? }, ...]，可叠加多个（依次嵌套）
  const FX = {
    bob:     { label: '上下浮动', unit: 'px', def: { amp: 12, period: 1600 }, make: (el, p) => el.animate([{ transform: 'translateY(0)', easing: 'ease-in-out' }, { transform: `translateY(${-p.amp}px)`, offset: .25, easing: 'ease-in-out' }, { transform: 'translateY(0)', offset: .5, easing: 'ease-in-out' }, { transform: `translateY(${p.amp}px)`, offset: .75, easing: 'ease-in-out' }, { transform: 'translateY(0)' }], { duration: p.period, iterations: Infinity }) },
    drift:   { label: '左右浮动', unit: 'px', def: { amp: 12, period: 1800 }, make: (el, p) => el.animate([{ transform: 'translateX(0)', easing: 'ease-in-out' }, { transform: `translateX(${p.amp}px)`, offset: .25, easing: 'ease-in-out' }, { transform: 'translateX(0)', offset: .5, easing: 'ease-in-out' }, { transform: `translateX(${-p.amp}px)`, offset: .75, easing: 'ease-in-out' }, { transform: 'translateX(0)' }], { duration: p.period, iterations: Infinity }) },
    sway:    { label: '摇摆', unit: '°', def: { amp: 6, period: 2000 }, make: (el, p) => el.animate([{ transform: 'rotate(0)', easing: 'ease-in-out' }, { transform: `rotate(${p.amp}deg)`, offset: .25, easing: 'ease-in-out' }, { transform: 'rotate(0)', offset: .5, easing: 'ease-in-out' }, { transform: `rotate(${-p.amp}deg)`, offset: .75, easing: 'ease-in-out' }, { transform: 'rotate(0)' }], { duration: p.period, iterations: Infinity }) },
    pulse:   { label: '呼吸缩放', unit: '倍', def: { amp: 0.05, period: 1800 }, make: (el, p) => el.animate([{ transform: 'scale(1)', easing: 'ease-in-out' }, { transform: `scale(${1 + p.amp})`, offset: .5, easing: 'ease-in-out' }, { transform: 'scale(1)' }], { duration: p.period, iterations: Infinity }) },
    flicker: { label: '闪烁', unit: '最低不透明度', def: { amp: 0.55, period: 1200 }, make: (el, p) => el.animate([{ opacity: 1, easing: 'ease-in-out' }, { opacity: p.amp, offset: .5, easing: 'ease-in-out' }, { opacity: 1 }], { duration: p.period, iterations: Infinity }) },
    shake:   { label: '抖动', unit: 'px', def: { amp: 4, period: 320 }, make: (el, p) => el.animate([{ transform: 'translate(0,0)' }, { transform: `translate(${p.amp}px,${-p.amp * .6}px)`, offset: .2 }, { transform: `translate(${-p.amp * .8}px,${p.amp * .5}px)`, offset: .4 }, { transform: `translate(${p.amp * .6}px,${p.amp}px)`, offset: .6 }, { transform: `translate(${-p.amp}px,${-p.amp * .4}px)`, offset: .8 }, { transform: 'translate(0,0)' }], { duration: p.period, iterations: Infinity }) },
    spin:    { label: '旋转', unit: '', def: { amp: 0, period: 3000 }, make: (el, p) => el.animate([{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], { duration: p.period, iterations: Infinity }) },
    shear:   { label: '顶边摇摆', unit: 'px', def: { amp: 20, period: 1800, dir: 'right' }, make: (el, p) => {   // 底边固定，顶边水平来回平移（矩形↔平行四边形）；dir=先向左/右
      el.style.transformOrigin = '50% 100%';
      const h = el.offsetHeight || 100, a0 = Math.atan2(p.amp, h) * 180 / Math.PI;
      const a = p.dir === 'left' ? a0 : -a0;   // skewX 正角=顶边向左
      // 正弦式缓动配对：中心→端点减速(easeOutSine)、端点→中心加速(easeInSine)，过原点不停顿、循环无缝
      const OUT = 'cubic-bezier(0.39,0.575,0.565,1)', IN = 'cubic-bezier(0.47,0,0.745,0.715)';
      return el.animate([{ transform: 'skewX(0)', easing: OUT }, { transform: `skewX(${a}deg)`, offset: .25, easing: IN }, { transform: 'skewX(0)', offset: .5, easing: OUT }, { transform: `skewX(${-a}deg)`, offset: .75, easing: IN }, { transform: 'skewX(0)' }], { duration: p.period, iterations: Infinity });
    } },
  };
  /** 文字素材：把 spans 渲染进 <p>（每个 span 一行，独立颜色/字体/对齐） */
  function renderSpans(pEl, spans) {
    pEl.innerHTML = '';
    (spans || []).forEach(sp => {
      const e = document.createElement('span');
      e.textContent = sp.text || '';
      if (sp.color) e.style.color = sp.color;
      if (sp.font) e.style.fontFamily = sp.font;
      e.style.textAlign = sp.align || 'center';
      if (sp.size) e.style.fontSize = sp.size + 'px';
      if (sp.glow > 0) { const gc = sp.glowColor || sp.color || '#ffffff'; e.style.textShadow = `0 0 ${sp.glow}px ${gc}, 0 0 ${sp.glow * 2}px ${gc}`; }   // 外发光：双层阴影
      if (sp.stroke > 0) { e.style.webkitTextStroke = `${sp.stroke}px ${sp.strokeColor || '#000000'}`; e.style.paintOrder = 'stroke fill'; }   // 描边：stroke 画在填充之下
      pEl.appendChild(e);
    });
  }
  /** 量出文字自然尺寸并设为轨道自然尺寸（素材像素） */
  function sizeTextTrack(wrap) {
    const m = wrap.media;
    m.style.width = 'max-content'; m.style.height = 'auto';   // 量尺时取消 .track-media 的 100% 宽高
    const w = Math.max(2, m.offsetWidth), h = Math.max(2, m.offsetHeight);
    m.style.width = '100%'; m.style.height = '100%';
    sizeTrack(wrap, w, h);
  }

  // ---------- 四角变形：矩形 → 任意四边形（图层级属性 layer.quad = [dx0,dy0, dx1,dy1, dx2,dy2, dx3,dy3]，
  //             四角依次 左上/右上/右下/左下 在素材原始像素坐标下的偏移；用单应矩阵映射为 matrix3d，挂在素材内层） ----------
  const adj3 = m => [m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3]];
  const mul3 = (a, b) => [a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8]];
  const mul3v = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
  function basisToPts(p) { const m = [p[0][0], p[1][0], p[2][0], p[0][1], p[1][1], p[2][1], 1, 1, 1]; const v = mul3v(adj3(m), [p[3][0], p[3][1], 1]); return mul3(m, [v[0], 0, 0, 0, v[1], 0, 0, 0, v[2]]); }
  function quadMatrix(w, h, q) {
    const src = [[0, 0], [w, 0], [w, h], [0, h]];
    const dst = src.map((p, i) => [p[0] + (q[i * 2] || 0), p[1] + (q[i * 2 + 1] || 0)]);
    const H = mul3(basisToPts(dst), adj3(basisToPts(src)));
    const n = H[8] || 1, m = H.map(v => v / n);
    return `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,${m[8]})`;
  }
  /** 应用/清除四角变形：在素材图外套一层 .quadwrap 承载 matrix3d（在动效链最内层） */
  function applyQuad(wrap, q) {
    const m = wrap && wrap.media; if (!m) return;
    let qd = m.parentElement && m.parentElement.classList.contains('quadwrap') ? m.parentElement : null;
    if (!q || q.every(v => !v)) { if (qd) { qd.parentElement.insertBefore(m, qd); qd.remove(); } wrap._quad = null; return; }
    if (!qd) { qd = document.createElement('div'); qd.className = 'quadwrap'; m.parentElement.insertBefore(qd, m); qd.appendChild(m); }
    qd.style.transform = quadMatrix(+wrap.dataset.w, +wrap.dataset.h, q);
    wrap._quad = q.slice();
  }

  // ---- 关键帧级四角变形：kf.quad 只写在设置帧上，其余帧视为 0；播放/scrub 时按到达 ease 逐分量插值 ----
  const QZ8 = [0, 0, 0, 0, 0, 0, 0, 0];
  function cubicBezierRt(x1, y1, x2, y2) {
    const A = a => 3 * a, cx = A(x1), bx = A(x2 - x1) - cx, ax = 1 - cx - bx, cy = A(y1), by = A(y2 - y1) - cy, ay = 1 - cy - by;
    const fx = t => ((ax * t + bx) * t + cx) * t, fy = t => ((ay * t + by) * t + cy) * t;
    return u => { if (u <= 0) return 0; if (u >= 1) return 1; let lo = 0, hi = 1, t = u;
      for (let i = 0; i < 24; i++) { const x = fx(t); if (Math.abs(x - u) < 1e-5) break; if (x < u) lo = t; else hi = t; t = (lo + hi) / 2; }
      return fy(t); };
  }
  const EASE_RT = { linear: u => u, ease: cubicBezierRt(.25, .1, .25, 1), 'ease-in': cubicBezierRt(.42, 0, 1, 1), 'ease-out': cubicBezierRt(0, 0, .58, 1), 'ease-in-out': cubicBezierRt(.42, 0, .58, 1), 'step-end': u => u < 1 ? 0 : 1, 'step-start': () => 1 };
  function easeRt(name) {
    if (!name) return EASE_RT['ease-in-out'];
    if (EASE_RT[name]) return EASE_RT[name];
    const m = /^cubic-bezier\(([^)]+)\)$/.exec(name);
    if (m) { const [a, b, c, d] = m[1].split(',').map(Number); return (EASE_RT[name] = cubicBezierRt(a, b, c, d)); }
    return EASE_RT['ease-in-out'];
  }
  /** 采样 t 时刻的四角变形；该轨没有任何帧带 quad → null */
  function sampleQuad(kfs, t) {
    if (!kfs || !kfs.length || !kfs.some(k => k.quad)) return null;
    const sorted = kfs;
    if (t <= sorted[0].t || sorted.length === 1) return sorted[0].quad || QZ8;
    const last = sorted[sorted.length - 1];
    if (t >= last.t) return last.quad || QZ8;
    let i = 0; while (sorted[i + 1].t < t) i++;
    const a = sorted[i], b = sorted[i + 1], u = easeRt(b.ease)((t - a.t) / Math.max(1, b.t - a.t));
    const qa = a.quad || QZ8, qb = b.quad || QZ8;
    return qa.map((v, j) => v + (qb[j] - v) * u);
  }

  /** 重建 wrap 内的动效链：wrap > fx1 > fx2 > … > media */
  function applyFx(wrap, fxList) {
    if (!wrap || !wrap.media) return;
    const m = wrap.media;
    let inner = m.parentElement && m.parentElement.classList.contains('quadwrap') ? m.parentElement : m;   // 四角变形层是最内核心，随 media 一起保留
    while (inner.parentElement !== wrap) { const d = inner.parentElement; d.getAnimations().forEach(a => a.cancel()); d.parentElement.insertBefore(inner, d); d.remove(); }
    let cur = inner;
    [...(fxList || [])].reverse().forEach(f => {
      const spec = FX[f.type]; if (!spec) { emit({ type: 'warn', msg: `未知内部动效: ${f.type}` }); return; }
      const d = document.createElement('div'); d.className = 'fx'; d.dataset.fx = f.type;
      cur.parentElement.insertBefore(d, cur); d.appendChild(cur);
      spec.make(d, { ...spec.def, ...f });   // 创建即运行（编辑模式调参可见；运行时整体暂停会连它一起暂停）
      cur = d;
    });
  }

  // ---------- 预加载：进入一个场景时，后台拉取 next 与各选项目标场景的素材，保证段落衔接不空窗 ----------
  const isVideoSrc = src => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(src);
  const isSpineSrc = src => /\.(json|skel)(\?|$)/i.test(src || '');
  const isAudioSrc = src => /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(src || '');
  const isAV = el => !!el && (el.tagName === 'VIDEO' || el.tagName === 'AUDIO');   // 音频轨与视频轨同语义
  const preloaded = new Set();
  function preloadScene(id) {
    const sc = scenes.get(id); if (!sc || preloaded.has(id)) return; preloaded.add(id);
    const srcs = [...sceneData(id).layers.map(L => L.src), ...(sc.preload || [])].filter(Boolean);   // layers + 场景自声明的 preload（文字层无 src）
    srcs.forEach(src => {
      if (isVideoSrc(src)) { const v = document.createElement('video'); v.preload = 'auto'; v.muted = true; v.src = src; preloadScene._keep.push(v); }
      else if (isSpineSrc(src)) {   // Spine 三件套：骨架 + atlas + 图集图
        fetch(src).catch(() => {});
        const stem = src.replace(/\.(json|skel)(\?.*)?$/i, '');
        fetch(stem + '.atlas').then(r => r.text()).then(txt => {
          const page = txt.split('\n').map(s => s.trim()).find(l => /\.(png|webp|jpe?g)$/i.test(l));
          if (page) { const i = new Image(); i.src = stem.slice(0, stem.lastIndexOf('/') + 1) + page; if (i.decode) i.decode().catch(() => {}); preloadScene._keep.push(i); }
        }).catch(() => {});
      }
      else { const i = new Image(); i.src = src; if (i.decode) i.decode().catch(() => {}); preloadScene._keep.push(i); }   // decode()：提前解码，避免首绘瞬间的解码卡顿
    });
    if (srcs.length) emit({ type: 'preload', id, count: srcs.length });
  }
  preloadScene._keep = [];   // 持有引用，防止被 GC 后重新下载

  // ---------- Spine 骨骼图层（vendor/spine-webgl.min.js，全局 spine，版本需与导出一致） ----------
  // 全页共享一个离屏 WebGL 画布（浏览器 WebGL 上下文有 ~16 个的上限，逐层建上下文撑不起一群）：
  // 每个图层只是轻量 2D canvas，渲染时在共享 GL 上画好该骨架再拷贝过去；骨架数据按 src 缓存（同骨架多实例只加载一次）。
  let _spineShared = null;
  function spineShared() {
    if (_spineShared) return _spineShared;
    const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 64;
    const glc = new spine.ManagedWebGLRenderingContext(canvas, { alpha: true });
    return _spineShared = { canvas, glc, renderer: new spine.SceneRenderer(canvas, glc), loads: new Map() };
  }
  /** 按 src 加载并缓存骨架：{data, pma, bounds}。bounds = 导出画布 ∪ 全部动作包围盒（动作移出导出范围也不裁剪） */
  function spineLoad(src) {
    const sh = spineShared();
    if (sh.loads.has(src)) return sh.loads.get(src);
    const p = (async () => {
      const base = src.slice(0, src.lastIndexOf('/') + 1), file = src.slice(src.lastIndexOf('/') + 1);
      const stem = file.replace(/\.(json|skel)$/i, ''), isBin = /\.skel$/i.test(file);
      const assets = new spine.AssetManager(sh.glc, base);
      if (isBin) assets.loadBinary(file); else assets.loadText(file);
      assets.loadTextureAtlas(stem + '.atlas');
      await assets.loadAll();
      const atlas = assets.require(stem + '.atlas');
      const parser = isBin ? new spine.SkeletonBinary(new spine.AtlasAttachmentLoader(atlas)) : new spine.SkeletonJson(new spine.AtlasAttachmentLoader(atlas));
      const data = parser.readSkeletonData(assets.require(file));
      const skeleton = new spine.Skeleton(data), state = new spine.AnimationState(new spine.AnimationStateData(data));
      let minX = data.x || 0, minY = data.y || 0, maxX = minX + (data.width || 0), maxY = minY + (data.height || 0);
      const bo = new spine.Vector2(), bs = new spine.Vector2(), tmp = [];
      for (const a of data.animations) {
        const e = state.setAnimation(0, a.name, false);
        const steps = Math.max(4, Math.ceil(a.duration * 12));
        for (let i = 0; i <= steps; i++) {
          e.trackTime = a.duration * i / steps;
          state.apply(skeleton); skeleton.updateWorldTransform(spine.Physics.update);
          skeleton.getBounds(bo, bs, tmp);
          if (bs.x > 0 && bs.y > 0) { minX = Math.min(minX, bo.x); minY = Math.min(minY, bo.y); maxX = Math.max(maxX, bo.x + bs.x); maxY = Math.max(maxY, bo.y + bs.y); }
        }
      }
      return { data, pma: !!(atlas.pages[0] && atlas.pages[0].pma), bounds: { minX, minY, maxX, maxY } };
    })();
    sh.loads.set(src, p);
    p.catch(() => sh.loads.delete(src));   // 失败不缓存，下次可重试
    return p;
  }
  /** 挂载一个 Spine 图层实例到 wrap._spine（skeleton/state 独立，数据共享）。失败仅告警不阻塞 */
  async function initSpine(wrap, src, spec) {
    if (typeof spine === 'undefined') { emit({ type: 'warn', msg: `Spine 运行时未加载（vendor/spine-webgl.min.js），图层 ${wrap.dataset.track} 显示为空` }); return false; }
    try {
      const { data, pma, bounds } = await spineLoad(src);
      const W = Math.max(2, Math.ceil(bounds.maxX - bounds.minX) + 4), H = Math.max(2, Math.ceil(bounds.maxY - bounds.minY) + 4);
      const canvas = wrap.media;
      canvas.width = W; canvas.height = H; sizeTrack(wrap, W, H);
      const skeleton = new spine.Skeleton(data);
      const state = new spine.AnimationState(new spine.AnimationStateData(data));
      const anims = data.animations.map(a => ({ name: a.name, dur: Math.round(a.duration * 1000) }));
      const wanted = spec && spec.anim, animName = (wanted && anims.some(a => a.name === wanted)) ? wanted : (anims[0] && anims[0].name);
      if (wanted && wanted !== animName) emit({ type: 'warn', msg: `Spine ${wrap.dataset.track} 没有动作「${wanted}」，用「${animName}」代替` });
      const S = wrap._spine = { skeleton, state, anims, pma, entry: null, anim: animName, loop: !spec || spec.loop !== false, dur: 0, W, H, cx: (bounds.minX + bounds.maxX) / 2, cy: (bounds.minY + bounds.maxY) / 2, ctx2d: canvas.getContext('2d') };
      if (animName) { S.entry = state.setAnimation(0, animName, S.loop); S.dur = Math.round(S.entry.animation.duration * 1000); }
      renderSpineAt(wrap, 0);
      return true;
    } catch (err) { emit({ type: 'warn', msg: `Spine 加载失败 ${src}: ${err && err.message}` }); return false; }
  }
  /** 把 Spine 图层渲染到内容时间 sec 秒。确定性（时间→姿态纯函数）：暂停、seek、编辑器 scrub 都天然正确 */
  function renderSpineAt(wrap, sec) {
    const S = wrap._spine; if (!S || !S.entry) return;
    S.lastRawSec = sec;                  // 记录原始内容时间，供 setSpineAnim(restart) 重定原点
    sec -= (S.rebaseSec || 0);           // restart 切动作后：内容时间从切换时刻重新计零
    const d = S.entry.animation.duration;
    S.entry.trackTime = (S.loop && d > 0) ? ((sec % d) + d) % d : Math.max(0, sec);   // loop 取模（负相位也成立）；非 loop 播完定格末姿态
    S.state.apply(S.skeleton);
    S.skeleton.update(0); S.skeleton.updateWorldTransform(spine.Physics.update);
    const sh = spineShared(), gl = sh.glc.gl;
    if (sh.canvas.width < S.W) sh.canvas.width = S.W;
    if (sh.canvas.height < S.H) sh.canvas.height = S.H;
    const gy = sh.canvas.height - S.H;   // GL 原点在左下：把渲染区钉在显示坐标的左上角
    gl.viewport(0, gy, S.W, S.H);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(0, gy, S.W, S.H);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    sh.renderer.camera.position.x = S.cx; sh.renderer.camera.position.y = S.cy;
    sh.renderer.camera.setViewport(S.W, S.H);
    sh.renderer.begin(); sh.renderer.drawSkeleton(S.skeleton, S.pma); sh.renderer.end();
    gl.disable(gl.SCISSOR_TEST);
    S.ctx2d.clearRect(0, 0, S.W, S.H);
    S.ctx2d.drawImage(sh.canvas, 0, 0, S.W, S.H, 0, 0, S.W, S.H);   // 同一帧内拷贝，无需 preserveDrawingBuffer
  }

  // ---------- 场景切换 ----------
  async function goto(id) {
    const sc = scenes.get(id);
    if (!sc) { emit({ type: 'error', msg: `场景不存在: ${id}` }); return; }
    clearIdle();
    const prev = ctxNow;
    if (prev) { prev.alive = false; prev.root.classList.add('out'); prev.root.classList.remove('in'); prev.root.querySelectorAll('video,audio').forEach(v => v.pause()); }

    const layer = document.createElement('div');
    layer.className = `scene t-${sc.transitionIn || 'fade'}`;
    layer.dataset.scene = id;
    stage.appendChild(layer);
    const ctx = makeCtx(sc, layer);
    current = id; ctxNow = ctx;
    emit({ type: 'scene', id, title: sc.title || id });
    [...(sc.choices || []).map(c => c.to), sc.next].filter(Boolean).forEach(nid => setTimeout(() => preloadScene(nid), 0));
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('in')));
    if (prev) setTimeout(() => prev.root.remove(), TRANSITION_MS);

    try { await sc.enter(ctx); } catch (e) { emit({ type: 'error', msg: `场景 ${id} enter() 抛错: ${e && e.message}` }); console.error(e); }
    if (!ctx.alive) return;
    // enter() 结束后的默认走向：有选项→出选项；结局→出 CTA；有 next→自动跳
    if (sc.choices && sc.choices.length && !ctx.choicesShown) ctx.showChoices();
    else if (sc.isEnding && !ctx.ctaShown) ctx.showCTA();
    else if (sc.next && !sc.choices) goto(sc.next);
  }

  function makeCtx(sc, root) {
    const ctx = {
      scene: sc, root, alive: true, choicesShown: false, ctaShown: false,
      el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; root.appendChild(e); return e; },
      /** 视频素材，默认 contain 完整放下居中、muted、无控制、不循环；opts: {fit:'contain'|'cover'|'fill', loop, cls} */
      video(src, opts = {}) {
        const v = document.createElement('video');
        v.className = `media fit-${opts.fit || 'contain'} ${opts.cls || ''}`;
        v.src = src; v.muted = true; v.controls = false; v.playsInline = true; v.setAttribute('playsinline', ''); v.autoplay = true; v.loop = !!opts.loop; v.preload = 'auto';
        root.appendChild(v);
        if (opts.sound) enableSound(v);   // 解锁声音后播放本视频自己的音轨（静音起播保证自动播放合规）
        v.play().catch(err => emit({ type: 'warn', msg: `video 自动播放失败 ${src}: ${err && err.message}` }));
        return v;
      },
      /** 图片素材，默认 contain；opts: {fit, cls} */
      image(src, opts = {}) { const i = document.createElement('img'); i.className = `media fit-${opts.fit || 'contain'} ${opts.cls || ''}`; i.src = src; i.alt = ''; root.appendChild(i); return i; },
      /**
       * 轨道素材（可在预览台编辑模式里拖动/缩放/记关键帧）。图或视频，按扩展名判断。
       * opts: {track: 轨道名(默认 t1,t2…), pose: 无关键帧数据时的初始姿态(默认 contain 适配), loop, hidden, cls}
       * 初始姿态优先取 tracks.js 里该场景 keys[track][0]。返回 wrap（.media 为媒体元素，.ready 为 Promise）。
       * 一般不用手写：素材列表放在 tracks.js 的 layers 里，场景内调 ctx.mountLayers() 即可。
       */
      sprite(src, opts = {}) {
        const name = opts.track || `t${root.querySelectorAll('.track').length + 1}`;
        const wrap = document.createElement('div'); wrap.className = `track ${opts.cls || ''}${opts.hidden ? ' hidden-layer' : ''}`;
        (opts.parent || root).appendChild(wrap);   // 跟随：嵌进父素材容器，父的位移/缩放/旋转自动作用于子
        wrap.dataset.track = name; wrap.dataset.src = src || '';
        const isText = !!opts.textSpans, isRect = !isText && !!opts.rectSpec, isLight = !isText && !isRect && !!opts.lightSpec, isSpine = !isText && !isRect && !isLight && (!!opts.spineSpec || isSpineSrc(src)), isVideo = !isText && !isRect && !isLight && !isSpine && isVideoSrc(src), isAudio = !isText && !isRect && !isLight && !isSpine && !isVideo && isAudioSrc(src);
        let m;
        if (isText) { m = document.createElement('p'); m.className = 'track-media track-text'; wrap.dataset.type = 'text'; renderSpans(m, opts.textSpans); }
        else if (isRect) { m = document.createElement('div'); m.className = 'track-media track-rect'; wrap.dataset.type = 'rect'; m.style.backgroundColor = opts.rectSpec.color || '#000000'; }
        else if (isLight) {   // 光效层：3 倍舞台大小的径向渐变（中心透亮四周压黑），移动=光心位置、缩放=光斑大小、纵向缩放=椭圆比
          m = document.createElement('div'); m.className = 'track-media track-light'; wrap.dataset.type = 'light';
          // 清晰椭圆边界：圈内全透明 → 边缘一小圈羽化（feather）→ 圈外压黑（edge 不透明度），不做大范围渐晕
          const ls = opts.lightSpec, inner = ls.inner != null ? ls.inner : 0.78, feather = ls.feather != null ? ls.feather : 0.12, edge = ls.edge != null ? ls.edge : 0.95, rx = ls.rx || 430, ry = ls.ry || 560, col = ls.color || '#000000';
          const dark = `color-mix(in srgb, ${col} ${Math.round(edge * 100)}%, transparent)`;
          m.style.background = `radial-gradient(${rx}px ${ry}px at 50% 50%, rgba(0,0,0,0) 0%, rgba(0,0,0,0) ${Math.round(inner * 100)}%, ${dark} ${Math.round((inner + feather) * 100)}%, ${dark} 100%)`;
        }
        else if (isSpine) { m = document.createElement('canvas'); m.className = 'track-media track-spine'; wrap.dataset.type = 'spine'; }
        else if (isAudio) {   // 音频轨：与视频同语义（in 起播/out 暂停/时间轴联动），运行时不可见，永远走声音解锁门控
          m = document.createElement('audio'); m.className = 'track-media track-audio'; wrap.dataset.type = 'audio';
          m.muted = true; m.loop = !!opts.loop; m.preload = 'auto'; enableSound(m); m.src = src;
          const badge = document.createElement('div'); badge.className = 'audio-badge'; badge.textContent = '♪ ' + name;
          wrap.appendChild(badge);   // 仅编辑模式可见（CSS 控制）
        }
        else { m = document.createElement(isVideo ? 'video' : 'img'); m.className = 'track-media'; if (isVideo) { m.muted = true; m.controls = false; m.playsInline = true; m.setAttribute('playsinline', ''); m.loop = !!opts.loop; m.preload = 'auto'; if (opts.sound) enableSound(m); } else m.alt = ''; m.src = src; }
        wrap.appendChild(m); wrap.media = m; wrap.trackName = name;
        if (opts.fx && opts.fx.length) applyFx(wrap, opts.fx);
        sizeTrack(wrap, STAGE.w, STAGE.h); wrap.style.visibility = 'hidden'; wrap._winIn = opts.winIn > 0;
        wrap.ready = new Promise(res => {
          const done = () => {
            if (isLight) {
              sizeTrack(wrap, STAGE.w * 3, STAGE.h * 3);   // 3 倍舞台：光心移动时四角永远盖得住
              const klf = keysOf(sc.id, name);
              setPose(wrap, (klf && klf[0]) || opts.pose || { x: 0, y: 0, s: 1 });
              wrap.style.visibility = wrap._winIn ? 'hidden' : '';
              return res(wrap);
            }
            if (isRect) {
              sizeTrack(wrap, opts.rectSpec.w || STAGE.w, opts.rectSpec.h || STAGE.h);
              const kfr = keysOf(sc.id, name);
              wrap._staticQuad = opts.quad || null;
              if (opts.quad) applyQuad(wrap, opts.quad);
              setPose(wrap, (kfr && kfr[0]) || opts.pose || { x: 0, y: 0, s: 1 });
              wrap.style.visibility = wrap._winIn ? 'hidden' : '';
              return res(wrap);
            }
            if (isText) {
              sizeTextTrack(wrap);
              const kf0 = keysOf(sc.id, name);
              wrap._staticQuad = opts.quad || null;
              const q0 = (kf0 && kf0[0] && kf0[0].quad) || opts.quad; if (q0) applyQuad(wrap, q0);
              setPose(wrap, (kf0 && kf0[0]) || opts.pose || { x: 0, y: 0, s: 1 });
              wrap.style.visibility = wrap._winIn ? 'hidden' : '';
              return res(wrap);
            }
            if (isAudio) {
              sizeTrack(wrap, 240, 64);   // 音频无画面：给编辑器一个可选中的固定框（运行时不可见）
              const kfa = keysOf(sc.id, name);
              setPose(wrap, (kfa && kfa[0]) || opts.pose || { x: 0, y: 0, s: 1 });
              wrap.style.visibility = wrap._winIn ? 'hidden' : '';
              if (opts.autoplay !== false) {
                if (opts.winIn > 0) m.dataset.waitStart = '1';   // 出场（in 时刻）起播，由 runTracks 看守
                else if (!paused) m.play().catch(() => {});
              }
              return res(wrap);
            }
            const w = isVideo ? m.videoWidth : m.naturalWidth, h = isVideo ? m.videoHeight : m.naturalHeight;
            if (w && h) sizeTrack(wrap, w, h); else emit({ type: 'warn', msg: `轨道 ${name} 素材尺寸读取失败: ${src}` });
            const kf = keysOf(sc.id, name);
            wrap._staticQuad = opts.quad || null;
            const q0 = (kf && kf[0] && kf[0].quad) || opts.quad; if (q0) applyQuad(wrap, q0);
            setPose(wrap, (kf && kf[0]) || opts.pose || { x: 0, y: 0, s: +wrap.dataset.fit });
            wrap.style.visibility = wrap._winIn ? 'hidden' : '';   // 有 in 窗口：等 runTracks 的时间窗动画来控制
            if (isVideo && opts.autoplay !== false) {
              if (opts.winIn > 0) m.dataset.waitStart = '1';   // 出场（in 时刻）才从第 0 帧起播，由 runTracks 看守
              else m.play().catch(err => emit({ type: 'warn', msg: `video 自动播放失败 ${src}: ${err && err.message}` }));
            }
            res(wrap);
          };
          if (isText || isRect || isLight) done();
          else if (isSpine) {
            initSpine(wrap, src, opts.spineSpec || {}).then(() => {   // 失败也 resolve：占位空 canvas，不卡场景
              const kf = keysOf(sc.id, name);
              wrap._staticQuad = opts.quad || null;
              const q0 = (kf && kf[0] && kf[0].quad) || opts.quad; if (q0) applyQuad(wrap, q0);
              setPose(wrap, (kf && kf[0]) || opts.pose || { x: 0, y: 0, s: +wrap.dataset.fit });
              wrap.style.visibility = wrap._winIn ? 'hidden' : '';
              res(wrap);
            });
          }
          else if (isVideo || isAudio) { if (m.readyState >= 1) done(); else { m.addEventListener('loadedmetadata', done, { once: true }); m.addEventListener('error', done, { once: true }); } }
          else { if (m.complete && m.naturalWidth) done(); else { m.onload = done; m.onerror = done; } }
        });
        return wrap;
      },
      /** 按 tracks.js 里本场景的 layers 列表创建全部素材轨道（顺序=叠放顺序），素材尺寸就绪后 resolve，返回 wrap 数组 */
      async mountLayers() {
        const layers = sceneData(sc.id).layers, wraps = [];
        layers.filter(L => !L.follow).forEach(L => wraps.push(ctx.sprite(L.src, { track: L.name, loop: L.loop, sound: L.sound, hidden: L.hidden, winIn: L.in, fx: L.fx, quad: L.quad,textSpans: L.type === 'text' ? (L.spans || []) : undefined, rectSpec: L.type === 'rect' ? { color: L.color, w: L.rectW, h: L.rectH } : undefined, spineSpec: L.type === 'spine' ? { anim: L.anim, loop: L.loop } : undefined, lightSpec: L.type === 'light' ? { inner: L.inner, feather: L.feather, edge: L.edge, rx: L.rx, ry: L.ry, color: L.color } : undefined })));
        layers.filter(L => L.follow).forEach(L => {
          const pw = root.querySelector(`.track[data-track="${L.follow}"]`);
          if (!pw) emit({ type: 'warn', msg: `图层 ${L.name} 的跟随目标 ${L.follow} 不存在，按普通层挂载` });
          wraps.push(ctx.sprite(L.src, { track: L.name, loop: L.loop, sound: L.sound, hidden: L.hidden, winIn: L.in, fx: L.fx, quad: L.quad,textSpans: L.type === 'text' ? (L.spans || []) : undefined, rectSpec: L.type === 'rect' ? { color: L.color, w: L.rectW, h: L.rectH } : undefined, spineSpec: L.type === 'spine' ? { anim: L.anim, loop: L.loop } : undefined, lightSpec: L.type === 'light' ? { inner: L.inner, feather: L.feather, edge: L.edge, rx: L.rx, ry: L.ry, color: L.color } : undefined, parent: pw || undefined }));
        });
        await Promise.all(wraps.map(w => w.ready));
        return wraps;
      },
      /** 播放本场景所有轨道的关键帧（≥2 帧的轨道），全部播完后 resolve。names 可指定只播某些轨道 */
      async runTracks(names) {
        const sd = sceneData(sc.id);
        const wraps = [...root.querySelectorAll('.track')].filter(w => !names || names.includes(w.dataset.track));
        await Promise.all(wraps.map(w => w.ready));
        if (!ctx.alive) return;
        const total = Math.max(1,
          ...wraps.map(w => { const kf = sd.keys[w.dataset.track]; return kf && kf.length ? kf[kf.length - 1].t : 0; }),
          ...sd.layers.map(L => Math.max(L.in || 0, L.out || 0)),
          ...wraps.map(w => {   // 视频播放段（含慢放尾段拉长）也计入总时长，否则看守时钟提前封顶
            const v = w.media; if (!isAV(v) || !isFinite(v.duration)) return 0;
            const L = sd.layers.find(l => l.name === w.dataset.track); if (!L) return 0;
            return (L.in || 0) + v.duration * 1000 + (L.slow ? (L.slow.last || 300) * ((L.slow.rate || 30) - 1) : 0);
          }),
          ...wraps.map(w => {   // Spine 非循环动作播放段也计入
            const S = w._spine; if (!S || S.loop || !S.dur) return 0;
            const L = sd.layers.find(l => l.name === w.dataset.track);
            return ((L && L.in) || 0) + Math.max(0, S.dur - ((L && L.phase) || 0));
          }));
        const anims = [];
        wraps.forEach(w => {
          const kf = sd.keys[w.dataset.track];
          let ta = null;
          if (kf && kf.length >= 2) { ta = animateTrack(w, kf); anims.push(ta); }
          const L = sd.layers.find(l => l.name === w.dataset.track);
          if (L) { const wa = windowAnim(w, L, total); if (wa) { w.style.visibility = ''; anims.push(wa); } }
          if (ta && kf.some(k => k.quad)) {   // 帧级四角变形：透视矩阵不适合 WAAPI 分解插值，逐帧采样
            (function qtick() {
              if (!ctx.alive) return;
              applyQuad(w, sampleQuad(kf, ta.currentTime || 0));
              if (ta.playState !== 'finished') requestAnimationFrame(qtick);
              else applyQuad(w, sampleQuad(kf, kf[kf.length - 1].t));
            })();
          }
        });
        emit({ type: 'tracks', id: sc.id, count: anims.length });
        // 视频出场看守：有 in 窗口的视频到点才从头起播；有 out 的过点即暂停（省电且不在后台空转）
        const vids = wraps.map(w => ({ w, L: sd.layers.find(l => l.name === w.dataset.track) }))
          .filter(x => x.L && isAV(x.w.media) && ((x.L.in || 0) > 0 || x.L.out != null || x.L.slow));
        if (vids.length) {
          const gate = document.createElement('div'); gate.style.display = 'none'; root.appendChild(gate);
          const vclock = bornPaused(gate.animate([{ opacity: 0 }, { opacity: 0 }], { duration: total, fill: 'forwards' }));
          (function vtick() {
            if (!ctx.alive) return;
            const t = vclock.currentTime || 0;
            let pending = false;
            for (const { w, L } of vids) {
              const v = w.media;
              if (v.dataset.waitStart) { if (t >= (L.in || 0)) { delete v.dataset.waitStart; if (!paused) v.play().catch(err => emit({ type: 'warn', msg: `video 起播失败 ${w.dataset.track}: ${err && err.message}` })); } pending = true; }   // 起播 tick 也保持看守存活，下一 tick 再评估 out/slow
              else if (L.out != null && t >= L.out && !v.paused) v.pause();
              else if (L.slow) {   // 慢放尾段：最后 last ms 的内容按 rate 倍拉长（playbackRate 下限 0.0625，改为暂停+逐帧 seek 驱动）
                if (isFinite(v.duration)) {
                  const durMs = v.duration * 1000, last = L.slow.last || 300, rate = L.slow.rate || 30;
                  const boundary = (L.in || 0) + Math.max(0, durMs - last);
                  if (t < boundary) pending = true;   // 慢放段未到：保持看守存活
                  else if (L.out == null || t < L.out) {
                    if (!v.paused) v.pause();
                    const sec = Math.min(durMs, (durMs - last) + (t - boundary) / rate) / 1000;
                    if (Math.abs(v.currentTime - sec) > 0.02) v.currentTime = sec;
                    if (sec < v.duration - 0.001) pending = true;   // 播到末帧后看守自然退出（定格由 fill 保持）
                  }
                } else pending = true;   // 元数据未就绪
              }
              if (L.out != null && t < L.out) pending = true;
            }
            if (pending) requestAnimationFrame(vtick);
          })();
        }
        // Spine 看守：内容时间 = 场景时钟 - in，逐帧确定性渲染（暂停时钟冻结即定格；编辑器 seekSpine 置 hold 后接管）
        const spines = wraps.filter(w => w._spine && w._spine.entry).map(w => ({ w, L: sd.layers.find(l => l.name === w.dataset.track) || {} }));
        if (spines.length) {
          const sclock = ctx.clock(1e9);
          (function stick() {
            if (!ctx.alive) return;
            const t = sclock.currentTime || 0;
            for (const { w, L } of spines) {
              if (w._spineHold) continue;
              const tIn = L.in || 0;
              // 时间窗外/已隐藏的不渲染（省 CPU/GPU，出现前 50ms 开始画保证出场首帧姿态正确）
              if (t < tIn - 50 || (L.out != null && t >= L.out + 50) || w.classList.contains('hidden-layer')) continue;
              renderSpineAt(w, (t - tIn + (L.phase || 0)) / 1000);   // phase：步伐相位偏移(ms，可负)
            }
            requestAnimationFrame(stick);
          })();
        }
        await Promise.all(anims.map(a => a.finished.catch(() => {})));
      },
      /** 文本；opts.typewriter = 每字毫秒数，返回的元素带 .done Promise */
      text(str, opts = {}) {
        const e = ctx.el('div', `txt ${opts.cls || ''}`);
        if (opts.typewriter) {
          e.classList.add('typing');
          e.done = new Promise(res => { let i = 0; const tick = () => { if (!ctx.alive) return res(); if (paused) return setTimeout(tick, 100); e.textContent = str.slice(0, ++i); if (i < str.length) setTimeout(tick, opts.typewriter); else { e.classList.remove('typing'); res(); } }; tick(); });
        } else { e.textContent = str; e.done = Promise.resolve(); }
        return e;
      },
      /** 占位块：资源未到位时用 */
      placeholder(label) { return ctx.el('div', 'placeholder', `[占位]\n${label}`); },
      /** 等待 ms（暂停时会顺延），场景已退出则直接返回 */
      wait(ms) { return new Promise(res => { let left = ms, last = performance.now(); const tick = () => { if (!ctx.alive) return res(); const now = performance.now(); if (!paused) left -= now - last; last = now; if (left <= 0) res(); else setTimeout(tick, Math.min(left, 50)); }; tick(); }); },
      /** 等 video 播完（loop 的视频永远不会 resolve，请配合 wait/showChoices） */
      ended(v) { return new Promise(res => { if (!ctx.alive) return res(); v.addEventListener('ended', () => res(), { once: true }); }); },
      /** 显示选项并启动闲置计时。choices: [{label, to}]；opts: {idleMs, cls} */
      showChoices(choices = sc.choices || [], opts = {}) {
        if (!ctx.alive || ctx.choicesShown) return;
        ctx.choicesShown = true;
        const box = ctx.el('div', `choices in ${opts.cls || ''}`);
        choices.forEach((c, i) => { const b = ctx.el('button', 'choice', c.label); box.appendChild(b); b.onclick = () => ctx.choose(c, i, 'click'); });
        emit({ type: 'choices', id: sc.id, labels: choices.map(c => c.label) });
        armIdle(() => { const i = Math.floor(Math.random() * choices.length); emit({ type: 'idle', id: sc.id, picked: choices[i].label }); ctx.choose(choices[i], i, 'idle'); }, opts.idleMs ?? sc.idleMs ?? DEFAULT_IDLE_MS);
        return box;
      },
      choose(c, i, by) {
        if (!ctx.alive) return; clearIdle();
        root.querySelectorAll('.choice').forEach((b, k) => { b.disabled = true; if (k === i) b.classList.add('picked'); });
        emit({ type: 'choice', id: sc.id, label: c.label, to: c.to, by });
        setTimeout(() => { if (ctx.alive && c.to) goto(c.to); }, 350);
      },
      /** 结局 CTA。opts: {label, href, onClick} */
      showCTA(opts = {}) {
        if (!ctx.alive || ctx.ctaShown) return; ctx.ctaShown = true;
        const b = ctx.el('button', 'cta', opts.label || sc.ctaLabel || '立即体验');
        b.onclick = () => { emit({ type: 'cta', id: sc.id }); if (opts.onClick) opts.onClick(); else if (opts.href || sc.ctaHref) window.open(opts.href || sc.ctaHref, '_blank'); };
        return b;
      },
      /** 行为时钟：与场景时间轴同源的隐藏动画（duration 毫秒）；播放器暂停期间创建也会正确冻结/恢复 */
      clock(duration) {
        const gate = document.createElement('div'); gate.style.display = 'none'; root.appendChild(gate);
        return bornPaused(gate.animate([{ opacity: 0 }, { opacity: 0 }], { duration, fill: 'forwards' }));
      },
      /** 整场时间跳转：把场景内全部动画（补间/时间窗/颜色/行为时钟/动效相位）和视频内容时间一致跳到 t 毫秒 */
      seek(t) {
        root.getAnimations({ subtree: true }).forEach(a => { try { a.currentTime = t; } catch (e) {} });
        const sd2 = sceneData(sc.id);
        root.querySelectorAll('.track').forEach(w => {
          const v = w.media; if (!isAV(v)) return;
          const L = sd2.layers.find(l => l.name === w.dataset.track); if (!L || !isFinite(v.duration)) return;
          const inT = L.in || 0, durMs = v.duration * 1000;
          const last = L.slow ? (L.slow.last || 300) : 0, rate = L.slow ? (L.slow.rate || 30) : 1;
          const boundary = inT + Math.max(0, durMs - last);
          if (t < inT) { v.pause(); v.currentTime = 0; v.dataset.waitStart = '1'; return; }
          delete v.dataset.waitStart;
          const content = Math.max(0, Math.min(durMs, t <= boundary ? t - inT : (durMs - last) + (t - boundary) / rate)) / 1000;
          v.currentTime = content;
          const shouldPlay = t < boundary && content < v.duration && (L.out == null || t < L.out) && !paused;
          if (shouldPlay) v.play().catch(() => {}); else v.pause();
        });
        emit({ type: 'seek', at: Math.round(t) });
      },
      /** 主动进入 next */
      done() { if (ctx.alive && sc.next) goto(sc.next); },
    };
    return ctx;
  }

  // ---------- 闲置计时 ----------
  function armIdle(fn, ms) { clearIdle(); idleArgs = { fn, ms }; if (idleEnabled && !paused) idleTimer = setTimeout(() => { idleTimer = null; fn(); }, ms); }
  function clearIdle() { if (idleTimer) clearTimeout(idleTimer); idleTimer = null; idleArgs = null; }
  function rearmIdle() { if (idleArgs && idleEnabled && !paused && !idleTimer) { const a = idleArgs; idleTimer = setTimeout(() => { idleTimer = null; a.fn(); }, a.ms); } }

  // ---------- 暂停（视频、CSS 动画、轨道动画、闲置计时一起停） ----------
  function pause() { if (paused) return; paused = true; stage.classList.add('paused'); if (bgmEl) bgmEl.pause(); stage.querySelectorAll('video,audio').forEach(v => v.pause()); stage.getAnimations({ subtree: true }).forEach(a => { if (a.playState === 'running') { a.pause(); a._pausedByPlayer = true; } }); if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } emit({ type: 'pause' }); }
  function resume() { if (!paused) return; paused = false; stage.classList.remove('paused'); if (bgmEl) bgmEl.play().catch(() => {}); if (ctxNow) ctxNow.root.querySelectorAll('video,audio').forEach(v => { if (!v.dataset.waitStart && !v.ended) v.play().catch(() => {}); }); /* ended=定格中的视频不重播 */ stage.getAnimations({ subtree: true }).forEach(a => { if (a._pausedByPlayer) { a.play(); a._pausedByPlayer = false; } }); if (ctxNow) ctxNow.root.querySelectorAll('.track').forEach(w => { delete w._spineHold; }); /* 编辑器的 Spine 接管随恢复解除 */ rearmIdle(); emit({ type: 'resume' }); }

  // ---------- 对外 ----------
  // ---------- 声音解锁（全局一次）与 BGM（跨场景单例）----------
  // 移动端规则：自动播放必须静音；用户任意一次真实点击后「解锁」——此后凡标记了发声的媒体（BGM、
  // sound:true 的视频）一律取消静音，跨场景保持解锁态。解锁监听用 window 捕获段 + passive：
  // 不 stopPropagation、不 preventDefault，绝不干扰现有点击交互；编辑模式里的点击不解锁。
  let bgmEl = null, soundOn = false, unlockArmed = false, soundBtnEl = null;
  /** 统一开关：BGM / data-sound 媒体 / SFX 门控一起切，喇叭按钮图标同步 */
  function setSound(on) {
    soundOn = on;
    if (bgmEl) { bgmEl.muted = !on; if (on && !paused && bgmEl.paused && !bgmEl.ended) bgmEl.play().catch(() => {}); }
    stage.querySelectorAll('[data-sound]').forEach(m => { m.muted = !on; });
    if (soundBtnEl) soundBtnEl.dataset.on = on ? '1' : '';
    emit({ type: 'sound', state: on ? 'on' : 'muted' });
  }
  function armSoundUnlock() {
    if (soundOn || unlockArmed) return;
    unlockArmed = true;
    const unlock = e => {
      if (e && (e.__auto || !e.isTrusted)) return;   // 行为派发的合成事件（如 gunfire 自动开火）不算用户手势，不解锁
      if (stage.classList.contains('editing')) return;
      if (soundBtnEl && e && soundBtnEl.contains(e.target)) return;   // 喇叭按钮自己管开关，不走全局解锁
      unlockArmed = false;
      window.removeEventListener('pointerdown', unlock, true);
      sfxCtx();   // 借这次用户手势恢复/创建 AudioContext（音效通道）
      setSound(true);
    };
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  }
  /** 媒体元素登记为「解锁后发声」：已解锁立即取消静音，未解锁则挂上一次性解锁监听 */
  function enableSound(el) {
    el.dataset.sound = '1';
    if (soundOn) el.muted = false; else armSoundUnlock();
  }
  // ---------- SFX（WebAudio：可重叠播放、可截断；解锁前静默跳过）----------
  let actx = null; const sfxBufs = new Map();
  function sfxCtx() {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state === 'suspended') actx.resume().catch(() => {});
    return actx;
  }
  function sfxLoad(src) {
    if (sfxBufs.has(src)) return sfxBufs.get(src);
    const c = sfxCtx(); if (!c) return Promise.reject(new Error('no AudioContext'));
    const p = fetch(src).then(r => r.arrayBuffer()).then(b => c.decodeAudioData(b));
    sfxBufs.set(src, p); p.catch(() => sfxBufs.delete(src));
    return p;
  }
  /** 播放音效：Playable.sfx(src, {volume, durMs})。soundOn（用户已解锁）才发声；durMs = 截断播放（毫秒） */
  function sfx(src, opts = {}) {
    if (!soundOn || paused) return;
    const c = sfxCtx(); if (!c) return;
    sfxLoad(src).then(buf => {
      if (!soundOn || paused) return;
      const s = c.createBufferSource(); s.buffer = buf;
      const g = c.createGain(); if (opts.volume != null) g.gain.value = opts.volume;
      s.connect(g); g.connect(c.destination);
      s.start();
      if (opts.durMs) s.stop(c.currentTime + opts.durMs / 1000);
    }).catch(() => {});
  }
  sfx.preload = src => { try { sfxLoad(src); } catch (_) {} };   // 提前解码，首发零延迟

  function bgm(src, opts = {}) {
    if (bgmEl) return bgmEl;
    const a = document.createElement('audio');
    a.src = src; a.loop = opts.loop !== false; a.autoplay = true;
    a.muted = !soundOn;   // 已解锁（如在 s01 点过）则直接带声起播
    if (opts.volume != null) a.volume = opts.volume;
    a.style.display = 'none';
    document.body.appendChild(a);
    bgmEl = a;
    if (!paused) a.play().catch(() => {});
    if (!soundOn) armSoundUnlock();
    emit({ type: 'bgm', state: 'start', src, muted: a.muted });
    return a;
  }

  window.Playable = {
    /** 循环 BGM：Playable.bgm('../assets/bgm.mp3', {volume}) —— 静音起播、首次点击解锁声音、跨场景持续、随播放器暂停/恢复 */
    bgm,
    /** 音效：Playable.sfx(src, {volume, durMs})，WebAudio 可重叠；未解锁声音时静默。Playable.sfx.preload(src) 预解码 */
    sfx,
    /** 右上角声音开关（跨场景常驻）：白色半透明圆底 + 喇叭/静音 SVG，点击切换全局声音；编辑模式自动隐藏 */
    soundButton() {
      if (soundBtnEl) return soundBtnEl;
      const b = document.createElement('div');
      b.className = 'sound-btn';
      b.innerHTML = `
<svg class="ic-on" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M13 24h11l13-11v38L24 40H13z" fill="#1c1f24"/>
  <path d="M43 24a10.5 10.5 0 0 1 0 16" stroke="#1c1f24" stroke-width="5" fill="none" stroke-linecap="round"/>
  <path d="M48.5 17.5a19 19 0 0 1 0 29" stroke="#1c1f24" stroke-width="5" fill="none" stroke-linecap="round"/>
</svg>
<svg class="ic-off" viewBox="0 0 64 64" aria-hidden="true">
  <path d="M13 24h11l13-11v38L24 40H13z" fill="#1c1f24"/>
  <path d="M43 26l12 12M55 26L43 38" stroke="#1c1f24" stroke-width="5" fill="none" stroke-linecap="round"/>
</svg>`;
      b.addEventListener('pointerdown', e => { e.stopPropagation(); e.preventDefault(); sfxCtx(); setSound(!soundOn); });
      stage.appendChild(b);
      soundBtnEl = b; b.dataset.on = soundOn ? '1' : '';
      return b;
    },
    /** 注册场景：{ id, title?, transitionIn?: 'fade'|'none'|'slide-up'|'zoom', enter(ctx), choices?: [{label,to}], idleMs?, next?, isEnding?, ctaLabel?, ctaHref?, preload?: [src] }
     *  预加载：进入场景时自动预载 next/choices 目标场景的素材（tracks.js 的 layers 全自动；enter() 里代码放置的 video/image 想被预载，就写进该场景的 preload 数组） */
    scene(def) { if (!def || !def.id || typeof def.enter !== 'function') throw new Error('scene 需要 id 和 enter()'); if (!scenes.has(def.id)) order.push(def.id); scenes.set(def.id, def); return def; },
    /** 行为/场景代码向调试事件流打点（预览台事件面板可见） */
    log(type, data = {}) { emit({ type, ...data }); },
    /** 预载某场景的素材（行为驱动的跳转目标不在 next/choices 里，需要手动预载） */
    preload(id) { preloadScene(id); },
    start(id) {
      stage = document.getElementById('stage');
      fitStage(); window.addEventListener('resize', fitStage);
      // 调试用：?s=<sceneId> 从指定场景启动（预览台会透传）；正式打包时地址里不会有这个参数
      const want = id || new URLSearchParams(location.search).get('s');
      goto(scenes.has(want) ? want : order[0]);
    },
  };

  window.__playable = {
    version: 2, stage: STAGE,
    get scenes() { return order.map(id => { const s = scenes.get(id); return { id, title: s.title || id, choices: (s.choices || []).map(c => c.to), next: s.next || null, isEnding: !!s.isEnding }; }); },
    get current() { return current; },
    get paused() { return paused; },
    get idleEnabled() { return idleEnabled; },
    goto, pause, resume,
    restart() { goto(order[0]); },
    setIdleEnabled(b) { idleEnabled = !!b; if (!idleEnabled && idleTimer) { clearTimeout(idleTimer); idleTimer = null; } else rearmIdle(); emit({ type: 'idleEnabled', value: idleEnabled }); },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    // ---- 编辑模式（预览台）----
    get tracksData() { return tracksData(); },
    setTracksData(d) { window.TRACKS = d; },
    setEditing(b) { stage.classList.toggle('editing', !!b); if (!b) stage.querySelectorAll('.track.selected').forEach(w => w.classList.remove('selected')); },
    /** 当前场景的轨道（DOM 顺序 = 自下而上）：[{name, src, w, h, fit, pose, keyframes, hidden, fromData}] */
    tracks() { const sd = sceneData(current); return ctxNow ? [...ctxNow.root.querySelectorAll('.track')].map(w => { const L = sd.layers.find(l => l.name === w.dataset.track); return { name: w.dataset.track, src: w.dataset.src, w: +w.dataset.w, h: +w.dataset.h, fit: +w.dataset.fit, pose: getPose(w), keyframes: sd.keys[w.dataset.track] || null, hidden: w.classList.contains('hidden-layer'), fromData: !!L, follow: (L && L.follow) || null, type: w.dataset.type || 'media', video: !!(w.media && w.media.tagName === 'VIDEO'), audio: !!(w.media && w.media.tagName === 'AUDIO'), spine: !!w._spine, spineAnims: w._spine ? w._spine.anims : null, spineAnim: w._spine ? w._spine.anim : null, spineLoop: w._spine ? w._spine.loop : null, dur: (isAV(w.media) && isFinite(w.media.duration)) ? Math.round(w.media.duration * 1000) : (w._spine ? w._spine.dur : 0) }; }) : []; },
    /** 编辑器用：重设文字素材的 spans 并重新量尺（自然尺寸随内容变化） */
    setText(name, spans) { const w = findTrack(name); if (!w || w.dataset.type !== 'text') return null; renderSpans(w.media, spans); sizeTextTrack(w); if (w._quad) applyQuad(w, w._quad); return { w: +w.dataset.w, h: +w.dataset.h, fit: +w.dataset.fit }; },
    /** 编辑器用：应用/清除四角变形（q = 8 个角偏移或 null） */
    setQuad(name, q) { applyQuad(findTrack(name), q); },
    /** 图层管理（编辑器用）：在当前场景里新建/删除/改名/显隐/重排素材轨道 */
    async addLayer(L) { if (!ctxNow) return null; const w = ctxNow.sprite(L.src, { track: L.name, loop: L.loop, hidden: L.hidden, textSpans: L.type === 'text' ? (L.spans || []) : undefined, rectSpec: L.type === 'rect' ? { color: L.color, w: L.rectW, h: L.rectH } : undefined, spineSpec: L.type === 'spine' ? { anim: L.anim, loop: L.loop } : undefined, lightSpec: L.type === 'light' ? { inner: L.inner, feather: L.feather, edge: L.edge, rx: L.rx, ry: L.ry, color: L.color } : undefined }); await w.ready; return { name: L.name, src: L.src, w: +w.dataset.w, h: +w.dataset.h, fit: +w.dataset.fit, pose: getPose(w), spineAnims: w._spine ? w._spine.anims : null, spineAnim: w._spine ? w._spine.anim : null, dur: (isAV(w.media) && isFinite(w.media.duration)) ? Math.round(w.media.duration * 1000) : (w._spine ? w._spine.dur : 0) }; },
    removeLayer(name) { const w = findTrack(name); if (w) w.remove(); },
    renameLayer(from, to) { const w = findTrack(from); if (w) { w.dataset.track = to; w.trackName = to; } },
    setLayerHidden(name, b) { const w = findTrack(name); if (w) w.classList.toggle('hidden-layer', !!b); },
    /** names 自下而上；只重排列出的轨道，整体保持在原来的位置（不会盖到后加的文字/选项上） */
    reorderLayers(names) {   // 按 names 顺序重排每个容器（舞台根 + 各跟随父容器）内部的轨道；代码放置的轨道留在原位（垫底）
      if (!ctxNow) return;
      const groups = new Map();   // 容器元素 -> 该容器内按目标顺序排列的 wrap
      names.map(findTrack).filter(Boolean).forEach(w => { const p = w.parentElement; if (!groups.has(p)) groups.set(p, []); groups.get(p).push(w); });
      groups.forEach((ws, p) => {
        const cur = [...p.children].filter(el => el.classList && el.classList.contains('track'));
        if (!cur.length) return;
        const anchor = cur[cur.length - 1].nextSibling;
        ws.forEach(w => p.insertBefore(w, anchor));
      });
    },
    /** 编辑器用：把轨道挂进/移出父素材容器（数据里的 follow 字段由编辑器维护） */
    setFollow(name, parentName) { const w = findTrack(name); if (!w || !ctxNow) return; if (parentName) { const pw = findTrack(parentName); if (pw && pw !== w) pw.appendChild(w); } else ctxNow.root.appendChild(w); },
    /** 编辑器用：把视频 seek 到内容时刻（秒；loop 视频按时长取模），保持暂停态显示该帧 */
    seekVideo(name, sec) { const w = findTrack(name); const v = w && w.media; if (!isAV(v)) return; const d = v.duration; if (!isFinite(d) || d <= 0) return; let t = sec; if (v.loop) t = ((sec % d) + d) % d; v.currentTime = Math.max(0, Math.min(t, Math.max(0, d - 0.001))); },
    playVideo(name) { const w = findTrack(name); const v = w && w.media; if (isAV(v)) { delete v.dataset.waitStart; v.play().catch(() => {}); } },
    pauseVideo(name) { const w = findTrack(name); const v = w && w.media; if (isAV(v)) v.pause(); },
    /** Spine 图层信息：{anims:[{name,dur}], anim, loop, dur}；非 Spine 轨返回 null */
    spineInfo(name) { const w = findTrack(name); const S = w && w._spine; return S ? { anims: S.anims, anim: S.anim, loop: S.loop, dur: S.dur } : null; },
    /** 切换 Spine 动作/循环，立即重渲；restart=true 时动作从当前时刻起播（行为中途切 fall 等用）。返回 {dur} */
    setSpineAnim(name, anim, loop, restart) { const w = findTrack(name); const S = w && w._spine; if (!S || !S.anims.some(a => a.name === anim)) return null; S.anim = anim; S.loop = loop !== false; S.state.clearTrack(0); S.entry = S.state.setAnimation(0, anim, S.loop); S.dur = Math.round(S.entry.animation.duration * 1000); if (restart) S.rebaseSec = S.lastRawSec || 0; renderSpineAt(w, w._spineHold ? w._spineHoldT : (S.lastRawSec || 0)); return { dur: S.dur }; },
    /** 编辑器用：把 Spine 钉到内容时间 contentMs（调用方自行按 in/phase 换算），并接管渲染直到 resume */
    seekSpine(name, contentMs) { const w = findTrack(name); if (!w || !w._spine) return; w._spineHold = true; w._spineHoldT = contentMs / 1000; renderSpineAt(w, w._spineHoldT); },
    /** 编辑器用：实时重建某素材的内部动效链 */
    setFx(name, fxList) { applyFx(findTrack(name), fxList); },
    /** 内部动效预设清单（编辑器渲染选项用） */
    get fxTypes() { return Object.entries(FX).map(([type, v]) => ({ type, label: v.label, unit: v.unit, def: v.def })); },
    selectTrack(name) { if (!ctxNow) return; ctxNow.root.querySelectorAll('.track').forEach(w => w.classList.toggle('selected', w.dataset.track === name)); },
    getPose(name) { const w = findTrack(name); return w ? getPose(w) : null; },
    setPose(name, p) { const w = findTrack(name); if (w) setPose(w, p); },
    /** 把轨道定格在关键帧序列 kf 的 t 时刻（不播放） */
    scrub(name, kf, t) { const w = findTrack(name); if (!w || kf.length < 2) return; const a = animateTrack(w, kf); a.pause(); const ct = Math.max(0, Math.min(t, a.effect.getTiming().duration)); a.currentTime = ct;
      if (w._colorAnim) { w._colorAnim.pause(); w._colorAnim.currentTime = ct; }
      applyQuad(w, kf.some(k => k.quad) ? sampleQuad(kf, t) : (w._staticQuad || null)); },
    /** 从 from 毫秒开始播放一遍 kf（忽略暂停状态）；win={in,out} 时间窗一起播。resolve 于播完 */
    playTrack(name, kf, from = 0, win) {
      const w = findTrack(name); if (!w) return Promise.resolve();
      w.getAnimations().forEach(a => a.cancel()); w.style.visibility = '';
      const anims = [];
      if (kf && kf.length >= 2) anims.push(animateTrack(w, kf));
      if (win) { const total = Math.max(kf && kf.length ? kf[kf.length - 1].t : 0, win.in || 0, win.out || 0, 1); const wa = windowAnim(w, win, total); if (wa) anims.push(wa); }
      if (!anims.length) return Promise.resolve();
      anims.forEach(a => { a.play(); if (from > 0) a.currentTime = Math.min(from, a.effect.getTiming().duration); });
      if (w._colorAnim) { w._colorAnim.play(); if (from > 0) w._colorAnim.currentTime = Math.min(from, w._colorAnim.effect.getTiming().duration); }
      if (kf && kf.length >= 2 && kf.some(k => k.quad)) {
        const ref = anims[0];
        (function qtick() { if (!findTrack(name)) return; applyQuad(findTrack(name), sampleQuad(kf, ref.currentTime || 0)); if (ref.playState === 'running' || ref.playState === 'pending') requestAnimationFrame(qtick); })();
      }
      return Promise.all(anims.map(a => a.finished.catch(() => {})));
    },
    /** 编辑器用：时间窗外完全隐藏（不影响保存数据；选中素材的变换框由预览台另行绘制） */
    dimTrack(name, b) { const w = findTrack(name); if (w) { w.style.visibility = b ? 'hidden' : ''; w.style.opacity = ''; } },
  };
})();
