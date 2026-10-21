// 「重新备注」：批量给没有备注的表情补写 AI 备注。
// 三条别随手改：必须带 id（否则失败那条一直占队首、坏图烧光轮次）；
// 进度框行的 key 定死后不改；单次失败不中止，连续 3 次才停。
import { api } from '../core/api.js';
import { $ } from '../core/dom.js';
import { fmtTok } from '../core/format.js';
import { showProgressToast } from '../core/progress-toast.js';
import { closeModelModal, modelModalShell } from '../app.js';

/* 问用户备注几张，取消返回 0。 */
function askRenoteCount({ pending = 0, suggested = 10 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const max = Math.max(1, Math.min(50, Number(pending) || 1));
    const init = Math.max(1, Math.min(max, Number(suggested) || 1));
    const overlay = modelModalShell({
      head: '重新备注',
      body: `
        <div style="white-space:pre-wrap;line-height:1.7">还有 <b>${pending}</b> 张表情没有备注。</div>
        <div class="field" style="margin-top:12px">
          <label for="renote-count">这次处理几张（1-${max}）</label>
          <input type="number" id="renote-count" min="1" max="${max}" step="1" value="${init}" />
        </div>
        <div class="hint">每张调用一次视觉模型（消耗 token），已有备注的不会被改动。
        运行中可以随时点进度框上的「停止」。</div>`,
      foot: '<button type="button" class="btn" data-renote-cancel>取消</button>'
        + '<button type="button" class="btn btn-primary" data-renote-accept>开始备注</button>'
    });
    const input = overlay.querySelector('#renote-count');
    const finish = (value) => {
      if (settled) return;
      settled = true;
      closeModelModal(overlay);
      resolve(value);
    };
    const readValue = () => {
      const raw = Number(input?.value);
      if (!Number.isFinite(raw) || raw < 1) return 0;
      return Math.min(max, Math.floor(raw));
    };
    overlay.querySelector('[data-renote-cancel]').addEventListener('click', () => finish(0));
    overlay.querySelector('[data-renote-accept]').addEventListener('click', () => {
      const value = readValue();
      if (!value) { input?.focus(); return; }
      finish(value);
    });
    // 回车即开始
    input?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); overlay.querySelector('[data-renote-accept]')?.click(); }
    });
    overlay.querySelector('.model-modal-close')?.addEventListener('click', () => finish(0));
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) finish(0);
    });
    setTimeout(() => { input?.focus(); input?.select(); }, 30);
  });
}

/* 顶部提示条；找不到就跳过。 */
function setHint(text) {
  const hint = document.getElementById('provider-action-hint');
  if (hint) hint.textContent = text;
}

