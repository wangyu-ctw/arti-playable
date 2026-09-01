/* tracks.js — 素材图层与关键帧。由 utils/preview.html 的编辑模式生成/保存，也可手改。
 * 结构：{ <sceneId>: {
 *   layers: [ { name, src, loop?, hidden? }, ... ],        // 素材列表，数组顺序 = 叠放顺序（后者在上）；场景内 ctx.mountLayers() 创建
 *   keys:   { <name>: [ { t: 毫秒, x, y, s, ease?, label? }, ... ] }   // 每个素材独立的关键帧
 * } }
 * x/y = 相对舞台中心的偏移(px)，s = 缩放(1 = 素材原始像素)。单帧 = 静态姿态；≥2 帧由 ctx.runTracks() 播放。 */
window.TRACKS = {};
