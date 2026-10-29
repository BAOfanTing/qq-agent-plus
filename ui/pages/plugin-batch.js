// 插件批量升级：逐个预览权限 diff，汇总确认后调用现有安装接口。
// 单独成文件是为了不让 plugins.js 越过 max-lines 门禁；不持有全局状态。
async function upgradeAllPlugins({ post, setStatus, refreshPlugins, askForConfirmation }) {
  const buttons = [...document.querySelectorAll('#plugins-installed [data-plugin-action="upgrade"]')];
  const ids = [...new Set(buttons.map((button) => button.dataset.pluginId).filter(Boolean))];
  if (!ids.length) {
    setStatus('没有可升级的插件', { tone: 'info' });
    return;
  }
  if (!await askForConfirmation(`要升级 ${ids.length} 个插件：${ids.join('、')}？\n\n会先逐个检查权限差异；有权限变化时再一起确认，升级后相关写开关与批准会重置。`)) return;

  const plans = [];
  for (const id of ids) {
    try {
      const preview = await post('/api/plugins/upgrade-preview', { id });
      plans.push({ id, diff: preview.diff || null });
    } catch (error) {
      setStatus(`检查 ${id} 的权限差异失败：${error?.message || error}`, { tone: 'error' });
      return;
    }
  }
  const changed = plans.filter((plan) => plan.diff?.permissionChanged);
  if (changed.length) {
    const lines = changed.map((plan) =>
      `${plan.id}：${(plan.diff.summary || []).join('；') || '权限面有变化'}`).join('\n');
    if (!await askForConfirmation(`以下插件升级会改变权限：\n\n${lines}\n\n升级后相关写开关会自动关闭、对象级批准与待批会清空。确认全部升级？`)) return;
  }

  const failed = [];
  for (let i = 0; i < plans.length; i += 1) {
    const plan = plans[i];
    setStatus(`批量升级 ${i + 1}/${plans.length}：${plan.id}…`, { busy: true });
    try {
      await post('/api/plugins/install', {
        id: plan.id,
        ...(plan.diff?.permissionChanged && plan.diff.diffHash ? { expectedDiffHash: plan.diff.diffHash } : {})
      });
    } catch (error) {
      failed.push(`${plan.id}：${error?.message || error}`);
    }
  }
  await refreshPlugins();
  if (failed.length) {
    setStatus(`批量升级完成，${failed.length} 个失败：\n${failed.join('\n')}`, { tone: 'error' });
  } else {
    setStatus(`已升级 ${plans.length} 个插件（旧版留在 .backup-* 里）`, { tone: 'success' });
  }
}

export { upgradeAllPlugins };
