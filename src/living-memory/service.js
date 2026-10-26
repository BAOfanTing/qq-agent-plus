import { Embedder, readLivingMemoryEmbeddingConfig } from './embedding.js';
import { LivingMemoryStore } from './store.js';
import { asText, clampInt, now, redactionReason } from './util.js';

function embeddingText(memory) {
  return [memory.summary, memory.content, memory.tags.join(' '), memory.entities.join(' ')].filter(Boolean).join('\n');
}

function recencyScore(memory) {
  const days = Math.max(0, (now() - memory.updatedAt) / 86400000);
  return Math.max(0, 1 - days / 365);
}

function cosineSimilarity(left, right) {
  if (!left || !right || left.length !== right.length || !left.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = Number(left[index]) || 0;
    const b = Number(right[index]) || 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function boundedDeadlineMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.max(200, Math.min(15000, Math.round(parsed)));
}

export class LivingMemoryService {
  constructor({ file, embeddingConfig = null, store = null, embedder = null, log = console } = {}) {
    this.embeddingConfig = embeddingConfig || readLivingMemoryEmbeddingConfig();
    this.store = store || new LivingMemoryStore({ file });
    this.embedder = embedder || new Embedder(this.embeddingConfig);
    this.log = log;
  }

  health() {
    return {
      ok: true,
      storage: { kind: 'sqlite', ok: true },
      embedding: {
        configured: this.embedder.ready(),
        model: this.embeddingConfig.model || '',
        dimensions: this.embeddingConfig.dimensions || 0
      },
      stats: this.store.stats()
    };
  }

  async upsertMemory(raw) {
    const rejected = raw?.allowSensitive === true ? '' : redactionReason(`${raw?.summary || ''}\n${raw?.content || ''}`);
    if (rejected) throw new Error(`拒绝保存：${rejected}`);
    const memory = this.store.upsertMemory(raw, { id: raw?.id });
    if (!this.embedder.ready() || memory.status !== 'active') {
      return this.store.setVectorState(memory.id, {
        status: this.embedder.ready() ? 'stale' : 'none',
        model: this.embeddingConfig.model
      });
    }
    try {
      const [vector] = await this.embedder.embed(embeddingText(memory));
      return this.store.setVectorState(memory.id, {
        status: 'ready',
        model: this.embeddingConfig.model,
        vector
      });
    } catch (error) {
      this.log.warn?.('[living-memory] 向量化失败，已保留关键词可检索记忆：', error?.message || error);
      return this.store.setVectorState(memory.id, {
        status: 'error',
        error: String(error?.message || error),
        model: this.embeddingConfig.model
      });
    }
  }

  async recall({ scopeKeys, query, limit = 6, deadlineMs = 0 } = {}) {
    const maxItems = clampInt(limit, 1, 20, 6);
    const lexical = this.store.lexicalCandidates({ scopeKeys, query, limit: 160 });
    const ranked = new Map();
    for (const item of lexical) ranked.set(item.memory.id, { memory: item.memory, lexical: item.score, semantic: 0 });

    let vectorError = '';
    let semanticAvailable = this.embedder.ready() && this.store.hasReadyVectors({
      scopeKeys,
      model: this.embeddingConfig.model
    });
    const deadline = boundedDeadlineMs(deadlineMs);
    const startedAt = now();
    const remainingMs = () => deadline ? Math.max(0, deadline - (now() - startedAt)) : 0;

    if (semanticAvailable) {
      try {
        const embeddingTimeoutMs = deadline
          ? Math.min(this.embeddingConfig.recallTimeoutMs, remainingMs())
          : this.embeddingConfig.recallTimeoutMs;
        if (embeddingTimeoutMs < 200) throw new Error('语义召回超出本轮时间预算，已使用关键词结果');
        const [queryVector] = await this.embedder.embed(asText(query, 4000), { timeoutMs: embeddingTimeoutMs });
        const candidates = this.store.vectorCandidates({
          scopeKeys,
          model: this.embeddingConfig.model,
          dimensions: queryVector.length,
          limit: this.embeddingConfig.vectorScanLimit
        });
        if (!candidates.length) {
          semanticAvailable = false;
        } else {
          const best = candidates
            .map((item) => ({ id: item.id, score: cosineSimilarity(queryVector, item.vector) }))
            .filter((item) => item.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 32);
          const memories = this.store.getMemories(best.map((item) => item.id));
          const byId = new Map(memories.map((memory) => [memory.id, memory]));
          for (const match of best) {
            const memory = byId.get(match.id);
            if (!memory) continue;
            const prior = ranked.get(memory.id) || { memory, lexical: 0, semantic: 0 };
            prior.semantic = Math.max(prior.semantic, match.score);
            ranked.set(memory.id, prior);
          }
        }
      } catch (error) {
        vectorError = String(error?.message || error);
      }
    }

    const entries = [...ranked.values()].map((item) => {
      const lexicalNormal = Math.min(1, item.lexical / 18);
      const score = item.semantic * 0.62 + lexicalNormal * 0.25
        + (Number(item.memory.importance) || 0) / 10 * 0.09 + recencyScore(item.memory) * 0.04;
      return {
        ...item.memory,
        retrieval: {
          score: Math.round(score * 1000) / 1000,
          semantic: Math.round(item.semantic * 1000) / 1000,
          lexical: item.lexical,
          recency: Math.round(recencyScore(item.memory) * 1000) / 1000
        }
      };
    }).sort((a, b) => b.retrieval.score - a.retrieval.score || b.updatedAt - a.updatedAt).slice(0, maxItems);

    const mode = !this.embedder.ready()
      ? 'lexical'
      : !semanticAvailable
        ? 'lexical-pending-vectors'
        : vectorError ? 'hybrid-degraded' : 'hybrid';
    return { entries, vectorError, mode };
  }

  archiveMemory(id) {
    return this.store.archiveMemory(id);
  }

  removeMemory(id) {
    return this.store.removeMemory(id);
  }

  recordTurn(raw) {
    return this.store.recordTurn(raw);
  }

  prune() {
    return { archived: this.store.pruneExpired().length };
  }

  close() {
    this.store.close();
  }
}
