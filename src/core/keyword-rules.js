// Keyword rules are deliberately small: plain text is cheap, while `re:` enables
// a bounded subset of JavaScript regexes for administrators who need it.
const REGEX_PREFIX = 're:';
const MAX_RULES = 100;
const MAX_REGEX_CHARS = 160;

function sourceOf(rule) {
  return String(rule ?? '').trim().slice(REGEX_PREFIX.length);
}

function unsafeRegexReason(source) {
  if (!source) return '正则内容不能为空';
  if (source.length > MAX_REGEX_CHARS) return `正则最多 ${MAX_REGEX_CHARS} 个字符`;
  if (/\\[1-9]|\(\?/.test(source)) return '正则不支持反向引用或断言';
  if (/\((?:[^()\\]|\\.)*[*+{|](?:[^()\\]|\\.)*\)\s*[*+{]/.test(source)) {
    return '正则不能重复包含量词或分支的分组';
  }
  return '';
}

export function validateBlacklistKeywordRules(rules) {
  if (!Array.isArray(rules)) return '';
  if (rules.length > MAX_RULES) return `黑名单关键词最多 ${MAX_RULES} 条`;
  for (const raw of rules) {
    const rule = String(raw ?? '').trim();
    if (!rule.startsWith(REGEX_PREFIX)) continue;
    const reason = unsafeRegexReason(sourceOf(rule));
    if (reason) return `黑名单规则「${rule.slice(0, 80)}」无效：${reason}`;
    try { new RegExp(sourceOf(rule), 'iu'); } catch (error) {
      return `黑名单规则「${rule.slice(0, 80)}」无效：${error.message}`;
    }
  }
  return '';
}

export function matchesBlacklistKeyword(text, rules = []) {
  const input = String(text ?? '');
  if (!input || !Array.isArray(rules)) return false;
  const lower = input.toLocaleLowerCase();
  for (const raw of rules) {
    const rule = String(raw ?? '').trim();
    if (!rule) continue;
    if (!rule.startsWith(REGEX_PREFIX)) {
      if (lower.includes(rule.toLocaleLowerCase())) return true;
      continue;
    }
    try {
      if (new RegExp(sourceOf(rule), 'iu').test(input)) return true;
    } catch { /* Invalid manual rule is ignored until fixed. */ }
  }
  return false;
}
