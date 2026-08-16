/**
 * 全链路中继自测（无需真实豆包凭据）：
 *   mock 豆包(19091) ⇦ DoubaoAsrClient(经 SessionRelay) ⇦ 本地 wss(19092) ⇦ 浏览器式 ws 客户端
 *
 * 验证：
 *   1. 客户端连上宿主 WS 后收到 ready
 *   2. 上行二进制音频被转发；下行 transcript（中间 + 定稿）回推
 *   3. 客户端发 end → 收到 done 且文本为定稿文本
 *   4. 鉴权失败路径：mock 用 bad key → 客户端收到 error
 *
 * 运行：node test/relay-test.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { SessionRelay } from '../lib/index.js';

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url));
const MOCK_PORT = 19091;
const RELAY_PORT = 19092;

// 关键：把豆包端点指到本地 mock，避免测试打到真实火山引擎
process.env.DSH_DOUBAO_ENDPOINT = `ws://127.0.0.1:${MOCK_PORT}`;

function startMock() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['test/mock-doubao.mjs'], {
      cwd: PLUGIN_DIR,
      stdio: 'ignore',
    });
    setTimeout(resolve, 800, child);
  });
}

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// ---------- 与插件 index.js 一致的升级接线 ----------
function startRelay(cfg) {
  const wss = new WebSocketServer({ noServer: true });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => {
    if (!req.headers.origin) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const relay = new SessionRelay(ws, cfg);
      relay.attach(ws);
    });
  });
  return new Promise((resolve) => {
    server.listen(RELAY_PORT, '127.0.0.1', () => resolve({ server, wss }));
  });
}

// ---------- 浏览器式客户端 ----------
async function browserClient(onMessage) {
  const ws = new WebSocket(`ws://127.0.0.1:${RELAY_PORT}/dsh-doubao-voice/v1/session`, {
    headers: { origin: 'http://127.0.0.1:3080' },
  });
  const state = { ready: false, transcripts: [], done: null, error: null };
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === 'ready') state.ready = true;
    if (msg.type === 'transcript') state.transcripts.push(msg);
    if (msg.type === 'done') state.done = msg;
    if (msg.type === 'error') state.error = msg;
    onMessage?.(msg, state, ws);
  });
  return { ws, state };
}

// ---------- 测试序列 ----------
const mock = await startMock();

// 测试 1：正常流
{
  const { server } = await startRelay({
    appId: 'test-app', accessToken: 'test-token', resourceId: 'volc.seedasr.sauc.duration',
    language: 'zh', customHotwords: '',
  });
  const { ws, state } = await browserClient((msg, st, sock) => {
    if (msg.type === 'done') {
      sock.close();
      server.close();
    }
  });
  await new Promise((r) => setTimeout(r, 500));
  record('客户端收到 ready', state.ready);
  // 发 3 块 6400B 静音
  for (let i = 0; i < 3; i++) ws.send(Buffer.alloc(6400));
  await new Promise((r) => setTimeout(r, 400));
  record('收到中间结果（isFinal=false）', state.transcripts.some((t) => !t.isFinal));
  ws.send(JSON.stringify({ type: 'end' }));
  await new Promise((r) => setTimeout(r, 2000));
  record('收到 done 且为定稿文本', state.done !== null && state.done.text.includes('你好世界'),
    state.done ? `done.text=${state.done.text}` : 'no done');
  ws.close();
  server.close();
}

// 测试 2：鉴权失败路径
{
  const { server } = await startRelay({
    appId: 'bad', accessToken: 'x', resourceId: 'volc.seedasr.sauc.duration',
    language: '', customHotwords: '',
  });
  const { ws, state } = await browserClient((msg, st, sock) => {
    if (msg.type === 'error') sock.close();
  });
  await new Promise((r) => setTimeout(r, 1200));
  record('鉴权失败时客户端收到 error', state.error !== null,
    state.error ? state.error.message : 'no error');
  ws.close();
  server.close();
}

mock.kill();

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n全部通过 ✓');
}
