// 本群梗库：群友解释过一次的梗/黑话/外号，按 chatKey 存下来。
// 只做轻量 key-value，不改知识库索引；条目少，直接读 JSON，写入走临时文件 + rename。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../core/config.js';
import { sanitizeUserText } from '../core/util.js';

const FILE = path.join(DATA_DIR, 'memes.json');
const MAX_ENTRIES = 500;
const MAX_PER_CHAT = 100;
const MAX_TERM = 40;
const MAX_MEANING = 500;
const MAX_USAGE = 300;
const MAX_ALIAS = 30;
const MAX_ALIASES = 8;
const MAX_CREATED_BY = 40;

function clean(value, max) {
  return sanitizeUserText(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function validChatKey(value) {
  return /^(?:group|private):[0-9A-Za-z_-]{1,40}$/.test(String(value || '').trim());
}

function readDb() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.entries)) return { version: 1, entries: [] };
    return parsed;
  } catch {
    return { version: 1, entries: [] };
  }
}

function writeDb(db) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

function publicEntry(entry) {
  return {
    id: entry.id,
    chatKey: entry.chatKey,
    term: entry.term,
    aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
    meaning: entry.meaning,
    usage: entry.usage || '',
    createdBy: entry.createdBy || '',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

export function listMemes(chatKey = '') {
  const key = String(chatKey || '').trim();
  const entries = readDb().entries
    .filter((entry) => !key || entry.chatKey === key)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt));
  return entries.map(publicEntry);
}

export function memeStats() {
  const entries = readDb().entries;
  const chats = new Set(entries.map((entry) => entry.chatKey));
  return { entries: entries.length, chats: chats.size };
}

export function lookupMemes(chatKey, query = '', limit = 6) {
  const key = String(chatKey || '').trim();
  const text = String(query || '').toLowerCase();
  const rows = readDb().entries.filter((entry) => entry.chatKey === key);
  const hits = [];
  for (const entry of rows) {
    const terms = [entry.term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
      .map((term) => String(term || '').toLowerCase())
      .filter(Boolean);
    const matched = terms.filter((term) => text.includes(term));
    if (!matched.length && text) continue;
    const score = matched.reduce((sum, term) => sum + term.length, 0)
      + (terms.some((term) => term === text) ? 20 : 0);
    hits.push({ entry, score });
  }
  hits.sort((a, b) => b.score - a.score || Number(b.entry.updatedAt) - Number(a.entry.updatedAt));
  return hits.slice(0, Math.max(1, Math.min(20, Number(limit) || 6))).map((hit) => publicEntry(hit.entry));
}

export function memesForPrompt(chatKey, text = '') {
  if (!String(text || '').trim()) return '';
  const hits = lookupMemes(chatKey, text, 6);
  if (!hits.length) return '';
  const lines = hits.map((entry) => {
    const aliases = entry.aliases.length ? `（也叫 ${entry.aliases.join('、')}）` : '';
    const usage = entry.usage ? `；用法：${entry.usage}` : '';
    return `- ${entry.term}${aliases}：${entry.meaning}${usage}`;
  });
  return [
    '【本群梗库（群友教过的，优先于网络搜索）】',
    '这些是群里已经确认过的梗/黑话；当前消息里出现了就按这里的含义理解，能贴合就自然用一次，不要重复问、也不要再搜。',
    ...lines
  ].join('\n');
}

export function rememberMeme({ chatKey, term, meaning, usage = '', aliases = [], createdBy = '' } = {}) {
  const key = String(chatKey || '').trim();
  if (!validChatKey(key)) throw new Error('chatKey 必须是 group:<群号> 或 private:<QQ号>');
  const normalizedTerm = clean(term, MAX_TERM);
  const normalizedMeaning = clean(meaning, MAX_MEANING);
  if (!normalizedTerm) throw new Error('梗/黑话名称不能为空');
  if (!normalizedMeaning) throw new Error('含义不能为空');
  const aliasList = (Array.isArray(aliases) ? aliases : String(aliases || '').split(/[,，、]/))
    .map((alias) => clean(alias, MAX_ALIAS))
    .filter(Boolean)
    .filter((alias, index, arr) => arr.indexOf(alias) === index && alias !== normalizedTerm)
    .slice(0, MAX_ALIASES);
  const normalizedUsage = clean(usage, MAX_USAGE);
  const normalizedBy = clean(createdBy, MAX_CREATED_BY);
  const db = readDb();
  const now = Date.now();
  const newNames = [normalizedTerm, ...aliasList].map((name) => name.toLowerCase());
  const existing = db.entries.find((entry) => entry.chatKey === key
    && [entry.term, ...(Array.isArray(entry.aliases) ? entry.aliases : [])]
      .map((name) => String(name || '').toLowerCase())
      .some((name) => newNames.includes(name)));

  let entry;
  if (existing) {
    entry = {
      ...existing,
      term: normalizedTerm,
      aliases: aliasList,
      meaning: normalizedMeaning,
      usage: normalizedUsage,
      updatedAt: now
    };
  } else {
    entry = {
      id: `meme_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      chatKey: key,
      term: normalizedTerm,
      aliases: aliasList,
      meaning: normalizedMeaning,
      usage: normalizedUsage,
      createdBy: normalizedBy,
      createdAt: now,
      updatedAt: now
    };
    db.entries.push(entry);
  }

  // 每群上限：超了先删该群最久没更新的；总量上限同理。
  const sameChat = db.entries.filter((item) => item.chatKey === key).sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
  while (sameChat.length > MAX_PER_CHAT) {
    const drop = sameChat.shift();
    db.entries = db.entries.filter((item) => item.id !== drop.id);
  }
  if (db.entries.length > MAX_ENTRIES) {
    db.entries.sort((a, b) => Number(a.updatedAt) - Number(b.updatedAt));
    db.entries = db.entries.slice(-MAX_ENTRIES);
  }
  writeDb(db);
  return publicEntry(entry);
}

export function deleteMeme(id) {
  const target = String(id || '').trim();
  if (!target) return false;
  const db = readDb();
  const before = db.entries.length;
  db.entries = db.entries.filter((entry) => entry.id !== target);
  if (db.entries.length === before) return false;
  writeDb(db);
  return true;
}
