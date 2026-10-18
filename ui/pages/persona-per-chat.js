// 按群人设的纯逻辑：选项生成与保存补丁装配。
//
// 抽成纯函数是为了能直接跑行为用例（不用搭 DOM）：换卡的字段清理、"
// 界面表达不了的旧条目要保住"这两类问题，靠字符串断言是测不出来的。
import { esc } from '../core/dom.js';

/**
 * 给一行生成下拉选项。
 * @param entry 该群的现有配置（可能只有 participation 这类界面表达不了的字段）
 * @param templates [[id, template], …]（含内置与自定义卡）
 */
function perChatOptions(entry, templates = []) {
  const builtins = templates.filter(([, t]) => t?.builtin);
  const customs = templates.filter(([, t]) => t && !t.builtin);
  const opts = ['<option value="">跟随全局</option>'];
  for (const [id, t] of builtins) {
    opts.push(`<option value="builtin:${esc(id)}"${entry?.templateId === id ? ' selected' : ''}>${esc(t.name)}</option>`);
  }
  for (const [id, t] of customs) {
    const hit = !entry?.templateId && entry?.roleText && entry.roleText === t.text;
    opts.push(`<option value="custom:${esc(id)}"${hit ? ' selected' : ''}>${esc(t.name)}（自定义）</option>`);
  }
  // 界面表达不了的条目一律给一个「保持」项：直接渲染成"跟随全局"会在下次保存时把它删掉
  // （手改的 participation / botName / 未知卡 id / 对不上任何卡的自定义正文）。
  const knownCard = entry?.templateId && templates.some(([id]) => id === entry.templateId);
  const knownCustom = !entry?.templateId && entry?.roleText && customs.some(([, t]) => t.text === entry.roleText);
  const expressible = !entry || knownCard || knownCustom || (!entry.templateId && !entry.roleText);
  if (entry && !expressible) {
    const label = entry.templateId
      ? `未知卡 ${entry.templateId}（回落全局）`
      : '自定义设置（保持）';
    opts.push(`<option value="keep" selected>${esc(label)}</option>`);
  } else if (entry && !entry.templateId && !entry.roleText) {
    // 只有 participation 之类的字段：同样要能"保持"
    opts.push('<option value="keep" selected>自定义设置（保持）</option>');
  }
  return opts.join('');
}

/**
 * 由页面上的行装配保存补丁。
 * @param rows [{ key, value }]（value 是下拉的值：'' / builtin:<id> / custom:<id> / keep）
 * @param currentMap 保存前的 personaPerChat
 * @param templates [[id, template], …]
 * @returns 新的 personaPerChat（整份）
 */
function buildPerChatPatch(rows, currentMap = {}, templates = []) {
  const out = {};
  for (const { key, value } of rows) {
    if (!/^(group|private):\d+$/.test(String(key || ''))) continue;
    const picked = String(value || '');
    if (!picked) continue;                       // 跟随全局
    const old = currentMap?.[key];
    if (picked === 'keep') {
      if (old && typeof old === 'object') out[key] = { ...old };
      continue;
    }
    // 换卡 = 采用这张卡的正文、档位与它自带的附加规则；实例级偏好（名字/参与度）保留
    const keepOthers = old && typeof old === 'object' ? { ...old } : {};
    delete keepOthers.roleText;
    delete keepOthers.changedAt;
    delete keepOthers.templateId;
    delete keepOthers.behaviorProfile;
    delete keepOthers.customRules;
    if (picked.startsWith('builtin:')) {
      out[key] = { ...keepOthers, templateId: picked.slice(8) };
      continue;
    }
    if (picked.startsWith('custom:')) {
      const tpl = templates.find(([id]) => id === picked.slice(7))?.[1];
      if (!tpl) continue;
      out[key] = { ...keepOthers, roleText: tpl.text, behaviorProfile: tpl.behaviorProfile || 'legacy' };
      if (tpl.customRules) out[key].customRules = tpl.customRules;
    }
  }
  return out;
}

export { perChatOptions, buildPerChatPatch };
