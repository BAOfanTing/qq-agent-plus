// JSON 修复共享 util：模型吐出的"准 JSON"常见瑕疵在这里统一收敛。
// 调用方：tools-core（inline 工具参数兜底）与 relationship-pilot（影子评估解析，
// Issue #6：长输出里 note 字段引用原话产生未转义引号，上线当天复现的那单）。
// 修复是尽力而为：任何一层解析成功即返回对象；全部失败返回 null，由调用方决定抛错。
// 注意：修复只在"原文解析已失败"之后使用，成功解析过的内容绝不再动。

/**
 * 逐字符扫描，给双引号字符串内部的未转义双引号补上反斜杠。
 * 判定依据：字符串内的 `"` 后面（跳过空白）跟的是 `,` `:` `}` `]` 或文本结束，
 * 才算真正的字符串结尾；否则视为内容里的引号，转义之。
 * 返回修复后的文本；无可修点（原文没有可修点，或修完引号仍未闭合）时返回 null。
 */
export function repairUnescapedStringQuotes(value) {
  const text = String(value ?? '');
  let output = '';
  let inString = false;
  let escaped = false;
  let changed = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      output += char;
      escaped = true;
      continue;
    }
    if (char !== '"') {
      output += char;
      continue;
    }

    let nextIndex = index + 1;
    while (nextIndex < text.length && /\s/.test(text[nextIndex])) nextIndex += 1;
    const next = text[nextIndex];
    if (next === undefined || [',', ':', '}', ']'].includes(next)) {
      output += char;
      inString = false;
    } else {
      output += '\\"';
      changed = true;
    }
  }

  return changed && !inString ? output : null;
}

const isStructural = (ch) => ch === undefined || ch === ',' || ch === ':' || ch === '}' || ch === ']';
const skipSpaces = (text, index) => {
  let next = index + 1;
  while (next < text.length && /\s/.test(text[next])) next += 1;
  return text[next];
};

/**
 * 全量归一化（处理四类瑕疵的叠加形态）：
 *   1. 尾随逗号：`[1,2,]` / `{"a":1,}`（字符串感知，"a,}" 这类内容不会被误改）
 *   2. 单引号字符串 → 双引号（含撇号正确处理：'it's' → "it's"）
 *   3. 双引号字符串内的未转义双引号 → 转义
 *   4. 前后缀文本 / 代码围栏：由调用方先做 base 切分，本函数只管引号与逗号
 * 输出恒为文本（调用方自行 JSON.parse）；语义是"尽力归一化"，不保证成功。
 */
function normalizeQuotesAndCommas(text) {
  let output = '';
  // 'code' = 结构区；'dq' = 原生双引号字符串；'sq' = 单引号字符串（转成双引号输出）
  let mode = 'code';
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (mode === 'code') {
      if (char === '"') { mode = 'dq'; output += char; continue; }
      if (char === "'") { mode = 'sq'; output += '"'; continue; }
      if (char === ',') {
        const following = skipSpaces(text, index);
        if (following === '}' || following === ']') continue; // 丢掉尾逗号
      }
      output += char;
      continue;
    }
    if (escaped) { output += char; escaped = false; continue; }
    if (char === '\\') { output += char; escaped = true; continue; }
    if (mode === 'dq') {
      if (char === '"') {
        if (isStructural(skipSpaces(text, index))) { mode = 'code'; output += char; }
        else output += '\\"'; // 字符串内容里的引号
        continue;
      }
      output += char; // 单引号在双引号字符串里是普通内容
      continue;
    }
    // sq → 双引号输出
    if (char === "'") {
      if (isStructural(skipSpaces(text, index))) { mode = 'code'; output += '"'; }
      else output += "'"; // 撇号（it's）是内容；双引号 JSON 里单引号无需转义
      continue;
    }
    if (char === '"') { output += '\\"'; continue; } // 单引号字符串里嵌的双引号是内容
    output += char;
  }
  return output;
}

function tryParse(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * 把"准 JSON"修成对象。处理四类常见瑕疵（可叠加）：
 *   1. 代码围栏：```json … ``` 或 ``` … ```
 *   2. 前后缀文本：只取首尾大括号之间的部分
 *   3. 尾随逗号（字符串感知）
 *   4. 单引号包字符串 / 字符串内未转义双引号（含两者混合 + 撇号）
 * 全部失败返回 null。
 */
export function repairJsonObject(raw) {
  const original = String(raw ?? '').trim();
  if (!original) return null;

  const bases = new Set();
  const addBase = (value) => {
    const text = String(value ?? '').trim();
    if (text) bases.add(text);
  };
  addBase(original);
  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(original);
  if (fence?.[1]) addBase(fence[1]);
  const first = original.indexOf('{');
  const last = original.lastIndexOf('}');
  if (first >= 0 && last > first) addBase(original.slice(first, last + 1));

  for (const base of bases) {
    const parsed = tryParse(base);
    if (parsed) return parsed;
    const normalized = normalizeQuotesAndCommas(base);
    if (normalized !== base) {
      const repaired = tryParse(normalized);
      if (repaired) return repaired;
      // 归一化后再过一遍未转义引号修复（归一化对个别形态会留下可修点）
      const quoted = repairUnescapedStringQuotes(normalized);
      if (quoted) {
        const repairedTwice = tryParse(quoted);
        if (repairedTwice) return repairedTwice;
      }
    }
  }
  return null;
}
