/**
 * mock 豆包（火山引擎 sauc）服务端：本地协议回放，供无凭据自测。
 * 监听 127.0.0.1:19091。行为：
 *   - 建连后收到首包（完整请求帧）→ 回一个中间结果帧（isFinal=false）
 *   - 收到任意音频帧 → 回一个定稿结果帧（isFinal=true）
 *   - 收到末帧（FLAG_LAST_NO_SEQUENCE）→ 800ms 后关闭
 *   - 若 header 带 X-Api-App-Key: bad → 握手阶段销毁 socket（模拟鉴权失败）
 */
import zlib from 'node:zlib';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import * as P from '../lib/doubao/asr-protocol.js';

const PORT = 19091;
const wss = new WebSocketServer({ noServer: true });
const server = createServer();

function resultFrame(text, definite, last) {
  const payload = JSON.stringify({
    result: [{ utterances: [{ text, definite }] }],
  });
  const gz = zlib.gzipSync(Buffer.from(payload, 'utf-8'));
  // 服务端帧（带序号）：[头 4B][sequence 4B][payloadSize 4B][payload]
  const header = P.buildHeader(
    P.MESSAGE_TYPE_FULL_SERVER_RESPONSE,
    last ? P.FLAG_SERVER_LAST_SEQUENCE : P.FLAG_SERVER_SEQUENCE,
    P.SERIALIZATION_JSON,
    P.COMPRESSION_GZIP
  );
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(++seqCounter, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(gz.length, 0);
  return Buffer.concat([header, seq, size, gz]);
}

let seqCounter = 0;

server.on('upgrade', (req, socket, head) => {
  const appKey = req.headers['x-api-app-key'] || '';
  if (appKey === 'bad') {
    // 模拟鉴权失败：握手阶段直接销毁 socket → 客户端 connect() 报错
    console.log('[mock] auth failure for bad key');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const appKey = req.headers['x-api-app-key'] || '';
  console.log(`[mock] connection appKey=${appKey}`);
  let first = true;
  ws.on('message', (data) => {
    if (!Buffer.isBuffer(data) || data.length < 8) return;
    const messageType = data[1] >> 4;
    const flags = data[1] & 15;
    console.log(`[mock] frame type=${messageType} flags=${flags} len=${data.length}`);
    if (first) {
      first = false;
      ws.send(resultFrame('中间结果…', false, false));
      return;
    }
    if (messageType === P.MESSAGE_TYPE_AUDIO_ONLY_REQUEST) {
      if (flags === P.FLAG_LAST_NO_SEQUENCE) {
        console.log('[mock] last frame → final + close in 800ms');
        ws.send(resultFrame('你好世界，这是定稿。', true, true));
        setTimeout(() => ws.close(), 800);
      } else {
        ws.send(resultFrame('中间结果…', false, false));
      }
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock doubao listening on ws://127.0.0.1:${PORT}`);
});
