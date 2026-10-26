import fs from 'node:fs';
import path from 'node:path';
import { chatCompletion } from '../llm/llm.js';
import { safeSlice } from '../core/util.js';
import { readLivingMemoryEmbeddingConfig } from './embedding.js';
import { livingMemoryApplies, normalizeLivingMemoryConfig } from './config.js';
import { LivingMemoryService } from './service.js';

const SENSITIVE = /(?:密码|口令|验证码|密钥|token|api[ _-]?key|access[ _-]?key|secret|pass(?:word)?|cvv|银行卡|卡号|身份证|护照|家庭住址|详细地址|病历|诊断|病情|政治立场|投票意向)/i;

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, Math.round(parsed))) : fallback;
}

function cleanText(value, max) {
  return safeSlice(String(value || '').replace(/\s+/g, ' ').trim(), max);
}

function parseJsonArray(value) {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
}

function normalizeCards(cards, scopeKey, source) {
  return (Array.isArray(cards) ? cards : []).slice(0, 6).map((raw) => {
    const summary = cleanText(raw?.summary, 260);
    const content = cleanText(raw?.content || summary, 1600);
    const tags = [...new Set((Array.isArray(raw?.tags) ? raw.tags : []).map((item) => cleanText(item, 48)).filter(Boolean))].slice(0, 12);
    const entities = [...new Set((Array.isArray(raw?.entities) ? raw.entities : []).map((item) => cleanText(item, 80)).filter(Boolean))].slice(0, 24);
    const relations = (Array.isArray(raw?.relations) ? raw.relations : []).slice(0, 24).map((item) => ({
      source: cleanText(item?.source, 80), predicate: cleanText(item?.predicate, 48), target: cleanText(item?.target, 80)
    })).filter((item) => item.source && item.target);
    const type = ['episode', 'fact', 'profile', 'preference', 'commitment', 'project', 'rule'].includes(raw?.type)
      ? raw.type : 'episode';
    const importance = Math.max(0, Math.min(10, Number(raw?.importance) || 3));
    const confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0.7));
    const expiresDays = Math.max(0, Math.min(3650, Math.round(Number(raw?.expiresDays) || 0)));
    return {
      scopeKey,
      type,
      summary,
      content,
      importance,
      confidence,
      tags,
      entities,
      relations,
      expiresAt: expiresDays ? Date.now() + expiresDays * 86400000 : 0,
      source
    };
  }).filter((item) => item.summary && item.content && !SENSITIVE.test(`${item.summary}\n${item.content}`));
}

function cardsPrompt(turns) {
  const transcript = turns.map((turn) => turn.lines.map((line) => `${line.role === 'assistant' ? '机器人' : '群友'}：${line.text}`).join('\n')).join('\n\n');
  return [
    '你是长期记忆提炼器。只提炼以后仍有价值、可验证、与当前会话相关的内容；不要复述闲聊。',
    '严禁记录密码、令牌、身份证、银行卡、详细住址、病历、诊断、政治立场等敏感信息。',
    '返回 JSON 数组，最多 6 项；每项字段：type、summary、content、importance(0-10)、confidence(0-1)、tags、entities、relations[{source,predicate,target}]、expiresDays。',
    'type 只能是 episode/fact/profile/preference/commitment/project/rule。没有值得保存的内容时返回 []。',
    '以下是本批对话：',
    transcript
  ].join('\n\n');
}

