'use strict';
/**
 * 火山引擎流式大模型 ASR 客户端（豆包语音识别）
 *
 * 依赖：ws（WebSocket 客户端，支持自定义 header——认证必须走 header，
 *       Node 22+ 原生 WebSocket 不支持，故必须用 ws 库）
 *
 * 源自 G:\DSH\qianyi（ESM 化，端点支持环境变量覆盖以便本地 mock 测试）。
 */
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import * as P from './asr-protocol.js';

export class DoubaoAsrClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.appId       火山引擎 App ID
   * @param {string} opts.accessToken 火山引擎 Access Token
   * @param {string} [opts.resourceId] Resource ID，默认 volc.seedasr.sauc.duration
   * @param {'async'|'duplex'} [opts.endpointMode] 默认 async
   * @param {string} [opts.language]  语言，默认空（自动）
   * @param {string} [opts.customHotwords] 热词，分隔符分隔
   * @param {number} [opts.connectTimeoutMs] 建连超时，默认 10000
   * @param {string} [opts.endpoint]  覆盖端点（测试用），默认 async 端点
   */
  constructor(opts) {
    super();
    const { appId, accessToken } = opts;
    if (!appId || !accessToken) {
      throw new Error('缺少 App ID / Access Token');
    }
    this.appId = appId;
    this.accessToken = accessToken;
    this.resourceId = opts.resourceId || 'volc.seedasr.sauc.duration';
    this.endpointMode = opts.endpointMode || 'async';
    this.language = opts.language || '';
    this.customHotwords = opts.customHotwords || '';
    this.connectTimeoutMs = opts.connectTimeoutMs || 10000;
    this.endpointOverride = opts.endpoint || '';
    this.ws = null;
    this.closed = false;
    this.connected = false;
  }

  get endpoint() {
    if (this.endpointOverride) return this.endpointOverride;
    return this.endpointMode === 'duplex' ? P.DUPLEX_ENDPOINT : P.ASYNC_ENDPOINT;
  }

  /**
   * 建立连接并发送建连首包。
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.endpoint, {
        headers: {
          'X-Api-App-Key': this.appId,
          'X-Api-Access-Key': this.accessToken,
          'X-Api-Resource-Id': this.resourceId,
          'X-Api-Connect-Id': crypto.randomUUID(),
        },
      });
      this.ws = ws;

      let settled = false;
      const fail = (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      };

      const timer = setTimeout(() => {
        ws.terminate();
        fail(new Error('连接豆包 ASR 超时'));
      }, this.connectTimeoutMs);

      ws.once('open', () => {
        if (settled) return;
        clearTimeout(timer);
        this.connected = true;
        settled = true;
        // 建连首包
        ws.send(
          P.buildClientRequest({
            language: this.language,
            customHotwords: this.customHotwords,
          })
        );
        this.emit('state', 'recording');
        resolve();
      });

      ws.on('message', (message) => {
        try {
          const parsed = P.parseServerMessage(message);
          if (parsed) {
            this.emit('transcript', { text: parsed.text, isFinal: parsed.isFinal });
            if (parsed.isFinal) this.emit('state', 'completed');
          }
        } catch (err) {
          this.emit('error', new Error(`解析 ASR 响应失败: ${err.message}`));
        }
      });

      ws.once('error', (err) => {
        clearTimeout(timer);
        this.connected = false;
        this.emit('error', err);
        fail(err);
      });

      ws.once('close', () => {
        clearTimeout(timer);
        this.closed = true;
        this.emit('close');
        if (!settled) fail(new Error('连接豆包 ASR 在建立前已关闭'));
      });
    });
  }

  /**
   * 发送一段音频（16kHz/16bit/单声道 PCM）。
   * @param {Buffer|Uint8Array} data
   */
  sendAudio(data) {
    const ws = this.ws;
    if (!ws || this.closed || ws.readyState !== WebSocket.OPEN) return;
    const audio = Buffer.from(data);
    if (audio.length === 0) return;
    ws.send(P.buildAudioFrame(audio, false));
  }

  /**
   * 结束本次识别：发送空末帧，800ms 后关闭连接。
   */
  end() {
    const ws = this.ws;
    if (!ws || this.closed) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(P.buildAudioFrame(Buffer.alloc(0), true));
      setTimeout(() => {
        if (!this.closed) ws.close();
      }, 800);
    } else {
      ws.terminate();
    }
  }

  /** 立即取消 */
  cancel() {
    if (this.ws) this.ws.terminate();
    this.closed = true;
  }
}
