import assert from 'node:assert/strict';
import { test } from 'node:test';
import { forageRss, parseRssFeed } from '../src/features/life-feed-source-rss.js';

test('RSS 2.0：标题/链接/摘要/时间/分类，CDATA 与实体都要还原', () => {
  const xml = `<?xml version="1.0"?><rss><channel><title>频道</title>
    <item><title><![CDATA[一篇文章]]></title><link>https://example.com/a</link>
      <description>摘要 &amp; 更多</description><pubDate>Tue, 28 Oct 2026 10:00:00 GMT</pubDate>
      <category>科技</category></item>
    <item><title>坏链接</title><link>javascript:alert(1)</link></item>
  </channel></rss>`;
  const items = parseRssFeed(xml, { feedUrl: 'https://example.com/feed.xml' });
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '一篇文章');
  assert.equal(items[0].url, 'https://example.com/a');
  assert.match(items[0].desc, /摘要 & 更多/);
  assert.equal(items[0].source, 'rss');
  assert.equal(items[0].via, 'example.com');
  assert.deepEqual(items[0].tags, ['科技']);
  assert.ok(items[0].pubdate > 0);
});

test('Atom：link href 也能解析', () => {
  const xml = `<feed><title>Atom 频道</title><entry><title>Atom 文章</title>
    <link href="https://example.com/atom" /><summary>简介</summary>
    <updated>2026-10-28T10:00:00Z</updated><category term="生活" /></entry></feed>`;
  const items = parseRssFeed(xml, { feedUrl: 'https://example.com/atom.xml' });
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://example.com/atom');
  assert.deepEqual(items[0].tags, ['生活']);
});

test('一个 feed 失败不影响其它 feed，且结果受 limit 约束', async () => {
  const calls = [];
  const items = await forageRss({
    urls: ['https://bad.example/feed', 'https://good.example/feed'],
    limit: 1,
    fetchImpl: async (url) => {
      calls.push(url);
      if (String(url).includes('bad')) throw new Error('network down');
      return {
        statusCode: 200,
        body: '<rss><channel><title>好频道</title><item><title>好文章</title><link>https://example.com/good</link></item></channel></rss>'
      };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, '好文章');
});