/* 装点击处理；refresh 由调用方注入，避免循环依赖。 */
function bindRenoteButton(refresh) {
  const button = $('#asset-renote');
  if (!button) return;
  button.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    const idle = btn.textContent;
    const restore = () => { btn.disabled = false; btn.textContent = idle; };

    btn.disabled = true;
    btn.textContent = '检查中…';
    let status = null;
    try {
      status = await api('/api/assets/stickers/renote-status');
    } catch (e) {
      setHint(`检查失败：${e.message}`);
      restore();
      return;
    }

    // 看不了图先说清原因
    if (!status?.canVision) {
      const why = status?.visionSwitch === false
        ? '「模型 API」页的「图片输入」开关是关的'
        : '当前模型被判定为不支持图片输入';
      if (typeof window.alert === 'function') {
        window.alert(`没法给表情写备注：${why}。\n\n请换一个支持视觉的模型，或在「平台能力」页跑一次视觉扫描确认。`);
      }
      restore();
      return;
    }
    if (!status?.pending) {
      setHint('所有表情都已经有备注了');
      restore();
      return;
    }

    // 张数由用户定（批量烧 token）
    const picked = await askRenoteCount({ pending: status.pending, suggested: Math.min(10, status.pending) });
    if (!picked) { restore(); return; }
    const count = Math.min(picked, status.pending);
    const previews = Array.isArray(status.previews) ? status.previews : [];

    btn.textContent = '备注中…';
    const toast = showProgressToast({
      title: '正在生成表情备注',
      total: count,
      detail: '准备中…',
      onStop: () => toast.update({ detail: '正在停止（等当前这张完成）…' })
    });

    let updated = 0;
    let totalTokens = 0;
    let doneCount = 0;
    const failures = [];
    let userStopped = false;
    let abortedReason = '';
    // 连续失败在前端计数（每批只发一条，后端攒不满），成功即清零
    let consecutiveNoVision = 0;
    let consecutiveRateLimited = 0;

    // rows 累积所有处理过的条目，slotAt 记槽位 → 下标；只显示最近 MAX_ROWS 行
    const MAX_ROWS = 6;
    const rows = [];
    const slotAt = new Map();
    let rowSeq = 0;
    const renderItems = () => toast.setItems(rows.slice(-MAX_ROWS));
    const openSlot = (slot, patch) => {
      // key 定死后不改，否则会被当成新行 → 同一张图显示两行
      rowSeq += 1;
      rows.push({ ...patch, key: `row-${rowSeq}`, status: 'running' });
      slotAt.set(slot, rows.length - 1);
      renderItems();
    };
    /* 该行处理完：原地改状态，行保留。 */
    const closeSlot = (slot, patch) => {
      const index = slotAt.get(slot);
      if (index === undefined || !rows[index]) return;
      rows[index] = { ...rows[index], ...patch };
      slotAt.delete(slot);
      renderItems();
    };

    /* 累计统计并判断是否该停（'stop' = 停）。 */
    const consume = (r, slotIndex) => {
      if (r?.updated) updated += 1;
      if (r?.failed?.length) failures.push(r.failed[0]?.reason || '未知原因');
      totalTokens += Number(r?.tokens?.totalTokens) || 0;
      doneCount += 1;

      if (r?.updated) {
        consecutiveNoVision = 0;
        consecutiveRateLimited = 0;
        const item = r?.items?.[0];
        if (item) {
          const img = item.imageUrl
            || (item.hasLocalFile ? `/api/assets/stickers/image?id=${encodeURIComponent(item.id)}` : '');
          closeSlot(slotIndex, { imageUrl: img, note: item.note, status: 'ok' });
        } else if (Number.isInteger(slotIndex)) {
          closeSlot(slotIndex, { status: 'ok', note: '已完成' });
        }
      } else if (r?.failed?.length) {
        const reason = String(r.failed[0]?.reason || '');
        if (Number.isInteger(slotIndex)) closeSlot(slotIndex, { status: 'fail', note: reason.slice(0, 60) });
        if (r?.aborted) {
          abortedReason = r.abortReason || reason || '已中止';
          return 'stop';
        }
        const rateLimited = r.failed[0]?.rateLimited === true || /限流|429|rpm/i.test(reason);
        if (rateLimited) {
          consecutiveRateLimited += 1;
          consecutiveNoVision = 0;
          if (consecutiveRateLimited >= 2) {
            abortedReason = '连续被限流（请求太快），先停一下，等几秒再继续';
            return 'stop';
          }
        } else if (/看不到|没有看到|没有收到/.test(reason)) {
          consecutiveNoVision += 1;
          consecutiveRateLimited = 0;
          if (consecutiveNoVision >= 2) {
            abortedReason = `${reason}（连续 ${consecutiveNoVision} 张都看不到图，已停止）`;
            return 'stop';
          }
        }
      }
      toast.update({ done: doneCount, total: count, tokens: totalTokens });
      return 'go';
    };

    const runOnce = (id = '') => api('/api/assets/stickers/renote', {
      method: 'POST',
      body: JSON.stringify(id ? { confirm: true, id } : { confirm: true, max: 1 })
    });

    // 串行 + 按 id 点名（原因见文件头）；串行是因为并发时进度框的行太容易撞
    let plainFailures = 0;
    const MAX_PLAIN_FAILURES = 3;
    try {
      for (let i = 0; i < count; i += 1) {
        if (toast.stopped) { userStopped = true; break; }
        if (abortedReason) break;

        const preview = previews[i] || null;
        openSlot(0, {
          imageUrl: preview?.imageUrl || '',
          note: '处理中…'
        });
        toast.update({ done: doneCount, total: count, detail: `第 ${i + 1}/${count} 张` });

        const r = await runOnce(preview?.id || '')
          .catch((error) => ({ failed: [{ reason: String(error?.message || error) }], updated: 0 }));
        if (!r?.updated) plainFailures += 1;
        else plainFailures = 0;
        if (consume(r, 0) === 'stop') { abortedReason = abortedReason || '已中止'; break; }
        // 普通失败 consume 里不中止，连撞 3 次停手
        if (plainFailures >= MAX_PLAIN_FAILURES) {
          abortedReason = `连续 ${plainFailures} 张失败（${failures[failures.length - 1] || '原因未知'}），已停止`;
          break;
        }
      }
      if (toast.stopped) userStopped = true;

      const tail = `${failures.length ? `，${failures.length} 条失败` : ''} · 消耗 ${fmtTok(totalTokens)} token`;
      if (userStopped) {
        toast.done(`已停止 · 补了 ${updated} 条${tail}`);
      } else if (abortedReason) {
        toast.fail(`${abortedReason}（补了 ${updated} 条 · 消耗 ${fmtTok(totalTokens)} token）`);
      } else if (failures.length && !updated) {
        toast.fail(failures[0]);
      } else {
        toast.done(`已补 ${updated} 条${tail}`);
      }
    } catch (e) {
      toast.fail(e.message);
    } finally {
      restore();
      if (typeof refresh === 'function') refresh();
    }
  });
}

export { askRenoteCount, bindRenoteButton };
