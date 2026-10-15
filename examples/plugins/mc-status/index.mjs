// 示例插件：Minecraft 服务器状态（issue #37 的原始诉求）。
//
// 这个文件同时是"插件长什么样"的活文档：不依赖任何 npm 包、不 import 宿主的内部模块，
// 只用一段 stdin/stdout 上的 JSON 协议（契约见 docs/PLUGINS.md）。
//
// 它做三件事：
//   1. init 时收下自己的配置段（capabilities 里声明了 config）；
//   2. 被模型调用 players 工具时，用 cap.http.request 去公开状态接口取数据 —— **自己不发 fetch**：
//      走宿主那条路才有内网拦截/体积上限/超时，日志里也查得到；
//   3. 把结果整理成模型好读的几行文本（不是把上游 JSON 原样倒出去）。
//
// 配置（可选）：plugins.settings.mc-status.statusUrl，默认 mcsrvstat.us 的 v3 接口。
// 想换成自己的状态页时改这一个值即可，注意 {host} 是占位符。
const send = (message) => { process.stdout.write(`${JSON.stringify(message)}\n`); };

const DEFAULT_STATUS_URL = 'https://api.mcsrvstat.us/3/{host}';
let settings = {};
let requestSeq = 0;
const pending = new Map();

/** 调宿主的能力（这里是 cap.http.request）：带自增 id，应答按 id 回来。 */
const callHost = (method, params) => new Promise((resolve, reject) => {
  const id = ++requestSeq;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});

/** 把上游 JSON 压成模型要的几行。上游字段可能缺，全部按"没有就说没有"处理。 */
function summarize(host, payload) {
  if (!payload || payload.online !== true) {
    return `服务器 ${host} 现在连不上或不在线（状态接口没有返回在线信息）。`;
  }
  const players = payload.players || {};
  const names = Array.isArray(players.list)
    ? players.list.map((entry) => (typeof entry === 'string' ? entry : entry?.name)).filter(Boolean)
    : [];
  const lines = [
    `服务器 ${host} 在线：${players.online ?? '?'}/${players.max ?? '?'} 人。`
  ];
  if (payload.version) lines.push(`版本：${payload.version}`);
  if (names.length) {
    // 只在人数不多时列名字（几十人全列出来对模型没意义，还占上下文）
    lines.push(names.length <= 30 ? `在线玩家：${names.join('、')}` : `在线玩家（前 30 位）：${names.slice(0, 30).join('、')}`);
  } else if (players.online > 0) {
    lines.push('这台服务器没有公开玩家名单（服务端关闭了查询），只能看到人数。');
  }
  const motd = Array.isArray(payload.motd?.clean) ? payload.motd.clean.join(' ').trim() : '';
  if (motd) lines.push(`服务器标语：${motd}`);
  return lines.join('\n');
}

const tools = {
  players: async (args) => {
    const host = String(args?.host ?? '').trim();
    if (!host) return { error: '要给我服务器地址，例如 play.example.com' };
    const template = String(settings.statusUrl || DEFAULT_STATUS_URL);
    const url = template.replace('{host}', encodeURIComponent(host));
    const response = await callHost('cap.http.request', { url });
    if (Number(response?.status) !== 200) {
      return { error: `状态接口返回 HTTP ${response?.status ?? '?'}（${url}）` };
    }
    let payload = null;
    try { payload = JSON.parse(String(response.body ?? '')); }
    catch { return { error: '状态接口返回的不是 JSON（地址可能填错了）' }; }
    const text = summarize(host, payload);
    await callHost('cap.log.write', { level: 'info', message: `查了 ${host}：${text.split('\n')[0]}` });
    return { host, summary: text };
  }
};

async function handleRequest(message) {
  const reply = (payload) => send({ id: message.id, ...payload });
  switch (message.method) {
    case 'init':
      settings = message.params?.settings ?? {};
      reply({ result: { ok: true } });
      return;
    case 'ping':
      reply({ result: {} });
      return;
    case 'schedule':
      reply({ result: {} });          // 这个插件没有周期任务（manifest 里没声明）
      return;
    case 'callTool': {
      const name = String(message.params?.name ?? '');
      const fn = tools[name];
      if (!fn) return reply({ error: { code: 'E_NO_TOOL', message: `没有这个工具：${name}` } });
      try { reply({ result: await fn(message.params?.args ?? {}) }); }
      catch (error) { reply({ error: { code: error?.code || 'E_TOOL', message: String(error?.message ?? error) } }); }
      return;
    }
    case 'shutdown':
      reply({ result: {} });
      setTimeout(() => process.exit(0), 10);
      return;
    default:
      reply({ error: { code: 'E_NO_METHOD', message: `未知方法：${message.method}` } });
  }
}

let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      let message = null;
      try { message = JSON.parse(line); } catch { message = null; }
      if (message && typeof message.method === 'string' && message.id !== undefined) handleRequest(message);
      else if (message && message.id !== undefined) {
        const entry = pending.get(message.id);
        if (entry) {
          pending.delete(message.id);
          if (message.error) entry.reject(Object.assign(new Error(message.error.message || '能力调用失败'), { code: message.error.code }));
          else entry.resolve(message.result ?? null);
        }
      }
    }
    index = buffer.indexOf('\n');
  }
});
