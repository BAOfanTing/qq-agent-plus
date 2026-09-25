// 表情库的两条数据安全不变量：
//  1) 同步剪枝不能删掉"有本地数据"的条目 —— 备注/标签/使用计数是模型攒的，丢了没备份；
//  2) 模型通过 sticker_note 写进来的文本要封顶 —— 它会原样进系统提示的表情清单。
// 背景（2026-09-23 全项目审查）：同步窗口挂在 sticker.promptMaxStickers 上、剪枝无条件删，
// 以及 applyStickerNote 只 trim 不封顶（另两处写入路径都有封顶）。
import assert from 'node:assert/strict';
import { it } from 'node:test';

const { mergeStickerLibrary, applyStickerNote } = await import('../src/onebot/stickers.js');

const local = (id, extra = {}) => ({
  id, resId: id, url: `https://example.invalid/${id}`, md5: '',
  desc: '', localNote: '', tags: [], usage: '', source: 'qq', useCount: 0, ...extra
});
const fetched = (id) => ({ emoji_id: id, resId: id, url: `https://example.invalid/${id}` });

it('同步剪枝：有备注/标签/使用次数的条目不因一次同步消失', () => {
  const existing = [
    local('a', { localNote: '被叫大肥鱼时用', useCount: 3 }),
    local('b', { tags: ['怼人'] }),
    local('c', { usage: '自嘲用' }),
    local('d')                      // 干干净净、这次没拉到 → 该剪
  ];
  const merged = mergeStickerLibrary(existing, [fetched('b')]);
  const ids = merged.map((e) => e.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c'], '有本地数据的要留下（含这次没返回的）');
  assert.equal(merged.find((e) => e.id === 'a').localNote, '被叫大肥鱼时用', '备注不能被清空');
});

it('同步剪枝：一条都没拉到时不剪枝（接口抖动不清库）', () => {
  const merged = mergeStickerLibrary([local('a'), local('b')], []);
  assert.deepEqual(merged.map((e) => e.id), ['a', 'b']);
});

it('sticker_note 写入封顶：备注/用途 300、标签 40×20，与其它写入路径一致', () => {
  const entries = [local('a')];
  const { entries: after } = applyStickerNote(entries, 'a', {
    note: 'x'.repeat(20000),
    usage: 'y'.repeat(5000),
    tags: Array.from({ length: 50 }, (_, i) => `tag-${i}-${'z'.repeat(80)}`)
  });
  const entry = after.find((e) => e.id === 'a');
  assert.equal(entry.localNote.length, 300);
  assert.equal(entry.usage.length, 300);
  assert.equal(entry.tags.length, 20);
  assert.equal(entry.tags[0].length, 40);
});
