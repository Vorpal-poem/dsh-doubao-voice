/**
 * 写入保险（lastWritten 守卫）单元测试：
 * 模拟「收尾中发送消息」场景——定稿到达时草稿已被清空，不得重新写入。
 * 运行：node test/writer-guard-test.mjs
 */

// 与 client.js makeLiveWriter 相同逻辑的最小模拟
function makeWriter(store) {
  // store: { draft, setDraft(text) } — setDraft 同步生效（模拟）
  let base = null;
  let active = false;
  let lastWritten = null;
  return {
    begin() {
      base = store.draft;
      lastWritten = null;
      active = true;
      return true;
    },
    set(text) {
      if (!active) return;
      if (lastWritten !== null) {
        if (store.draft === '') return; // 已发送/清空
        if (store.draft !== lastWritten && !store.draft.startsWith(base)) return; // 被替换
      }
      const text2 = typeof text === 'string' ? text : '';
      const needSep = base.length > 0 && text2.length > 0 && !/\s$/.test(base) && !/^\s/.test(text2);
      const next = base + (needSep ? ' ' : '') + text2;
      store.draft = next;
      lastWritten = next;
    },
    finish() {
      active = false;
      base = null;
      lastWritten = null;
    },
  };
}

// 场景 1：正常流程（录音 → 定稿 → 发送）→ 定稿写入成功，发送后无残留
{
  const store = { draft: '' };
  const w = makeWriter(store);
  w.begin();
  w.set('第一句话');
  w.set('第一句话，第二句话');
  w.set('第一句话，第二句话。', true); // done 定稿
  w.finish();
  const afterDone = store.draft;
  store.draft = ''; // 用户发送 → 草稿清空
  w.set('第一句话，第二句话。'); // 迟到的写入尝试
  const ok = afterDone === '第一句话，第二句话。' && store.draft === '';
  console.log(`${ok ? '✓' : '✗'} 场景1 正常流程+发送后迟到写入被拦 → afterDone=${JSON.stringify(afterDone)} final=${JSON.stringify(store.draft)}`);
  if (!ok) process.exitCode = 1;
}

// 场景 2：收尾中发送（done 到达时草稿已空）→ 不重新写入
{
  const store = { draft: '' };
  const w = makeWriter(store);
  w.begin();
  w.set('测试内容');
  store.draft = ''; // 用户在定稿前发送
  w.set('测试内容。', true); // 定稿迟到
  w.finish();
  const ok = store.draft === '';
  console.log(`${ok ? '✓' : '✗'} 场景2 收尾中发送→定稿迟到被拦 → final=${JSON.stringify(store.draft)}`);
  if (!ok) process.exitCode = 1;
}

// 场景 3：录音前有手动输入（base 非空），正常定稿 → 保留手动输入 + 定稿
{
  const store = { draft: '我先打的字' };
  const w = makeWriter(store);
  w.begin();
  w.set('语音内容');
  w.set('语音内容，定稿。', true);
  w.finish();
  const ok = store.draft === '我先打的字 语音内容，定稿。';
  console.log(`${ok ? '✓' : '✗'} 场景3 手动输入+语音定稿 → ${JSON.stringify(store.draft)}`);
  if (!ok) process.exitCode = 1;
}

// 场景 4：流式期间状态回读延迟（draft 还是旧值）→ 不应误拦
{
  const store = { draft: '' };
  const w = makeWriter(store);
  w.begin();
  w.set('第');
  // 模拟回读延迟：draft 仍是上一次写入前的值（base）
  store.draft = '';
  w.set('第一句话');
  const ok = store.draft === '第一句话';
  console.log(`${ok ? '✓' : '✗'} 场景4 回读延迟不误拦 → ${JSON.stringify(store.draft)}`);
  if (!ok) process.exitCode = 1;
}

console.log(process.exitCode ? '\n有失败项' : '\n全部通过 ✓');
