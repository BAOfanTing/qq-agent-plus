// 插件宿主：**每个插件一个子进程**，通过 stdio 上的 NDJSON 协议对话。
//
// 为什么不是一个进程装所有插件：权限是按进程给的。一个进程里跑两个插件，等于让它们共享
// 彼此的权限与崩溃面；分开才能做到"这个插件读不到 config.json""那个插件崩了不影响别人"。
//
// 这个类负责的四件事：起进程（带隔离参数）、按 manifest 鉴权能力调用、看住它（心跳/超时/崩溃
// 重启/连续失败停用）、以及停机时收干净。它**不**决定插件的工具能不能给模型用 —— 那是
// registry.js 的门控（默认拒），两边分开放，免得"加载成功"被当成"被授权"。
import { spawn as spawnChild } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import {
  CAP_REQUIREMENT, HOST_METHODS, encodeMessage, createLineDecoder, isResponse, previewLine, rpcError, rpcResult
} from './protocol.js';
import { pluginNodeArgs, probeIsolation } from './isolation.js';import { createCapabilities } from './capabilities.js';

// 默认时间参数：测试会覆盖成小值，生产用这一套。
export const HOST_DEFAULTS = Object.freeze({
  initTimeoutMs: 5000,
  callTimeoutMs: 20000,
  heartbeatMs: 15000,       // 心跳间隔
  heartbeatMissLimit: 2,    // 连续两次心跳无应答就判死
  shutdownGraceMs: 2000,
  restartBackoffMs: [1000, 5000, 15000],
  maxRestarts: 3,           // 连续崩溃超过这个数就停用（不再空转重启）
  maxRawLinesPerMin: 60     // 插件直接往 stdout 打的行：保留一部分就够排查了，别让它刷日志
});

/** 剥环境变量：子进程默认继承 env，`process.env.QQ_AGENT_*` 读得到 —— 那是凭据与路径（第 0 步实测）。 */
function childEnv(base = process.env) {
  const keep = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'windir', 'ComSpec', 'TMPDIR', 'TEMP', 'TMP', 'TZ', 'LANG', 'LC_ALL'];
  const env = {};
  for (const key of keep) if (base[key] !== undefined) env[key] = base[key];
  return env;
}

const delay = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });

export class PluginHost {
  /**
   * @param manifest 已校验过的 manifest（src/plugins/manifest.js）
   * @param dataDir  应用数据目录
   * @param log      宿主日志（Error 实例才会进异常面板，与各 manager 同约定）
   * @param deps     注入点（测试用）：spawn / spawnSyncImpl / checkEntry / now
   */
  constructor({
    manifest, dataDir, log = () => {}, getSettings = () => ({}),
    spawn = spawnChild, spawnSyncImpl = spawnSync, nodePath = process.execPath,
    timeouts = {}, capabilities = null, now = () => Date.now(), requireIsolation = true
  } = {}) {
    this.manifest = manifest;
    this.id = manifest.id;
    this.dataDir = dataDir;
    this.log = log;
    this.getSettings = getSettings;
    this.now = now;
    this.spawnImpl = spawn;
    this.spawnSyncImpl = spawnSyncImpl;
    this.nodePath = nodePath;
    this.timeouts = { ...HOST_DEFAULTS, ...timeouts };
    // 隔离不可用时是否拒绝加载（默认拒绝）。置 false 是"我明确接受没有隔离"——
    // 那种情况下插件进程读得到 config.json，所以状态里会带 unconfined:true，控制台如实显示。
    this.requireIsolation = requireIsolation !== false;
    this.unconfined = false;
    this.caps = capabilities ?? createCapabilities({
      pluginId: this.id, dataDir, getSettings, log, now
    });

    this.state = 'idle';           // idle | starting | running | stopping | stopped | failed
    this.starting = false;         // 重入保护（与 state 分开：崩溃重启时 state 也是 starting）
    this.lastError = '';
    this.startedAt = 0;
    this.restarts = 0;
    this.child = null;
    this.seq = 0;
    this.pending = new Map();      // id -> {resolve, reject, timer, method}
    this.heartbeatTimer = null;
    this.heartbeatMisses = 0;
    this.stopping = false;
    this.rawLines = [];
    this.stats = { calls: 0, timeouts: 0, denied: 0, protocolErrors: 0, crashes: 0 };
    this.decoder = createLineDecoder({
      onMessage: (message) => this.#onMessage(message),
      onParseError: (text) => {
        this.stats.protocolErrors += 1;
        this.#raw(`[插件输出不是协议消息] ${previewLine(text)}`);
      },
      onViolation: (kind) => {
        this.stats.protocolErrors += 1;
        this.log(`[plugin:${this.id}] 协议违规（${kind}），已忽略该段数据`);
      }
    });
  }

