(() => {
  'use strict';

  const UI_VERSION = '1.2.2';
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
  if (state.target === undefined) state.target = 'field';
  if (state.subtableCode === undefined) state.subtableCode = '';
  if (state.activeQuery === undefined) state.activeQuery = 'active in ("啟用")';
  if (!Array.isArray(state.triggers)) state.triggers = ['create.submit', 'edit.submit'];
  if (state.statusCond === undefined) state.statusCond = '*';
  if (state.toStatus === undefined) state.toStatus = '*';
  if (state.actionName === undefined) state.actionName = '*';
  if (state.confirmMessage === undefined) state.confirmMessage = '此記錄將於儲存後自動產生編號，是否繼續？';
  if (state.maxRetry === undefined) state.maxRetry = 5;
  if (!Array.isArray(state.categories)) state.categories = [];
  if (!Array.isArray(state.codeMaps)) state.codeMaps = [];

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

  let FIELD_OPTIONS = [{ v: '', l: '欄位載入中…' }];
  const loadFields = () => {
    if (!window.KintoneConfigHelper) return Promise.resolve([]);
    return KintoneConfigHelper.getFields()
      .then((fields) => {
        const opts = [{ v: '', l: '（尚未選擇）' }];
        (fields || []).forEach((f) => opts.push({
          v: f.code,
          l: f.label,                                            // 選單主要顯示：人看得懂的欄位名稱
          sub: `欄位代碼 ${f.code}・${TYPE_LABEL[f.type] || f.type}`, // 次要資訊：辨識同名欄位用
        }));
        FIELD_OPTIONS = opts;
        return opts;
      })
      .catch(() => []);
  };

  const root = document.getElementById('ui-section');

  const render = () => {
    root.innerHTML = '';
    root.appendChild(renderToolbar());
    root.appendChild(renderIntro());
    root.appendChild(renderCounterSection());
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
    sec.appendChild(grid);
    sec.appendChild(advanced('進階設定（一般不用動）', advGrid));
    return sec;
  };

  // 2. 指定欄位
  const renderFieldSection = () => {
    const isSub = state.target === 'subtable';

    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(2, '號碼要寫到哪一欄', [
      '選出這張表單的兩個欄位：號碼要填進哪裡，以及要看哪一欄決定號碼的種類。',
      '若一張表單要一次產生多個號碼（例如表格裡每一列都要一個設備代號），請改選「表格的每一列各一個號碼」。',
    ]));

    const grid = el('div', { class: 'anum-grid' });

    mkRow(grid, '號碼的產生方式',
      select(TARGET_OPTS, state.target || 'field', (v) => { state.target = v; render(); }),
      '「一張單一個號碼」：號碼寫進表單本身的欄位。' +
      '「表格的每一列各一個號碼」：表格有幾列就產生幾個號碼，一次寫入。');

    if (isSub) {
      mkRow(grid, '表格欄位',
        searchableSelect(FIELD_OPTIONS, state.subtableCode, (v) => { state.subtableCode = v; }),
        '要逐列給號的那個表格（子表格）。下面兩個欄位請改填「表格裡面」的欄位。');
    }

    mkRow(grid, isSub ? '存放號碼的欄位（表格內）' : '存放號碼的欄位',
      searchableSelect(FIELD_OPTIONS, state.numberField, (v) => { state.numberField = v; }),
      isSub
        ? '表格每一列的號碼會寫進這一欄。⚠ kintone 的表格內欄位無法勾「值必須唯一」，' +
          '因此少了資料庫層的重複防護，請改以「計數器 App 設為唯讀、只開管理員編輯」來把關。'
        : '產生的號碼會寫進這一欄。建議到這個欄位的設定裡勾選「值必須唯一」，萬一有意外也能擋下重複號碼。');

    mkRow(grid, isSub ? '判斷種類的欄位（表格內）' : '判斷種類的欄位',
      searchableSelect(FIELD_OPTIONS, state.categoryField, (v) => { state.categoryField = v; }),
      isSub
        ? '外掛會看每一列這一欄的值，決定該列要套用哪一條規則。' +
          '若這個欄位其實放在表單本體（不在表格裡）也沒關係，外掛會自動往表單本體找。'
        : '外掛會看這一欄的值，決定要套用下面第 4 步的哪一條規則。通常是「分類」、「類別」這種下拉選單。');

    sec.appendChild(grid);
    return sec;
  };

  // 3. 觸發時機
  const renderTriggerSection = () => {
    const sec = el('section', { class: 'anum-section' });
    sec.appendChild(sectionHead(3, '什麼時候產生號碼', [
      '勾選同仁做了哪些動作時要自動給號。可以複選，沒勾的動作就不會產生號碼。',
      '已經有號碼的記錄不會再拿到新號碼，重複儲存也不會跳號，可以放心。',
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

    const grid = el('div', { class: 'anum-grid' });
    mkRow(grid, '儲存前的確認訊息',
      textInput(state.confirmMessage, (v) => { state.confirmMessage = v; }, '例如：確定要產生號碼嗎？'),
      '同仁按下儲存時會先跳出這句話問一次，按取消就不會存檔也不會給號。' +
      '如果不想多一道詢問，這裡填一個星號 * ，就會直接存檔，完成後再顯示拿到的號碼。');
    sec.appendChild(grid);

    const advGrid = el('div', { class: 'anum-grid' });
    mkRow(advGrid, '限定某個狀態才給號',
      textInput(state.statusCond, (v) => { state.statusCond = v; }, '*'),
      '只在「編輯並儲存」時檢查。填狀態名稱（例如：處理中）就只有該狀態會給號；維持 * 表示不限定。');
    mkRow(advGrid, '限定送到某個狀態',
      textInput(state.toStatus, (v) => { state.toStatus = v; }, '*'),
      '只在「按下流程動作」時檢查。填流程送達的狀態名稱（例如：已核准）；維持 * 表示不限定。');
    mkRow(advGrid, '限定某個流程動作',
      textInput(state.actionName, (v) => { state.actionName = v; }, '*'),
      '只在「按下流程動作」時檢查。填按鈕上的文字（例如：核准）；維持 * 表示不限定。');
    mkRow(advGrid, '同時儲存的重試次數',
      numberInput(state.maxRetry, (v) => { state.maxRetry = Number(v) || 5; }, '5'),
      '多人同時按儲存時，搶輸的一方會自動再試一次拿下一號。預設 5 次，一般辦公情境很夠用。');
    sec.appendChild(advanced('進階設定（一般不用動）', advGrid));
    return sec;
  };

  // 4. 分類規則
  const renderCategorySection = () => {
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
    state.categories.forEach((c, i) => {
      const paramCell = c.mode === 'copy'
        ? textInput(c.copyField, (v) => { state.categories[i].copyField = v; }, '欄位代碼，例：統一編號')
        : el('span', { class: 'anum-cell-off' }, ['不需填寫']);
      const validateCell = c.mode === 'copy'
        ? select(VALIDATE_OPTS, c.validate || '', (v) => { state.categories[i].validate = v; })
        : el('span', { class: 'anum-cell-off' }, ['—']);
      const keyCell = c.mode === 'copy'
        ? el('span', { class: 'anum-cell-off' }, ['—'])
        : textInput(c.counterKey, (v) => { state.categories[i].counterKey = v.trim(); }, '留空＝同分類值');

      tbody.appendChild(el('tr', {}, [
        cell(textInput(c.match, (v) => { state.categories[i].match = v; }, '例：境外供應商')),
        cell(keyCell),
        cell(select(MODE_OPTS, c.mode || 'issue', (v) => { state.categories[i].mode = v; render(); })),
        cell(paramCell),
        cell(validateCell),
        cell(el('button', { class: 'anum-btn-row', title: '刪除這條規則', onclick: () => { state.categories.splice(i, 1); render(); } }, ['✕']), 'is-center'),
      ]));
    });
    table.appendChild(tbody);
    sec.appendChild(el('div', { class: 'anum-table-wrap' }, [table]));
    sec.appendChild(el('button', {
      class: 'anum-btn anum-btn-add',
      onclick: () => { state.categories.push({ match: '', counterKey: '', mode: 'issue', copyField: '', validate: '' }); render(); },
    }, ['＋ 新增一條規則']));
    return sec;
  };

  // 5. 代碼對照表（供 number_format 的自訂 token 使用）
  const renderCodeMapSection = () => {
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

    // is-top：本表含較高的多行輸入框，整列靠上對齊，短欄位才不會浮在半空中
    const table = el('table', { class: 'anum-table is-top' });
    table.appendChild(el('thead', {}, [el('tr', {}, [
      el('th', { style: { width: '20%' } }, ['代號名稱', el('small', {}, ['英文，供編號樣式使用'])]),
      el('th', { style: { width: '32%' } }, ['值要從哪一欄取']),
      el('th', { style: { width: '43%' } }, ['對照表', el('small', {}, ['一行一組，中間用等號'])]),
      el('th', { style: { width: '5%' } }, ['']),
    ])]));
    const tbody = el('tbody');
    state.codeMaps.forEach((m, i) => {
      tbody.appendChild(el('tr', {}, [
        cell(textInput(m.token, (v) => { state.codeMaps[i].token = v.trim(); }, '例：level')),
        cell(searchableSelect(FIELD_OPTIONS, m.field, (v) => { state.codeMaps[i].field = v; })),
        cell(textArea(pairsToText(m.pairs), (v) => { state.codeMaps[i].pairs = textToPairs(v); }, '一般事故=G\n重大事故=M')),
        cell(el('button', { class: 'anum-btn-row', title: '刪除這組對照', onclick: () => { state.codeMaps.splice(i, 1); render(); } }, ['✕']), 'is-center'),
      ]));
    });
    table.appendChild(tbody);
    sec.appendChild(el('div', { class: 'anum-table-wrap' }, [table]));
    sec.appendChild(el('button', {
      class: 'anum-btn anum-btn-add',
      onclick: () => { state.codeMaps.push({ token: '', field: '', pairs: [] }); render(); },
    }, ['＋ 新增一組對照']));
    return sec;
  };

  const renderToolbar = () => {
    const bar = el('div', { class: 'anum-toolbar' });
    bar.appendChild(el('span', { class: 'anum-ver' }, [`設定畫面 v${UI_VERSION}`]));
    const msg = el('span', { id: 'anum-msg', style: { flex: '1', marginLeft: '10px' } });
    bar.appendChild(msg);
    bar.appendChild(el('button', { class: 'anum-btn', onclick: () => { history.back(); } }, ['取消']));
    bar.appendChild(el('button', { class: 'anum-btn anum-btn-primary', onclick: save }, ['儲存設定']));
    return bar;
  };

  const validate = () => {
    const errors = [];
    if (!state.counterApp) errors.push('第 1 步：請填寫編號計數器的 App ID');
    if (!state.numberField) errors.push('第 2 步：請選擇存放號碼的欄位');
    if (!state.categoryField) errors.push('第 2 步：請選擇判斷種類的欄位');
    if (state.target === 'subtable' && !state.subtableCode) {
      errors.push('第 2 步：選了「表格的每一列各一個號碼」時，必須指定表格欄位');
    }
    if (!state.triggers.length) errors.push('第 3 步：請至少勾選一個產生號碼的時機');
    if (!state.categories.length) errors.push('第 4 步：請至少新增一條規則');
    // 已載入欄位清單時才做欄位代碼比對；載入失敗（FIELD_OPTIONS 只有預設項）則略過，
    // 以免因為取不到欄位而擋住管理者存檔。
    const knownFields = new Set(FIELD_OPTIONS.map((o) => o.v).filter(Boolean));
    const canCheckFields = knownFields.size > 0;

    state.categories.forEach((c, i) => {
      const id = `第 4 步的第 ${i + 1} 條規則`;
      if (!c.match) errors.push(`${id}：請填寫分類值`);
      if (c.mode === 'copy' && !c.copyField) errors.push(`${id}：選了「直接抄欄位」，請填要抄哪一欄`);

      if (c.mode !== 'copy') {
        // 萬用規則沒有分類值可沿用，必須明確指定計數器代碼。
        if (c.match === '*' && !c.counterKey) {
          errors.push(`${id}：分類值填星號時，計數器代碼一定要填`);
        }

        const key = c.counterKey || '';
        if (key.indexOf('{') !== -1 || key.indexOf('}') !== -1) {
          // 括號必須成對且內容非空
          const tokens = key.match(/\{[^{}]*\}/g) || [];
          const stripped = key.replace(/\{[^{}]*\}/g, '');
          if (stripped.indexOf('{') !== -1 || stripped.indexOf('}') !== -1) {
            errors.push(`${id}：計數器代碼的大括號沒有成對`);
          }
          tokens.forEach((t) => {
            const code = t.slice(1, -1).trim();
            if (!code) {
              errors.push(`${id}：計數器代碼裡有一組空的大括號`);
            } else if (canCheckFields && !knownFields.has(code)) {
              errors.push(`${id}：計數器代碼裡的 {${code}} 在這張表單找不到，請確認欄位代碼`);
            }
          });
        }
      }
    });
    const seenTokens = new Set();
    state.codeMaps.forEach((m, i) => {
      const id = `第 5 步的第 ${i + 1} 組對照`;
      if (!m.token) errors.push(`${id}：請填寫代號名稱`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.token)) errors.push(`${id}：代號名稱請用英文字母、數字或底線，且開頭不能是數字`);
      else if (['prefix', 'seq', 'period', 'YYYY', 'YY', 'MM', 'DD'].includes(m.token)) errors.push(`${id}：代號名稱「${m.token}」是系統保留字，請換一個`);
      else if (seenTokens.has(m.token)) errors.push(`${id}：代號名稱「${m.token}」跟前面重複了`);
      else seenTokens.add(m.token);
      if (!m.field) errors.push(`${id}：請選擇值要從哪一欄取`);
      if (!(m.pairs || []).length) errors.push(`${id}：對照表請至少填一行，格式為「值=代號」`);
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

    // ----- 1) 蒐集 Token：組合注入用的 header，以及回填用的對照表 -----
    const counterToken = (state.counterToken || '').trim();
    const selfToken = (state.selfToken || '').trim();
    const tokenMap = {};                        // { counter, self }（加密存放，供回填）
    if (counterToken) tokenMap.counter = counterToken;
    if (selfToken) tokenMap.self = selfToken;
    const combined = [...new Set(Object.values(tokenMap).filter(Boolean))].join(',');

    // ----- 2) 一般設定（getConfig 可讀）只保留非機密中繼資料，絕不含明文 Token -----
    const publicState = Object.assign({}, state, {
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
        alert('設定已儲存，API Token 也已加密保存，一般同仁無法讀取。\n\n最後一步：請回到 App 畫面按右上角的「更新 App」，設定才會正式生效。');
        window.location.href = `../../flow?app=${APP_ID}`;
      });
    });
  };

  loadFields().then(render);
})();
