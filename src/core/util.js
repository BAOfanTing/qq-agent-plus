// 通用小工具：无业务逻辑。

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  if (hi <= lo) return lo;
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/** 带抖动的均匀随机区间。 */
export function randRange([min, max]) {
  return randInt(min, max);
}

export function nowMs() {
  return Date.now();
}

// ── 时间格式化（固定上海时区，给模型/界面看） ───────────────────────────
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export const ZONE_OFFSET_MS = 8 * 60 * 60 * 1000; // Asia/Shanghai（UTC+8）：全项目钟点/自然日判断共用

function pad2(n) {
  return String(n).padStart(2, '0');
}

function shanghaiDate(ts = Date.now()) {
  const value = Number(ts);
  return new Date((Number.isFinite(value) ? value : Date.now()) + ZONE_OFFSET_MS);
}

/** 2026-08-30 21:33:05（周六） */
export function formatFullTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  const formatted = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}（${WEEKDAYS[d.getUTCDay()]}）`;
  return formatted;
}

/** 08-30 21:33 */
export function formatShortTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 21:33:05 */
export function formatClockTime(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

export function todayKey(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 当前时间所属上海自然日的起点，返回 UTC 毫秒时间戳。 */
export function shanghaiDayStart(ts = Date.now()) {
  const shifted = shanghaiDate(ts);
  return Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  ) - ZONE_OFFSET_MS;
}

// ── 文本处理 ─────────────────────────────────────────────────────────────

/** 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。 */
/** 当前时刻在固定时区里的"当天第几分钟"（00:00=0）。活跃时段/主动窗口都用它，别再各自 new Date(+8)。 */
export function minuteOfDayInZone(ts = Date.now()) {
  const d = shanghaiDate(ts);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

/**
 * 机器人在这个会话里"叫什么"：**群友/好友实际看到的名字优先** ——
 * 群内展示名（群名片）→ 账号昵称（QQ 昵称）→ 机器人名字（控制台里的项目标识）。
 *
 * 聊天提示词、每日说说、空间互动、好友评估、看图判断全都走这一个口径：
 * 各处各挑一个来源会出现"群里显示「犊子」、说说里却自称「小鲸鱼」"这类自相矛盾 ——
 * 模型需要的是"别人叫我什么"，而不是控制台里的名字。
 */
export function resolveSelfName(persona = {}, accountNickname = '') {
  // 逐个 trim 再判空：只写了空格的"群内展示名"要当成没填，落到账号昵称上
  for (const value of [persona?.selfNickname, accountNickname, persona?.botName]) {
    const name = String(value ?? '').trim();
    if (name) return name;
  }
  return '我';
}

/**
 * 防提示注入/泄露：把用户昵称、消息文本里的“指令式方括号标记”弱化，
 * 避免群友伪装成系统段（如【本次唤醒】）骗模型。只处理外观，不改变语义。
 */
export function sanitizeUserText(text) {
  let s = String(text ?? '');
  // 系统段标记在提示词里是全角【】（见 prompt.js 的【本次唤醒】/【管理员附加规则】），
  // 所以半角、全角、繁体方括号都要处理；命中后换圆括号：语义不变，但不再是"段标记"。
  // 只换方括号本身（$1 是关键词、$2 是其余载荷），不能把括号里的内容一起吃掉
  // ⚠️ 这份名单要与**所有会往提示词里塞段头的模块**同步（不只是 prompt.js）：
  //    memory-global（全局印象）、incident-pilot（异常隔离）、asset-observer（已确认黑话）、
  //    daily-moments（上海时间/总结日期/群聊材料）、moment-prompt（当前人设/这次表达的场景）、
  //    experimental-tool-scheduler（实验调度·强规则）、friend-review/moment（好友动态/评论回复…）。
  //    只要某个段头只在一处被认，群友就能在自己的消息里伪造它。
  //    test/prompt-safety.test.mjs 会把这些模块里的【…】全抽出来逐个断言能被弱化。
  s = s.replace(
    /[\[【［][\s\u200b\u200c\u200d]*((?:本次唤醒|系统提醒|系统|管理员(?:附加规则)?|owner|角色扮演|会话令牌|当前时间|上海时间|过去状态|此刻状态|记忆(?:与会话交接)?|上次会话交接|上次生命周期检查点|当前对话线程|优先级|角色设定|当前人设|安全规则|工作方式|反\s*AI\s*味|保持主体性|该说\s*\/\s*不该说|群聊不是客服队列|像真人一样|不要当群管家|引用与点名|可用表情包|QQ\s*场景规则|发送与汇报禁令|发言与沉默|发言的唯一通道|分条发送|看图先读情绪|自然交流与可靠边界|每次运行的决策顺序|生命周期续接|空格不是分句符号|异常隔离|对群友的全局印象|已确认黑话|群聊材料|总结日期|最近已发动态|好友动态|评论回复|这次表达的场景|真实与研究|核心原则|隐私与配图|本次包含的提交|最终提交|提交|预算|表情包(?:用法|策略)?|实验调度|从什么地方写起|像自己发动态|可忽略的灵感|可选配图|安全边界)[^\]】］]*)[\]】］]/gi,
    '（$1）'
  );
  return s;
}

/** 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。 */
export function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch { /* 原样返回 */ }
  }
  return value;
}

/**
 * 把弱模型常见的"对象形态"消息解包回纯文本：
 *   {"text":"..."} / {"content":"..."} / {"message":"..."} → 取第一个字符串值
 *   content-parts（OpenAI 视觉格式 [{type:'text',text:...}]）→ 取 text 段拼接
 *   嵌套数组 → 拍平拼接
 * 返回 null = 解不出来（调用方应报错回模型，而不是把 "[object Object]" 发出去）。
 */
function unwrapMessage(m) {
  if (m === null || m === undefined) return '';
  if (typeof m === 'string') return m;
  if (Array.isArray(m)) return m.map(unwrapMessage).filter((x) => x !== null).join('\n');
  if (typeof m === 'object') {
    // content-parts：{type:'text', text:'...'} 或 {content:[{type:'text',...}]}
    if (m.type === 'text' && typeof m.text === 'string') return m.text;
    if (Array.isArray(m.content)) {
      return m.content.filter((p) => p && p.type === 'text').map((p) => String(p.text ?? '')).join('\n');
    }
    const v = m.text ?? m.content ?? m.message;
    if (typeof v === 'string') return v;
    return null;
  }
  return String(m);
}

/**
 * 把 messages 参数统一成字符串数组。兼容：
 *  - 字符串 / 字符串数组（正常路径）
 *  - JSON 字符串形态的数组、带引号的字符串（老兼容）
 *  - 双重编码的 JSON 对象字符串 "{\"text\":\"...\"}"（弱模型高发）
 *  - 对象 / 对象数组（弱模型高发，逐一解包）
 *  salvage 规则：能解出文本的条目照发；一条都解不出来才抛错 ——
 *  错误会作为工具结果回给模型，它在同一会话里可以自我纠正重发。
 */
export function normalizeMessageList(input) {
  let value = input;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) value = parsed;
      } catch { /* 保持字符串 */ }
    } else if (trimmed.startsWith('"')) {
      const unquoted = unquoteJsonString(trimmed);
      if (typeof unquoted === 'string') value = unquoted;
    }
  }
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const bad = [];
  for (const m of arr) {
    const unwrapped = unwrapMessage(m);
    if (unwrapped === null) { bad.push(m); continue; }
    const s = String(unwrapped).trim();
    if (s) out.push(s);
  }
  if (!out.length && bad.length) {
    throw new Error(`messages 必须是字符串或字符串数组，收到的是对象形态：${JSON.stringify(bad[0])?.slice(0, 120)}——请把消息文本直接作为字符串传入`);
  }
  return out;
}

/** 简单串行队列：保证发送按顺序、带间隔执行。 */
export function createSendChain() {
  let chain = Promise.resolve();
  return function enqueue(task) {
    const next = chain.then(task, task);
    // 防止单次失败中断整条链
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

/** 简易事件总线。 */
export function createEventBus() {
  const listeners = new Map();
  return {
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) {
      const set = listeners.get(type);
      if (!set) return;
      for (const fn of [...set]) {
        try { fn(payload); } catch (error) { console.error(`[bus] ${type} 监听器出错:`, error); }
      }
    }
  };
}

/** 截断长文本（日志/会话记录展示用）。 */
export function truncate(text, max = 400) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}…(共${s.length}字)`;
}
