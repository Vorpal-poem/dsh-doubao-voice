'use strict';
/**
 * 火山引擎流式大模型 ASR（sauc / bigmodel）二进制帧协议
 * 纯函数实现，无第三方依赖。
 * 协议细节参考 Proma 桌面端 doubao-asr-service.ts（已核实）。
 * 源自 G:\DSH\qianyi（ESM 化）。
 */

import zlib from 'node:zlib';

// ---------- 协议常量 ----------
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 1; // 头长度 = HEADER_SIZE * 4 = 4 字节

const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 1; // 建连首包（完整请求）
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 2; // 纯音频帧
const MESSAGE_TYPE_FULL_SERVER_RESPONSE = 9; // 服务端完整响应
const MESSAGE_TYPE_SERVER_ERROR = 15; // 服务端错误

const FLAG_NO_SEQUENCE = 0; // 无序号
const FLAG_LAST_NO_SEQUENCE = 2; // 末帧（无序号）
const FLAG_SERVER_SEQUENCE = 1; // 服务端带序号
const FLAG_SERVER_LAST_SEQUENCE = 3; // 服务端末帧（带序号）

const SERIALIZATION_NONE = 0;
const SERIALIZATION_JSON = 1;

const COMPRESSION_GZIP = 1;

// 端点（可被 DSH_DOUBAO_ENDPOINT 覆盖，便于本地 mock 测试）
const ASYNC_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async';
const DUPLEX_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

// 静音/强制识别参数（与 Proma 一致）
const DICTATION_END_WINDOW_SIZE_MS = 5000;
const DICTATION_FORCE_TO_SPEECH_TIME_MS = 1000;
const MAX_INLINE_HOTWORDS = 100;
const HOTWORD_SEPARATOR_PATTERN = /[\n,，;；。]+/u; // 热词分隔符

// ---------- 帧构造 ----------

/** 4 字节协议头 */
function buildHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ]);
}

/** 完整帧 = 头(4B) + payload长度(4B BE) + payload */
function buildFrame(messageType, flags, serialization, compression, payload) {
  const header = buildHeader(messageType, flags, serialization, compression);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

/** 解析热词字符串 → [{word}]，最多 100 个 */
function parseCustomHotwords(value) {
  const seen = new Set();
  const hotwords = [];
  for (const rawWord of String(value || '').split(HOTWORD_SEPARATOR_PATTERN)) {
    const word = rawWord.trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    hotwords.push({ word });
    if (hotwords.length >= MAX_INLINE_HOTWORDS) break;
  }
  return hotwords;
}

/**
 * 建连首包（完整请求）
 * @param {object} opts
 * @param {string} [opts.uid]           用户标识
 * @param {string} [opts.language]      语言，如 'zh'，空则自动
 * @param {string} [opts.customHotwords] 热词，分隔符分隔
 */
function buildClientRequest(opts = {}) {
  const audio = {
    format: 'pcm',
    codec: 'raw',
    rate: 16000,
    bits: 16,
    channel: 1,
  };
  if (opts.language) audio.language = opts.language;

  const hotwords = parseCustomHotwords(opts.customHotwords);
  const request = {
    model_name: 'bigmodel',
    enable_nonstream: true,
    show_utterances: true,
    result_type: 'full',
    enable_itn: true,
    enable_punc: true,
    enable_ddc: true,
    end_window_size: DICTATION_END_WINDOW_SIZE_MS,
    force_to_speech_time: DICTATION_FORCE_TO_SPEECH_TIME_MS,
  };
  if (hotwords.length > 0) {
    request.corpus = { context: JSON.stringify({ hotwords }) };
  }

  const payload = zlib.gzipSync(
    Buffer.from(JSON.stringify({ user: { uid: opts.uid || 'dsh-doubao-voice' }, audio, request }), 'utf-8')
  );
  return buildFrame(
    MESSAGE_TYPE_FULL_CLIENT_REQUEST,
    FLAG_NO_SEQUENCE,
    SERIALIZATION_JSON,
    COMPRESSION_GZIP,
    payload
  );
}

/**
 * 音频帧：裸 PCM (16kHz/16bit/单声道) gzip 后发送
 * @param {Buffer} audio PCM 数据
 * @param {boolean} isLast 是否为结束帧（空数据 + true）
 */
function buildAudioFrame(audio, isLast = false) {
  const payload = zlib.gzipSync(audio);
  return buildFrame(
    MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
    isLast ? FLAG_LAST_NO_SEQUENCE : FLAG_NO_SEQUENCE,
    SERIALIZATION_NONE,
    COMPRESSION_GZIP,
    payload
  );
}

// ---------- 响应解析 ----------

/** 从 result 中取文本 */
function getResultText(result) {
  return result.text ?? result.utterances?.map((u) => u.text ?? '').join('') ?? '';
}

/** 多个候选按 confidence 降序取最优 */
function getAuthoritativeResult(results) {
  const candidates = results
    .map((r) => ({ result: r, text: getResultText(r) }))
    .filter((item) => item.text.trim().length > 0);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].result;
  return [...candidates].sort(
    (a, b) => (b.result.confidence ?? 0) - (a.result.confidence ?? 0)
  )[0].result;
}

