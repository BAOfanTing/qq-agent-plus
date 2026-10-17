/**
 * 插件版本的规范化：撤回规则与注册表比较必须用同一把尺子。
 *
 * 索引是第三方内容源，`version` 可能写成 `1.0`、`v1.0.0`、`1.0.0+build`；
 * 而 manifest 校验后的版本总是 `x.y.z`。按字符串精确比较会漏掉这些等价写法 ——
 * 一条 `demo@1.0` 的撤回规则对已安装的 `1.0.0` 完全不起作用。
 */
export function canonicalVersion(value) {
  const core = String(value ?? '').trim().replace(/^[vV]/, '').split(/[-+]/)[0];
  if (!core) return '';
  const parts = core.split('.').map((n) => Number(n));
  if (!parts.length || parts.some((n) => !Number.isInteger(n) || n < 0)) return '';
  while (parts.length < 3) parts.push(0);
  return parts.slice(0, 3).join('.');
}

/** 撤回规则里的一侧：`id`（撤全部）或 `id@canonical`。 */
export function versionRule(id, version) {
  const canonical = canonicalVersion(version);
  return canonical ? `${id}@${canonical}` : String(id || '');
}
