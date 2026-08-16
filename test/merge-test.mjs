/**
 * 合并算法确定性测试（与 client.js 中 mergeText 逐字一致，LCP 版）：
 * 覆盖服务端各种真实/可能的输出形态，断言最终文本无重复。
 * 运行：node test/merge-test.mjs
 */

// ---- 与 client.js 逐字一致的 mergeText ----
function makeMerger() {
  let accum = '';
  let lastSeg = '';
  return {
    merge(text, isFinal) {
      const t = typeof text === 'string' ? text.trim() : '';
      if (!t) return;
      const prev = accum;
      if (!prev) {
        accum = t;
        lastSeg = t;
        return;
      }
      const n = Math.min(prev.length, t.length);
      let i = 0;
      while (i < n && prev[i] === t[i]) i++;
      const overlap = i / Math.max(1, n);
      const replaceLastSeg = () => {
        accum = prev.slice(0, prev.length - lastSeg.length) + t;
        lastSeg = t;
      };
      const appendNew = () => {
        const needSep = !/\s$/.test(prev) && !/^\s/.test(t);
        accum = prev + (needSep ? ' ' : '') + t;
        lastSeg = t;
      };
      const isSegExtension = lastSeg.length > 0
        && (t.startsWith(lastSeg) || lastSeg.startsWith(t));
      if (isFinal) {
        if (t.length < prev.length && overlap < 0.3) {
          if (isSegExtension) replaceLastSeg();
          else appendNew();
        } else {
          accum = t;
          lastSeg = t;
        }
        return;
      }
      if (overlap >= 0.3) {
        accum = t;
        lastSeg = t;
        return;
      }
      if (isSegExtension) replaceLastSeg();
      else appendNew();
    },
    get() { return accum; },
  };
}

// 真实捕获序列（三句话 + 停顿，实测 17 条 + 空 done；含中途修订 第2→第二）
const realSeq = [
  ['第', false], ['第一句话', false], ['第一句话，测试', false], ['第一句话，测试分局', false],
  ['第一句话，测试分局效果', false], ['第一句话，测试分局效果，第2', false], ['第一句话，测试分局效果，第2句话', false],
  ['第一句话，测试分局效果，第二句话，看看', false], ['第一句话，测试分局效果，第二句话，看看有', false],
  ['第一句话，测试分局效果，第二句话，看看有没有', false], ['第一句话，测试分局效果，第二句话，看看有没有重复', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题。第三', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题。第三句话', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题。第三句话，准备', false],
  ['第一句话，测试分局效果，第二句话，看看有没有重复问题。第三句话，准备结束', false],
];

// 场景 A：真实序列（含中途修订）→ 应等于最后一条，无堆叠
{
  const m = makeMerger();
  for (const [t, f] of realSeq) m.merge(t, f);
  const ok = m.get() === '第一句话，测试分局效果，第二句话，看看有没有重复问题。第三句话，准备结束';
  console.log(`${ok ? '✓' : '✗'} 场景A 真实序列含中途修订 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 B：中途 definite（VAD 分句）+ 后续全量文本 → 不得堆叠
{
  const m = makeMerger();
  const seq = [
    ['第', false], ['第一句话', false], ['第一句话', true],
    ['第一句话第二句话', false],
    ['第一句话第二句话，看看', false],
    ['第一句话第二句话，看看有没有重复', true],
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '第一句话第二句话，看看有没有重复';
  console.log(`${ok ? '✓' : '✗'} 场景B 中途定稿+全量延伸 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 C：定稿修正了开头（不在延伸路径上）→ 必须整体替换而非追加
{
  const m = makeMerger();
  const seq = [
    ['测试分局效果', false],
    ['测试分局效果，第二句话', false],
    ['第一句话，测试分局效果。第二句话，看看', true],
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '第一句话，测试分局效果。第二句话，看看';
  console.log(`${ok ? '✓' : '✗'} 场景C 定稿修正开头 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 D：全新分句（增量文本，非全量）→ 追加
{
  const m = makeMerger();
  const seq = [
    ['第一句话', false], ['第一句话，测试', true],
    ['第二句话', false], ['第二句话，看看', true],
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '第一句话，测试 第二句话，看看';
  console.log(`${ok ? '✓' : '✗'} 场景D 增量分句追加 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 E：done 携带定稿全文（与最近定稿相同）→ 幂等，不重复
{
  const m = makeMerger();
  m.merge('第一句话，测试分局效果', false);
  m.merge('第一句话，测试分局效果。第二句话，看看', true);
  m.merge('第一句话，测试分局效果。第二句话，看看', true);
  const ok = m.get() === '第一句话，测试分局效果。第二句话，看看';
  console.log(`${ok ? '✓' : '✗'} 场景E done 重复定稿 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 F：连续多次中途修订（同一段反复重写）→ 始终替换，最后一条为准
{
  const m = makeMerger();
  const seq = [
    ['帮我查一下明天天气', false],
    ['帮我查一下明天的天气情况', false],
    ['帮我查一下明天天气怎么样', false],
    ['帮我查一下明天的天气怎么样', false],
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '帮我查一下明天的天气怎么样';
  console.log(`${ok ? '✓' : '✗'} 场景F 连续修订 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 G：真实 VAD 分句序列（含中途 definite + 空间分隔的全量延伸 + 结尾修正标点）
{
  const m = makeMerger();
  const seq = [
    ['第一', false], ['第一句话', false], ['第一句话说完', false],
    ['第一句话说完', true], // utt1 定稿（VAD 分句）
    ['第一句话说完 第二', true], ['第一句话说完 第二句话', true],
    ['第一句话说完 第二句话开始', true], ['第一句话说完 第二句话开始 第三', true],
    ['第一句话说完 第二句话开始 第3句话结束', true],
    ['第一句话说完 第二句话开始 第三句话结束。', true], // 定稿修正
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '第一句话说完 第二句话开始 第三句话结束。';
  console.log(`${ok ? '✓' : '✗'} 场景G 真实VAD分句序列 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

// 场景 H：增量分句后又来全量（带标点差异）→ 不得堆叠
{
  const m = makeMerger();
  const seq = [
    ['第一句话', false], ['第一句话，测试分局效果', false],
    ['第二句话', false], // 增量（VAD 后新句，低重叠）→ 追加
    ['第一句话，测试分局效果。第二句话，看看', false], // 全量（含标点修正）→ 替换
  ];
  for (const [t, f] of seq) m.merge(t, f);
  const ok = m.get() === '第一句话，测试分局效果。第二句话，看看';
  console.log(`${ok ? '✓' : '✗'} 场景H 增量后全量不堆叠 → ${JSON.stringify(m.get())}`);
  if (!ok) process.exitCode = 1;
}

console.log(process.exitCode ? '\n有失败项' : '\n全部通过 ✓');
