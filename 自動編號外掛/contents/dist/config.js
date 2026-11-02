(() => {
  'use strict';

  const UI_VERSION = '1.7.2';
  const PLUGIN_ID = kintone.$PLUGIN_ID;
  const APP_ID = kintone.app.getId();

  const raw = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  let state;
  try { state = JSON.parse(raw.data || '{}'); } catch (e) { state = {}; }

  // ── 設定結構（v2.0）──
  // 共用（整個外掛一份）：計數器 App、Token、active 條件、重試次數
  // 號碼組 profiles[]（一組號碼一份）：存放欄位、判斷欄位、觸發時機、分類規則、代碼對照表
  // 一個 App 只能加一次本外掛，但表單可能有好幾個號碼（例：事故編號＋東亞貨物編號），故以多組承載。
  const PROFILE_KEYS = [
    'numberLabel', 'numberField', 'categoryField', 'target', 'subtableCode',
    'triggers', 'statusCond', 'toStatus', 'actionName', 'confirmMessage',
    'categories', 'codeMaps',
  ];

  const newProfile = (src = {}) => {
    const p = {};
    PROFILE_KEYS.forEach((k) => { if (src[k] !== undefined) p[k] = src[k]; });
    if (p.numberField === undefined) p.numberField = '';
    if (p.numberLabel === undefined) p.numberLabel = '';
    if (p.categoryField === undefined) p.categoryField = '';
    if (p.target === undefined) p.target = 'field';
    if (p.subtableCode === undefined) p.subtableCode = '';
    if (!Array.isArray(p.triggers)) p.triggers = ['create.submit', 'edit.submit'];
    if (p.statusCond === undefined) p.statusCond = '*';
    if (p.toStatus === undefined) p.toStatus = '*';
    if (p.actionName === undefined) p.actionName = '*';
    if (p.confirmMessage === undefined) p.confirmMessage = '此記錄將於儲存後自動產生編號，是否繼續？';
    if (!Array.isArray(p.categories)) p.categories = [];
    if (!Array.isArray(p.codeMaps)) p.codeMaps = [];
    return p;
  };

  // 舊版（v1.5.0 以前）是平面設定、只有一組 → 轉成第 1 組
  if (!Array.isArray(state.profiles) || !state.profiles.length) {
    state.profiles = [newProfile(state)];
  } else {
    state.profiles = state.profiles.map((p) => newProfile(p));
  }
  PROFILE_KEYS.forEach((k) => { delete state[k]; });

  state.version = '2.0';
  if (state.counterApp === undefined) state.counterApp = '';
  if (state.counterToken === undefined) state.counterToken = '';
  if (state.selfToken === undefined) state.selfToken = '';
  if (state.activeQuery === undefined) state.activeQuery = 'active in ("啟用")';
  if (state.maxRetry === undefined) state.maxRetry = 5;

  // 目前正在編輯哪一組（只存在畫面上，不寫入設定）
  let activeIdx = 0;
  const prof = () => state.profiles[activeIdx];
  // 分頁名稱：沒填「這個號碼叫什麼」時用預設的「號碼 N」，填了才顯示該名稱（不從欄位代碼猜）
  const profileName = (p, i) => (p.numberLabel || '').trim() || `號碼 ${i + 1}`;
  const tabText = (p, i) => ((p.numberLabel || '').trim() ? `${i + 1}. ${p.numberLabel.trim()}` : profileName(p, i));

  // ----- SECURE TOKEN STORAGE -----
  // Token 存放於外掛代理設定（加密於 kintone 伺服器，只有本設定頁能透過 getProxyConfig 讀回；
  // 一般使用者在記錄頁完全讀不到）。代理設定以「網址前置比對」決定是否注入，因此只要針對
  // /k/v1/ 前綴為 GET / POST / PUT 各註冊一次，即涵蓋 record.json / records.json 的
  // 建立、更新、查詢，不需分別為 Counter App / 本 App 各註冊一次。
  const REST_PREFIX = kintone.api.url('/k/v1/record.json', true).replace(/record\.json.*$/, '');
  // 存放「counter/self → Token」對照的內部欄位；此網址永不會被實際呼叫（.invalid 保證不解析），
  // 僅供本設定頁 getProxyConfig 回填輸入框使用。
  const TOKEN_MAP_URL = 'https://anum-plugin.invalid/token-map';

  const readSecuredTokenMap = () => {
    try {
      const cfg = kintone.plugin.app.getProxyConfig(TOKEN_MAP_URL, 'POST');
      if (cfg && cfg.data && cfg.data.map) return JSON.parse(cfg.data.map);
    } catch (e) { /* 尚未設定過 */ }
    return null;
  };

  // 讀回已加密的 Token 值供編輯；若代理設定尚無資料（首次從舊版遷移），
  // state 仍保有舊版明文 Token（來自 getConfig），可直接沿用，按一次儲存即完成搬移。
  const _securedMap = readSecuredTokenMap();
  if (_securedMap) {
    if (typeof _securedMap.counter === 'string') state.counterToken = _securedMap.counter;
    if (typeof _securedMap.self === 'string') state.selfToken = _securedMap.self;
  }

  // 儲存代理設定為 callback 型 API，需鏈式呼叫，最後才寫一般設定。
  const chainProxy = (entries, done) => {
    const next = (i) => {
      if (i >= entries.length) return done();
      const [u, m, h, d] = entries[i];
      kintone.plugin.app.setProxyConfig(u, m, h, d, () => next(i + 1));
    };
    next(0);
  };

  const TRIGGER_OPTS = [
    { v: 'create.submit',   l: '新增一筆並儲存時' },
    { v: 'edit.submit',     l: '編輯後儲存時' },
    { v: 'process.proceed', l: '按下流程動作時（送簽、核准…）' },
  ];

  // 固定選項的下拉：l 用「短標籤」讓收合狀態放得下，完整說明放 sub（展開時第二行會顯示）
  const TARGET_OPTS = [
    { v: 'field',    l: '一張單一個號碼（寫進表單欄位）' },
    { v: 'subtable', l: '表格的每一列各一個號碼' },
  ];

  const MODE_OPTS = [
    { v: 'issue', l: '計數器發號', sub: '跟計數器拿一個新號碼' },
    { v: 'copy',  l: '抄表單欄位', sub: '不發新號，直接複製現有欄位的值' },
  ];

  const VALIDATE_OPTS = [
    { v: '',       l: '不檢查' },
    { v: 'taxId8', l: '8 位數字', sub: '統一編號格式' },
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

  const textInput = (value, onChange, placeholder = '', type = 'text') => {
    const i = el('input', { type, placeholder });
    i.value = value == null ? '' : value;
    i.addEventListener('input', (e) => onChange(e.target.value));
    return i;
  };

  const textArea = (value, onChange, placeholder = '', rows = 3) => {
    const t = el('textarea', { placeholder, rows: String(rows) });
    t.value = value == null ? '' : value;
    t.addEventListener('input', (e) => onChange(e.target.value));
    return t;
  };

  // 代碼對照的文字表示 ⇄ 結構化陣列：畫面用「值=代碼」逐行編輯，設定檔存陣列
  const pairsToText = (pairs) => (pairs || []).map((p) => `${p.from}=${p.to}`).join('\n');
  const textToPairs = (text) => String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=');
      if (i === -1) return null;
      return { from: line.slice(0, i).trim(), to: line.slice(i + 1).trim() };
    })
    .filter((p) => p && p.from && p.to);

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
    const wrap = el('label', { for: id, class: 'anum-check' });
    wrap.appendChild(cb);
    wrap.appendChild(el('span', {}, [label]));
    return wrap;
  };

  // 可搜尋下拉選單。
  // 選單面板的寬度由 CSS 的 min-width:100% + width:max-content 決定，會依選項內容自動加寬，
  // 因此「欄位名稱很長」時不會被輸入框的寬度截斷；輸入框本身只顯示簡短的欄位名稱，
  // 完整資訊（欄位代碼、型態）放在選單第二行與 title 提示。
  const searchableSelect = (options, currentValue, onChange) => {
    const wrap = el('div', { class: 'anum-ss-wrap' });
    let _val = currentValue;
    const findOpt = (v) => options.find((x) => x.v === v);
    const labelOf = (v) => { const o = findOpt(v); return o ? o.l : (v || ''); };
    const titleOf = (v) => {
      const o = findOpt(v);
      if (!o) return v || '';
      return o.sub ? `${o.l}（${o.sub}）` : o.l;
    };

    const inp = el('input', {
      type: 'text', class: 'anum-ss-input', autocomplete: 'off',
      placeholder: '點一下選擇，或直接輸入關鍵字搜尋',
    });
    inp.value = labelOf(_val);
    inp.title = titleOf(_val);

    const list = el('div', { class: 'anum-ss-list' });

    const buildList = (filter) => {
      list.innerHTML = '';
      const lf = (filter || '').trim().toLowerCase();
      const shown = lf
        ? options.filter((o) => `${o.l} ${o.sub || ''} ${o.v}`.toLowerCase().includes(lf))
        : options;

      if (!shown.length) {
        list.appendChild(el('div', { class: 'anum-ss-empty' }, ['找不到符合的欄位']));
      } else {
        shown.forEach((o) => {
          const item = el('div', { class: 'anum-ss-item' + (o.v === _val ? ' anum-ss-active' : '') });
          item.appendChild(el('span', { class: 'anum-ss-main' }, [o.l]));
          if (o.sub) item.appendChild(el('span', { class: 'anum-ss-sub' }, [o.sub]));
          item.title = titleOf(o.v);
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            _val = o.v;
            inp.value = o.l;
            inp.title = titleOf(o.v);
            list.classList.remove('is-open');
            onChange(o.v);
          });
          list.appendChild(item);
        });
      }

      list.classList.add('is-open');
      // 若面板會超出視窗右緣，改為靠右展開，確保內容完整可見
      list.classList.remove('is-flip');
      const rect = list.getBoundingClientRect();
      if (rect.right > document.documentElement.clientWidth - 8) list.classList.add('is-flip');
    };

    inp.addEventListener('focus', () => { inp.select(); buildList(''); });
    inp.addEventListener('input', (e) => buildList(e.target.value));
    inp.addEventListener('blur', () => {
      setTimeout(() => {
        list.classList.remove('is-open');
        inp.value = labelOf(_val);   // 沒選任何項目就還原成目前的值
        inp.title = titleOf(_val);
      }, 180);
    });

    wrap.appendChild(inp);
    wrap.appendChild(list);
    return wrap;
  };

  // kintone 欄位型態的中文說明，讓選單直接看得懂，不必記英文代號
  const TYPE_LABEL = {
    SINGLE_LINE_TEXT: '單行文字', MULTI_LINE_TEXT: '多行文字', RICH_TEXT: '格式化文字',
    NUMBER: '數值', CALC: '計算', RADIO_BUTTON: '單選按鈕', CHECK_BOX: '核取方塊',
    MULTI_SELECT: '複選', DROP_DOWN: '下拉選單', DATE: '日期', TIME: '時間',
    DATETIME: '日期時間', FILE: '附件', LINK: '連結', USER_SELECT: '使用者選擇',
    ORGANIZATION_SELECT: '組織選擇', GROUP_SELECT: '群組選擇', REFERENCE_TABLE: '關聯表格',
    STATUS: '狀態', STATUS_ASSIGNEE: '執行者', RECORD_NUMBER: '記錄編號',
    CREATOR: '建立人', MODIFIER: '更新人', CREATED_TIME: '建立時間', UPDATED_TIME: '更新時間',
    SUBTABLE: '子表格', CATEGORY: '分類',
  };

  // 提示／確認視窗一律用 SweetAlert2：外掛自帶一份（3rd_parties/sweetalert2.all.min.js），
  // 設定頁不套用 App 的 JavaScript 自訂也一定有 Swal。原生 alert / confirm 只是 Swal 載入失敗時的最後備案。
  const ensureCfgSwalStyle = () => {
    if (!document.getElementById('anum-cfg-swal-style')) {
      const st = document.createElement('style');
      st.id = 'anum-cfg-swal-style';
      st.textContent = `
        @keyframes anumCfgIn { from { transform: scale(.9) translateY(10px); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes anumCfgOut { to { transform: scale(.94); opacity: 0 } }
        .anum-cfg-in  { animation: anumCfgIn .28s cubic-bezier(.22,1,.36,1); }
        .anum-cfg-out { animation: anumCfgOut .16s ease-in forwards; }
        .anum-cfg-popup { border-radius: 12px; padding: 26px 30px 28px; }
        .anum-cfg-title { font-size: 21px !important; font-weight: 700 !important; }
        .anum-cfg-text  { font-size: 16px !important; line-height: 1.75 !important; color: #33404e !important; }
        .anum-cfg-nowrap { white-space: pre !important; overflow-x: auto; }
        /* 「貼上設定」等自訂對話框（.anum-dlg-backdrop z-index 10000）開著時，視窗要疊在它上面 */
        .anum-cfg-container { z-index: 10100 !important; }
      `;
      document.head.appendChild(st);
    }
  };

  const uiDone = (title, html) => {
    if (!window.Swal) {
      window.alert(`${title}\n\n${String(html).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')}`);
      return Promise.resolve();
    }
    ensureCfgSwalStyle();
    return window.Swal.fire({
      icon: 'success',
      title,
      html,
      width: 'auto',
      confirmButtonText: '好，我知道了',
      confirmButtonColor: '#2563a8',
      customClass: {
        container: 'anum-cfg-container',
        popup: 'anum-cfg-popup', title: 'anum-cfg-title', htmlContainer: 'anum-cfg-text',
      },
      showClass: { popup: 'anum-cfg-in' },
      hideClass: { popup: 'anum-cfg-out' },
    });
  };

  const uiAsk = async (title, text, confirmText) => {
    if (!window.Swal) return window.confirm(`${title}\n\n${text}`);
    ensureCfgSwalStyle();
    const res = await window.Swal.fire({
      icon: 'warning',
      title,
      text,
      width: 'auto',
      showCancelButton: true,
      confirmButtonText: confirmText || '確定',
      cancelButtonText: '取消',
      confirmButtonColor: '#c0392b',
      cancelButtonColor: '#8a94a3',
      reverseButtons: true,
      focusCancel: true,
      customClass: {
        container: 'anum-cfg-container',
        popup: 'anum-cfg-popup', title: 'anum-cfg-title', htmlContainer: 'anum-cfg-text anum-cfg-nowrap',
      },
      showClass: { popup: 'anum-cfg-in' },
      hideClass: { popup: 'anum-cfg-out' },
    });
    return res.isConfirmed;
  };

  const NONE_OPT = { v: '', l: '（尚未選擇）' };
  const mkFieldOpt = (code, label, type, extra) => ({
    v: code,
    l: label || code,                                                    // 選單主行：人看得懂的欄位名稱
    sub: `欄位代碼 ${code}・${TYPE_LABEL[type] || type}${extra || ''}`,   // 次要資訊：辨識同名欄位用
  });
  const byLabel = (a, b) => String(a.l).localeCompare(String(b.l), 'zh-Hant');

  let FIELD_OPTIONS = [{ v: '', l: '欄位載入中…' }];   // 表單本體的欄位
  let SUBTABLE_OPTIONS = [{ v: '', l: '欄位載入中…' }]; // 表單上的表格（子表格）清單
  const SUBTABLE_FIELDS = {};                          // { 表格代碼: [表格內欄位選項] }

  // 取得表格內欄位的選項；withTop=true 時附上表單本體欄位（判斷種類的欄位允許放在表單本體）
  const subFieldOptions = (subCode, withTop) => {
    const inner = SUBTABLE_FIELDS[subCode] || [];
    if (!withTop) return [NONE_OPT].concat(inner);
    const top = FIELD_OPTIONS.filter((o) => o.v);
    return [NONE_OPT].concat(inner, top);
  };

  // 讀取整張表單的欄位結構。
  // 不用 KintoneConfigHelper.getFields()：它只回傳表單本體的欄位，既沒有子表格本身，
  // 也拿不到子表格「裡面」的欄位，逐列給號的三個選單會全部是空的。
  // 改打 REST API 取完整結構（preview 端點可讀到尚未套用的表單變更）。
  const loadFields = () => {
    return kintone.api(kintone.api.url('/k/v1/preview/app/form/fields.json', true), 'GET', { app: APP_ID })
      .then((resp) => {
        const props = (resp && resp.properties) || {};
        const top = [];
        const subs = [];

        Object.keys(props).forEach((code) => {
          const f = props[code];
          if (f.type === 'SUBTABLE') {
            subs.push(mkFieldOpt(code, f.label, f.type));
            const inner = [];
            Object.keys(f.fields || {}).forEach((ic) => {
              const inf = f.fields[ic];
              inner.push(mkFieldOpt(ic, inf.label, inf.type, `・在表格「${f.label || code}」內`));
            });
            SUBTABLE_FIELDS[code] = inner.sort(byLabel);
          } else {
            top.push(mkFieldOpt(code, f.label, f.type));
          }
        });

        FIELD_OPTIONS = [NONE_OPT].concat(top.sort(byLabel));
        SUBTABLE_OPTIONS = subs.length
          ? [NONE_OPT].concat(subs.sort(byLabel))
          : [{ v: '', l: '這張表單沒有表格（子表格）' }];
        return FIELD_OPTIONS;
      })
      .catch((e) => {
        // 取不到表單結構時退回舊方式，至少「一張單一個號碼」還能設定
        console.error('[anum] 讀取欄位失敗，改用 KintoneConfigHelper', e);
        if (!window.KintoneConfigHelper) {
          FIELD_OPTIONS = [NONE_OPT];
          SUBTABLE_OPTIONS = [{ v: '', l: '欄位讀取失敗' }];
          return [];
        }
        return KintoneConfigHelper.getFields()
          .then((fields) => {
            FIELD_OPTIONS = [NONE_OPT].concat(
              (fields || []).map((f) => mkFieldOpt(f.code, f.label, f.type)).sort(byLabel)
            );
            SUBTABLE_OPTIONS = [{ v: '', l: '欄位讀取失敗，請重新整理' }];
            return FIELD_OPTIONS;
          })
          .catch(() => []);
      });
  };

  const root = document.getElementById('ui-section');

  const render = () => {
    root.innerHTML = '';
    root.appendChild(renderToolbar());
    root.appendChild(renderIntro());
    root.appendChild(renderCounterSection());
    root.appendChild(renderProfileTabs());
    root.appendChild(renderFieldSection());
    root.appendChild(renderTriggerSection());
    root.appendChild(renderCategorySection());
    root.appendChild(renderCodeMapSection());
  };

  // label ＋ 控制項（可帶一行灰色補充說明）
  // 表格儲存格：一律包同一層 .anum-cell 容器。
  // 各格內容物高度不同（輸入框 38px／說明文字 19px／刪除鈕 29px），若直接放進 td，
  // 每格會各自對齊、整列看起來歪掉，切換模式時還會跳動。統一容器後高度與垂直置中一致。
  const cell = (content, mod) =>
    el('td', {}, [el('div', { class: 'anum-cell' + (mod ? ' ' + mod : '') }, [content])]);

  const mkRow = (grid, label, control, hint) => {
    grid.appendChild(el('div', { class: 'anum-label' }, [label]));
    if (!hint) { grid.appendChild(control); return; }
    const field = el('div', { class: 'anum-field' });
    field.appendChild(control);
    field.appendChild(el('div', { class: 'anum-hint' }, [hint]));
    grid.appendChild(field);
  };

  const sectionHead = (num, title, helps = []) => {
    const frag = document.createDocumentFragment();
    frag.appendChild(el('h3', { class: 'anum-section-title' }, [
      el('span', { class: 'anum-step' }, [String(num)]),
      title,
    ]));
    helps.forEach((h) => frag.appendChild(el('p', { class: 'anum-section-help' }, [h])));
    return frag;
  };

  // 進階設定：預設收合，讓主畫面只留下大多數人需要填的欄位
  const advanced = (title, body) => {
    const d = el('details', { class: 'anum-adv' });
    d.appendChild(el('summary', {}, [title]));
    const inner = el('div', { class: 'anum-adv-body' });
    inner.appendChild(body);
    d.appendChild(inner);
    return d;
  };

  const renderIntro = () => el('div', { class: 'anum-intro' }, [
    el('strong', {}, ['這個外掛在做什麼？']),
    el('br'),
    '同仁儲存表單時，外掛會去「編號計數器 App」拿一個新號碼，填進你指定的欄位。' +
    '因為號碼統一由計數器發放，就算多人同時按儲存，也不會有兩筆拿到相同號碼。',
    el('br'),
    '請由上往下依序設定，填完最下面按右上角的「儲存設定」。',
  ]);

  // 1. 計數器連線
  const renderCounterSection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(1, '號碼要跟誰拿', [
      '先告訴外掛「編號計數器 App」在哪裡。號碼由它統一發放與記錄，這裡只負責去拿。',
    ]));

    sec.appendChild(el('div', { class: 'anum-note' }, [
      '底下兩個 API Token 存進 kintone 時會加密，一般同仁看不到，也不會出現在瀏覽器畫面上。',
      el('br'),
      '若你是從舊版更新上來，請在這頁按一次「儲存設定」，原本的 Token 就會自動轉成加密保存。',
    ]));

    const grid = el('div', { class: 'anum-grid' });
    mkRow(grid, '編號計數器 App ID',
      textInput(state.counterApp, (v) => { state.counterApp = v.trim(); }, '例如：100'),
      '打開計數器 App，看網址列 /k/ 後面那個數字。例如 .../k/100/ 就填 100。');

    mkRow(grid, '計數器的 API Token',
      textInput(state.counterToken, (v) => { state.counterToken = v.trim(); }, '建議填寫', 'password'),
      '在計數器 App 的「API Token」設定產生，權限要勾「新增記錄」與「編輯記錄」。' +
      '填了之後，就算同仁對計數器沒有權限也能順利取號。');

    mkRow(grid, '這張表單的 API Token',
      textInput(state.selfToken, (v) => { state.selfToken = v.trim(); }, '選填', 'password'),
      '號碼要寫回這張表單時使用。如果同仁按下儲存或送簽後就失去編輯權限，請填這一欄。');

    const advGrid = el('div', { class: 'anum-grid' });
    mkRow(advGrid, '只使用啟用中的計數器',
      textInput(state.activeQuery, (v) => { state.activeQuery = v; }, 'active in ("啟用")'),
      '計數器 App 用「啟用狀態」欄位控制哪幾台在服役。除非你把那個欄位的選項改過名稱，' +
      '否則這裡維持預設即可。若要連停用的也拿號，把這欄清空。');
    mkRow(advGrid, '同時儲存的重試次數',
      numberInput(state.maxRetry, (v) => { state.maxRetry = Number(v) || 5; }, '5'),
      '多人同時按儲存時，搶輸的一方會自動再試一次拿下一號。預設 5 次，一般辦公情境很夠用。所有號碼組共用。');
    sec.appendChild(grid);
    sec.appendChild(advanced('進階設定（一般不用動）', advGrid));
    return sec;
  };

  // 號碼組分頁：一張表單有幾個號碼就設幾組，下面第 2~5 步編輯的是目前選中的那一組
  const syncTabLabel = () => {
    const t = document.getElementById(`anum-tab-${activeIdx}`);
    if (t) t.textContent = tabText(prof(), activeIdx);
  };

  const renderProfileTabs = () => {
    const sec = el('section', { class: 'anum-section anum-profiles' });
    sec.appendChild(el('h3', { class: 'anum-section-title' }, ['這張表單要產生哪些號碼']));
    sec.appendChild(el('p', { class: 'anum-section-help' }, [
      '一張表單有幾個號碼要自動產生，就設定幾組。' +
      '每一組各自決定號碼寫到哪一欄、什麼時候產生、怎麼給號。點下方分頁切換要編輯的那一組。',
    ]));

    const tabs = el('div', { class: 'anum-tabs', role: 'tablist' });
    state.profiles.forEach((p, i) => {
      tabs.appendChild(el('button', {
        id: `anum-tab-${i}`,
        class: 'anum-tab' + (i === activeIdx ? ' is-active' : ''),
        role: 'tab',
        'aria-selected': i === activeIdx ? 'true' : 'false',
        onclick: () => { activeIdx = i; render(); },
      }, [tabText(p, i)]));
    });
    tabs.appendChild(el('button', {
      class: 'anum-tab anum-tab-add',
      onclick: () => {
        state.profiles.push(newProfile());
        activeIdx = state.profiles.length - 1;
        render();
      },
    }, ['＋ 新增一組號碼']));
    sec.appendChild(tabs);

    if (state.profiles.length > 1) {
      const bar = el('div', { class: 'anum-tab-actions' });
      bar.appendChild(el('span', {}, [`目前編輯：第 ${activeIdx + 1} 組「${profileName(prof(), activeIdx)}」`]));
      bar.appendChild(el('button', {
        class: 'anum-btn anum-btn-danger',
        onclick: async () => {
          const ok = await uiAsk(
            '刪除號碼組',
            `確定要刪除第 ${activeIdx + 1} 組「${profileName(prof(), activeIdx)}」嗎？\n（按「儲存設定」後才會真正生效）`,
            '刪除'
          );
          if (!ok) return;
          state.profiles.splice(activeIdx, 1);
          activeIdx = Math.max(0, activeIdx - 1);
          render();
        },
      }, ['刪除這一組']));
      sec.appendChild(bar);
    }
    return sec;
  };

  // 2. 指定欄位
  const renderFieldSection = () => {
    const p = prof();
    const isSub = p.target === 'subtable';

    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(2, '號碼要寫到哪一欄', [
      '選出這張表單的兩個欄位：號碼要填進哪裡，以及要看哪一欄決定號碼的種類。',
      '若一張表單要一次產生多個號碼（例如表格裡每一列都要一個設備代號），請改選「表格的每一列各一個號碼」。',
    ]));

    const grid = el('div', { class: 'anum-grid' });

    mkRow(grid, '這個號碼叫什麼',
      textInput(p.numberLabel, (v) => { p.numberLabel = v.trim(); syncTabLabel(); }, '例如：設備代號、事故編號'),
      '同仁看到的訊息會用這個名稱，例如填「設備代號」，儲存時就會顯示「正在產生設備代號…」。留空預設為「編號」。');

    mkRow(grid, '號碼的產生方式',
      select(TARGET_OPTS, p.target || 'field', (v) => { p.target = v; render(); }),
      '「一張單一個號碼」：號碼寫進表單本身的欄位。' +
      '「表格的每一列各一個號碼」：表格有幾列就產生幾個號碼，一次寫入。');

    if (isSub) {
      // 換表格時要重畫，下面兩個選單才會換成「這個表格裡面」的欄位
      mkRow(grid, '表格欄位',
        searchableSelect(SUBTABLE_OPTIONS, p.subtableCode, (v) => { p.subtableCode = v; render(); }),
        '要逐列給號的那個表格（子表格）。選好之後，下面兩個選單就會列出這個表格裡面的欄位。');
    }

    // 逐列給號時，號碼欄位一定在表格內；判斷種類的欄位則允許放在表單本體，故一併列出
    const numberOpts = isSub ? subFieldOptions(p.subtableCode, false) : FIELD_OPTIONS;
    const categoryOpts = isSub ? subFieldOptions(p.subtableCode, true) : FIELD_OPTIONS;
    const needPickSub = isSub && !p.subtableCode;

    mkRow(grid, isSub ? '存放號碼的欄位（表格內）' : '存放號碼的欄位',
      searchableSelect(numberOpts, p.numberField, (v) => { p.numberField = v; }),
      needPickSub
        ? '請先在上面選好「表格欄位」，這裡才會列出可選的欄位。'
        : (isSub
          ? '表格每一列的號碼會寫進這一欄。⚠ kintone 的表格內欄位無法勾「值必須唯一」，' +
            '因此少了資料庫層的重複防護，請改以「計數器 App 設為唯讀、只開管理員編輯」來把關。'
          : '產生的號碼會寫進這一欄。建議到這個欄位的設定裡勾選「值必須唯一」，萬一有意外也能擋下重複號碼。'));

    mkRow(grid, isSub ? '判斷種類的欄位（表格內）' : '判斷種類的欄位',
      searchableSelect(categoryOpts, p.categoryField, (v) => { p.categoryField = v; }),
      needPickSub
        ? '請先在上面選好「表格欄位」，這裡才會列出可選的欄位。'
        : (isSub
          ? '外掛會看每一列這一欄的值，決定該列要套用哪一條規則。' +
            '清單裡同時列出「表格內」與「表單本體」的欄位，選表單本體的也可以，整張單會共用同一個值。'
          : '外掛會看這一欄的值，決定要套用下面第 4 步的哪一條規則。通常是「分類」、「類別」這種下拉選單。'));

    sec.appendChild(grid);
    return sec;
  };

  // 3. 觸發時機
  const renderTriggerSection = () => {
    const p = prof();
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(3, '什麼時候產生號碼', [
      '勾選同仁做了哪些動作時要自動給號。可以複選，沒勾的動作就不會產生號碼。',
      '已經有號碼的記錄不會再拿到新號碼，重複儲存也不會跳號，可以放心。',
    ]));

    const checks = el('div', { class: 'anum-checks' });
    TRIGGER_OPTS.forEach((t) => {
      checks.appendChild(checkbox(p.triggers.includes(t.v), (on) => {
        const set = new Set(p.triggers);
        if (on) set.add(t.v); else set.delete(t.v);
        p.triggers = Array.from(set);
      }, t.l));
    });
    sec.appendChild(checks);

    const grid = el('div', { class: 'anum-grid' });
    const noun = (p.numberLabel || '').trim() || '編號';
    mkRow(grid, '儲存前的確認訊息',
      textInput(p.confirmMessage, (v) => { p.confirmMessage = v; }, `例如：確定要產生${noun}嗎？`),
      '同仁按下儲存時會先跳出這句話問一次，按取消就不會存檔也不會給號。' +
      '如果不想多一道詢問，這裡填一個星號 * ，就會直接存檔，完成後再顯示拿到的號碼。');
    sec.appendChild(grid);

    const advGrid = el('div', { class: 'anum-grid' });
    mkRow(advGrid, '限定某個狀態才給號',
      textInput(p.statusCond, (v) => { p.statusCond = v; }, '*'),
      '只在「編輯並儲存」時檢查。填狀態名稱（例如：處理中）就只有該狀態會給號；維持 * 表示不限定。');
    mkRow(advGrid, '限定送到某個狀態',
      textInput(p.toStatus, (v) => { p.toStatus = v; }, '*'),
      '只在「按下流程動作」時檢查。填流程送達的狀態名稱（例如：已核准）；維持 * 表示不限定。');
    mkRow(advGrid, '限定某個流程動作',
      textInput(p.actionName, (v) => { p.actionName = v; }, '*'),
      '只在「按下流程動作」時檢查。填按鈕上的文字（例如：核准）；維持 * 表示不限定。');
    sec.appendChild(advanced('進階設定（一般不用動）', advGrid));
    return sec;
  };

  // 4. 分類規則
  const renderCategorySection = () => {
    const p = prof();
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(4, '每一種分類，號碼怎麼給', [
      '第 2 步選的「判斷種類的欄位」有幾個選項，這裡就加幾條規則，一條一條對應。',
    ]));

    sec.appendChild(el('div', { class: 'anum-note' }, [
      '幾個常用技巧：',
      el('ul', {}, [
        el('li', {}, [
          '想讓「兩個以上的選項共用同一組流水號」（號碼接續、不重複）：把它們的「計數器代碼」填成一樣。',
        ]),
        el('li', {}, [
          '所有選項都用同一種規則：「分類值」填一個星號 ',
          el('span', { class: 'anum-eg' }, ['*']),
          ' 就代表「只要有填分類就適用」。系統會先找完全相同的那一條，都沒有才用星號這條。',
        ]),
        el('li', {}, [
          '計數器很多台時：「計數器代碼」可以寫成 ',
          el('span', { class: 'anum-eg' }, ['{設備種類}新增']),
          '，大括號裡填欄位代碼，實際執行時會換成該筆記錄的值（例如變成 N1新增），',
          '這樣 36 台計數器也只要寫 2 條規則。',
        ]),
      ]),
    ]));

    const table = el('table', { class: 'anum-table' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { style: { width: '22%' } }, ['分類值', el('small', {}, ['表單上的選項文字'])]),
      el('th', { style: { width: '18%' } }, ['計數器代碼', el('small', {}, ['要跟哪一台拿號'])]),
      el('th', { style: { width: '18%' } }, ['號碼怎麼來']),
      el('th', { style: { width: '21%' } }, ['抄哪一欄', el('small', {}, ['選「抄表單欄位」才填'])]),
      el('th', { style: { width: '16%' } }, ['格式檢查']),
      el('th', { style: { width: '5%' } }, ['']),
    ])]));
    const tbody = el('tbody');
    p.categories.forEach((c, i) => {
      const paramCell = c.mode === 'copy'
        ? textInput(c.copyField, (v) => { p.categories[i].copyField = v; }, '欄位代碼，例：統一編號')
        : el('span', { class: 'anum-cell-off' }, ['不需填寫']);
      const validateCell = c.mode === 'copy'
        ? select(VALIDATE_OPTS, c.validate || '', (v) => { p.categories[i].validate = v; })
        : el('span', { class: 'anum-cell-off' }, ['—']);
      const keyCell = c.mode === 'copy'
        ? el('span', { class: 'anum-cell-off' }, ['—'])
        : textInput(c.counterKey, (v) => { p.categories[i].counterKey = v.trim(); }, '留空＝同分類值');

      tbody.appendChild(el('tr', {}, [
        cell(textInput(c.match, (v) => { p.categories[i].match = v; }, '例：境外供應商')),
        cell(keyCell),
        cell(select(MODE_OPTS, c.mode || 'issue', (v) => { p.categories[i].mode = v; render(); })),
        cell(paramCell),
        cell(validateCell),
        cell(el('button', { class: 'anum-btn-row', title: '刪除這條規則', onclick: () => { p.categories.splice(i, 1); render(); } }, ['✕']), 'is-center'),
      ]));
    });
    table.appendChild(tbody);
    sec.appendChild(el('div', { class: 'anum-table-wrap' }, [table]));
    sec.appendChild(el('button', {
      class: 'anum-btn anum-btn-add',
      onclick: () => { p.categories.push({ match: '', counterKey: '', mode: 'issue', copyField: '', validate: '' }); render(); },
    }, ['＋ 新增一條規則']));
    return sec;
  };

  // 5. 代碼對照表（供 number_format 的自訂 token 使用）
  const renderCodeMapSection = () => {
    const p = prof();
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(5, '號碼中間要夾英文代號（選用）', [
      '沒有這種需求就整段略過，不影響其他設定。',
      '有些號碼中間會夾一個隨每筆記錄變動的代號，例如 2026001-G-CA 的 G 代表一般事故、M 代表重大事故。' +
      '在這裡把「欄位的值」對應成「代號」，就能寫進號碼裡。',
    ]));

    sec.appendChild(el('div', { class: 'anum-note' }, [
      '設定完成後，到計數器 App 那筆記錄的「編號樣式」欄位，用大括號把代號名稱包起來即可，例如：',
      el('br'),
      el('span', { class: 'anum-eg' }, ['{YYYY}{seq}-{level}-{prefix}']),
      ' → 會產生 ',
      el('span', { class: 'anum-eg' }, ['2026001-G-CA']),
      el('br'),
      '若某筆記錄的欄位值在對照表裡找不到代號，系統會直接擋下並顯示原因，' +
      '不會產生像 2026001--CA 這種中間缺一塊的號碼。',
    ]));

    sec.appendChild(el('div', { class: 'anum-note' }, [
      '對照表左邊除了寫完整的值，也可以用星號：',
      el('br'),
      el('span', { class: 'anum-eg' }, ['事業本部*=A']),
      ' → 只要開頭是「事業本部」就用 A（例如「事業本部 業務課」）。好幾條都符合時，用最長的那條。',
      el('br'),
      el('span', { class: 'anum-eg' }, ['*=Z']),
      ' → 上面都沒對到時一律用 Z（不寫就是擋下不給號）。完全相同的值永遠優先。',
      el('br'),
      '來源欄位可以選「組織選擇」「使用者選擇」「群組選擇」，比對的是組織／人員的名稱，也可以填它們的代碼。',
    ]));

    // is-top：本表含較高的多行輸入框，整列靠上對齊，短欄位才不會浮在半空中
    const table = el('table', { class: 'anum-table is-top' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { style: { width: '20%' } }, ['代號名稱', el('small', {}, ['英文，供編號樣式使用'])]),
      el('th', { style: { width: '32%' } }, ['值要從哪一欄取']),
      el('th', { style: { width: '43%' } }, ['對照表', el('small', {}, ['一行一組，中間用等號'])]),
      el('th', { style: { width: '5%' } }, ['']),
    ])]));
    const tbody = el('tbody');
    p.codeMaps.forEach((m, i) => {
      tbody.appendChild(el('tr', {}, [
        cell(textInput(m.token, (v) => { p.codeMaps[i].token = v.trim(); }, '例：level')),
        // 逐列給號時，代號的來源欄位可能在表格內，故一併列出
        cell(searchableSelect(
          p.target === 'subtable' ? subFieldOptions(p.subtableCode, true) : FIELD_OPTIONS,
          m.field,
          (v) => { p.codeMaps[i].field = v; }
        )),
        cell(textArea(pairsToText(m.pairs), (v) => { p.codeMaps[i].pairs = textToPairs(v); }, '一般事故=G\n重大事故=M\n事業本部*=A')),
        cell(el('button', { class: 'anum-btn-row', title: '刪除這組對照', onclick: () => { p.codeMaps.splice(i, 1); render(); } }, ['✕']), 'is-center'),
      ]));
    });
    table.appendChild(tbody);
    sec.appendChild(el('div', { class: 'anum-table-wrap' }, [table]));
    sec.appendChild(el('button', {
      class: 'anum-btn anum-btn-add',
      onclick: () => { p.codeMaps.push({ token: '', field: '', pairs: [] }); render(); },
    }, ['＋ 新增一組對照']));
    return sec;
  };

  // ── 設定複製／貼上：把這個 App 的設定帶到另一個 App 的外掛設定畫面 ──
  // 匯出內容刻意不含 API Token：Token 是加密保存的，一旦轉成文字貼來貼去就失去保護；
  // 貼上後保留目標 App 原本的 Token（沒有就到第 1 步重填）。
  const EXPORT_MARK = 'anumPluginConfig';

  const buildExport = () => JSON.stringify({
    [EXPORT_MARK]: 1,
    uiVersion: UI_VERSION,
    fromApp: String(APP_ID),
    counterApp: state.counterApp,
    activeQuery: state.activeQuery,
    maxRetry: state.maxRetry,
    profiles: state.profiles.map((p) => newProfile(JSON.parse(JSON.stringify(p)))),
  }, null, 2);

  // 解析貼上的文字。除了本功能匯出的格式，也接受舊版平面設定（只有一組、沒有 profiles）。
  const parseImport = (text) => {
    let obj;
    try { obj = JSON.parse(String(text || '').trim()); } catch (e) {
      throw new Error('貼上的內容不是有效的設定文字，請確認是從「複製設定」完整複製過來的（開頭是 { 、結尾是 } ）。');
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('貼上的內容格式不正確。');
    let profiles;
    if (Array.isArray(obj.profiles) && obj.profiles.length) profiles = obj.profiles;
    else if (obj.numberField || Array.isArray(obj.categories)) profiles = [obj];
    else throw new Error('貼上的內容裡找不到號碼組設定，請確認是本外掛的設定。');
    return {
      counterApp: obj.counterApp != null ? String(obj.counterApp).trim() : undefined,
      activeQuery: typeof obj.activeQuery === 'string' ? obj.activeQuery : undefined,
      maxRetry: Number(obj.maxRetry) > 0 ? Number(obj.maxRetry) : undefined,
      fromApp: obj.fromApp ? String(obj.fromApp) : '',
      profiles: profiles.map((p) => newProfile(p)),
    };
  };

  // 貼上後立刻比對：設定裡用到、但這張表單沒有的欄位代碼（不同 App 欄位代碼常不一樣）
  const missingFieldsOf = (profiles) => {
    const top = new Set(FIELD_OPTIONS.map((o) => o.v).filter(Boolean));
    if (!top.size) return []; // 欄位清單沒載入成功就不比對，交給儲存時檢查
    const missing = new Set();
    profiles.forEach((p) => {
      const isSub = p.target === 'subtable';
      const inner = new Set(((isSub && SUBTABLE_FIELDS[p.subtableCode]) || []).map((o) => o.v));
      const has = (code) => top.has(code) || inner.has(code);
      if (isSub && p.subtableCode && !SUBTABLE_FIELDS[p.subtableCode]) missing.add(p.subtableCode);
      [p.numberField, p.categoryField].forEach((c) => { if (c && !has(c)) missing.add(c); });
      p.categories.forEach((c) => {
        if (c.mode === 'copy' && c.copyField && !has(c.copyField)) missing.add(c.copyField);
        ((c.counterKey || '').match(/\{[^{}]+\}/g) || []).forEach((t) => {
          const code = t.slice(1, -1).trim();
          if (code && !has(code)) missing.add(code);
        });
      });
      p.codeMaps.forEach((m) => { if (m.field && !has(m.field)) missing.add(m.field); });
    });
    return [...missing];
  };

  const copyText = (text, ta) => {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(ta));
    }
    return Promise.resolve(fallbackCopy(ta));
  };
  const fallbackCopy = (ta) => {
    try { ta.focus(); ta.select(); return document.execCommand('copy'); } catch (e) { return false; }
  };

  // 簡易對話框（設定頁不保證有 SweetAlert2，故自己畫）
  const openDialog = (title, bodyNodes, buttons) => {
    const overlay = el('div', { class: 'anum-dlg-overlay' });
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const dlg = el('div', { class: 'anum-dlg', role: 'dialog', 'aria-modal': 'true' });
    dlg.appendChild(el('h3', { class: 'anum-dlg-title' }, [title]));
    bodyNodes.forEach((n) => dlg.appendChild(n));
    const actions = el('div', { class: 'anum-dlg-actions' });
    buttons.forEach((b) => actions.appendChild(el('button', {
      class: 'anum-btn' + (b.primary ? ' anum-btn-primary' : ''),
      onclick: () => b.onClick(close),
    }, [b.label])));
    dlg.appendChild(actions);
    overlay.appendChild(dlg);
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    return { close };
  };

  const openExportDialog = () => {
    const text = buildExport();
    const ta = el('textarea', { class: 'anum-dlg-text', rows: '14', readonly: 'readonly' });
    ta.value = text;
    const status = el('div', { class: 'anum-dlg-status' });
    openDialog('複製這個 App 的外掛設定', [
      el('p', { class: 'anum-dlg-help' }, [
        '下面這段文字就是目前畫面上的全部設定（包含尚未儲存的修改）。',
        '到另一個 App 的本外掛設定畫面，按右上角「貼上設定」，把它貼進去即可。',
      ]),
      el('p', { class: 'anum-dlg-help is-warn' }, [
        '為了安全，API Token 不會被複製；貼到新 App 後請在第 1 步重新填寫。',
      ]),
      ta,
      status,
    ], [
      { label: '關閉', onClick: (close) => close() },
      {
        label: '複製到剪貼簿', primary: true,
        onClick: () => copyText(text, ta).then((ok) => {
          status.className = 'anum-dlg-status ' + (ok ? 'is-ok' : 'anum-error');
          status.textContent = ok
            ? '已複製！到另一個 App 的設定畫面按「貼上設定」即可。'
            : '瀏覽器不允許自動複製，請在上面的文字框按 Ctrl+A 全選後 Ctrl+C 複製。';
        }),
      },
    ]);
    ta.focus();
    ta.select();
  };

  const openImportDialog = () => {
    const ta = el('textarea', {
      class: 'anum-dlg-text', rows: '14',
      placeholder: '把另一個 App 按「複製設定」得到的文字貼在這裡（Ctrl+V）',
    });
    const status = el('div', { class: 'anum-dlg-status' });

    const apply = async (mode, close) => {
      let data;
      try { data = parseImport(ta.value); } catch (e) {
        status.className = 'anum-dlg-status anum-error';
        status.textContent = e.message;
        return;
      }
      if (mode === 'replace') {
        const ok = await uiAsk(
          '取代目前設定',
          `確定要用貼上的 ${data.profiles.length} 組號碼取代目前全部的設定嗎？\n（按「儲存設定」後才會真正生效，API Token 會保留原本的）`,
          '取代'
        );
        if (!ok) return;
        if (data.counterApp !== undefined) state.counterApp = data.counterApp;
        if (data.activeQuery !== undefined) state.activeQuery = data.activeQuery;
        if (data.maxRetry !== undefined) state.maxRetry = data.maxRetry;
        state.profiles = data.profiles;
        activeIdx = 0;
      } else {
        activeIdx = state.profiles.length;
        state.profiles = state.profiles.concat(data.profiles);
      }
      close();
      render();

      const missing = missingFieldsOf(data.profiles);
      const m = document.getElementById('anum-msg');
      m.className = missing.length ? 'anum-error' : 'anum-ok';
      m.textContent = missing.length
        ? `已貼上，但這張表單找不到以下欄位代碼：${missing.join('、')}。請在第 2～5 步重新選擇後再儲存。`
        : `已貼上 ${data.profiles.length} 組號碼設定，請檢查無誤後按「儲存設定」。`;
    };

    openDialog('貼上其他 App 的外掛設定', [
      el('p', { class: 'anum-dlg-help' }, [
        '「取代目前設定」：整份換成貼上的內容（含計數器 App ID）。',
        el('br'),
        '「加到現有號碼組後面」：保留目前的號碼組，把貼上的號碼組接在後面。',
      ]),
      el('p', { class: 'anum-dlg-help is-warn' }, [
        '提醒：計數器 App 裡要先有這個 App 的發號機記錄（適用 App ID ＝ 這個 App），否則儲存表單時會找不到號碼來源。',
      ]),
      ta,
      status,
    ], [
      { label: '取消', onClick: (close) => close() },
      { label: '加到現有號碼組後面', onClick: (close) => apply('append', close) },
      { label: '取代目前設定', primary: true, onClick: (close) => apply('replace', close) },
    ]);
    ta.focus();
  };

  const renderToolbar = () => {
    const bar = el('div', { class: 'anum-toolbar' });
    bar.appendChild(el('span', { class: 'anum-ver' }, [`設定畫面 v${UI_VERSION}`]));
    const msg = el('span', { id: 'anum-msg', style: { flex: '1', marginLeft: '10px' } });
    bar.appendChild(msg);
    bar.appendChild(el('button', { class: 'anum-btn', title: '把目前設定轉成文字，貼到其他 App 使用', onclick: openExportDialog }, ['複製設定']));
    bar.appendChild(el('button', { class: 'anum-btn', title: '貼上其他 App 複製來的設定', onclick: openImportDialog }, ['貼上設定']));
    bar.appendChild(el('button', { class: 'anum-btn', onclick: () => { history.back(); } }, ['取消']));
    bar.appendChild(el('button', { class: 'anum-btn anum-btn-primary', onclick: save }, ['儲存設定']));
    return bar;
  };

  const validateProfile = (p, tag) => {
    const errors = [];
    if (!p.numberField) errors.push(tag + '第 2 步：請選擇存放號碼的欄位');
    if (!p.categoryField) errors.push(tag + '第 2 步：請選擇判斷種類的欄位');
    if (p.target === 'subtable' && !p.subtableCode) {
      errors.push(tag + '第 2 步：選了「表格的每一列各一個號碼」時，必須指定表格欄位');
    }
    // 切換產生方式後，欄位可能還留著另一種模式的舊值（例如表單本體的欄位留在逐列模式），
    // 這種設定執行時永遠找不到欄位，必須在存檔前擋下。
    if (p.target === 'subtable' && p.subtableCode && SUBTABLE_FIELDS[p.subtableCode]) {
      const inner = new Set(SUBTABLE_FIELDS[p.subtableCode].map((o) => o.v));
      const topLevel = new Set(FIELD_OPTIONS.map((o) => o.v).filter(Boolean));
      if (p.numberField && !inner.has(p.numberField)) {
        errors.push(`${tag}第 2 步：「${p.numberField}」不在表格「${p.subtableCode}」裡面，請重新選擇存放號碼的欄位`);
      }
      if (p.categoryField && !inner.has(p.categoryField) && !topLevel.has(p.categoryField)) {
        errors.push(`${tag}第 2 步：找不到判斷種類的欄位「${p.categoryField}」，請重新選擇`);
      }
    }
    if (!p.triggers.length) errors.push(tag + '第 3 步：請至少勾選一個產生號碼的時機');
    if (!p.categories.length) errors.push(tag + '第 4 步：請至少新增一條規則');
    // 已載入欄位清單時才做欄位代碼比對；載入失敗（FIELD_OPTIONS 只有預設項）則略過，
    // 以免因為取不到欄位而擋住管理者存檔。
    // 逐列給號時，{欄位代碼} 樣板可以指向表格內的欄位，因此一併納入比對範圍。
    const knownFields = new Set(FIELD_OPTIONS.map((o) => o.v).filter(Boolean));
    if (p.target === 'subtable') {
      Object.keys(SUBTABLE_FIELDS).forEach((sc) => {
        SUBTABLE_FIELDS[sc].forEach((o) => { if (o.v) knownFields.add(o.v); });
      });
    }
    const canCheckFields = knownFields.size > 0;

    p.categories.forEach((c, i) => {
      const id = `第 4 步的第 ${i + 1} 條規則`;
      if (!c.match) errors.push(`${tag}${id}：請填寫分類值`);
      if (c.mode === 'copy' && !c.copyField) errors.push(`${tag}${id}：選了「直接抄欄位」，請填要抄哪一欄`);

      if (c.mode !== 'copy') {
        // 萬用規則沒有分類值可沿用，必須明確指定計數器代碼。
        if (c.match === '*' && !c.counterKey) {
          errors.push(`${tag}${id}：分類值填星號時，計數器代碼一定要填`);
        }

        const key = c.counterKey || '';
        if (key.indexOf('{') !== -1 || key.indexOf('}') !== -1) {
          // 括號必須成對且內容非空
          const tokens = key.match(/\{[^{}]*\}/g) || [];
          const stripped = key.replace(/\{[^{}]*\}/g, '');
          if (stripped.indexOf('{') !== -1 || stripped.indexOf('}') !== -1) {
            errors.push(`${tag}${id}：計數器代碼的大括號沒有成對`);
          }
          tokens.forEach((t) => {
            const code = t.slice(1, -1).trim();
            if (!code) {
              errors.push(`${tag}${id}：計數器代碼裡有一組空的大括號`);
            } else if (canCheckFields && !knownFields.has(code)) {
              errors.push(`${tag}${id}：計數器代碼裡的 {${code}} 在這張表單找不到，請確認欄位代碼`);
            }
          });
        }
      }
    });
    const seenTokens = new Set();
    p.codeMaps.forEach((m, i) => {
      const id = `第 5 步的第 ${i + 1} 組對照`;
      if (!m.token) errors.push(`${tag}${id}：請填寫代號名稱`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.token)) errors.push(`${tag}${id}：代號名稱請用英文字母、數字或底線，且開頭不能是數字`);
      else if (['prefix', 'seq', 'period', 'YYYY', 'YY', 'MM', 'DD'].includes(m.token)) errors.push(`${tag}${id}：代號名稱「${m.token}」是系統保留字，請換一個`);
      else if (seenTokens.has(m.token)) errors.push(`${tag}${id}：代號名稱「${m.token}」跟前面重複了`);
      else seenTokens.add(m.token);
      if (!m.field) errors.push(`${tag}${id}：請選擇值要從哪一欄取`);
      if (!(m.pairs || []).length) errors.push(`${tag}${id}：對照表請至少填一行，格式為「值=代號」`);
    });
    return errors;
  };

  // 一組號碼的「實際計數器代碼」（未用 {欄位} 樣板者），用來偵測不同組誤用同一台計數器
  const fixedCounterKeys = (p) => new Set(
    (p.categories || [])
      .filter((c) => c.mode !== 'copy')
      .map((c) => (c.counterKey || '').trim() || c.match)
      .filter((k) => k && k !== '*' && k.indexOf('{') === -1)
  );

  // 回傳 { errors, firstBad }：firstBad 為第一個有錯的組別索引（-1 表示錯在共用區或沒有錯）
  const validate = () => {
    const errors = [];
    let firstBad = -1;
    if (!state.counterApp) errors.push('第 1 步：請填寫編號計數器的 App ID');

    const multi = state.profiles.length > 1;
    state.profiles.forEach((p, i) => {
      const tag = multi ? `【第 ${i + 1} 組「${profileName(p, i)}」】` : '';
      const errs = validateProfile(p, tag);
      if (errs.length && firstBad === -1) firstBad = i;
      errors.push(...errs);
    });

    // 跨組檢查
    const seenField = new Map();
    const seenKey = new Map();
    state.profiles.forEach((p, i) => {
      const where = p.target === 'subtable' ? `${p.subtableCode}.${p.numberField}` : p.numberField;
      if (p.numberField) {
        if (seenField.has(where)) {
          errors.push(`第 ${seenField.get(where) + 1} 組與第 ${i + 1} 組都把號碼寫進「${p.numberField}」，同一個欄位只能由一組負責`);
          if (firstBad === -1) firstBad = i;
        } else seenField.set(where, i);
      }
      // 不同組共用同一台計數器 → 兩種號碼會搶同一串流水號，而且樣式相同，幾乎一定是設定錯誤
      // （例：事故編號與東亞貨物編號都填 CA）。同一組內多個分類共用則是正常用法，不檢查。
      fixedCounterKeys(p).forEach((k) => {
        if (seenKey.has(k) && seenKey.get(k) !== i) {
          errors.push(`第 ${seenKey.get(k) + 1} 組與第 ${i + 1} 組都使用計數器代碼「${k}」，會共用同一串流水號，請把其中一組改成不同代碼（例：TOA_${k}）`);
          if (firstBad === -1) firstBad = i;
        } else seenKey.set(k, i);
      });
    });
    return { errors, firstBad };
  };

  const save = () => {
    const msg = document.getElementById('anum-msg');
    msg.className = '';
    msg.textContent = '';
    const { errors, firstBad } = validate();
    if (errors.length) {
      if (firstBad !== -1 && firstBad !== activeIdx) { activeIdx = firstBad; render(); }
      const m = document.getElementById('anum-msg');
      m.className = 'anum-error';
      m.textContent = errors.join(' / ');
      return;
    }

    // ----- 1) 蒐集 Token：組合注入用的 header，以及回填用的對照表 -----
    const counterToken = (state.counterToken || '').trim();
    const selfToken = (state.selfToken || '').trim();
    const tokenMap = {};                        // { counter, self }（加密存放，供回填）
    if (counterToken) tokenMap.counter = counterToken;
    if (selfToken) tokenMap.self = selfToken;
    const combined = [...new Set(Object.values(tokenMap).filter(Boolean))].join(',');

    // ----- 2) 一般設定（getConfig 可讀）只保留非機密中繼資料，絕不含明文 Token -----
    // 第 1 組另存一份舊版平面格式：萬一外掛退回 v1.5.0 以前，第 1 組仍可照常運作（新版只讀 profiles）
    const legacyMirror = {};
    PROFILE_KEYS.forEach((k) => { legacyMirror[k] = state.profiles[0][k]; });
    const publicState = Object.assign(legacyMirror, state, {
      counterToken: '',                         // 不再以明文存放
      hasCounterToken: !!counterToken,           // 只留「有沒有設 Token」的旗標
      selfToken: '',                             // 不再以明文存放
      hasSelfToken: !!selfToken,
    });

    // ----- 3) 先寫加密代理設定，成功後才寫一般設定 -----
    const jsonHeaders = combined
      ? { 'Content-Type': 'application/json', 'X-Cybozu-API-Token': combined }
      : { 'Content-Type': 'application/json' };
    const getHeaders = combined ? { 'X-Cybozu-API-Token': combined } : {};

    chainProxy([
      [REST_PREFIX, 'GET',  getHeaders,  {}],
      [REST_PREFIX, 'POST', jsonHeaders, {}],
      [REST_PREFIX, 'PUT',  jsonHeaders, {}],
      [TOKEN_MAP_URL, 'POST', {}, { map: JSON.stringify(tokenMap) }],
    ], () => {
      kintone.plugin.app.setConfig({ data: JSON.stringify(publicState) }, () => {
        const goBack = () => { window.location.href = `../../flow?app=${APP_ID}`; };
        uiDone(
          '設定已儲存',
          'API Token 也已加密保存，一般同仁無法讀取。<br><br>' +
          '<b>最後一步</b>：請回到 App 畫面按右上角的「更新 App」，設定才會正式生效。'
        ).then(goBack);
      });
    });
  };

  loadFields().then(render);
})();
