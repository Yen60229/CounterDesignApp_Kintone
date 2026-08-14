/**
 * 重號檢查（掛在「編號計數器」App 上使用）
 *
 * 【用途】
 * 子表格模式下 kintone 的「值的唯一性」用不了（不支援子表格內欄位），
 * 少了資料庫層的最後防線。本工具是它的替代品——**事後**掃描業務 App 的編號，
 * 把重複的號碼找出來。
 *
 * 刻意做成「事後檢查」而非「發號時擋下」：
 * 檢查不在發號的關鍵路徑上，壞掉也只是檢查沒跑，不會有人送不出單。
 * 若改成每次發號都去驗證，就多了一個會擋住使用者存檔的失敗點，
 * 那是維運上最擾民、也最難查的一種故障。
 *
 * 【檢查項目】
 *  ① 重複編號 —— 同一個號碼出現在兩筆以上（或同一筆的兩列）
 *  ② 空白編號 —— 該有號碼卻是空的，代表漏發或發號失敗
 *
 * 【安裝】
 * 編號計數器 App → 設定 → JavaScript / CSS 自訂 → 電腦版 JavaScript → 上傳本檔。
 * 可與「發號機批量建檔.js」並存（各自 IIFE，不會互相干擾）。
 *
 * 【使用】
 * 清單頁右上「重號檢查」→ 填業務 App ID 與編號欄位 → 開始檢查。
 */