function renderContext(entries, maxChars) {
  const lines = [];
  let used = 0;
  for (const entry of entries || []) {
    const line = `- [${entry.type || '记忆'} · 重要度 ${Number(entry.importance || 0).toFixed(1)}] ${cleanText(entry.summary || entry.content, 420)}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `【长期语义记忆】\n以下内容来自当前会话允许访问的历史记忆，仅作背景参考；当前用户消息优先，旧记忆可能已过时：\n${lines.join('\n')}` : '';
}

function emptyStats() {
  return { total: 0, active: 0, vectorReady: 0, turns: 0, scopes: [] };
}

export class LivingMemoryRuntime {
  constructor({ getConfig, dataDir, log = () => {}, emit = () => {}, service = null } = {}) {
    this.getConfig = typeof getConfig === 'function' ? getConfig : (() => ({}));
    this.dataDir = path.resolve(String(dataDir || process.env.QQ_AGENT_DATA_DIR || 'data'));
    this.databaseFile = path.join(this.dataDir, 'living-memory', 'living-memory.sqlite');
    this.log = log;
    this.emit = emit;
    this.service = service;
    this.pending = new Map();
    this.timers = new Map();
    this.lastRecall = new Map();
    this.pruneTimer = null;
  }

  config() { return normalizeLivingMemoryConfig(this.getConfig()?.livingMemory); }

  applies(chatKey) { return livingMemoryApplies(this.config(), chatKey); }

  scopesFor(chatKey) {
    const cfg = this.config();
    return cfg.allowGlobal ? [chatKey, 'owner-global'] : [chatKey];
  }

  #service({ create = true } = {}) {
    if (!create && !this.service && !fs.existsSync(this.databaseFile)) return null;
    if (!this.service) {
      this.service = new LivingMemoryService({
        file: this.databaseFile,
        embeddingConfig: readLivingMemoryEmbeddingConfig(),
        log: { warn: (...args) => this.log(...args) }
      });
      this.pruneTimer = setInterval(() => {
        try { this.service?.prune(); } catch (error) { this.log('[living-memory] 定期清理失败：', error?.message || error); }
      }, 6 * 60 * 60 * 1000);
      this.pruneTimer.unref?.();
    }
    return this.service;
  }

  async recall({ chatKey, triggerEntries = [] } = {}) {
    const cfg = this.config();
    if (!this.applies(chatKey)) return { text: '', entries: [], mode: 'disabled' };
    const query = (triggerEntries || []).map((entry) => cleanText(entry?.text, 600)).filter(Boolean).join('\n');
    if (!query) return { text: '', entries: [], mode: 'empty-query' };
    try {
      const result = await this.#service().recall({ scopeKeys: this.scopesFor(chatKey), query, limit: cfg.maxRecallItems, deadlineMs: cfg.recallTimeoutMs });
      const entries = Array.isArray(result?.entries) ? result.entries : [];
      const context = renderContext(entries, cfg.maxInjectChars);
      const view = { at: Date.now(), query: cleanText(query, 1000), entries, mode: result?.mode || 'unknown', vectorError: result?.vectorError || '' };
      this.lastRecall.set(chatKey, view);
      this.emit('living-memory-update', { chatKey, phase: 'recall', count: entries.length, mode: view.mode });
      return { text: cfg.mode === 'active' ? context : '', entries, mode: cfg.mode, audit: view };
    } catch (error) {
      this.log(`[living-memory] 召回跳过：${error?.message || error}`);
      this.emit('living-memory-update', { chatKey, phase: 'recall-error', error: String(error?.message || error) });
      return { text: '', entries: [], mode: 'unavailable', error: String(error?.message || error) };
    }
  }

  captureTurn(input = {}) {
    void this.#captureTurn(input);
  }

  async #captureTurn({ chatKey, sessionId = '', triggerEntries = [], sent = [] } = {}) {
    const cfg = this.config();
    if (!this.applies(chatKey) || cfg.autoCapture === false) return;
    const lines = [
      ...(triggerEntries || []).filter((entry) => !entry?.self).map((entry) => ({ role: 'user', text: cleanText(entry?.text, 1200) })),
      ...(sent || []).map((entry) => ({ role: 'assistant', text: cleanText(entry?.text || entry?.content || '', 1200) }))
    ].filter((entry) => entry.text && !SENSITIVE.test(entry.text));
    if (!lines.some((entry) => entry.role === 'user')) return;
    let turnId = '';
    try {
      const recorded = this.#service().recordTurn({
        scopeKey: chatKey,
        sessionId: cleanText(sessionId, 120),
        payload: { lines, capturedAt: Date.now() }
      });
      turnId = cleanText(recorded?.id, 100);
    } catch (error) {
      this.log(`[living-memory] 来源回合写入跳过：${error?.message || error}`);
    }
    const bucket = this.pending.get(chatKey) || [];
    bucket.push({ sessionId: cleanText(sessionId, 120), turnId, lines, at: Date.now() });
    this.pending.set(chatKey, bucket);
    if (bucket.length >= cfg.captureMinMessages) {
      void this.flush(chatKey);
      return;
    }
    clearTimeout(this.timers.get(chatKey));
    const timer = setTimeout(() => { void this.flush(chatKey); }, cfg.captureIdleMs);
    timer.unref?.();
    this.timers.set(chatKey, timer);
  }

  async flush(chatKey) {
    clearTimeout(this.timers.get(chatKey));
    this.timers.delete(chatKey);
    const batch = this.pending.get(chatKey) || [];
    this.pending.delete(chatKey);
    if (!batch.length || !this.applies(chatKey)) return { created: 0 };
    const source = {
      sessionIds: [...new Set(batch.map((turn) => turn.sessionId).filter(Boolean))],
      turnIds: [...new Set(batch.map((turn) => turn.turnId).filter(Boolean))],
      turnCount: batch.length,
      createdAt: Date.now()
    };
    try {
      const response = await chatCompletion({
        messages: [{ role: 'system', content: cardsPrompt(batch) }],
        temperature: 0.1,
        maxTokens: 1600,
        purpose: 'judge'
      });
      const cards = normalizeCards(parseJsonArray(response?.message?.content), chatKey, source);
      let created = 0;
      for (const card of cards) {
        await this.#service().upsertMemory(card);
        created += 1;
      }
      this.emit('living-memory-update', { chatKey, phase: 'capture', created });
      return { created };
    } catch (error) {
      this.log(`[living-memory] 提炼 ${chatKey} 失败：${error?.message || error}`);
      this.emit('living-memory-update', { chatKey, phase: 'capture-error', error: String(error?.message || error) });
      return { created: 0, error: String(error?.message || error) };
    }
  }

  status() {
    const service = this.#service({ create: false });
    if (service) return service.health();
    const embedding = readLivingMemoryEmbeddingConfig();
    return {
      ok: true,
      initialized: false,
      storage: { kind: 'sqlite', ok: true },
      embedding: { configured: embedding.enabled, model: embedding.model, dimensions: embedding.dimensions },
      stats: emptyStats()
    };
  }

  list(options) {
    const service = this.#service({ create: false });
    return service ? service.store.listMemories(options) : { total: 0, entries: [] };
  }

  get(id) {
    const memory = this.#service({ create: false })?.store.getMemory(id);
    if (!memory) throw new Error('记忆不存在');
    return { memory };
  }

  create(memory) { return this.#service().upsertMemory(memory).then((saved) => ({ memory: saved })); }

  remove(id) {
    const memory = this.#service().removeMemory(id);
    if (!memory) throw new Error('记忆不存在');
    return { memory };
  }

  archive(id) {
    const memory = this.#service().archiveMemory(id);
    if (!memory) throw new Error('记忆不存在');
    return { memory };
  }

  graph(options) {
    const service = this.#service({ create: false });
    return service ? service.store.graph(options) : { nodes: [], edges: [] };
  }

  async recallTest({ chatKey, query, limit } = {}) {
    const cfg = this.config();
    if (!this.applies(chatKey)) throw new Error('长期记忆未启用或当前会话不在范围内');
    const result = await this.#service().recall({
      scopeKeys: this.scopesFor(chatKey),
      query: cleanText(query, 1200),
      limit: clampInt(limit, 1, 16, cfg.maxRecallItems),
      deadlineMs: cfg.recallTimeoutMs
    });
    return { ...result, injectedText: renderContext(result.entries || [], cfg.maxInjectChars) };
  }

  stop() {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    clearInterval(this.pruneTimer);
    this.pruneTimer = null;
    this.service?.close();
    this.service = null;
  }
}