  status() {
    return {
      id: this.id,
      name: this.manifest.name,
      version: this.manifest.version,
      capabilities: [...this.manifest.capabilities],
      tools: this.manifest.tools.map((t) => t.name),
      schedule: this.manifest.schedule.map((s) => s.name),
      state: this.state,
      running: this.state === 'running',
      unconfined: this.unconfined,   // true = 本机没隔离且配置允许降级（控制台要显示出来）
      restarts: this.restarts,
      startedAt: this.startedAt,
      lastError: this.lastError,
      stats: { ...this.stats },
      storageFile: this.caps.storageFile
    };
  }

  /** 起进程并完成 init 握手。返回 true=可用；false=没起来（原因写进 lastError）。 */
  async start() {
    // 幂等：已经在跑就直接算成功。重入保护用独立的 starting 标记 —— 崩溃重启那条路上
    // state 也会是 'starting'，用它做判断会把重启挡在门外（自锁，重启永远起不来）。
    if (this.#alive() && this.state === 'running') return true;
    if (this.starting) return false;
    this.starting = true;
    try {
      return await this.#startOnce();
    } finally {
      this.starting = false;
    }
  }

  async #startOnce() {
    this.state = 'starting';
    this.stopping = false;
    this.lastError = '';

    const entry = this.manifest.entry;
    // 先语法体检：插件写错一个括号，直接 spawn 只会得到"进程秒退"，报错里看不出原因
    const check = this.spawnSyncImpl(this.nodePath, ['--check', entry], { encoding: 'utf8', timeout: 15000 });
    if (check?.status !== 0) {
      this.#fail(`语法检查未通过：${previewLine(String(check?.stderr || check?.error?.message || '').split('\n').slice(-3).join(' '), 300)}`);
      return false;
    }

    const probe = probeIsolation({ pluginDir: this.#pluginDir(), spawn: this.spawnSyncImpl, nodePath: this.nodePath });
    this.unconfined = !probe.ok;
    if (!probe.ok && this.requireIsolation) {
      // 隔离不可用时**不假装**：默认宁可插件跑不起来，也不能在没有隔离的机器上执行第三方代码
      this.#fail(`隔离不可用：${probe.error}`);
      return false;
    }
    if (!probe.ok) {
      // 配置里明确关掉了 requireIsolation：照常起，但这件事必须吵闹地说出来（日志 + 状态 + 控制台）
      this.log(`[plugin:${this.id}] ⚠️ 未隔离运行（${probe.error}）：该插件进程读得到 config.json，风险自负`);
    }

    try {
      // 隔离参数按**本插件自己的目录**现算（probeIsolation 只返回"能不能用"的结论，
      // 不缓存参数 —— 缓存一份会把第一个插件的目录发给所有插件）
      // 未隔离时用最朴素的参数起（不加 --permission —— 那组参数在本机跑不起来）
      const spawnArgs = this.unconfined ? [] : pluginNodeArgs({ pluginDir: this.#pluginDir() });
      this.child = this.spawnImpl(this.nodePath, [...spawnArgs, entry], {
        cwd: this.#pluginDir(),
        env: childEnv(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch (error) {
      this.#fail(`启动失败：${error?.message ?? error}`);
      return false;
    }

    this.child.stdout.on('data', (chunk) => this.decoder.push(chunk));
    this.child.stderr.on('data', (chunk) => {
      // 与 stdout 同一条限流：插件刷 stderr（或循环打印错误）不该把宿主日志/journal 灌满
      const text = previewLine(String(chunk), 400);
      if (text) this.#raw(`stderr: ${text}`);
    });
    this.child.on('error', (error) => this.#fail(`进程错误：${error?.message ?? error}`));
    this.child.on('exit', (code, signal) => this.#onExit(code, signal));

    // init 握手：带上 apiVersion 与能力清单，插件据此决定自己要不要继续
    try {
      await this.#request(HOST_METHODS.init, {
        apiVersion: this.manifest.apiVersion,
        pluginId: this.id,
        capabilities: [...this.manifest.capabilities],
        settings: this.#settingsForInit()
      }, this.timeouts.initTimeoutMs);
    } catch (error) {
      this.#fail(`init 未完成：${error?.message ?? error}`);
      this.#kill();
      return false;
    }

    this.state = 'running';
    this.startedAt = this.now();
    this.#startHeartbeat();
    return true;
  }

  /** 让插件执行一个工具调用。超时/进程不可用都会抛带 code 的错误。 */
  async callTool(name, args, { timeoutMs } = {}) {
    return this.#request(HOST_METHODS.callTool, { name: String(name ?? ''), args: args ?? {} },
      timeoutMs ?? this.timeouts.callTimeoutMs);
  }

  /** 周期任务由宿主驱动（这样插件重启后周期不会丢），失败不向上抛。 */
  async runSchedule(name) {
    try {
      await this.#request(HOST_METHODS.schedule, { name: String(name ?? '') }, this.timeouts.callTimeoutMs);
      return true;
    } catch (error) {
      this.log(`[plugin:${this.id}] 周期任务 ${name} 失败：${error?.message ?? error}`);
      return false;
    }
  }

  /**
   * 投递一条入站消息（**只读观察**：插件看得到，但改不了内容、也拦不住消息 —— 它没有返回值
   * 通道，宿主也不等它）。没在跑就丢掉：插件停机期间的消息不需要补课。
   */
  observe(event) {
    if (this.state !== 'running') return false;
    return this.#notify(HOST_METHODS.observe, event);
  }

  /** 停机：先请它自己退，宽限期内没动静就 kill。 */
  async stop() {
    if (this.state === 'idle' || this.state === 'stopped') { this.state = 'stopped'; return; }
    this.stopping = true;
    this.state = 'stopping';
    try { this.#notify(HOST_METHODS.shutdown, {}); } catch { /* 已经不在就算了 */ }
    const deadline = this.now() + this.timeouts.shutdownGraceMs;
    while (this.child && !this.child.killed && this.#alive() && this.now() < deadline) {
      await delay(50);
    }
    this.#kill();
    this.caps.flush();
    this.state = 'stopped';
  }

  #pluginDir() { return this.manifest.dir || ''; }
  #alive() { return Boolean(this.child) && this.child.exitCode === null && this.child.signalCode === null; }
  #settingsForInit() { return structuredClone(this.getSettings() ?? {}); }

  #fail(reason) {
    this.lastError = String(reason ?? '');
    this.log(`[plugin:${this.id}] ${this.lastError}`);
  }

  /** 插件直接打在 stdout 上的行：留一部分当线索，超量就只计数（防刷屏）。 */
  #raw(line) {
    const t = this.now();
    while (this.rawLines.length && t - this.rawLines[0] > 60_000) this.rawLines.shift();
    if (this.rawLines.length >= this.timeouts.maxRawLinesPerMin) return;
    this.rawLines.push(t);
    this.log(`[plugin:${this.id}] ${previewLine(line)}`);
  }

  #startHeartbeat() {
    this.#stopHeartbeat();
    this.heartbeatMisses = 0;
    this.heartbeatTimer = setInterval(() => {
      if (this.state !== 'running') return;
      this.#request(HOST_METHODS.ping, {}, Math.max(1000, Math.floor(this.timeouts.heartbeatMs / 2)))
        .then(() => { this.heartbeatMisses = 0; })
        .catch(() => {
          this.heartbeatMisses += 1;
          if (this.heartbeatMisses >= this.timeouts.heartbeatMissLimit) {
            this.log(`[plugin:${this.id}] 连续 ${this.heartbeatMisses} 次心跳无应答，重启该插件进程`);
            this.#kill(new Error('心跳超时'));
          }
        });
    }, this.timeouts.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  #stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  #kill(reason) {
    try { this.child?.kill('SIGKILL'); } catch { /* 已经退了 */ }
    if (reason) this.lastError = String(reason.message ?? reason);
  }

  async #onExit(code, signal) {
    this.#stopHeartbeat();
    this.#rejectAll(new Error(`插件进程退出（code=${code}, signal=${signal}）`));
    if (this.stopping || this.state === 'stopped' || this.state === 'stopping') { this.state = 'stopped'; return; }
    this.stats.crashes += 1;
    this.child = null;
    // 稳稳跑过一段时间的插件，一次崩溃不该计入"连续崩溃"：否则一个月里零星崩三次就被停用了
    if (this.startedAt && this.now() - this.startedAt > 5 * 60_000) this.restarts = 0;
    this.startedAt = 0;
    if (this.restarts >= this.timeouts.maxRestarts) {
      // 连续崩够次数就停用：空转重启只会一直刷日志、一直烧 CPU
      this.state = 'failed';
      this.#fail(`连续崩溃 ${this.restarts} 次（最后 code=${code}, signal=${signal}），已停用该插件`);
      return;
    }
    const wait = this.timeouts.restartBackoffMs[Math.min(this.restarts, this.timeouts.restartBackoffMs.length - 1)];
    this.restarts += 1;
    this.state = 'starting';
    this.log(`[plugin:${this.id}] 进程退出（code=${code}, signal=${signal}），${Math.round(wait / 1000)} 秒后重启（第 ${this.restarts} 次）`);
    await delay(wait);
    if (this.stopping) { this.state = 'stopped'; return; }
    const ok = await this.start();
    if (!ok) this.state = 'failed';
  }

  #rejectAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  #notify(method, params) {
    if (!this.child?.stdin?.writable) return false;
    this.child.stdin.write(encodeMessage({ method, params }));
    return true;
  }

  #request(method, params, timeoutMs) {
    if (!this.#alive()) return Promise.reject(Object.assign(new Error(`插件未在运行（${this.id}）`), { code: 'E_PLUGIN_DOWN' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stats.timeouts += 1;
        reject(Object.assign(new Error(`${method} 超时（${timeoutMs}ms）`), { code: 'E_TIMEOUT' }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      this.child.stdin.write(encodeMessage({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error(`写入插件 stdin 失败：${error?.message ?? error}`), { code: 'E_PIPE' }));
      });
    });
  }

  #onMessage(message) {
    if (isResponse(message)) {
      const entry = this.pending.get(message.id);
      if (!entry) return;                     // 迟到的应答（超时后到达）：丢掉
      clearTimeout(entry.timer);
      this.pending.delete(message.id);
      if (message.error) {
        entry.reject(Object.assign(new Error(String(message.error.message ?? '插件报错')), {
          code: String(message.error.code || 'E_PLUGIN')
        }));
      } else {
        entry.resolve(message.result ?? null);
      }
      return;
    }
    // 插件发起的请求：只可能是能力调用（cap.*），逐条按 manifest 声明鉴权
    if (typeof message?.method === 'string') return this.#onCapability(message);
    this.stats.protocolErrors += 1;
    this.#raw(`[无法识别的消息] ${previewLine(JSON.stringify(message))}`);
  }

  async #onCapability(message) {
    const { id, method, params } = message;
    const reply = (payload) => {
      if (id === undefined || id === null || !this.child?.stdin?.writable) return;
      this.child.stdin.write(encodeMessage(payload));
    };
    const required = CAP_REQUIREMENT[method];
    if (!required) {
      reply(rpcError(id, 'E_NO_METHOD', `未知能力方法：${method}`));
      this.stats.protocolErrors += 1;
      return;
    }
    if (!this.manifest.capabilities.includes(required)) {
      // 没在 manifest 里声明就调 = 越权。记下来（控制台能看到），并且拒绝
      this.stats.denied += 1;
      this.log(`[plugin:${this.id}] 越权调用 ${method}（未声明能力 "${required}"），已拒绝`);
      reply(rpcError(id, 'E_CAP_DENIED', `未声明能力 "${required}"`));
      return;
    }
    try {
      const result = await this.caps.methods[method](params ?? {});
      reply(rpcResult(id, result ?? null));
    } catch (error) {
      reply(rpcError(id, error?.code || 'E_CAP', error?.message ?? String(error)));
    }
  }
}
