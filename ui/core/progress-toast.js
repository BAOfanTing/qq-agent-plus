// 右上角进度条。样式在 style.css 的 #progress-toast-* 一节，这里不写内联颜色（会跟错主题）。
// 同一时刻只保留一个实例。

const HOST_ID = 'progress-toast-host';
let activeToast = null;

function ensureHost() {
  let host = document.getElementById(HOST_ID);
  if (host) return host;
  host = document.createElement('div');
  host.id = HOST_ID;
  document.body.appendChild(host);
  return host;
}

/**
 * 返回句柄：update / setItems / done / fail / close / stopped。
 * 给了 onStop 才显示「停止」；点了只置位，不取消在途请求。
 */
function showProgressToast({ title = '处理中', total = 0, detail = '', onStop = null } = {}) {
  if (activeToast) activeToast.close();
  const host = ensureHost();

  const card = document.createElement('div');
  card.className = 'progress-toast-card';

  const head = document.createElement('div');
  head.className = 'progress-toast-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'progress-toast-title';
  titleEl.textContent = title;
  const countEl = document.createElement('span');
  countEl.className = 'progress-toast-count';
  head.append(titleEl, countEl);

  const track = document.createElement('div');
  track.className = 'progress-toast-track';
  const bar = document.createElement('div');
  bar.className = 'progress-toast-bar';
  track.appendChild(bar);

  const detailEl = document.createElement('div');
  detailEl.className = 'progress-toast-detail';
  detailEl.textContent = detail;

  // 条目列表，调用 setItems() 才出现
  const itemsEl = document.createElement('div');
  itemsEl.className = 'progress-toast-items';
  itemsEl.hidden = true;

  // token 消耗
  const tokenEl = document.createElement('div');
  tokenEl.className = 'progress-toast-tokens';
  tokenEl.hidden = true;

  // 停止按钮，给了 onStop 才出现
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'progress-toast-stop';
  stopBtn.textContent = '停止';
  stopBtn.hidden = typeof onStop !== 'function';

  card.append(head, track, detailEl, itemsEl, tokenEl, stopBtn);
  host.appendChild(card);
  // 下一帧再加 is-show，否则 transition 不触发
  requestAnimationFrame(() => card.classList.add('is-show'));

  let doneCount = 0;
  let totalCount = Math.max(0, Number(total) || 0);
  let tokensUsed = 0;
  let stopped = false;
  let timer = null;

  // 停止只置位，不取消在途请求；调用方每回合检查 stopped
  stopBtn.addEventListener('click', () => {
    if (stopped) return;
    stopped = true;
    stopBtn.disabled = true;
    stopBtn.textContent = '正在停止…';
    try { onStop(); } catch { /* 回调异常不该影响停止语义 */ }
  });

  const renderTokens = () => {
    if (tokensUsed > 0) {
      tokenEl.hidden = false;
      tokenEl.textContent = `本次消耗 ${tokensUsed.toLocaleString()} token`;
    }
  };

  const render = () => {
    // 宽度百分比 + 文字计数；总数为 0 时不画进度
    const pct = totalCount > 0 ? Math.min(100, Math.round((doneCount / totalCount) * 100)) : 0;
    bar.style.width = `${pct}%`;
    countEl.textContent = totalCount > 0 ? `${doneCount}/${totalCount}` : '';
  };
  render();

  const close = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    card.classList.remove('is-show');
    setTimeout(() => card.remove(), 200);
    if (activeToast && activeToast.card === card) activeToast = null;
  };

  /* 收尾：定成完成/失败态，停留 5 秒后消失。 */
  const STAY_MS = 5000;
  const finish = (text, { ok }) => {
    if (timer) clearTimeout(timer);
    titleEl.textContent = ok ? `${title} · 完成` : `${title} · 失败`;
    card.classList.add(ok ? 'is-done' : 'is-fail');
    detailEl.textContent = text;
    countEl.textContent = ok && totalCount > 0 ? `${doneCount}/${totalCount}` : '';
    // 失败也显示 token（钱一样花了）
    renderTokens();
    // 收尾后收起停止按钮
    stopBtn.hidden = true;
    timer = setTimeout(close, STAY_MS);
  };

  const handle = {
    card,
    /* 用户是否点了停止 */
    get stopped() { return stopped; },
    update({ done, total: nextTotal, detail: nextDetail, tokens } = {}) {
      if (Number.isFinite(Number(done))) doneCount = Number(done);
      if (Number.isFinite(Number(nextTotal)) && Number(nextTotal) > 0) totalCount = Number(nextTotal);
      if (typeof nextDetail === 'string') detailEl.textContent = nextDetail;
      if (Number.isFinite(Number(tokens))) { tokensUsed = Number(tokens); renderTokens(); }
      render();
    },
    /* 设置条目：{ key, imageUrl, note, status('running'|'ok'|'fail') }。 */
    setItems(items) {
      const list = Array.isArray(items) ? items.filter(Boolean) : [];
      if (!list.length) { itemsEl.hidden = true; itemsEl.textContent = ''; return; }
      itemsEl.hidden = false;
      // 按 key 增量更新，避免重建导致缩略图闪烁；key 重复会共用 DOM，故用 #n 去重
      const seen = new Map();
      const wanted = list.map((item, index) => {
        const base = String(item.key ?? `row-${index}`);
        const count = seen.get(base) || 0;
        seen.set(base, count + 1);
        return count === 0 ? base : `${base}#${count}`;
      });
      const existingByKey = new Map();
      for (const row of [...itemsEl.children]) {
        if (wanted.includes(row.dataset.key)) existingByKey.set(row.dataset.key, row);
        else row.remove();
      }
      for (const [index, key] of wanted.entries()) {
        let row = existingByKey.get(key);
        if (!row) {
          row = document.createElement('div');
          row.className = 'progress-toast-item';
          row.dataset.key = key;
          const thumb = document.createElement('img');
          thumb.className = 'progress-toast-thumb';
          thumb.alt = '正在备注的表情';
          thumb.loading = 'lazy';
          thumb.referrerPolicy = 'no-referrer';
          const note = document.createElement('div');
          note.className = 'progress-toast-note';
          row.append(thumb, note);
        }
        // 顺序对不上就挪位置
        if (itemsEl.children[index] !== row) itemsEl.insertBefore(row, itemsEl.children[index] || null);
      }
      for (const [index, item] of list.entries()) {
        const row = itemsEl.children[index];
        if (!row) continue;
        const thumb = row.querySelector('.progress-toast-thumb');
        const note = row.querySelector('.progress-toast-note');
        const status = item.status || 'running';
        row.dataset.status = status;
        if (item.imageUrl && thumb.getAttribute('src') !== item.imageUrl) thumb.src = item.imageUrl;
        if (!item.imageUrl) thumb.removeAttribute('src');
        thumb.hidden = !item.imageUrl;
        note.textContent = item.note
          || (status === 'running' ? '处理中…' : (status === 'fail' ? '失败' : ''));
      }
    },
    done(text = '') { finish(text || `已处理 ${doneCount} 项`, { ok: true }); },
    fail(text = '') { finish(text || '处理失败', { ok: false }); },
    close
  };
  activeToast = handle;
  return handle;
}

export { showProgressToast };
