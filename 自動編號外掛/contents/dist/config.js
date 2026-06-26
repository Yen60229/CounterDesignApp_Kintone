(() => {
  'use strict';

  const UI_VERSION = '1.1.0';
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const APP_ID = kintone.app.getId();

  const raw = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  let state;
  try { state = JSON.parse(raw.data || '{}'); } catch (e) { state = {}; }

  // 預設值
  if (!state.version) state.version = '1.0';
  if (state.counterApp === undefined) state.counterApp = '';
  if (state.counterToken === undefined) state.counterToken = '';
  if (state.selfToken === undefined) state.selfToken = '';
  if (state.numberField === undefined) state.numberField = '';
  if (state.categoryField === undefined) state.categoryField = '';
  if (state.activeQuery === undefined) state.activeQuery = 'active in ("啟用")';
  if (!Array.isArray(state.triggers)) state.triggers = ['create.submit', 'edit.submit'];
  if (state.statusCond === undefined) state.statusCond = '*';
  if (state.toStatus === undefined) state.toStatus = '*';
  if (state.actionName === undefined) state.actionName = '*';
  if (state.confirmMessage === undefined) state.confirmMessage = '此記錄將於儲存後自動產生編號，是否繼續？';
  if (state.maxRetry === undefined) state.maxRetry = 5;
  if (!Array.isArray(state.categories)) state.categories = [];

  const TRIGGER_OPTS = [
    { v: 'create.submit', l: '新增儲存（create.submit）' },
    { v: 'edit.submit',   l: '編輯儲存（edit.submit）' },
    { v: 'process.proceed', l: '流程推進（process.proceed）' },
  ];

  const MODE_OPTS = [
    { v: 'issue', l: '發號（由 Counter App 遞增）' },
    { v: 'copy',  l: '抄錄欄位（旁路，不發號）' },
  ];

  const VALIDATE_OPTS = [
    { v: '',       l: '不驗證' },
    { v: 'taxId8', l: '統一編號 8 碼數字' },
  ];

  // ── DOM helpers ──
  const el = (tag, props = {}, children = []) => {
    const e = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') e.className = v;
      else if (k === 'style') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    });
    children.forEach((c) => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
    return e;
  };

  const select = (options, value, onChange, attrs = {}) => {
    // 以 searchableSelect 取代標準 select，使所有下拉選單皆可搜尋
    return searchableSelect(options, value, onChange);
  };

  const textInput = (value, onChange, placeholder = '') => {
    const i = el('input', { type: 'text', placeholder });
    i.value = value == null ? '' : value;
    i.addEventListener('input', (e) => onChange(e.target.value));
    return i;
  };

  const numberInput = (value, onChange, placeholder = '') => {
    const i = el('input', { type: 'number', placeholder, min: '1' });
    i.value = value == null ? '' : value;
    i.addEventListener('input', (e) => onChange(e.target.value));
    return i;
  };

  const checkbox = (checked, onChange, label) => {
    const id = `cb-${Math.random().toString(36).slice(2, 8)}`;
    const cb = el('input', { type: 'checkbox', id });
    cb.checked = !!checked;
    cb.addEventListener('change', (e) => onChange(e.target.checked));
    const wrap = el('label', { for: id, style: { display: 'inline-flex', gap: '4px', alignItems: 'center' } });
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(' ' + label));
    return wrap;
  };

  const searchableSelect = (options, currentValue, onChange) => {
    const wrap = el('div', { class: 'anum-ss-wrap' });
    let _val = currentValue;
    const findLabel = (v) => { const o = options.find((x) => x.v === v); return o ? o.l : (v || ''); };
    const inp = el('input', { type: 'text', class: 'anum-ss-input', autocomplete: 'off', placeholder: '🔍 搜尋或點選...' });
    inp.value = findLabel(_val);
    const list = el('div', { class: 'anum-ss-list' });
    const buildList = (filter) => {
      list.innerHTML = '';
      const lf = (filter || '').toLowerCase();
      const shown = lf ? options.filter((o) => o.l.toLowerCase().includes(lf) || o.v.toLowerCase().includes(lf)) : options;
      if (!shown.length) {
        list.appendChild(el('div', { class: 'anum-ss-empty' }, ['無符合選項']));
      } else {
        shown.forEach((o) => {
          const item = el('div', { class: 'anum-ss-item' + (o.v === _val ? ' anum-ss-active' : '') }, [o.l]);
          item.title = o.l;
          item.addEventListener('mousedown', (e) => {
            e.preventDefault(); _val = o.v; inp.value = o.l; list.style.display = 'none'; onChange(o.v);
          });
          list.appendChild(item);
        });
      }
      list.style.display = 'block';
    };
    inp.addEventListener('focus', () => { inp.select(); buildList(''); });
    inp.addEventListener('input', (e) => buildList(e.target.value));
    inp.addEventListener('blur', () => { setTimeout(() => { list.style.display = 'none'; inp.value = findLabel(_val); }, 200); });
    wrap.appendChild(inp);
    wrap.appendChild(list);
    return wrap;
  };

  let FIELD_OPTIONS = [{ v: '', l: '— 載入中 —' }];
  const loadFields = () => {
    if (!window.KintoneConfigHelper) return Promise.resolve([]);
    return KintoneConfigHelper.getFields()
      .then((fields) => {
        const opts = [{ v: '', l: '— 請選擇 —' }];
        (fields || []).forEach((f) => opts.push({ v: f.code, l: `${f.label} (${f.code}) [${f.type}]` }));
        FIELD_OPTIONS = opts;
        return opts;
      })
      .catch(() => []);
  };

  const root = document.getElementById('ui-section');

  const render = () => {
    root.innerHTML = '';
    root.appendChild(renderToolbar());
    root.appendChild(renderCounterSection());
    root.appendChild(renderFieldSection());
    root.appendChild(renderTriggerSection());
    root.appendChild(renderCategorySection());
  };

  const mkRow = (grid, label, control) => {
    grid.appendChild(el('div', { class: 'anum-label' }, [label]));
    grid.appendChild(control);
  };

  // 1. 計數器（Counter App）設定
  const renderCounterSection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(el('h3', { class: 'anum-section-title' }, ['1. 計數器（Counter App）設定']));
    sec.appendChild(el('p', { class: 'anum-section-help' }, [
      '發號由獨立的 Counter App 統一管理，靠各筆記錄的 revision 樂觀鎖保證號碼唯一。',
    ]));
    sec.appendChild(el('p', { class: 'anum-section-help warn' }, [
      '⚠ Counter App 需具備欄位代碼：source_app_id、category_key、prefix、pad、' +
      'number_format、reset_cycle、period_tag、current、last_issued_at、active。' +
      '編號樣式（RN000001 / RN-001…）由 Counter App 各筆的 number_format 欄位決定，後台改樣式免動本外掛。',
    ]));
    const grid = el('div', { class: 'anum-grid' });
    mkRow(grid, 'Counter App ID', textInput(state.counterApp, (v) => { state.counterApp = v.trim(); }, '例：100'));
    mkRow(grid, 'Counter API Token', textInput(state.counterToken, (v) => { state.counterToken = v.trim(); },
      '建議填。具「記錄編輯」權限，讓使用者即使無權限也能成功發號'));
    mkRow(grid, '本 App Token', textInput(state.selfToken, (v) => { state.selfToken = v.trim(); },
      '選填。回寫編號用；流程推進後使用者已無編輯權時需要'));
    mkRow(grid, 'active 查詢條件', textInput(state.activeQuery, (v) => { state.activeQuery = v; },
      '預設 active in ("啟用")。請對應 Counter App 啟用核取方塊的實際值'));
    sec.appendChild(grid);
    return sec;
  };

  // 2. 業務欄位設定
  const renderFieldSection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(el('h3', { class: 'anum-section-title' }, ['2. 業務 App 欄位']));
    sec.appendChild(el('p', { class: 'anum-section-help' }, [
      '「編號欄位」建議勾選 kintone「值的唯一性」作為最後防線。',
    ]));
    const grid = el('div', { class: 'anum-grid' });
    mkRow(grid, '編號欄位（寫入目標）', searchableSelect(FIELD_OPTIONS, state.numberField, (v) => { state.numberField = v; }));
    mkRow(grid, '分類欄位（決定規則）', searchableSelect(FIELD_OPTIONS, state.categoryField, (v) => { state.categoryField = v; }));
    sec.appendChild(grid);
    return sec;
  };

  // 3. 觸發與 UI 設定
  const renderTriggerSection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(el('h3', { class: 'anum-section-title' }, ['3. 觸發時機與確認訊息']));
    sec.appendChild(el('p', { class: 'anum-section-help' }, [
      '儲存類觸發（create/edit）會在「儲存成功後」才發號回寫，避免取消造成跳號；' +
      '流程推進觸發則於推進當下原子寫入。',
    ]));

    const checks = el('div', { class: 'anum-checks' });
    TRIGGER_OPTS.forEach((t) => {
      checks.appendChild(checkbox(state.triggers.includes(t.v), (on) => {
        const set = new Set(state.triggers);
        if (on) set.add(t.v); else set.delete(t.v);
        state.triggers = Array.from(set);
      }, t.l));
    });
    sec.appendChild(checks);

    const grid = el('div', { class: 'anum-grid', style: { marginTop: '12px' } });
    mkRow(grid, '確認訊息文字', textInput(state.confirmMessage, (v) => { state.confirmMessage = v; }, '儲存前彈出的 UI 提示'));
    mkRow(grid, '狀態條件（編輯儲存）', textInput(state.statusCond, (v) => { state.statusCond = v; }, '* 表示任意；填狀態名稱限定'));
    mkRow(grid, '到狀態（流程推進）', textInput(state.toStatus, (v) => { state.toStatus = v; }, '* 表示任意'));
    mkRow(grid, '動作名稱（流程推進）', textInput(state.actionName, (v) => { state.actionName = v; }, '* 表示任意'));
    mkRow(grid, '併發重試次數', numberInput(state.maxRetry, (v) => { state.maxRetry = Number(v) || 5; }, '預設 5'));
    sec.appendChild(grid);
    return sec;
  };

  // 4. 分類規則
  const renderCategorySection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(el('h3', { class: 'anum-section-title' }, ['4. 分類規則']));
    sec.appendChild(el('p', { class: 'anum-section-help' }, [
      '「分類值」要與分類欄位選項完全相同（會直接用此值當 Counter App 的 category_key）。' +
      '發號類無需另填參數；抄錄類填要複製的來源欄位代碼（如國內供應商抄統一編號）。',
    ]));

    const table = el('table', { class: 'anum-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { style: { width: '25%' } }, ['分類值（比對）']),
      el('th', { style: { width: '18%' } }, ['模式']),
      el('th', { style: { width: '30%' } }, ['參數（抄錄時填來源欄位）']),
      el('th', { style: { width: '19%' } }, ['驗證']),
      el('th', { style: { width: '8%' } }, ['']),
    ])]));
    const tbody = el('tbody');
    state.categories.forEach((c, i) => {
      const paramCell = c.mode === 'copy'
        ? textInput(c.copyField, (v) => { state.categories[i].copyField = v; }, '來源欄位代碼，例：統一編號')
        : el('span', { style: { color: '#999', fontSize: '13px' } }, ['（用分類值本身）']);
      const validateCell = c.mode === 'copy'
        ? select(VALIDATE_OPTS, c.validate || '', (v) => { state.categories[i].validate = v; })
        : el('span', { style: { color: '#bbb', fontSize: '12px' } }, ['—']);

      tbody.appendChild(el('tr', {}, [
        el('td', {}, [textInput(c.match, (v) => { state.categories[i].match = v; }, '例：境外供應商')]),
        el('td', {}, [select(MODE_OPTS, c.mode || 'issue', (v) => { state.categories[i].mode = v; render(); })]),
        el('td', {}, [paramCell]),
        el('td', {}, [validateCell]),
        el('td', {}, [el('button', { class: 'anum-btn-row', onclick: () => { state.categories.splice(i, 1); render(); } }, ['✕'])]),
      ]));
    });
    table.appendChild(tbody);
    sec.appendChild(table);
    sec.appendChild(el('button', {
      class: 'anum-btn anum-btn-add',
      onclick: () => { state.categories.push({ match: '', mode: 'issue', copyField: '', validate: '' }); render(); },
    }, ['+ 新增分類規則']));
    return sec;
  };

  const renderToolbar = () => {
    const bar = el('div', { class: 'anum-toolbar' });
    bar.appendChild(el('span', { style: { fontSize: '12px', color: '#9aa3ad' } }, [`設定畫面 v${UI_VERSION}`]));
    const msg = el('span', { id: 'anum-msg', style: { fontSize: '13px', flex: '1', marginLeft: '8px' } });
    bar.appendChild(msg);
    bar.appendChild(el('button', { class: 'anum-btn', onclick: () => { history.back(); } }, ['取消']));
    bar.appendChild(el('button', { class: 'anum-btn anum-btn-primary', onclick: save }, ['儲存']));
    return bar;
  };

  const validate = () => {
    const errors = [];
    if (!state.counterApp) errors.push('缺少 Counter App ID');
    if (!state.numberField) errors.push('缺少編號欄位');
    if (!state.categoryField) errors.push('缺少分類欄位');
    if (!state.triggers.length) errors.push('至少勾選一個觸發時機');
    if (!state.categories.length) errors.push('至少新增一條分類規則');
    state.categories.forEach((c, i) => {
      const id = `分類規則 #${i + 1}`;
      if (!c.match) errors.push(`${id}: 缺少分類值`);
      if (c.mode === 'copy' && !c.copyField) errors.push(`${id}: 抄錄模式缺少來源欄位`);
    });
    return errors;
  };

  const save = () => {
    const msg = document.getElementById('anum-msg');
    msg.className = '';
    msg.textContent = '';
    const errors = validate();
    if (errors.length) {
      msg.className = 'anum-error';
      msg.textContent = errors.join(' / ');
      return;
    }
    kintone.plugin.app.setConfig({ data: JSON.stringify(state) }, () => {
      alert('設定已儲存。請回到 App 按「更新 App」後生效。');
      window.location.href = `../../flow?app=${APP_ID}`;
    });
  };

  loadFields().then(render);
})();
