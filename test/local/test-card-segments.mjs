// 本地回归：分享卡片（json / xml 段）解析成可读文本，并标注"自己的动态"。
//
// 背景：别人把说说转发进群时，OneBot 给的是 json / xml 段；旧实现只输出「[卡片消息]」，
// 模型既不知道内容，也认不出是自己空间动态被搬进来了。
//
// 用法：QQ_AGENT_DATA_DIR=$(mktemp -d) node test/local/test-card-segments.mjs
import fs from 'node:fs';

if (!process.env.QQ_AGENT_DATA_DIR || !fs.existsSync(process.env.QQ_AGENT_DATA_DIR)) {
  console.error('必须设置 QQ_AGENT_DATA_DIR 为已存在的临时目录（不要指向生产数据）');
  process.exit(2);
}

const { segmentsToText } = await import(new URL('../../src/onebot.js', import.meta.url).href);

const SELF = '10000001';

// 典型 QQ 空间分享卡片（转发到群里的那种）
const qzoneJson = JSON.stringify({
  app: 'com.tencent.mobileqq.webview',
  config: { type: 'normal' },
  desc: '来自 QQ 空间',
  meta: {
    detail_1: {
      appid: '1105044154',
      desc: '今天在地铁上看到一个穿恐龙睡衣的人',
      host: { nick: '小鲸鱼', uin: Number(SELF) },
      qqdocurl: 'https://h5.qzone.qq.com/ugc/share?tid=abc',
      scene: 1030,
      title: '深夜碎碎念'
    }
  },
  prompt: '[QQ空间] 动态分享',
  view: 'news'
});

const otherJson = qzoneJson.replace(String(SELF), '123456789');

const xmlCard = `<?xml version="1.0" encoding="utf-8"?>
<msg serviceID="1" templateID="1" action="web" brief="[QQ空间] 一句话" url="https://h5.qzone.qq.com/ugc/share?tid=xyz">
<item layout="2"><title><![CDATA[深夜碎碎念第二弹]]></title><summary><![CDATA[来自 QQ 空间]]></summary></item>
<source name="QQ空间" icon="https://qzonestyle.gtimg.cn/qzone/phone/m/v4/widget/mobile/hy/image/logo.png" />
</msg>`;

const cases = [];
const wrap = (type, data) => [{ type, data: { data } }];

// 1) 自己的说说被转发进群：要能看到内容，并且标出"你自己的动态"
cases.push(await (async () => {
  const text = await segmentsToText(wrap('json', qzoneJson), { selfId: SELF });
  return ['自己的空间卡片（json）', text.includes('深夜碎碎念') && text.includes('恐龙睡衣') && text.includes('你自己的动态'), text];
})());

// 2) 别人转发的说说：不该标成自己的
cases.push(await (async () => {
  const text = await segmentsToText(wrap('json', otherJson), { selfId: SELF });
  return ['别人的空间卡片（json）', text.includes('深夜碎碎念') && !text.includes('你自己的动态'), text];
})());

// 3) XML 卡片：抽 title / summary / source
cases.push(await (async () => {
  const text = await segmentsToText(wrap('xml', xmlCard), { selfId: SELF });
  return ['xml 卡片', text.includes('深夜碎碎念第二弹') && text.includes('QQ空间'), text];
})());

// 4) 坏掉的卡片：退化成 [卡片消息]，不能抛错
cases.push(await (async () => {
  const text = await segmentsToText(wrap('json', '{不是合法 json'), { selfId: SELF });
  return ['损坏卡片兜底', text.includes('卡片'), text];
})());

// 5) 卡片与文字混排：顺序与内容都要保留
cases.push(await (async () => {
  const segments = [
    { type: 'text', data: { text: '你看这个 ' } },
    { type: 'json', data: { data: qzoneJson } },
    { type: 'text', data: { text: ' 是不是你说过' } }
  ];
  const text = await segmentsToText(segments, { selfId: SELF });
  return ['与文字混排', text.startsWith('你看这个') && text.endsWith('是不是你说过') && text.includes('你自己的动态'), text];
})());

let ok = 0;
for (const [name, pass, text] of cases) {
  if (pass) ok += 1;
  console.log('%s %s', pass ? 'PASS' : 'FAIL', name);
  if (!pass) console.log('     实际输出：%s', String(text).slice(0, 160));
}
console.log('结果: %d/%d', ok, cases.length);
process.exit(ok === cases.length ? 0 : 1);
