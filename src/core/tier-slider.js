// 响应滑条：**滑条上的数字就是概率**。
//
// 语义（2026-09-22 改）：
//   - 滑条 0~100 = 普通消息的响应概率：拖到 30，就是大约每 100 批普通消息接 30 批。
//   - 被 @ 或命中关键词**一定**响应，不受这个数字影响（清空关键词表就只回 @）。
//   - 100% = 任何消息都响应（全响应）。
//
// 以前是四段式（0~10 仅艾特 / 10~20 +关键词 / 20~90 概率线性增长 / 90~100 全响应），
// "只有中间那 70% 才是概率、两端是特例" —— 用户反馈"概率调中等还是都回"就是这么来的。
// 老配置由 legacySliderToProbability / legacyTierToProbability 一次性换算（见 config-legacy.js）。
//
// 刻意做成**零依赖模块**：config.js（保存配置时派生）与 prompt.js（运行时判定）都要用它，
// 而 prompt.js 又 import config.js —— 放进任一方都会形成循环依赖。

/**
 * 概率取值：0~100；非法（NaN/空/负）按 fallback 处理。
 * @param {*} value 待解析的值
 * @param {number} fallback 非法时用的值（滑条默认 100 = 全响应，迁移场景传 0）
 */
export function clampProbability(value, fallback = 100) {
  // ⚠️ 先判"有没有值"：Number(null)/Number('') 都是 0，直接 Number() 会把"没填"读成 0%
  const missing = value === undefined || value === null || String(value).trim() === '';
  const n = missing ? NaN : Number(value);
  if (!Number.isFinite(n)) return Math.min(100, Math.max(0, Number(fallback) || 0));
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/**
 * 概率 → { tier, randomPercent }。
 * tier 只用来选"读多少条已读"和展示触发方式：0%→1、中间→3、100%→4。
 */
export function sliderToTier(pos) {
  const probability = clampProbability(pos, 100);
  return {
    tier: probability <= 0 ? 1 : (probability >= 100 ? 4 : 3),
    randomPercent: probability
  };
}

/** { tier, randomPercent } → 概率（把已保存的老配置还原成滑条位置）。 */
export function tierToSlider(tier, randomPercent = 0) {
  const t = Math.min(4, Math.max(1, Number(tier) || 4));
  if (t >= 4) return 100;
  if (t <= 2) return 0;   // 老的 1/2 档都不掷骰子；现在等价于"只回 @ 和关键词"
  return clampProbability(randomPercent, 0);
}

/**
 * 老四段式滑条位置 → 概率（一次性迁移用）。
 * 0~20 → 0；20~90 → 线性 ((pos-20)/70*100)；90~100 → 100。
 */
export function legacySliderToProbability(pos) {
  const raw = Number(pos);
  if (!Number.isFinite(raw)) return 100;
  const p = Math.min(100, Math.max(0, raw));
  if (p <= 20) return 0;
  if (p >= 90) return 100;
  return Math.round(((p - 20) / 70) * 1000) / 10;
}

/** 老 { tier, randomPercent } → 概率（老配置连滑条位置都没有时走这条）。 */
export function legacyTierToProbability(tier, randomPercent = 0) {
  const t = Math.min(4, Math.max(1, Number(tier) || 4));
  if (t >= 4) return 100;
  if (t <= 2) return 0;
  return clampProbability(randomPercent, 0);
}
