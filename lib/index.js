/**
 * dsh-doubao-voice host half（server 插件）：
 *   1. 凭据管理（GET/POST /config，落盘 ~/.dsh/dsh-doubao-voice.json，环境变量优先）
 *   2. 测试连接（POST /test）
 *   3. WebSocket 升级中继（/dsh-doubao-voice/v1/session）：
 *      浏览器 WS（二进制 PCM 上行 / JSON 下行） ⇄ 火山引擎流式 ASR（豆包 Seed ASR / sauc）
 *
 * 协议实现源自 G:\DSH\qianyi（火山引擎流式 ASR 接入示例，ESM 化）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { DoubaoAsrClient } from './doubao/doubao-asr-client.js';

export const name = 'dsh-doubao-voice';
export const inject = ['webServer'];

const API_ROOT = '/dsh-doubao-voice/v1';
const SESSION_PATH = '/dsh-doubao-voice/v1/session';

const ENV_KEYS = {
  appId: 'ARK_APP_ID',
  accessToken: 'ARK_ACCESS_TOKEN',
  resourceId: 'ARK_RESOURCE_ID',
  language: 'ARK_LANGUAGE',
  customHotwords: 'ARK_HOTWORDS',
};

const DEFAULTS = {
  appId: '',
  accessToken: '',
  resourceId: 'volc.seedasr.sauc.duration',
  language: '',
  customHotwords: '',
};

function configFile() {
  return join(homedir(), '.dsh', 'dsh-doubao-voice.json');
}

function loadFileConfig() {
  try {
    const raw = readFileSync(configFile(), 'utf8');
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function resolveConfig() {
  const out = { ...DEFAULTS, ...loadFileConfig() };
  for (const [key, envName] of Object.entries(ENV_KEYS)) {
    const env = process.env[envName];
    if (env !== undefined && env !== '') out[key] = env;
  }
  return out;
}

/** 收紧凭据文件 ACL：仅当前用户可读写（Windows icacls，失败不阻塞）。
 *  注意：icacls 通用权限不能组合，读写用 (M)=Modify，(RW) 是非法参数。 */
