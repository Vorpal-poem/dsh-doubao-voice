/**
 * dsh-doubao-voice web 端（client 插件）：
 * 输入框麦克风按钮（+ 全局快捷键，默认 Alt+V 切换录音）
 * → getUserMedia 采集 → 16kHz/16bit/单声道 → 每 200ms 一块（6400B）经 WebSocket
 *   上行到宿主 → 宿主中继到火山引擎流式 ASR（豆包）→ 流式识别结果实时回推，
 *   追尾替换写入输入框（不自动发送；取消录音自动回滚）。
 *
 * 传输协议（浏览器 ⇄ 宿主）：
 *   上行：二进制 = PCM 块；文本 JSON {type:'end'|'cancel'}
 *   下行：JSON {type:'ready'|'transcript',text,isFinal|'error',message|'done',text}
 */
window.__ModuleLoader__.load({
  id: 'dsh-doubao-voice',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-doubao-voice/v1';
    const SESSION_PATH = '/dsh-doubao-voice/v1/session';
    const STORAGE_KEY = 'dsh-doubao-voice.settings';

    // ---------------- 默认配置 ----------------
    const DEFAULTS = {
      hotkey: 'alt+v',
      lang: 'zh-CN', // BCP-47，官方文档取值
      maxDurationSec: 300,
      outputMode: 'cursor', // cursor（跟随光标，默认）| composer（始终输入框）| clipboard（仅剪贴板）
    };
    const OUTPUT_MODES = [
      { value: 'cursor', label: '跟随光标（默认）' },
      { value: 'composer', label: '始终输入框' },
      { value: 'clipboard', label: '仅剪贴板' },
    ];
    const LANGS = [
      { value: '', label: '自动' },
      { value: 'zh-CN', label: '中文（普通话）' },
      { value: 'en-US', label: 'English' },
      { value: 'ja-JP', label: '日本語' },
      { value: 'ko-KR', label: '한국어' },
      { value: 'yue-CN', label: '粤语' },
    ];

    // ---------------- CSS ----------------
    const css = `
      .dsdv-button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0;flex:none}
      .dsdv-button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
      .dsdv-button:disabled{opacity:.4;cursor:default}
      .dsdv-micwrap{display:inline-flex;align-items:center;gap:7px;flex:none;height:28px}
      .dsdv-meter{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;appearance:none;cursor:pointer;padding:0;flex:none;color:inherit}
      .dsdv-meter:disabled{opacity:.4;cursor:default}
      .dsdv-bars{display:flex;align-items:center;gap:2px;height:16px}
      .dsdv-bar{width:2.5px;border-radius:1.5px;background:var(--dsw-alias-label-tertiary);transition:height 90ms ease}
      .dsdv-miclabel{font-size:12px;line-height:14px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
      .dsdv-spinner{width:13px;height:13px;border:2px solid var(--dsw-alias-border-l1);border-top-color:var(--dsw-alias-label-tertiary);border-radius:50%;animation:dsdv-spin .8s linear infinite}
      @keyframes dsdv-spin{to{transform:rotate(360deg)}}
      .dsdv-toast{position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:100;max-width:min(560px,calc(100vw - 48px));box-sizing:border-box;padding:9px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-base);box-shadow:var(--dsw-shadow-lv3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;pointer-events:none;opacity:0;transition:opacity .18s ease}
      .dsdv-toast[data-show=true]{opacity:1}
      .dsdv-toast[data-kind=error]{border-color:var(--dsw-alias-state-error-primary)}
      .dsdv-settings{display:flex;flex-direction:column;width:100%;max-width:560px}
      .dsdv-row{border-bottom:1px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:14px 0;display:flex}
      .dsdv-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:24px;display:flex}
      .dsdv-rowTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}
      .dsdv-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      .dsdv-pill{box-sizing:border-box;background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;border-radius:18px;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex;min-width:120px}
      .dsdv-input{box-sizing:border-box;background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);border:1px solid transparent;border-radius:18px;padding:0 14px;font-size:14px;line-height:22px;width:240px}
      .dsdv-input::placeholder{color:var(--dsw-alias-label-tertiary)}
      .dsdv-input:focus{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}
      .dsdv-btn{appearance:none;font:inherit;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:5px 14px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-secondary);background:0 0;display:inline-flex;align-items:center;gap:8px}
      .dsdv-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}
      .dsdv-btn:disabled{opacity:.4;cursor:default}
      .dsdv-btn-primary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
      .dsdv-btn-primary:hover:not(:disabled){background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
      .dsdv-ok{color:var(--dsw-alias-state-success-primary,#1a9e5c);font-size:12px;line-height:18px}
      .dsdv-err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere}
      .dsdv-actions{display:flex;align-items:center;gap:12px;padding:12px 0}
      .dsdv-status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);padding:8px 0}
    `;
    if (document.querySelector('style[data-plugin-css="dsh-doubao-voice"]') === null) {
      const style = document.createElement('style');
      style.dataset.plugin = 'dsh-doubao-voice';
      style.dataset.pluginCss = 'dsh-doubao-voice';
      style.textContent = css;
      document.head.appendChild(style);
    }

    // ---------------- toast ----------------
    let toastTimer = null;
    let toastEl = null;
    function showToast(message, kind = 'info') {
      if (toastEl === null) {
        toastEl = document.createElement('div');
        toastEl.className = 'dsdv-toast';
        document.body.appendChild(toastEl);
      }
      toastEl.dataset.kind = kind;
      toastEl.textContent = message;
      requestAnimationFrame(() => { toastEl.dataset.show = 'true'; });
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.dataset.show = 'false';
        setTimeout(() => { toastEl.remove(); toastEl = null; }, 220);
      }, 6000);
    }

    // ---------------- 设置存取 ----------------
    let settings = { ...DEFAULTS };
    let serverConfigured = false; // 宿主凭据状态缓存（插件加载时获取，保存后更新）
    function loadStoredSettings() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) settings = { ...DEFAULTS, ...JSON.parse(raw) };
      } catch { /* 保持默认 */ }
    }
    function saveStoredSettings(patch) {
      settings = { ...settings, ...patch };
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch { /* noop */ }
    }

    // ---------------- 音频处理 ----------------
    function resampleTo16k(input, fromRate) {
      if (fromRate === 16000) return input;
      const targetLen = Math.max(1, Math.round(input.length * 16000 / fromRate));
      const out = new Float32Array(targetLen);
      for (let i = 0; i < targetLen; i++) {
        const pos = i * fromRate / 16000;
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const a = input[idx] ?? 0;
        const b = input[idx + 1] ?? a;
        out[i] = a + (b - a) * frac;
      }
      return out;
    }

    /** Float32 → Int16 小端 Uint8Array（16kHz 单声道） */
    function toInt16Le(samples) {
      const buf = new ArrayBuffer(samples.length * 2);
      const view = new DataView(buf);
      for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
      return new Uint8Array(buf);
    }

    function concatU8(a, b) {
      const out = new Uint8Array(a.length + b.length);
      out.set(a, 0);
      out.set(b, a.length);
      return out;
    }

    // ---------------- 豆包流式录音会话 ----------------
    // 流程：点击 → 连接中继（WS + 豆包）→ ready 后开始采集 → 边录边流式上行
    class DoubaoSession {
      constructor(handlers) {
        this.handlers = handlers; // { onPartial(text), onDone(text), onError(message, hint) }
        this.ws = null;
        this.audioContext = null;
        this.stream = null;
        this.source = null;
        this.processor = null;
        this.sampleRate = 16000;
        this.pendingChunk = null; // 不足 200ms 的残余音频
        this.volAccum = 0; // 音量峰值累计
        this.lastVolReport = 0; // 上次音量上报时间
        this.running = false;
        this.ended = false; // 已发 end，等待定稿
        this.doneSent = false; // done 是否已投递（防重复收尾）
        this.autoStopTimer = null;
        this.maxReached = false;
      }

      wsUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}${SESSION_PATH}`;
      }

      /** 连接中继并等待 ready（豆包建连完成），然后开始采集 */
      start() {
        return new Promise((resolve, reject) => {
          if (!navigator.mediaDevices?.getUserMedia) {
            reject(new Error('当前环境不支持 getUserMedia（需要 https 或 localhost）'));
            return;
          }
          const ws = new WebSocket(this.wsUrl());
          this.ws = ws;
          let settled = false;

          ws.onopen = () => { /* 等 ready */ };
          ws.onmessage = (event) => {
            if (typeof event.data !== 'string') return;
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }
            if (msg.type === 'ready') {
              if (settled) return;
              settled = true;
              void this.beginCapture().then(resolve, (err) => {
                this.handlers.onError(err instanceof Error ? err.message : String(err), '检查麦克风权限');
              });
            } else if (msg.type === 'transcript') {
              this.handlers.onPartial(msg.text, msg.isFinal === true);
            } else if (msg.type === 'done') {
              if (!this.doneSent) {
                this.doneSent = true;
                this.handlers.onDone(String(msg.text ?? '').trim());
              }
              this.finishWs();
            } else if (msg.type === 'error') {
              if (!settled) {
                settled = true;
                reject(new Error(msg.message));
              } else {
                this.handlers.onError(msg.message, '检查设置里的 App ID / Access Token');
              }
              this.finishWs();
            }
          };
          ws.onerror = () => {
            if (!settled) {
              settled = true;
              reject(new Error('无法连接语音中继服务（dsh 是否在运行？）'));
            } else {
              this.handlers.onError('语音连接中断', '');
            }
            this.finishWs();
          };
          ws.onclose = () => {
            if (!settled) {
              settled = true;
              reject(new Error('语音中继连接已关闭'));
            } else if (!this.doneSent) {
              // done 未到连接先关（异常/超时）：收尾，确保 UI 回到空闲
              this.doneSent = true;
              this.handlers.onDone('');
            }
          };
        });
      }

      async beginCapture() {
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
        const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
        this.audioContext = new AudioCtx();
        if (this.audioContext.state === 'suspended') {
          try { await this.audioContext.resume(); } catch { /* noop */ }
        }
        this.sampleRate = this.audioContext.sampleRate;
        this.source = this.audioContext.createMediaStreamSource(this.stream);
        this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
        this.processor.channelCount = 1;
        this.processor.channelCountMode = 'explicit';
        this.processor.onaudioprocess = (event) => {
          if (!this.running || this.ended) return;
          const data = event.inputBuffer.getChannelData(0);
          // 音量峰值（约 80ms 上报一次，驱动动态指示条）
          let peak = 0;
          for (let i = 0; i < data.length; i++) {
            const a = Math.abs(data[i]);
            if (a > peak) peak = a;
          }
          if (peak > this.volAccum) this.volAccum = peak;
          const now = performance.now();
          if (now - this.lastVolReport > 80) {
            if (typeof this.handlers.onVolume === 'function') {
              this.handlers.onVolume(this.volAccum);
            }
            this.volAccum = 0;
            this.lastVolReport = now;
          }
          const pcm16k = resampleTo16k(data, this.sampleRate);
          const pcm = toInt16Le(pcm16k);
          // 每 200ms（6400B）发一块
          let pending = this.pendingChunk ? concatU8(this.pendingChunk, pcm) : pcm;
          this.pendingChunk = null;
          while (pending.length >= 6400) {
            const chunk = pending.slice(0, 6400);
            pending = pending.slice(6400);
            if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(chunk);
          }
          this.pendingChunk = pending;
        };
        this.source.connect(this.processor);
        this.processor.connect(this.audioContext.destination); // 输出静音，仅驱动处理
        this.running = true;
        this.autoStopTimer = setTimeout(() => {
          this.maxReached = true;
          void this.stop();
        }, settings.maxDurationSec * 1000);
      }

      /** 用户停止：残余音频 + end，等待 done 定稿 */
      stop() {
        if (this.ended) return;
        this.ended = true;
        if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
        this.stopCapture();
        if (this.pendingChunk && this.pendingChunk.length > 0
          && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(this.pendingChunk);
        }
        this.pendingChunk = null;
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'end' }));
        }
        // 兜底：10 秒内没收到 done 也要收尾（确保 UI 回到空闲，不会卡死）
        setTimeout(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
            this.finishWs();
          }
          if (!this.doneSent) {
            this.doneSent = true;
            this.handlers.onDone('');
          }
        }, 10000);
      }

      /** 取消：回滚，立即断开 */
      cancel() {
        this.ended = true;
        if (this.autoStopTimer) clearTimeout(this.autoStopTimer);
        this.stopCapture();
        if (this.ws) {
          try { this.ws.send(JSON.stringify({ type: 'cancel' })); } catch { /* noop */ }
          try { this.ws.close(); } catch { /* noop */ }
        }
        this.finishWs();
      }

      stopCapture() {
        this.running = false;
        try {
          if (this.processor) this.processor.disconnect();
          if (this.source) this.source.disconnect();
        } catch { /* noop */ }
        if (this.stream) {
          this.stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
        }
        if (this.audioContext && this.audioContext.state !== 'closed') {
          this.audioContext.close().catch(() => undefined);
          this.audioContext = null;
        }
      }

      finishWs() {
        const ws = this.ws;
        this.ws = null;
        if (ws) {
          try { ws.onmessage = null; ws.onerror = null; ws.onclose = null; ws.close(); } catch { /* noop */ }
        }
      }
    }

    // ---------------- 麦克风按钮 ----------------
    function MicGlyph() {
      return h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M19 10v2a7 7 0 0 1-14 0v-2', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('line', { x1: 12, y1: 19, x2: 12, y2: 23, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }),
        h('line', { x1: 8, y1: 23, x2: 16, y2: 23, stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' }));
    }

    /** 音量动态指示：5 根随音量跳动的竖条 */
    function VolumeMeter(props) {
      const v = Math.max(0, Math.min(1, props.volume));
      return h('span', { className: 'dsdv-bars', 'aria-hidden': true },
        [0, 1, 2, 3, 4].map((i) => {
          const base = 3.5 + Math.abs(i - 2) * 2.2; // 中间高、两侧低
          const height = Math.round(Math.min(16, base + v * 12.5));
          return h('span', { key: i, className: 'dsdv-bar', style: { height: `${height}px` } });
        }));
    }

    function MicButton(props) {
      const [mode, setMode] = React.useState('idle'); // idle | connecting | recording | finalizing
      const [err, setErr] = React.useState('');
      const [volume, setVolume] = React.useState(0);
      const modeRef = React.useRef('idle');
      modeRef.current = mode;
      const sessionRef = React.useRef(null);
      const locked = props.input.phase !== 'plain';
      const liveRef = React.useRef(props.live);
      liveRef.current = props.live;

      const teardown = React.useCallback(() => {
        const session = sessionRef.current;
        sessionRef.current = null;
        if (session !== null && typeof session.cancel === 'function') session.cancel();
      }, []);

      // 累计识别文本。实测 bigmodel_async：整个录音是单个 utterance，
      // 中间结果是「全量累计文本」且可能中途修订（如"第2"→"第二"），最终定稿是修正后的权威全文。
      // 规则：定稿 → 整体替换；中间结果 → 与当前文本公共前缀占比 ≥30%（同一段文本的延伸/修订，
      //       含标点差异）→ 整体替换；否则（全新分句）→ 追加。
      const accumRef = React.useRef('');
      const lastSegRef = React.useRef(''); // 最近追加/替换的一段（增量分句追踪）
      const mergeText = React.useCallback((text, isFinal) => {
        const t = typeof text === 'string' ? text.trim() : '';
        if (!t) return;
        const prev = accumRef.current;
        const lastSeg = lastSegRef.current;
        if (!prev) {
          accumRef.current = t;
          lastSegRef.current = t;
          return;
        }
        // 最长公共前缀占比
        const n = Math.min(prev.length, t.length);
        let i = 0;
        while (i < n && prev[i] === t[i]) i++;
        const overlap = i / Math.max(1, n);
        // 替换最后一段（新文本是上一段的延伸/修订）
        const replaceLastSeg = () => {
          accumRef.current = prev.slice(0, prev.length - lastSeg.length) + t;
          lastSegRef.current = t;
        };
        // 全新分句追加
        const appendNew = () => {
          const needSep = !/\s$/.test(prev) && !/^\s/.test(t);
          accumRef.current = prev + (needSep ? ' ' : '') + t;
          lastSegRef.current = t;
        };
        const isSegExtension = lastSeg.length > 0
          && (t.startsWith(lastSeg) || lastSeg.startsWith(t));
        if (isFinal) {
          // 定稿：全量/修正（等长或更长，或高重叠）→ 整体替换；
          // 明显更短的增量分句 → 替换或追加最后一段
          if (t.length < prev.length && overlap < 0.3) {
            if (isSegExtension) replaceLastSeg();
            else appendNew();
          } else {
            accumRef.current = t;
            lastSegRef.current = t;
          }
          return;
        }
        if (overlap >= 0.3) {
          accumRef.current = t; // 同一段文本的延伸或修订 → 整体替换
          lastSegRef.current = t;
          return;
        }
        if (isSegExtension) replaceLastSeg();
        else appendNew();
      }, []);

      const handlePartial = React.useCallback((text, isFinal) => {
        mergeText(text, isFinal === true);
        if (typeof liveRef.current.set === 'function') {
          liveRef.current.set(accumRef.current);
        }
      }, [mergeText]);

      const handleVolume = React.useCallback((v) => {
        setVolume(v);
      }, []);

      const handleDone = React.useCallback((text) => {
        sessionRef.current = null;
        setMode('idle');
        setErr('');
        setVolume(0);
        const live = liveRef.current;
        if (typeof text === 'string' && text.trim()) {
          mergeText(text, true); // 定稿：整体替换为权威全文
          if (typeof live.set === 'function') live.set(accumRef.current);
        }
        if (typeof live.finish === 'function') live.finish();
        // 未识别到内容时静默结束（不弹窗）
      }, [mergeText]);

      const handleError = React.useCallback((message, hint) => {
        sessionRef.current = null;
        setMode('idle');
        setErr(message);
        setVolume(0);
        if (typeof liveRef.current.cancel === 'function') liveRef.current.cancel(); // 回滚临时文本
        showToast(message + (hint ? `｜${hint}` : ''), 'error');
      }, []);

      const startRecording = React.useCallback(async () => {
        if (sessionRef.current !== null) return;
        if (modeRef.current === 'finalizing') return; // 收尾期间锁死，必须等完成
        setErr('');
        // 凭据状态在插件加载时缓存（点击不等待网络往返）
        if (!serverConfigured) {
          showToast('尚未配置豆包凭据，请到 设置 → 语音输入（豆包）填写 App ID / Access Token', 'error');
          return;
        }
        // 记录写入基线（录音前的草稿）
        if (typeof liveRef.current.begin === 'function' && !liveRef.current.begin()) {
          showToast('当前输入框不可用，请稍后再试', 'error');
          return;
        }
        accumRef.current = '';
        setMode('connecting'); // 正在准备中
        try {
          const session = new DoubaoSession({
            // 会话代次守卫：回调只属于当前会话，防止取消/替换后旧会话迟到事件污染 UI
            onPartial: (text, isFinal) => {
              if (sessionRef.current === session) handlePartial(text, isFinal);
            },
            onDone: (text) => {
              if (sessionRef.current === session) handleDone(text);
            },
            onError: (message, hint) => {
              if (sessionRef.current === session) handleError(message, hint);
            },
            onVolume: handleVolume,
          });
          sessionRef.current = session;
          await session.start();
          if (sessionRef.current !== session) return; // 等待期间被取消/替换 → 放弃
          setMode('recording'); // 正在听写
        } catch (cause) {
          if (sessionRef.current !== session) return;
          sessionRef.current = null;
          if (typeof liveRef.current.finish === 'function') liveRef.current.finish();
          const message = cause instanceof Error ? cause.message : String(cause);
          setErr(message);
          setMode('idle');
          showToast(message, 'error');
        }
      }, [handlePartial, handleDone, handleError, handleVolume]);

      const stopRecording = React.useCallback(() => {
        // 强制锁定：收尾期间不接受任何点击（必须等收尾完成回到空闲）
        if (modeRef.current === 'finalizing') return;
        const session = sessionRef.current;
        if (session === null) return;
        setMode('finalizing'); // 收尾中
        setVolume(0);
        session.stop();
      }, []);

      /** connecting 中点击/热键再按 = 取消 */
      const cancelConnecting = React.useCallback(() => {
        if (modeRef.current === 'finalizing') return; // 收尾期间锁死
        const session = sessionRef.current;
        sessionRef.current = null;
        if (session !== null && typeof session.cancel === 'function') session.cancel();
        setMode('idle');
        setVolume(0);
        if (typeof liveRef.current.finish === 'function') liveRef.current.finish();
      }, []);

      React.useEffect(() => {
        return () => {
          teardown();
          if (typeof liveRef.current.cancel === 'function') liveRef.current.cancel();
        };
      }, [teardown]);

      // 注册为热键目标
      React.useEffect(() => {
        const handle = {
          start: () => { void startRecording(); },
          stop: () => { stopRecording(); },
          cancel: () => { cancelConnecting(); },
          toggle: () => {
            if (modeRef.current === 'idle') void startRecording();
            else if (modeRef.current === 'connecting') cancelConnecting();
            else if (modeRef.current === 'recording') stopRecording();
          },
          stopAll: () => {
            if (modeRef.current === 'recording') stopRecording();
            else if (modeRef.current === 'connecting') cancelConnecting();
          },
          isIdle: () => modeRef.current === 'idle',
          isRecording: () => modeRef.current === 'recording',
        };
        activeMic = handle;
        return () => { if (activeMic === handle) activeMic = null; };
      }, [startRecording, stopRecording, cancelConnecting]);

      const STATUS_LABEL = {
        connecting: '正在准备中',
        recording: '正在听写',
        finalizing: '收尾中',
      };
      const label = mode === 'idle' ? '' : STATUS_LABEL[mode];

      const title = mode === 'connecting'
        ? '正在准备中…'
        : mode === 'recording'
          ? '正在听写，点击停止'
          : mode === 'finalizing'
            ? '收尾中…'
            : err || '语音输入（豆包流式，Alt+V 快捷键）';

      const disabled = mode === 'idle' ? locked : (mode === 'finalizing');

      let indicator;
      if (mode === 'idle') {
        indicator = h('button', {
          type: 'button',
          className: 'dsdv-button',
          title,
          'aria-label': title,
          disabled,
          onMouseDown: () => {
            // 点击瞬间捕获光标目标（焦点转移前）
            if (typeof liveRef.current.setCursorTarget === 'function') {
              liveRef.current.setCursorTarget(document.activeElement);
            }
          },
          onClick: () => { void startRecording(); },
        }, h(MicGlyph));
      } else if (mode === 'recording') {
        indicator = h('button', {
          type: 'button',
          className: 'dsdv-meter',
          title,
          'aria-label': title,
          onClick: () => { stopRecording(); },
        }, h(VolumeMeter, { volume }));
      } else {
        // connecting / finalizing：转圈
        indicator = h('button', {
          type: 'button',
          className: 'dsdv-meter',
          title,
          'aria-label': title,
          disabled,
          onClick: () => {
            if (mode === 'connecting') cancelConnecting();
            // finalizing：disabled + 显式拦截，强制等收尾完成
          },
        }, h('span', { className: 'dsdv-spinner', 'aria-hidden': true }));
      }

      return h('div', { className: 'dsdv-micwrap' }, [
        indicator,
        label ? h('span', { className: 'dsdv-miclabel' }, label) : null,
      ]);
    }

    // ---------------- 热键 ----------------
    let hotkeySpec = parseHotkey(DEFAULTS.hotkey);
    let activeMic = null;

    function parseHotkey(spec) {
      const mods = { alt: false, ctrl: false, meta: false, shift: false };
      let key = null;
      for (const part of String(spec || '').toLowerCase().split('+')) {
        const p = part.trim();
        if (p === 'alt' || p === 'option') mods.alt = true;
        else if (p === 'ctrl' || p === 'control') mods.ctrl = true;
        else if (p === 'cmd' || p === 'meta' || p === 'command') mods.meta = true;
        else if (p === 'shift') mods.shift = true;
        else if (p !== '') key = p;
      }
      return { mods, key };
    }

    function hotkeyMatches(event) {
      const m = hotkeySpec.mods;
      if (event.altKey !== m.alt || event.ctrlKey !== m.ctrl
        || event.metaKey !== m.meta || event.shiftKey !== m.shift) return false;
      if (hotkeySpec.key === null) return true;
      const k = (event.key ?? '').toLowerCase();
      const c = (event.code ?? '').toLowerCase();
      return k === hotkeySpec.key || c === hotkeySpec.key;
    }

    function onHotkeyDown(event) {
      if (event.repeat) return;
      if (!hotkeyMatches(event)) return;
      if (activeMic === null) return;
      event.preventDefault();
      activeMic.toggle();
    }

    function installHotkeyListeners() {
      window.addEventListener('keydown', onHotkeyDown, true);
      const onBlur = () => {
        if (typeof activeMic?.stopAll === 'function') activeMic.stopAll();
        else if (activeMic?.isRecording()) activeMic.stop();
      };
      window.addEventListener('blur', onBlur);
      return () => {
        window.removeEventListener('keydown', onHotkeyDown, true);
        window.removeEventListener('blur', onBlur);
      };
    }

    // ---------------- 设置页 ----------------
    function SettingsPage() {
      const [form, setForm] = React.useState({ appId: '', accessToken: '', resourceId: 'volc.seedasr.sauc.duration', language: 'zh-CN', customHotwords: '', hotkey: settings.hotkey, maxDurationSec: settings.maxDurationSec, outputMode: settings.outputMode || 'cursor' });
      const [status, setStatus] = React.useState(null); // null | ok | err
      const [cfgInfo, setCfgInfo] = React.useState(null);

      React.useEffect(() => {
        void (async () => {
          try {
            const res = await fetch(`${API}/config`);
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.ok) {
              setCfgInfo(data);
              setForm((f) => ({
                ...f,
                resourceId: data.resourceId || f.resourceId,
                language: data.language || f.language || 'zh-CN',
                customHotwords: data.customHotwords || f.customHotwords,
              }));
            }
          } catch { /* noop */ }
        })();
      }, []);

      const save = async () => {
        // 凭据字段留空 = 保持已保存的值（允许只改其他配置）
        const body = {
          resourceId: form.resourceId,
          language: form.language,
          customHotwords: form.customHotwords,
        };
        if (form.appId.trim()) body.appId = form.appId.trim();
        if (form.accessToken.trim()) body.accessToken = form.accessToken.trim();
        try {
          const res = await fetch(`${API}/config`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data?.ok) {
            saveStoredSettings({ hotkey: form.hotkey, maxDurationSec: form.maxDurationSec, lang: form.language, outputMode: form.outputMode });
            hotkeySpec = parseHotkey(form.hotkey);
            serverConfigured = true;
            setCfgInfo((c) => ({ ...c, configured: true, tokenSet: true }));
            setForm((f) => ({ ...f, appId: '', accessToken: '' })); // 清空输入，显示"已保存"占位
            setStatus({ kind: 'ok', text: '已保存' });
          } else {
            setStatus({ kind: 'err', text: data?.error?.message ?? `保存失败（HTTP ${res.status}）` });
          }
        } catch (cause) {
          setStatus({ kind: 'err', text: cause instanceof Error ? cause.message : String(cause) });
        }
      };

      const test = async () => {
        setStatus(null);
        try {
          const res = await fetch(`${API}/test`, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (res.ok && data?.ok) setStatus({ kind: 'ok', text: data.message || '连接成功' });
          else setStatus({ kind: 'err', text: data?.error?.message ?? `测试失败（HTTP ${res.status}）` });
        } catch (cause) {
          setStatus({ kind: 'err', text: cause instanceof Error ? cause.message : String(cause) });
        }
      };

      const row = (titleText, control, hintText) => h('div', { className: 'dsdv-row' },
        h('div', { className: 'dsdv-rowText' },
          h('div', { className: 'dsdv-rowTitle' }, titleText),
          hintText ? h('div', { className: 'dsdv-hint' }, hintText) : null),
        control);

      const input = (value, onChange, placeholder, type = 'text', width = 240) => h('input', {
        type, className: 'dsdv-input', value,
        placeholder, style: { width: `${width}px` },
        onChange: (e) => onChange(e.target.value),
      });

      // 脱敏：不显示 App ID / 凭据文件路径等细节
      const saved = cfgInfo?.configured;
      const statusNode = status === null
        ? h('div', { className: 'dsdv-status' },
          saved
            ? `凭据已保存${cfgInfo?.envMode ? '（环境变量）' : ''}，留空保持不变`
            : '尚未配置凭据')
        : h('div', { className: status.kind === 'ok' ? 'dsdv-ok' : 'dsdv-err' }, status.text);

      return h('div', { className: 'dsdv-settings' },
        row('App ID', input(form.appId, (v) => setForm({ ...form, appId: v }),
          saved ? (cfgInfo?.appIdMasked || '已保存') : '火山引擎 App ID', 'text', 300),
          '火山引擎控制台 → 智能语音 → 流式大模型语音识别；留空保持不变'),
        row('Access Token', input(form.accessToken, (v) => setForm({ ...form, accessToken: v }),
          saved ? '已保存，留空保持不变' : '访问令牌', 'password', 300),
          '也可用环境变量 ARK_APP_ID / ARK_ACCESS_TOKEN 代替'),
        row('Resource ID', input(form.resourceId, (v) => setForm({ ...form, resourceId: v }), 'volc.seedasr.sauc.duration', 'text', 300),
          '默认 volc.seedasr.sauc.duration'),
        row('识别语言', h('select', {
          className: 'dsdv-pill', value: form.language,
          onChange: (e) => setForm({ ...form, language: e.target.value }),
        }, LANGS.map((l) => h('option', { key: l.value, value: l.value }, l.label))), '留空自动'),
        row('热词', input(form.customHotwords, (v) => setForm({ ...form, customHotwords: v }), '如：芯片,Buck电路', 'text', 300),
          '逗号/分号分隔，最多 100 个'),
        row('快捷键', input(form.hotkey, (v) => setForm({ ...form, hotkey: v }), 'alt+v', 'text', 180),
          '格式 alt+v / ctrl+shift+space / f2'),
        row('输出方式', h('select', {
          className: 'dsdv-pill', value: form.outputMode,
          onChange: (e) => setForm({ ...form, outputMode: e.target.value }),
        }, OUTPUT_MODES.map((m) => h('option', { key: m.value, value: m.value }, m.label))),
          '跟随光标：写入焦点所在的可编辑元素（输入框走官方 API）；失败自动复制到剪贴板'),
        row('最长录音时长（秒）', input(String(form.maxDurationSec), (v) => setForm({ ...form, maxDurationSec: Number.parseInt(v, 10) || 300 }), '300', 'number', 140),
          '到时自动停止并定稿'),
        statusNode,
        h('div', { className: 'dsdv-actions' },
          h('button', { type: 'button', className: 'dsdv-btn', onClick: () => void test() }, '测试连接'),
          h('button', { type: 'button', className: 'dsdv-btn dsdv-btn-primary', onClick: () => void save() }, '保存'),
        ),
      );
    }

    const PLUGIN_VERSION = '0.2.0';

    // ---------------- 插件入口 ----------------
    function apply(ctx) {
      const sessions = ctx.get('sessions');
      const conversation = ctx.get('conversation');
      console.log(`[dsh-doubao-voice] v${PLUGIN_VERSION} loaded`);

      void (async () => {
        loadStoredSettings();
        hotkeySpec = parseHotkey(settings.hotkey);
        try {
          const res = await fetch(`${API}/config`);
          const data = await res.json().catch(() => ({}));
          serverConfigured = Boolean(res.ok && data?.ok && data.configured);
        } catch {
          serverConfigured = false;
        }
      })();

      const uninstallHotkey = installHotkeyListeners();

      // 实时写入器：记录录音起始基线，set(text) 每次写「基线 + 最新累计文本」。
      // 不依赖读取输入框状态回读（setDraft 异步生效，回读会拿到旧值导致重复追加）。
      // 定稿不并入基线——豆包 enable_nonstream 会回发整段累计文本，并入基线会造成整句重复堆叠。
      // 输出目标（Proma 逻辑）：
      //   cursor（默认）：焦点在可编辑元素 → 写入该元素（composer 走官方 API，其他元素走 DOM）；
      //                    无焦点/不可写 → 写入 composer；写入失败 → 兜底剪贴板
      //   composer：始终写入 composer；clipboard：始终写入剪贴板
      const isEditableEl = (el) => {
        if (!el || !(el instanceof HTMLElement)) return false;
        if (el.isContentEditable) return !el.getAttribute('contenteditable') || el.getAttribute('contenteditable') !== 'false';
        if (el.tagName === 'TEXTAREA') return !el.readOnly && !el.disabled;
        if (el.tagName === 'INPUT') {
          const t = (el.type || 'text').toLowerCase();
          if (['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden', 'range', 'color'].includes(t)) return false;
          return !el.readOnly && !el.disabled;
        }
        return false;
      };
      const isComposerEl = (el) => !!(el && el.matches && el.matches('textarea[data-phase]'));

      const makeLiveWriter = (sessionId) => {
        let active = false;
        let target = null; // { kind:'composer', input, sel } | { kind:'dom', el, textContent, baseline, sel } | { kind:'clipboard' }
        let base = ''; // 目标在录音开始时的内容（含用户已输入）
        let lastWritten = null;
        let clipboardFellBack = false; // 本次会话是否已兜底剪贴板
        let cursorTarget = null; // 点击麦克风瞬间（mousedown，焦点转移前）捕获的光标目标

        const composerInput = () => {
          const actx = sessions.scope(sessionId);
          if (actx === undefined) return null;
          return conversation.input.for(actx);
        };

        const toClipboard = (text) => {
          if (clipboardFellBack) return;
          clipboardFellBack = true;
          try {
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
              navigator.clipboard.writeText(text).catch(() => undefined);
            } else {
              const ta = document.createElement('textarea');
              ta.value = text;
              ta.style.position = 'fixed';
              ta.style.opacity = '0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              ta.remove();
            }
            showToast('自动写入失败，识别结果已复制到剪贴板', 'info');
          } catch { /* noop */ }
        };

        /** 捕获元素的光标位置/选区（字符偏移） */
        const captureSel = (el, textContent) => {
          try {
            if (textContent) {
              const sel = window.getSelection();
              if (sel && sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                if (el.contains(range.startContainer)) {
                  const pre = range.cloneRange();
                  pre.selectNodeContents(el);
                  pre.setEnd(range.startContainer, range.startOffset);
                  const start = pre.toString().length;
                  return { start, end: start + range.toString().length };
                }
              }
              const len = (el.textContent || '').length;
              return { start: len, end: len };
            }
            const len = (el.value || '').length;
            return {
              start: typeof el.selectionStart === 'number' ? el.selectionStart : len,
              end: typeof el.selectionEnd === 'number' ? el.selectionEnd : len,
            };
          } catch {
            return { start: 0, end: 0 };
          }
        };

        /** 构建插入结果：光标在末尾 → 追加（保留分隔逻辑）；否则 → 光标处插入/替换选区 */
        const buildNext = (baseText, sel, text) => {
          const text2 = typeof text === 'string' ? text : '';
          if (sel.start >= baseText.length) {
            const needSep = baseText.length > 0 && text2.length > 0
              && !/\s$/.test(baseText) && !/^\s/.test(text2);
            return baseText + (needSep ? ' ' : '') + text2;
          }
          return baseText.slice(0, sel.start) + text2 + baseText.slice(sel.end);
        };

        const writeDom = (el, textContent, value, caret) => {
          if (textContent) el.textContent = value;
          else el.value = value;
          try {
            if (textContent) {
              const range = document.createRange();
              range.selectNodeContents(el);
              range.collapse(false);
              const sel = window.getSelection();
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              el.focus();
              el.setSelectionRange(caret, caret);
            }
          } catch { /* noop */ }
        };

        const writer = {
          begin: () => {
            const input = composerInput();
            if (input === null) return false;
            const snap = input.state.getSnapshot();
            if (snap.phase !== 'plain') return false;
            const mode = settings.outputMode || 'cursor';
            target = null;
            clipboardFellBack = false;
            lastWritten = null;
            if (mode === 'clipboard') {
              target = { kind: 'clipboard' };
              base = '';
            } else if (mode === 'composer') {
              target = { kind: 'composer', input, sel: { start: snap.draft.length, end: snap.draft.length } };
              base = snap.draft;
            } else {
              // cursor：优先写入「唤起瞬间」焦点所在的可编辑元素
              // （mousedown 捕获的 cursorTarget，避免点击按钮导致焦点转移）；
              // 热键唤起时 keydown 不转移焦点，activeElement 即当前焦点
              const el = cursorTarget !== null && cursorTarget.isConnected
                ? cursorTarget
                : document.activeElement;
              if (isEditableEl(el)) {
                if (isComposerEl(el)) {
                  // 焦点在 composer：走官方 API，光标位置从 textarea 读取
                  target = { kind: 'composer', input, sel: captureSel(el, false) };
                  base = snap.draft;
                } else {
                  const textContent = el.isContentEditable === true;
                  const baseline = textContent ? el.textContent : el.value;
                  target = { kind: 'dom', el, textContent, baseline, sel: captureSel(el, textContent) };
                  base = baseline;
                }
              } else {
                target = { kind: 'composer', input, sel: { start: snap.draft.length, end: snap.draft.length } };
                base = snap.draft;
              }
            }
            active = true;
            return true;
          },
          set: (text) => {
            if (!active || target === null) return;
            const next = buildNext(base, target.sel, text);
            if (target.kind === 'composer') {
              const input = target.input ?? composerInput();
              if (!input) return;
              const snap = input.state.getSnapshot();
              if (snap.phase !== 'plain') return;
              // 发送/清空/替换检测
              if (lastWritten !== null) {
                if (snap.draft === '') return;
                if (snap.draft !== lastWritten && !snap.draft.startsWith(base)) return;
              }
              input.setDraft(next);
              lastWritten = next;
              return;
            }
            if (target.kind === 'dom') {
              const el = target.el;
              if (!el || !el.isConnected) {
                toClipboard(next); // 元素已被移除 → 兜底剪贴板
                return;
              }
              // DOM 写入同步生效，无回读延迟：严格比对，用户改动/清空即停止
              const cur = target.textContent ? el.textContent : el.value;
              if (lastWritten !== null && cur !== lastWritten) return;
              try {
                writeDom(el, target.textContent, next, target.sel.start + (typeof text === 'string' ? text.length : 0));
                lastWritten = next;
              } catch {
                toClipboard(next);
              }
              return;
            }
            // clipboard
            navigator.clipboard?.writeText(next).catch(() => undefined);
            lastWritten = next;
          },
          finish: () => {
            active = false;
            target = null;
            base = '';
            lastWritten = null;
            cursorTarget = null;
          },
          isActive: () => active,
          /** 点击麦克风瞬间（mousedown）捕获光标目标，供 begin 使用 */
          setCursorTarget: (el) => {
            cursorTarget = el instanceof HTMLElement ? el : null;
          },
          cancel: () => {
            if (!active || target === null) return;
            if (target.kind === 'composer') {
              const input = target.input ?? composerInput();
              if (input) input.setDraft(base); // 回滚到录音前
            } else if (target.kind === 'dom') {
              try {
                const el = target.el;
                if (el && el.isConnected) {
                  writeDom(el, target.textContent, target.baseline, target.sel.start);
                }
              } catch { /* noop */ }
            }
            writer.finish();
          },
        };
        return writer;
      };

      // 输入框左侧麦克风按钮
      ctx.inject(['slots', 'conversation', 'sessions'], (scope) => {
        scope.slots.inject('conversation.input.left', () => scope.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-doubao-voice-button',
          order: -100,
          inject: (sessionId) => ({ live: makeLiveWriter(sessionId) }),
        }, MicButton));
      });

      // 设置页
      ctx.inject(['slots'], (scope) => {
        scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section',
          id: 'doubao-voice-input',
          order: 100,
          label: () => '语音输入（豆包）',
        }, SettingsPage));
      });

      ctx.effect(uninstallHotkey, 'dsh-doubao-voice: hotkey listeners');
    }

    return { apply, inject: ['slots', 'conversation', 'sessions'] };
  },
});
