// RSS / Atom 最小适配器：只读 feed 里的标题、链接、摘要、时间和分类，不抓正文。
// 不引入 XML 依赖：只覆盖 RSS 2.0 与 Atom 的常见字段；解析失败只记错误，不影响其它来源。
import crypto from 'node:crypto';
import { safeFetch } from '../llm/safe-fetch.js';

const MAX_FEED_BYTES = 2 * 1024 * 1024;

function decodeEntities(text) {
  return String(text || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function stripTags(text) {
  // 先还原 CDATA，再剥 HTML 标签：反过来会把 <![CDATA[正文]]> 整段当标签吃掉。
  const decoded = decodeEntities(String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1'));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? stripTags(m[1]) : '';
}

function atomLink(block) {
  const m = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\/?>/i.exec(block);
  return m ? decodeEntities(m[1]).trim() : '';
}

function safeHttpUrl(raw) {
  const text = String(raw || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    return url.toString();
  } catch { return ''; }
}

export function parseRssFeed(xml, { feedUrl = '' } = {}) {
  const source = String(xml || '');
  const blocks = source.match(/<item\b[\s\S]*?<\/item>/gi)
    || source.match(/<entry\b[\s\S]*?<\/entry>/gi)
    || [];
  const channelTitle = tag(source.slice(0, source.search(/<item\b|<entry\b/i) >>> 0), 'title');
  let host = '';
  try { host = new URL(feedUrl).host.toLowerCase(); } catch { /* 保留空 */ }
  return blocks.map((block) => {
    const title = tag(block, 'title');
    const url = safeHttpUrl(tag(block, 'link') || atomLink(block));
    if (!title || !url) return null;
    const desc = tag(block, 'description') || tag(block, 'summary') || tag(block, 'content');
    const published = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated');
    const pubMs = Date.parse(published) || 0;
    const tags = [...block.matchAll(/<category\b[^>]*(?:term=["']([^"']+)["']|>([\s\S]*?)<\/category>)/gi)]
      .map((m) => stripTags(m[1] || m[2] || ''))
      .filter(Boolean)
      .slice(0, 6);
    return {
      id: `rss-${crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)}`,
      title,
      desc,
      up: channelTitle || host,
      upMid: '',
      duration: 0,
      play: 0,
      pubdate: pubMs ? Math.floor(pubMs / 1000) : 0,
      tags,
      cover: '',
      url,
      source: 'rss',
      via: host || 'rss'
    };
  }).filter(Boolean);
}

export async function forageRss({ urls = [], limit = 10, fetchImpl = safeFetch, log = () => {} } = {}) {
  const feeds = [...new Set((Array.isArray(urls) ? urls : [])
    .map((url) => String(url || '').trim())
    .filter((url) => /^https?:\/\//i.test(url)))].slice(0, 10);
  if (!feeds.length) return [];
  const perFeed = Math.max(1, Math.ceil(Math.max(1, limit) / feeds.length));
  const all = [];
  for (const feedUrl of feeds) {
    try {
      const response = await fetchImpl(feedUrl, {
        maxBytes: MAX_FEED_BYTES,
        headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' }
      });
      if (response?.statusCode !== 200) throw new Error(`HTTP ${response?.statusCode || '?'}`);
      all.push(...parseRssFeed(response.body || '', { feedUrl }).slice(0, perFeed));
    } catch (error) {
      log(`[life-feed] RSS ${feedUrl} 读取失败：${error?.message ?? error}`);
    }
  }
  return all.slice(0, Math.max(1, limit));
}
