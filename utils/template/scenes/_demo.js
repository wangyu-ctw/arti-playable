/* _demo.js — 示例场景，只用来验证骨架和 utils/preview.html。正式项目：删掉本文件并从 index.html 移除引用。
 * 展示了：文字打字机、占位块、wait、选项+闲置自动选、结局 CTA、素材 contain 的写法。
 */
Playable.scene({
  id: 'demo-intro', title: '示例·开场', transitionIn: 'zoom',
  async enter(ctx) {
    ctx.root.style.background = 'linear-gradient(180deg,#1b2a49,#0b0f1a)';
    ctx.text('骨架已就位', { cls: 'title' });
    await ctx.text('这是一段示例文案，正式场景会替换掉。', { cls: 'sub', typewriter: 60 }).done;
    await ctx.wait(800);
    ctx.done();                       // 进入 next
  },
  next: 'demo-choice',
});

Playable.scene({
  id: 'demo-choice', title: '示例·选择', transitionIn: 'fade',
  async enter(ctx) {
    // 真实素材写法：ctx.video('../assets/xxx.mp4', { loop: true })  —— 默认 contain 完整放下
    ctx.placeholder('这里是循环视频\n../assets/xxx.mp4\n(默认 contain 完整放下)');
    ctx.text('接下来怎么办？', { cls: 'caption' });
    // enter() 返回后骨架自动 showChoices()，5s 无操作随机选
  },
  choices: [
    { label: '选项 A', to: 'demo-end-a' },
    { label: '选项 B', to: 'demo-end-b' },
  ],
});

Playable.scene({
  id: 'demo-end-a', title: '示例·结局A', isEnding: true, ctaLabel: '立即体验',
  async enter(ctx) { ctx.root.style.background = '#2b1d0e'; ctx.text('结局 A', { cls: 'title' }); await ctx.wait(400); },
});
Playable.scene({
  id: 'demo-end-b', title: '示例·结局B', isEnding: true, ctaLabel: '立即体验',
  async enter(ctx) { ctx.root.style.background = '#0e2b1d'; ctx.text('结局 B', { cls: 'title' }); await ctx.wait(400); },
});