(() => {
  'use strict';

  // 允許使用本工具的帳號代碼。清空陣列（[]）＝不限制。
  const AUTHORIZED_USERS = ['24136'];

  // 表單預設值
  const DEFAULTS = {
    sourceApp: '',
    numberField: '設備代號',
    subtableCode: '',
  };

  const QUERY_LIMIT = 500;
  const BUTTON_ID = 'dupcheck-button';
  const STYLE_ID = 'dupcheck-style';

  // ── DOM 小工具 ──────────────────────────────────────────────────────────

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.forEach((c) => node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return node;
  };

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = el('style', { id: STYLE_ID });
    style.textContent = `
      .dc-btn {
        background-color: #16a085; color: #fff; font-size: 14px; font-weight: bold;
        padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 0 8px;
      }
      .dc-btn:hover { background-color: #138d75; }
      .dc-btn:disabled { background-color: #bdc3c7; cursor: not-allowed; }
      .dc-btn--ghost { background-color: #95a5a6; }
      .dc-btn--ghost:hover { background-color: #7f8c8d; }

      .dc-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center; z-index: 10000;
      }
      .dc-modal {
        background: #fff; border-radius: 6px; width: min(820px, 94vw);
        max-height: 88vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); font-size: 14px;
      }
      .dc-head {
        padding: 16px 20px; border-bottom: 1px solid #e5e5e5;
        font-size: 16px; font-weight: bold; color: #2c3e50;
      }
      .dc-body { padding: 16px 20px; overflow: auto; }
      .dc-foot {
        padding: 12px 20px; border-top: 1px solid #e5e5e5;
        display: flex; justify-content: flex-end; gap: 4px;
      }
      .dc-row { display: flex; align-items: center; margin-bottom: 12px; }
      .dc-row > label { width: 170px; flex: none; color: #555; }
      .dc-row > input { flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 3px; }
      .dc-hint { color: #888; font-size: 12px; margin: 4px 0 14px 170px; }

      .dc-table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; }
      .dc-table th, .dc-table td {
        border: 1px solid #e5e5e5; padding: 5px 8px; text-align: left; font-size: 13px;
      }
      .dc-table th { background: #f7f7f7; }
      .dc-table a { color: #3498db; text-decoration: none; }
      .dc-table a:hover { text-decoration: underline; }

      .dc-ok   { color: #148f77; font-weight: bold; margin: 6px 0; }
      .dc-bad  { color: #c0392b; font-weight: bold; margin: 6px 0; }
      .dc-warn { color: #b9770e; margin: 6px 0; }
      .dc-note { color: #888; font-size: 12px; margin-top: 10px; }
      .dc-sub  { font-weight: bold; margin: 14px 0 4px; color: #2c3e50; }
    `;
    document.head.appendChild(style);
  };

  const api = (endpoint, method, params) =>
    kintone.api(kintone.api.url(endpoint, true), method, params);

  /** 分頁取回所有記錄。 */
  const fetchAll = async (app, fields, onProgress) => {
    const all = [];
    let offset = 0;
    for (;;) {
      const resp = await api('/k/v1/records', 'GET', {
        app,
        query: `limit ${QUERY_LIMIT} offset ${offset}`,
        fields,
      });
      const batch = resp.records || [];
      all.push(...batch);
      onProgress(all.length);
      if (batch.length < QUERY_LIMIT) return all;
      offset += QUERY_LIMIT;
    }
  };

  // ── 核心：掃描並找出重複 ────────────────────────────────────────────────

  /**
   * @returns {{ total:number, codes:number, blanks:object[], duplicates:object[] }}
   */
  const scan = async (cfg, onProgress) => {
    const isSub = !!cfg.subtableCode;
    // 子表格的值要以「子表格欄位代碼」取得；一般欄位則直接取該欄位
    const fields = ['$id', isSub ? cfg.subtableCode : cfg.numberField];

    const records = await fetchAll(cfg.sourceApp, fields, onProgress);

    /** @type {Map<string, {recordId:string, where:string}[]>} */
    const seen = new Map();
    const blanks = [];
    let codeCount = 0;

    const note = (code, recordId, where) => {
      if (!seen.has(code)) seen.set(code, []);
      seen.get(code).push({ recordId, where });
    };

    records.forEach((r) => {
      const recordId = r.$id.value;

      if (!isSub) {
        const v = r[cfg.numberField] ? String(r[cfg.numberField].value || '').trim() : '';
        if (!v) blanks.push({ recordId, where: '' });
        else { codeCount++; note(v, recordId, ''); }
        return;
      }

      const table = r[cfg.subtableCode];
      const rows = table && Array.isArray(table.value) ? table.value : [];
      rows.forEach((row, i) => {
        const f = row.value ? row.value[cfg.numberField] : null;
        const v = f ? String(f.value || '').trim() : '';
        const where = `第 ${i + 1} 列`;
        if (!v) blanks.push({ recordId, where });
        else { codeCount++; note(v, recordId, where); }
      });
    });

    const duplicates = [...seen.entries()]
      .filter(([, hits]) => hits.length > 1)
      .map(([code, hits]) => ({ code, hits }))
      .sort((a, b) => b.hits.length - a.hits.length || a.code.localeCompare(b.code));

    return { total: records.length, codes: codeCount, blanks, duplicates };
  };

  // ── 畫面 ────────────────────────────────────────────────────────────────

  const openDialog = () => {
    const overlay = el('div', { class: 'dc-overlay' });
    const body = el('div', { class: 'dc-body' });
    const foot = el('div', { class: 'dc-foot' });
    overlay.appendChild(
      el('div', { class: 'dc-modal' }, [el('div', { class: 'dc-head' }, ['重號檢查']), body, foot])
    );

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const inputs = {};
    const addRow = (key, label, hint) => {
      const input = el('input', { type: 'text', value: DEFAULTS[key] || '' });
      inputs[key] = input;
      body.appendChild(el('div', { class: 'dc-row' }, [el('label', {}, [label]), input]));
      if (hint) body.appendChild(el('div', { class: 'dc-hint' }, [hint]));
    };

    const renderForm = () => {
      body.textContent = '';
      foot.textContent = '';

      addRow('sourceApp', '業務 App ID', '要檢查哪個 App。開啟該 App，網址 /k/123/ 裡的 123。');
      addRow('numberField', '編號欄位代碼', '存放編號的欄位。若在表格裡，這裡填「表格內」的欄位代碼。');
      addRow('subtableCode', '表格欄位代碼（選填）', '編號在表格裡才要填；一般欄位請留空。');

      const msg = el('div', { class: 'dc-bad' });
      body.appendChild(msg);

      const run = el('button', { class: 'dc-btn' }, ['開始檢查']);
      run.onclick = async () => {
        const cfg = {
          sourceApp: inputs.sourceApp.value.trim(),
          numberField: inputs.numberField.value.trim(),
          subtableCode: inputs.subtableCode.value.trim(),
        };

        msg.textContent = '';
        if (!/^\d+$/.test(cfg.sourceApp)) { msg.textContent = '業務 App ID 必須是數字'; return; }
        if (!cfg.numberField) { msg.textContent = '請填編號欄位代碼'; return; }

        run.disabled = true;
        try {
          const result = await scan(cfg, (n) => { run.textContent = `讀取中... ${n} 筆`; });
          renderResult(cfg, result);
        } catch (err) {
          msg.textContent = `檢查失敗：${(err && err.message) || err}`;
          run.disabled = false;
          run.textContent = '開始檢查';
        }
      };

      foot.appendChild(el('button', { class: 'dc-btn dc-btn--ghost', onclick: close }, ['取消']));
      foot.appendChild(run);
    };

    const recordLink = (cfg, hit) => {
      const a = el('a', { href: `/k/${cfg.sourceApp}/show#record=${hit.recordId}`, target: '_blank' }, [
        `#${hit.recordId}${hit.where ? ` ${hit.where}` : ''}`,
      ]);
      return a;
    };

    const renderResult = (cfg, result) => {
      body.textContent = '';
      foot.textContent = '';

      body.appendChild(
        el('div', { class: 'dc-note' }, [
          `掃描 ${result.total} 筆記錄，共 ${result.codes} 個編號` +
            (cfg.subtableCode ? `（表格「${cfg.subtableCode}」逐列）` : ''),
        ])
      );

      // ① 重複編號
      body.appendChild(el('div', { class: 'dc-sub' }, ['① 重複編號']));
      if (result.duplicates.length === 0) {
        body.appendChild(el('div', { class: 'dc-ok' }, ['✓ 沒有重複編號']));
      } else {
        body.appendChild(
          el('div', { class: 'dc-bad' }, [`✗ 發現 ${result.duplicates.length} 個重複的編號`])
        );

        const table = el('table', { class: 'dc-table' });
        table.appendChild(
          el('thead', {}, [
            el('tr', {}, ['編號', '出現次數', '出現在'].map((h) => el('th', {}, [h]))),
          ])
        );
        const tbody = el('tbody');
        result.duplicates.forEach((d) => {
          const where = el('td');
          d.hits.forEach((hit, i) => {
            if (i) where.appendChild(document.createTextNode('、'));
            where.appendChild(recordLink(cfg, hit));
          });
          tbody.appendChild(
            el('tr', {}, [el('td', {}, [d.code]), el('td', {}, [String(d.hits.length)]), where])
          );
        });
        table.appendChild(tbody);
        body.appendChild(table);
      }

      // ② 空白編號
      body.appendChild(el('div', { class: 'dc-sub' }, ['② 空白編號']));
      if (result.blanks.length === 0) {
        body.appendChild(el('div', { class: 'dc-ok' }, ['✓ 沒有空白編號']));
      } else {
        body.appendChild(
          el('div', { class: 'dc-warn' }, [
            `${result.blanks.length} 處沒有編號 —— 可能是漏發、發號失敗，或該列本來就不需要編號。`,
          ])
        );
        const list = el('div', { class: 'dc-note' });
        result.blanks.slice(0, 30).forEach((hit, i) => {
          if (i) list.appendChild(document.createTextNode('、'));
          list.appendChild(recordLink(cfg, hit));
        });
        if (result.blanks.length > 30) {
          list.appendChild(document.createTextNode(` …等 ${result.blanks.length} 處`));
        }
        body.appendChild(list);
      }

      if (result.duplicates.length) {
        body.appendChild(
          el('div', { class: 'dc-note' }, [
            '處理建議：重複多半來自「計數器的 current 被改小」或「同一個 App 重複建了發號機」。' +
              '請先到編號計數器確認該台的 current 是否小於實際已使用的最大號，' +
              '再決定是要改號還是把 current 調到正確位置。',
          ])
        );
      }

      foot.appendChild(el('button', { class: 'dc-btn dc-btn--ghost', onclick: renderForm }, ['重新檢查']));
      foot.appendChild(el('button', { class: 'dc-btn', onclick: close }, ['關閉']));
    };

    renderForm();
    document.body.appendChild(overlay);
  };

  // ── 進入點 ──────────────────────────────────────────────────────────────

  kintone.events.on('app.record.index.show', (event) => {
    if (document.getElementById(BUTTON_ID)) return event;
    if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(kintone.getLoginUser().code)) {
      return event;
    }

    injectStyle();

    const button = el('button', { id: BUTTON_ID, class: 'dc-btn' }, ['重號檢查']);
    button.onclick = openDialog;

    const header = kintone.app.getHeaderMenuSpaceElement();
    if (header) header.appendChild(button);

    return event;
  });
})();