function hardenConfigFile(file) {
  try {
    const user = process.env.USERNAME || '';
    if (!user) return;
    spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:(M)`], {
      windowsHide: true, timeout: 10000, stdio: 'ignore',
    });
  } catch {
    /* best-effort */
  }
}

function saveFileConfig(cfg) {
  const content = `${JSON.stringify(cfg, null, 2)}\n`;
  try {
    mkdirSync(join(homedir(), '.dsh'), { recursive: true });
    try {
      writeFileSync(configFile(), content, 'utf8');
    } catch (err) {
      // 旧版本曾把 ACL 收成只读 (R)，导致重写失败——先修复 ACL 再重试一次
      if (err.code === 'EPERM' || err.code === 'EACCES') {
        hardenConfigFile(configFile());
        writeFileSync(configFile(), content, 'utf8');
      } else {
        throw err;
      }
    }
    hardenConfigFile(configFile());
  } catch (err) {
    throw new Error(`保存凭据失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function json(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(body);
}

/** 轻量信任校验：只服务本机 DSH Web GUI 的同源请求 */
function trustedRequest(req) {
  const host = String(req.headers.host ?? '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  const loopback = hostname === 'localhost' || hostname === '::1'
    || hostname === '127.0.0.1' || hostname === '[::1]';
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '');
  if (fetchSite === 'cross-site') return false;
  const origin = String(req.headers.origin ?? '');
  if (origin === '') return loopback;
  try {
    return new URL(origin).hostname === hostname || loopback;
  } catch {
    return false;
  }
}

async function readJsonBody(req, maxBytes = 64 * 1024) {
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('请求体过大');
    parts.push(chunk);
  }
  if (parts.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function maskSecret(value) {
  const s = String(value ?? '');
  if (s.length <= 4) return s ? '****' : '';
  return `${s.slice(0, 2)}…${s.slice(-2)}`;
}

// ================= 会话中继 =================

export class SessionRelay {
  constructor(ws, cfg) {
    this.client = ws;
    this.doubao = null;
    this.lastFinal = '';
    this.ended = false;
    this.closed = false;
    this.cfg = cfg;
  }

  static create(cfg) {
    const doubao = new DoubaoAsrClient({
      appId: cfg.appId,
      accessToken: cfg.accessToken,
      resourceId: cfg.resourceId,
      language: cfg.language,
      customHotwords: cfg.customHotwords,
      endpoint: process.env.DSH_DOUBAO_ENDPOINT || '',
    });
    return doubao;
  }

  send(message) {
    if (!this.closed && this.client.readyState === 1 /* OPEN */) {
      this.client.send(JSON.stringify(message));
    }
  }

  attach(ws) {
    this.client = ws;
    const doubao = SessionRelay.create(this.cfg);
    this.doubao = doubao;

    doubao.on('transcript', ({ text, isFinal }) => {
      if (isFinal) this.lastFinal = text;
      this.send({ type: 'transcript', text, isFinal });
    });
    doubao.on('error', (err) => {
      this.send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
    doubao.on('close', () => {
      this.send({ type: 'done', text: this.lastFinal });
      this.teardown();
    });

    doubao.connect().then(() => {
      this.send({ type: 'ready', message: '已连接豆包流式 ASR' });
    }).catch((err) => {
      this.send({
        type: 'error',
        message: `连接豆包 ASR 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      this.teardown();
    });

    ws.on('message', (data, isBinary) => {
      // 注意：本 ws 版本文本帧也以 Buffer 投递，必须用 isBinary 判别
      if (isBinary) {
        doubao.sendAudio(data);
        return;
      }
      try {
        const parsed = JSON.parse(String(data));
        if (parsed.type === 'end') {
          this.ended = true;
          doubao.end();
        } else if (parsed.type === 'cancel') {
          doubao.cancel();
          this.teardown();
        }
      } catch {
        /* 非 JSON 文本消息忽略 */
      }
    });

    ws.on('close', () => {
      doubao.cancel();
      this.closed = true;
    });
    ws.on('error', () => {
      doubao.cancel();
      this.closed = true;
    });
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    try { this.client.close(); } catch { /* noop */ }
  }
}

// ================= 插件入口 =================

export function apply(ctx, config = {}) {
  let cfg = resolveConfig();

  const wss = new WebSocketServer({ noServer: true });

  // ---------- HTTP 路由 ----------
  const route = async (req, res) => {
    if (!trustedRequest(req)) {
      json(res, 403, { ok: false, error: { code: 'forbidden', message: '请求未通过 Host/Origin 信任校验' } });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal');
    const suffix = url.pathname.slice(API_ROOT.length);
    try {
      if (req.method === 'GET' && suffix === '/health') {
        json(res, 200, { ok: true, plugin: name, protocol: 1 });
        return;
      }
      if (req.method === 'GET' && suffix === '/config') {
        const envMode = Boolean(process.env.ARK_APP_ID && process.env.ARK_ACCESS_TOKEN);
        json(res, 200, {
          ok: true,
          configured: Boolean(cfg.appId && cfg.accessToken),
          appIdMasked: maskSecret(cfg.appId),
          tokenSet: Boolean(cfg.accessToken),
          resourceId: cfg.resourceId,
          language: cfg.language,
          customHotwords: cfg.customHotwords,
          envMode,
          configFile: configFile(),
        });
        return;
      }
      if (req.method === 'POST' && suffix === '/config') {
        const body = await readJsonBody(req);
        const patch = {};
        // 凭据字段：空字符串 = 保持已保存的值（允许只改其他配置）
        if (typeof body.appId === 'string' && body.appId.trim() !== '') patch.appId = body.appId.trim();
        if (typeof body.accessToken === 'string' && body.accessToken.trim() !== '') patch.accessToken = body.accessToken.trim();
        // 其他字段：空字符串 = 清空（正常覆盖）
        if (typeof body.resourceId === 'string') patch.resourceId = body.resourceId.trim();
        if (typeof body.language === 'string') patch.language = body.language.trim();
        if (typeof body.customHotwords === 'string') patch.customHotwords = body.customHotwords.trim();
        const next = { ...cfg, ...patch };
        saveFileConfig(next);
        cfg = resolveConfig(); // 环境变量优先
        json(res, 200, { ok: true, configured: Boolean(cfg.appId && cfg.accessToken) });
        return;
      }
      if (req.method === 'POST' && suffix === '/test') {
        if (!cfg.appId || !cfg.accessToken) {
          json(res, 400, { ok: false, error: { code: 'no-credentials', message: '尚未配置 App ID / Access Token' } });
          return;
        }
        const doubao = SessionRelay.create(cfg);
        const timer = setTimeout(() => doubao.cancel(), 15000);
        try {
          await doubao.connect();
          doubao.end(); // 建连即测：握手 + 首包通过即视为凭据可用
          json(res, 200, { ok: true, message: '连接成功（凭据有效）' });
        } catch (err) {
          json(res, 502, {
            ok: false,
            error: { code: 'connect-failed', message: err instanceof Error ? err.message : String(err) },
          });
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      json(res, 404, { ok: false, error: { code: 'not-found', message: '未知的 dsh-doubao-voice 端点' } });
    } catch (cause) {
      json(res, 500, { ok: false, error: { code: 'internal', message: cause instanceof Error ? cause.message : String(cause) } });
    }
  };

  // ---------- WebSocket 升级 ----------
  const upgradeHandler = (req, socket, head) => {
    if (!trustedRequest(req)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const relay = new SessionRelay(ws, cfg);
      relay.attach(ws);
    });
  };

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'prefix', path: API_ROOT, handler: route }),
      ctx.webServer.registerUpgrade({ path: SESSION_PATH, handler: upgradeHandler }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
      for (const client of wss.clients) {
        try { client.close(); } catch { /* noop */ }
      }
      wss.close();
    };
  }, 'dsh-doubao-voice: routes');
}
