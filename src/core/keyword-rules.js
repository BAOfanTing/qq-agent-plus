// 群消息关键词黑名单规则（PR #80）。
//
// 设计约束（2026-10-31 加固）：
//   1. 普通条目是大小写不敏感的**包含匹配**，成本 O(n)，默认用这个；
//   2. `re:` 前缀启用一个**有意收窄**的正则子集：最多一个不限长度的量词（* / + / {n,}），
//      不允许断言、反向引用、嵌套重复；匹配前把输入截到 2000 字符。
//      原因：JS 正则没有超时，`^a*a*a*a*a*b$` 这类顺序量词在 3000 字消息上能卡死事件循环
//      （实测 >10 秒），而 ingest 是同步路径。收窄到"线性回溯"的上限比事后救火可靠。
//   3. 规则在配置加载时清洗（非法条目丢弃、fail-closed），保存时校验（400）；
//      编译结果按规则内容缓存，不在每条消息上重复 new RegExp。
const REGEX_PREFIX = 're:';
const MAX_RULES = 100;
const MAX_REGEX_CHARS = 160;
const MAX_UNBOUNDED_QUANTIFIERS = 1;
const MAX_BOUNDED_REPEAT = 1000;
const MAX_REGEX_INPUT_CHARS = 2000;

function ruleText(rule) {
  return String(rule ?? '').trim();
}

function sourceOf(rule) {
  return ruleText(rule).slice(REGEX_PREFIX.length);
}

/**
 * 数一下"不限长度"的量词（*、+、{n,}）。字符类与转义里的符号不算。
 * `{n,m}` 是有界重复，不算；但 n/m 过大会在别处单独拒绝。
 */
function countUnboundedQuantifiers(source) {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') { i += 1; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '*' || ch === '+') { count += 1; continue; }
    if (ch === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i));
      if (m) {
        if (m[2] === '') count += 1;   // {n,} 不限上界
        i += m[0].length - 1;
      }
    }
  }
  return count;
}

/** 有界重复的上下界也别开太大（{1,1000000} 同样能拖垮匹配）。 */
function boundedRepeatTooLarge(source) {
  const re = /\{(\d+)(?:,(\d+))?\}/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const min = Number(m[1]) || 0;
    const max = m[2] === undefined ? min : Number(m[2]) || 0;
    if (min > MAX_BOUNDED_REPEAT || max > MAX_BOUNDED_REPEAT) return true;
  }
  return false;
}

function unsafeRegexReason(source) {
  if (!source) return '正则内容不能为空';
  if (source.length > MAX_REGEX_CHARS) return `正则最多 ${MAX_REGEX_CHARS} 个字符`;
  if (/\\[1-9]|\(\?/.test(source)) return '正则不支持反向引用或断言';
  if (countUnboundedQuantifiers(source) > MAX_UNBOUNDED_QUANTIFIERS) {
    return `正则最多只允许 ${MAX_UNBOUNDED_QUANTIFIERS} 个不限长度的量词（*、+、{n,}）`;
  }
  if (boundedRepeatTooLarge(source)) return `有界重复的上下界不能超过 ${MAX_BOUNDED_REPEAT}`;
  // 分组整体重复（(a+)+ / (a|b)*）仍单独拒绝：即使只有一个不限量词，嵌套回溯也不可控
  if (/\((?:[^()\\]|\\.)*[*+{|](?:[^()\\]|\\.)*\)\s*[*+{]/.test(source)) {
    return '正则不能重复包含量词或分支的分组';
  }
  return '';
}

/** 校验整张规则表；返回错误文案（空串 = 通过）。 */
export function validateBlacklistKeywordRules(rules) {
  if (!Array.isArray(rules)) return '';
  if (rules.length > MAX_RULES) return `黑名单关键词最多 ${MAX_RULES} 条`;
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule.startsWith(REGEX_PREFIX)) continue;
    const reason = unsafeRegexReason(sourceOf(rule));
    if (reason) return `黑名单规则「${rule.slice(0, 80)}」无效：${reason}`;
    try { new RegExp(sourceOf(rule), 'iu'); } catch (error) {
      return `黑名单规则「${rule.slice(0, 80)}」无效：${error.message}`;
    }
  }
  return '';
}

/**
 * 配置加载时清洗：非法/不安全的规则**丢弃**，不让一条手改坏的正则拖垮 ingest。
 * 返回新数组，不改原值；超过上限的部分直接截断。
 */
export function sanitizeBlacklistKeywordRules(rules) {
  if (!Array.isArray(rules)) return [];
  const out = [];
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule || out.length >= MAX_RULES) continue;
    if (rule.startsWith(REGEX_PREFIX)) {
      if (unsafeRegexReason(sourceOf(rule))) continue;
      try { new RegExp(sourceOf(rule), 'iu'); } catch { continue; }
    }
    out.push(rule);
  }
  return out;
}

// 编译缓存：按"规则内容"缓存，配置不变时每条消息只做匹配，不再重复构造 RegExp。
let cache = { key: '', compiled: null };

function compileRules(rules) {
  const key = rules.map(ruleText).join('\u0000');
  if (cache.key === key && cache.compiled) return cache.compiled;
  const literals = [];
  const regexes = [];
  for (const raw of rules) {
    const rule = ruleText(raw);
    if (!rule) continue;
    if (!rule.startsWith(REGEX_PREFIX)) {
      literals.push(rule.toLocaleLowerCase());
      continue;
    }
    const source = sourceOf(rule);
    if (unsafeRegexReason(source)) continue;
    try { regexes.push(new RegExp(source, 'iu')); } catch { /* 手改坏的正则跳过 */ }
  }
  cache = { key, compiled: { literals, regexes } };
  return cache.compiled;
}

export function matchesBlacklistKeyword(text, rules = []) {
  const input = String(text ?? '');
  if (!input || !Array.isArray(rules) || !rules.length) return false;
  const { literals, regexes } = compileRules(rules);
  if (literals.length) {
    const lower = input.toLocaleLowerCase();
    for (const literal of literals) {
      if (literal && lower.includes(literal)) return true;
    }
  }
  if (!regexes.length) return false;
  // 正则只看前 2000 字：配合"最多一个不限量词"，把最坏回溯压到线性量级。
  const head = input.length > MAX_REGEX_INPUT_CHARS ? input.slice(0, MAX_REGEX_INPUT_CHARS) : input;
  for (const regex of regexes) {
    if (regex.test(head)) return true;
  }
  return false;
}