function isResultFinal(result) {
  return result.utterances?.some((u) => u.definite === true) ?? false;
}

/** 解析 JSON payload → { text, isFinal } | null */
function parseServerPayload(value, fallbackFinal) {
  if (typeof value !== 'object' || value === null) return null;
  const payload = value;
  const results = Array.isArray(payload.result)
    ? payload.result
    : payload.result
      ? [payload.result]
      : [];

  if (results.length === 0) {
    const message = payload.text ?? payload.message ?? payload.error;
    return message ? { text: message, isFinal: fallbackFinal } : null;
  }
  if (payload.text) {
    return { text: payload.text, isFinal: fallbackFinal || results.some(isResultFinal) };
  }
  const authoritative = getAuthoritativeResult(results);
  const text = authoritative ? getResultText(authoritative) : '';
  const utteranceFinal = authoritative ? isResultFinal(authoritative) : false;
  if (!text) return null;
  return { text, isFinal: fallbackFinal || utteranceFinal };
}

/**
 * 解析一条服务端消息
 * @param {Buffer} data WebSocket message（Buffer 或可转 Buffer）
 * @returns {{text:string,isFinal:boolean}|null}
 */
function parseServerMessage(data) {
  if (!Buffer.isBuffer(data)) data = Buffer.from(data);
  if (data.length < 8) return null;

  const headerSize = (data[0] & 15) * 4;
  const messageType = data[1] >> 4;
  const flags = data[1] & 15;
  const serialization = data[2] >> 4;
  const compression = data[2] & 15;

  let offset = headerSize;
  const hasSequence = flags === FLAG_SERVER_SEQUENCE || flags === FLAG_SERVER_LAST_SEQUENCE;
  if (hasSequence) offset += 4; // 跳过 sequence

  if (messageType === MESSAGE_TYPE_SERVER_ERROR) {
    if (data.length < offset + 8) return null;
    const code = data.readUInt32BE(offset);
    offset += 4;
    const size = data.readUInt32BE(offset);
    offset += 4;
    const message = data.subarray(offset, offset + size).toString('utf-8');
    return { text: `豆包 ASR 错误 ${code}: ${message}`, isFinal: true };
  }

  if (messageType !== MESSAGE_TYPE_FULL_SERVER_RESPONSE || data.length < offset + 4) {
    return null;
  }
  const payloadSize = data.readUInt32BE(offset);
  offset += 4;
  const payload = data.subarray(offset, offset + payloadSize);
  const decoded =
    compression === COMPRESSION_GZIP ? zlib.gunzipSync(payload) : payload;
  if (serialization !== SERIALIZATION_JSON) return null;

  const parsed = JSON.parse(decoded.toString('utf-8'));
  return parseServerPayload(parsed, flags === FLAG_SERVER_LAST_SEQUENCE);
}

export {
  // 常量
  PROTOCOL_VERSION,
  HEADER_SIZE,
  MESSAGE_TYPE_FULL_CLIENT_REQUEST,
  MESSAGE_TYPE_AUDIO_ONLY_REQUEST,
  MESSAGE_TYPE_FULL_SERVER_RESPONSE,
  MESSAGE_TYPE_SERVER_ERROR,
  FLAG_NO_SEQUENCE,
  FLAG_LAST_NO_SEQUENCE,
  FLAG_SERVER_SEQUENCE,
  FLAG_SERVER_LAST_SEQUENCE,
  SERIALIZATION_NONE,
  SERIALIZATION_JSON,
  COMPRESSION_GZIP,
  ASYNC_ENDPOINT,
  DUPLEX_ENDPOINT,
  DICTATION_END_WINDOW_SIZE_MS,
  DICTATION_FORCE_TO_SPEECH_TIME_MS,
  MAX_INLINE_HOTWORDS,
  HOTWORD_SEPARATOR_PATTERN,
  // 函数
  buildHeader,
  buildFrame,
  parseCustomHotwords,
  buildClientRequest,
  buildAudioFrame,
  parseServerMessage,
  parseServerPayload,
};
