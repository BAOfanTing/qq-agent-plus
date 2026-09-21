import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from '../core/config.js';

const MEMORY_BACKUP_ROOT = path.join(DATA_DIR, 'memory', 'backups');
const BACKUP_ROOT = path.join(MEMORY_BACKUP_ROOT, 'consolidation');
const chatDirName = (chatKey) => String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * 在人物长期记忆被 consolidation 覆写前保存完整全局快照。
 *
 * 新路径按人物保存不可覆盖的历史：
 *   memory/backups/consolidation/<QQ>/<timestamp>-<uuid>.json
 *
 * 同时保留旧的“当前会话最近一次整理前快照”路径：
 *   memory/backups/<group_...|private_...>/<QQ>.json
 * 这份兼容副本允许旧管理工具继续读取，但真正的历史审计以新路径为准。
 */
const KEEP_PER_PERSON = 20;

export function backupPersonBeforeConsolidation(person, {
  sourceChatKey = '',
  at = Date.now(),
  reason = 'consolidation'
} = {}) {
  const userId = String(person?.userId || '').trim();
  const impressions = Array.isArray(person?.impressions) ? person.impressions : [];
  if (!/^\d{1,15}$/.test(userId) || !impressions.length) return null;

  const when = Number(at) || Date.now();
  const snapshot = structuredClone(person);
  const dir = path.join(BACKUP_ROOT, userId);
  const file = path.join(dir, `${when}-${crypto.randomUUID()}.json`);
  writeJsonAtomic(file, {
    version: 1,
    reason: String(reason || 'consolidation'),
    sourceChatKey: String(sourceChatKey || ''),
    backedUpAt: when,
    person: snapshot
  });

  const chatDir = chatDirName(sourceChatKey);
  if (/^(group|private)_\d+$/.test(chatDir)) {
    writeJsonAtomic(path.join(MEMORY_BACKUP_ROOT, chatDir, `${userId}.json`), snapshot);
  }
  // 只增不删会一直占盘：每人只保留最近 KEEP_PER_PERSON 份（文件名前缀是时间戳）
  try {
    const kept = fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort();
    for (const stale of kept.slice(0, Math.max(0, kept.length - KEEP_PER_PERSON))) {
      try { fs.rmSync(path.join(dir, stale), { force: true }); } catch { /* 删不掉不影响本次备份 */ }
    }
  } catch { /* 目录读不到就算了 */ }
  return file;
}
