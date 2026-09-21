// 本地回归：findSticker 的模糊兜底（id / 备注原文 / 备注半句 / 模糊词都能命中）。
//
// 用法：
//   node test/local/test-sticker-lookup.mjs
//
// 说明：纯函数用例，不读写任何数据目录、不连网，直接用内存里的条目数组。
const { findSticker } = await import(new URL('../../src/onebot/stickers.js', import.meta.url).href);

const entries = [
  { id: 'collected_1', desc: '自动收藏 · 王八蛋的爸子', localNote: '躺平猫', tags: ['猫'], hidden: false },
  { id: 'collected_2', desc: '别墨迹', localNote: '小博美配"别墨迹"，催人/怼人专用', tags: [], hidden: false }
];

const cases = [
  ['完整 id', 'collected_1', true],
  ['备注原文', '躺平猫', true],
  ['备注半句', '催人/怼人', true],
  ['模糊词命中唯一', '小博美', true],
  ['多个都不匹配', '不存在的图', false],
  ['空串', '', false]
];
let ok = 0;
for (const [name, ref, want] of cases) {
  const got = findSticker(entries, ref);
  const pass = Boolean(got) === want;
  if (pass) ok += 1;
  console.log('%s %s 传入「%s」→ %s', pass ? 'PASS' : 'FAIL', name, ref, got ? got.id : 'null');
}
console.log('结果: %d/%d', ok, cases.length);
process.exit(ok === cases.length ? 0 : 1);
