// 极简 MCP stdio 客户端：只依赖 node 内建。一个 server 一个子进程，JSON-RPC 走 stdin/stdout。
// 不实现采样/资源/提示词，只做 tools/list + tools/call —— 这是给聊天机器人用的最小闭环。

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT = 30000;
const PROTOCOL_VERSION = '2024-11-05';

export class McpStdioClient {
  constructor({ id, command, args = [], env = {}, cwd = '', timeoutMs = DEFAULT_TIMEOUT, log = () => {} }) {
    this.id = String(id || '').trim();
    this.command = String(command || '').trim();
    this.args = Array.isArray(args) ? args.map(String) : [];
    this.env = env && typeof env === 'object' ? env : {};
    this.cwd = String(cwd || '').trim() || undefined;
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT);
    this.log = log;
    this.proc = null;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = '';
    this.stderrTail = '';
    this.tools = [];
    this.startedAt = 0;
    this.lastError = '';
    this.ready = false;
  }

  get running() {
    return Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null);
  }

  async start() {
    if (!this.id) throw new Error('MCP server 缺少 id');
    if (!this.command) throw new Error(`MCP server ${this.id} 缺少 command`);
    if (this.running) return;
    this.ready = false;
    this.lastError = '';
    this.buffer = '';
    this.stderrTail = '';
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true
    });
    this.proc = child;
    this.startedAt = Date.now();
    child.stdin.on('error', (error) => {
      // 子进程退出/关闭 stdin 后再写会异步抛 EPIPE；没有监听会变成 uncaughtException，
      // 一个坏 MCP server 就能带走整个机器人。
      this.ready = false;
      this.lastError = `stdin: ${String(error?.message ?? error)}`;
      this.#failAll(new Error(`MCP ${this.id} 写入失败：${this.lastError}`));
    });
    child.stdout.on('error', (error) => {
      this.lastError = `stdout: ${String(error?.message ?? error)}`;
    });
    child.stderr.on('error', () => { /* stderr 只做诊断，读不了就算了 */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4000);
    });
    child.on('error', (error) => {
      this.lastError = String(error?.message ?? error);
      this.#failAll(new Error(`MCP ${this.id} 进程错误：${this.lastError}`));
    });
    child.on('exit', (code, signal) => {
      const detail = `MCP ${this.id} 进程退出 code=${code ?? 'null'} signal=${signal || 'null'}`;
      this.ready = false;
      this.lastError = detail;
      this.log.warn?.(detail);
      this.#failAll(new Error(detail));
    });
    try {
      await this.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'qq-agent-plus', version: '1' }
      });
      this.#send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.tools = await this.listTools();
      this.ready = true;
      this.log.info?.(`MCP ${this.id} 就绪，${this.tools.length} 个工具`);
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.stop();
      throw error;
    }
  }

  #send(payload) {
    if (!this.proc?.stdin?.writable) throw new Error(`MCP ${this.id} 未启动`);
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 1024 * 1024) {
      this.lastError = 'stdout 单行超过 1MB，已停止该 server';
      this.buffer = '';
      this.#failAll(new Error(`MCP ${this.id} ${this.lastError}`));
      this.stop();
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');
      if (!line) continue;
      let message = null;
      try { message = JSON.parse(line); } catch { continue; }
      if (message?.id != null && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(String(message.error.message || 'MCP 调用失败')));
        else entry.resolve(message.result);
      }
    }
  }

  #failAll(error) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.id} ${method} 超时（${this.timeoutMs}ms）`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.#send({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async listTools() {
    const out = [];
    let cursor = '';
    for (let page = 0; page < 20; page += 1) {
      const result = await this.request('tools/list', cursor ? { cursor } : {});
      const tools = Array.isArray(result?.tools) ? result.tools : [];
      out.push(...tools);
      cursor = String(result?.nextCursor || '');
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name, args = {}) {
    const result = await this.request('tools/call', { name, arguments: args });
    return result;
  }

  stop() {
    const child = this.proc;
    this.proc = null;
    this.ready = false;
    this.#failAll(new Error(`MCP ${this.id} 已停止`));
    if (!child) return;
    try { child.kill('SIGTERM'); } catch { /* 已退出 */ }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
    timer.unref?.();
  }
}

/** 把 MCP 的 content 数组压成模型能读的文本。 */
export function mcpContentToText(result) {
  const parts = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((part) => {
    if (part?.type === 'text') return String(part.text ?? '');
    if (part?.type === 'image') return `[图片 ${part.mimeType || ''}]`;
    if (part?.type === 'resource') return `[资源 ${part.resource?.uri || ''}]`;
    return '';
  }).filter(Boolean).join('\n');
  return text || '(MCP 工具没有返回文本)';
}
