/**
 * 發號機批量建檔與批量更新（掛在「編號計數器」App 上使用）
 *
 * 【用途】
 * 自動編號外掛的「計數器代碼」支援 {欄位代碼} 樣板後，一個業務 App 可能需要
 * 幾十台發號機（例：設備代號依「設備種類 × 設備需求」分組 → 18 種類 × 2 需求 ＝ 36 台）。
 * 本工具提供一鍵「批量建立缺少的發號機」與「批量更新既有發號機欄位」功能。
 *
 * 【特色】
 * ・**批量建立與批量更新（Upsert）**：
 *   - 缺少的新發號機：一鍵批次建立（POST /k/v1/records）。
 *   - 已存在的發號機：可選擇同步更新指定欄位（樣式、位數、週期、必填欄位等，PUT /k/v1/records）。
 * ・**動態探測本 App 原生與必填欄位（支援 USER_SELECT / 組織 / 群組 / 核取方塊等）**：
 *   - 自動讀取 Counter App 表單設定，找出所有被設為「必填」的原生與自訂欄位，
 *     在畫面上自動列出並供使用者確認與修改，USER_SELECT 自動預填登入者代碼，
 *     杜絕因缺漏必填欄位導致的寫入錯誤。
 * ・**接續既有編號與流水號保護**：
 *   - 掃描業務 App 現有編號，算出各台已發到的最大號。
 *   - 建立新記錄時自動接續現有號碼；更新既有記錄時預設保護 current 不被重置，
 *     並提供「號碼落後時自動校正 (Fix Drift)」開關防止撞號。
 * ・**reset_cycle 智慧對照**：
 *   - 支援英文（NONE/YEARLY/MONTHLY/DAILY）與中文選項（不重置/每年重置…）動態對應。
 * ・**先預覽再寫入**：完整呈現「待建立」與「待更新」的新舊值比對與欄位差異。
 * ・**分批寫入**：符合 kintone REST API 每批 100 筆上限規定。
 *
 * 【安裝】
 * 編號計數器 App → 設定 → JavaScript / CSS 自訂 → 電腦版 JavaScript → 上傳本檔。
 */
(() => {
  'use strict';

  // ── 可調整的設定 ────────────────────────────────────────────────────────

  // 允許使用本工具的帳號代碼。清空陣列（[]）＝不限制。
  const AUTHORIZED_USERS = ['24136'];

  // Counter App 的核心欄位代碼。若你的 App 欄位代碼不同，改這裡。
  const F = Object.freeze({
    sourceAppId: 'source_app_id',
    categoryKey: 'category_key',
    active: 'active',
    prefix: 'prefix',
    pad: 'pad',
    numberFormat: 'number_format',
    resetCycle: 'reset_cycle',
    periodTag: 'period_tag',
    current: 'current',
    uniqueKey: 'unique_key',
  });

  /** 複合鍵的組合值。 */
  const buildUniqueKey = (sourceAppId, categoryKey) => `${sourceAppId}-${categoryKey}`;

  // active 欄位（核取方塊）的啟用值，需與 App 設定一致。
  const ACTIVE_VALUE = '啟用';

  // reset_cycle 語意值對照表（支援英文常數與中文選項）
  const RESET_CYCLE_ALIASES = Object.freeze({
    NONE: 'NONE', '不重置': 'NONE',
    YEARLY: 'YEARLY', '每年重置': 'YEARLY',
    MONTHLY: 'MONTHLY', '每月重置': 'MONTHLY',
    DAILY: 'DAILY', '每日重置': 'DAILY',
  });

  /**
   * 各「情境」對應的預設編號樣式與歸零週期。
   */
  const MODE_SPEC = Object.freeze({
    新增: { numberFormat: '{prefix}{YY}{seq}', resetCycle: 'YEARLY' },
    修改: { numberFormat: '{prefix}99{seq}', resetCycle: 'NONE' },
    調整: { numberFormat: '{prefix}99{seq}', resetCycle: 'NONE' },
  });

  // 表單預設值
  const DEFAULTS = Object.freeze({
    sourceApp: '',
    field: '設備種類',
    modes: '新增,修改',
    prefix: 'NX',
    pad: '3',
    numberField: '設備代號',
  });

  // kintone REST API 上限
  const BATCH_SIZE = 100;
  const QUERY_LIMIT = 500;

  // 由本工具主邏輯核心控管的欄位集合
  const RESERVED_FIELDS = new Set(Object.values(F));

  // 支援自動填值與必填偵測的欄位型別清單（含 USER_SELECT、組織、群組、複選等）
  const ALLOWED_EXTRA_TYPES = new Set([
    'SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'NUMBER', 'LINK',
    'RADIO_BUTTON', 'DROP_DOWN', 'DATE', 'TIME', 'DATETIME',
    'USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT',
    'CHECK_BOX', 'MULTI_SELECT',
  ]);

  const BUTTON_ID = 'counter-seed-button';
  const STYLE_ID = 'counter-seed-style';

  // ── 共用 DOM 與樣式小工具 ───────────────────────────────────────────────

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'checked') node.checked = !!v;
      else node.setAttribute(k, v);
    });
    children.forEach((c) => {
      if (c === null || c === undefined) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  };

  const injectStyle = () => {
    if (document.getElementById(STYLE_ID)) return;
    const style = el('style', { id: STYLE_ID });
    style.textContent = `
      .cs-btn {
        background-color: #3498db; color: #fff; font-size: 14px; font-weight: bold;
        padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 0 8px;
        transition: background-color .15s;
      }
      .cs-btn:hover { background-color: #2980b9; }
      .cs-btn:disabled { background-color: #bdc3c7; cursor: not-allowed; }
      .cs-btn--ghost { background-color: #95a5a6; }
      .cs-btn--ghost:hover { background-color: #7f8c8d; }
      .cs-btn--success { background-color: #27ae60; }
      .cs-btn--success:hover { background-color: #219150; }

      .cs-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center; z-index: 10000;
      }
      .cs-modal {
        background: #fff; border-radius: 6px; width: min(860px, 95vw);
        max-height: 90vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); font-size: 14px;
      }
      .cs-head {
        padding: 16px 20px; border-bottom: 1px solid #e5e5e5;
        font-size: 16px; font-weight: bold; color: #2c3e50;
        display: flex; justify-content: space-between; align-items: center;
      }
      .cs-body { padding: 16px 20px; overflow-y: auto; }
      .cs-foot {
        padding: 12px 20px; border-top: 1px solid #e5e5e5;
        display: flex; justify-content: flex-end; align-items: center; gap: 6px;
      }
      .cs-section-title {
        font-weight: bold; color: #2c3e50; margin: 16px 0 8px 0;
        padding-bottom: 4px; border-bottom: 1px dashed #dcdcdc; font-size: 14px;
      }
      .cs-row { display: flex; align-items: center; margin-bottom: 10px; }
      .cs-row > label { width: 170px; flex: none; color: #444; font-weight: 500; }
      .cs-row > input, .cs-row > select {
        flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 3px;
      }
      .cs-req-star { color: #e74c3c; margin-right: 4px; font-weight: bold; }
      .cs-hint { color: #777; font-size: 12px; margin: 2px 0 10px 170px; line-height: 1.4; }

      .cs-card-box {
        background: #fdfefe; border: 1px solid #e2e8f0; border-radius: 4px;
        padding: 10px 14px; margin-bottom: 12px;
      }
      .cs-checkbox-group { display: flex; flex-wrap: wrap; gap: 14px; margin: 6px 0 2px 170px; }
      .cs-checkbox-item { display: flex; align-items: center; gap: 4px; cursor: pointer; color: #333; }

      .cs-extra-fields { margin: 6px 0 10px 170px; }
      .cs-extra-row { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
      .cs-extra-row input, .cs-extra-row select {
        flex: 1; padding: 5px 8px; border: 1px solid #ccc; border-radius: 3px; min-width: 0;
      }
      .cs-btn--small { padding: 3px 8px; font-size: 12px; margin: 0; }

      .cs-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      .cs-table th, .cs-table td {
        border: 1px solid #e5e5e5; padding: 6px 8px; text-align: left; font-size: 13px;
      }
      .cs-table th { background: #f8fafc; font-weight: 600; color: #334155; }
      .cs-badge {
        display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 11px; font-weight: bold;
      }
      .cs-badge--new { background: #e8f8f5; color: #117a65; border: 1px solid #a3e4d7; }
      .cs-badge--update { background: #ebf5fb; color: #2471a3; border: 1px solid #aed6f1; }
      .cs-badge--skip { background: #f2f4f4; color: #7f8c8d; border: 1px solid #d5dbdb; }

      .cs-diff-text { font-size: 11px; color: #2980b9; margin-top: 2px; }
      .cs-summary { margin-bottom: 8px; font-weight: 500; color: #333; }
      .cs-skip { color: #7f8c8d; font-size: 12px; margin-top: 8px; }
      .cs-muted td { color: #888; background: #fafafa; }
      .cs-error { color: #c0392b; white-space: pre-wrap; margin-top: 8px; font-size: 13px; }
      .cs-warn { color: #b7791f; background: #fffaf0; border: 1px solid #feebc8; padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 13px; }
      .cs-info { color: #2b6cb0; background: #ebf8ff; border: 1px solid #bee3f8; padding: 8px 12px; border-radius: 4px; margin: 8px 0; font-size: 13px; }
    `;
    document.head.appendChild(style);
  };

  // ── 提示視窗（SweetAlert2，含進出場動畫；環境沒有 Swal 時退回原生視窗）──
  const injectSwalStyle = (() => {
    let done = false;
    return () => {
      if (done || document.getElementById('cs-swal-style')) return;
      done = true;
      const style = document.createElement('style');
      style.id = 'cs-swal-style';
      style.textContent = `
        .cs-swal-popup { border-radius: 12px; padding: 26px 30px 28px; max-width: 92vw; }
        .cs-swal-title { font-size: 21px !important; font-weight: 700 !important; }
        .cs-swal-text  { font-size: 16px !important; line-height: 1.75 !important; color: #33404e !important; text-align: left; }
        .cs-swal-confirm, .cs-swal-cancel {
          font-size: 16px !important; font-weight: 600 !important;
          padding: 10px 26px !important; border-radius: 8px !important;
        }
        @keyframes csPopIn  { from { transform: scale(.9) translateY(10px); opacity: 0 } to { transform: none; opacity: 1 } }
        @keyframes csPopOut { to { transform: scale(.94) translateY(4px); opacity: 0 } }
        .cs-anim-in  { animation: csPopIn .28s cubic-bezier(.22,1,.36,1); }
        .cs-anim-out { animation: csPopOut .16s ease-in forwards; }
        .cs-prog { min-width: 320px; max-width: 440px; margin: 6px auto 2px; }
        .cs-prog-label { font-size: 15px; color: #33404e; margin-bottom: 12px; min-height: 22px; }
        .cs-prog-track { height: 12px; background: #e6ebf1; border-radius: 999px; overflow: hidden; }
        .cs-prog-bar {
          height: 100%; width: 0%; border-radius: 999px;
          background: linear-gradient(90deg,#2b6cb0,#57a5e5,#2b6cb0); background-size: 200% 100%;
          animation: csShimmer 1.5s linear infinite; transition: width .4s cubic-bezier(.4,0,.2,1);
        }
        .cs-prog-bar.is-done { animation: none; background: linear-gradient(90deg,#2f9e5f,#46b877); }
        @keyframes csShimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }
        .cs-prog-count { margin-top: 10px; font-size: 14px; color: #6b7480; font-variant-numeric: tabular-nums; }
      `;
      document.head.appendChild(style);
    };
  })();

  const SWAL_BASE = {
    width: 'auto',
    customClass: {
      popup: 'cs-swal-popup', title: 'cs-swal-title', htmlContainer: 'cs-swal-text',
      confirmButton: 'cs-swal-confirm', cancelButton: 'cs-swal-cancel',
    },
    showClass: { popup: 'cs-anim-in' },
    hideClass: { popup: 'cs-anim-out' },
    confirmButtonColor: '#2b6cb0',
    cancelButtonColor: '#8a94a3',
  };

  const toHtml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');

  const uiAlert = async (icon, title, text) => {
    if (!window.Swal) { window.alert(`${title}\n\n${text || ''}`); return; }
    injectSwalStyle();
    await window.Swal.fire(Object.assign({}, SWAL_BASE, {
      icon, title, html: toHtml(text || ''), confirmButtonText: '好，我知道了',
    }));
  };

  const uiConfirm = async (title, text, confirmText) => {
    if (!window.Swal) return window.confirm(`${title}\n\n${text || ''}`);
    injectSwalStyle();
    const res = await window.Swal.fire(Object.assign({}, SWAL_BASE, {
      icon: 'question', title, html: toHtml(text || ''),
      showCancelButton: true,
      confirmButtonText: confirmText || '確定',
      cancelButtonText: '取消',
      reverseButtons: true,
    }));
    return res.isConfirmed;
  };

  // 批量建立／更新會跑很多筆，用進度條讓使用者知道還要多久、以及是否已完成
  const uiProgress = (() => {
    let active = false;
    const $ = (id) => document.getElementById(id);
    return {
      open(title) {
        if (!window.Swal) return;
        injectSwalStyle();
        active = true;
        window.Swal.fire(Object.assign({}, SWAL_BASE, {
          title,
          html:
            '<div class="cs-prog">' +
              '<div class="cs-prog-label" id="cs-prog-label">正在準備…</div>' +
              '<div class="cs-prog-track"><div class="cs-prog-bar" id="cs-prog-bar"></div></div>' +
              '<div class="cs-prog-count" id="cs-prog-count"></div>' +
            '</div>',
          allowOutsideClick: false, allowEscapeKey: false, showConfirmButton: false,
        }));
      },
      update(label, done, total) {
        if (!active) return;
        const l = $('cs-prog-label'), b = $('cs-prog-bar'), c = $('cs-prog-count');
        if (l && label) l.textContent = label;
        if (b && total > 0) b.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        if (c && total > 0) c.textContent = `${done} / ${total} 筆`;
      },
      async finish(label) {
        if (!active) return;
        const l = $('cs-prog-label'), b = $('cs-prog-bar');
        if (b) { b.style.width = '100%'; b.classList.add('is-done'); }
        if (l && label) l.textContent = label;
        await new Promise((r) => setTimeout(r, 450));
        active = false;
      },
      close() {
        active = false;
        if (window.Swal && window.Swal.isVisible && window.Swal.isVisible()) window.Swal.close();
      },
    };
  })();

  const api = (endpoint, method, params) =>
    kintone.api(kintone.api.url(endpoint, true), method, params);

  /** 解析 kintone API 錯誤明細 */
  const describeApiError = (err) => {
    const base = (err && err.message) || String(err);
    if (!err || !err.errors) return base;

    const details = Object.entries(err.errors)
      .map(([field, info]) => {
        const messages = (info && info.messages) || [];
        return `・${field}：${messages.join('；') || '（無詳細訊息）'}`;
      })
      .join('\n');

    return details ? `${base}\n${details}` : base;
  };

  /** 快取 Counter App 自身的表單設定 */
  let _counterForm = null;
  const getCounterForm = async () => {
    if (_counterForm) return _counterForm;
    try {
      _counterForm = await api('/k/v1/app/form/fields', 'GET', { app: kintone.app.getId() });
    } catch {
      _counterForm = { properties: {} };
    }
    return _counterForm;
  };

  /** 檢查 Counter App 是否有 unique_key 欄位 */
  const hasUniqueKeyField = async () => {
    const form = await getCounterForm();
    return !!(form.properties && form.properties[F.uniqueKey]);
  };

  /**
   * 根據欄位型別將字串轉換為 kintone REST API 格式
   */
  const formatFieldValue = (type, rawValue) => {
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      if (['USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT', 'CHECK_BOX', 'MULTI_SELECT'].includes(type)) {
        return { value: [] };
      }
      return { value: '' };
    }

    if (['USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT'].includes(type)) {
      if (Array.isArray(rawValue)) {
        return {
          value: rawValue
            .map((item) => (typeof item === 'string' ? { code: item.trim() } : { code: item.code || '' }))
            .filter((item) => item.code),
        };
      }
      const codes = String(rawValue)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { value: codes.map((code) => ({ code })) };
    }

    if (type === 'CHECK_BOX' || type === 'MULTI_SELECT') {
      if (Array.isArray(rawValue)) return { value: rawValue };
      const items = String(rawValue)
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      return { value: items };
    }

    return { value: String(rawValue) };
  };

  /**
   * 將 kintone 記錄欄位的值轉為純字串，方便新舊比對與預覽呈現
   */
  const extractRawValueForDiff = (type, fieldObj) => {
    if (!fieldObj || fieldObj.value === undefined || fieldObj.value === null) return '';
    const v = fieldObj.value;
    if (['USER_SELECT', 'ORGANIZATION_SELECT', 'GROUP_SELECT'].includes(type)) {
      if (Array.isArray(v)) {
        return v.map((item) => item.code || item.name || '').filter(Boolean).join(', ');
      }
    }
    if (type === 'CHECK_BOX' || type === 'MULTI_SELECT') {
      if (Array.isArray(v)) {
        return v.join(', ');
      }
    }
    return String(v);
  };

  /**
   * 取得 Counter App 所有被設為必填（required: true）的欄位清單。
   * 分為：
   * 1. 核心由程式自動維護的欄位（如 source_app_id, category_key, pad, reset_cycle, current）
   * 2. 自訂必填欄位（例如：USER_SELECT 負責人、部門、用途備註等，需要使用者提供值）
   */
  const getRequiredFieldsInfo = async () => {
    const form = await getCounterForm();
    const allRequired = Object.values(form.properties || {}).filter((f) => f.required);

    // 排除已在核心表單中有專屬輸入框或由系統推算的欄位
    const autoHandledCodes = new Set([
      F.sourceAppId,
      F.categoryKey,
      F.uniqueKey,
      F.pad,
      F.resetCycle,
      F.current,
      F.periodTag,
    ]);

    const customRequired = allRequired.filter(
      (f) => !autoHandledCodes.has(f.code) && ALLOWED_EXTRA_TYPES.has(f.type)
    );

    const unfillableRequired = allRequired.filter(
      (f) => !autoHandledCodes.has(f.code) && !ALLOWED_EXTRA_TYPES.has(f.type)
    );

    return { allRequired, customRequired, unfillableRequired };
  };

  /** 取得可供「其他自訂欄位」選取的候選清單 */
  const getExtraFieldOptions = async () => {
    const form = await getCounterForm();
    return Object.values(form.properties || {})
      .filter((f) => !RESERVED_FIELDS.has(f.code) && ALLOWED_EXTRA_TYPES.has(f.type))
      .sort((a, b) => a.label.localeCompare(b.label, 'zh-Hant'))
      .map((f) => ({ code: f.code, label: f.label, type: f.type, required: !!f.required }));
  };

  /** 解析 Counter App reset_cycle 的實際可用選項字串 */
  const resolveResetCycleOptions = async () => {
    const form = await getCounterForm();
    const field = form.properties && form.properties[F.resetCycle];
    if (!field || !field.options) {
      throw new Error(`Counter App 找不到「${F.resetCycle}」欄位，或它不是下拉/單選型別`);
    }

    const optionValues = Object.keys(field.options);
    const map = {};
    optionValues.forEach((v) => {
      const semantic = RESET_CYCLE_ALIASES[v];
      if (semantic) map[semantic] = v;
    });

    return { map, optionValues };
  };

  /** 全量取得記錄（分頁） */
  const fetchAll = async (app, query, fields) => {
    const all = [];
    let offset = 0;
    for (;;) {
      const resp = await api('/k/v1/records', 'GET', {
        app,
        query: `${query} limit ${QUERY_LIMIT} offset ${offset}`.trim(),
        fields,
      });
      const batch = resp.records || [];
      all.push(...batch);
      if (batch.length < QUERY_LIMIT) return all;
      offset += QUERY_LIMIT;
    }
  };

  // ── 編號解析與比對 ──────────────────────────────────────────────────────

  const pad2 = (n) => String(n).padStart(2, '0');

  /** 取得當期標記 */
  const getPeriodTag = (cycle) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    switch (cycle) {
      case 'YEARLY':
        return `${y}`;
      case 'MONTHLY':
        return `${y}${m}`;
      case 'DAILY':
        return `${y}${m}${d}`;
      default:
        return '';
    }
  };

  /** 拆解編號樣式為前後固定字串 */
  const splitFormat = (numberFormat, prefix, cycle) => {
    const now = new Date();
    const yyyy = String(now.getFullYear());

    const render = (s) =>
      s
        .replace(/\{prefix\}/g, prefix)
        .replace(/\{YYYY\}/g, yyyy)
        .replace(/\{YY\}/g, yyyy.slice(-2))
        .replace(/\{MM\}/g, pad2(now.getMonth() + 1))
        .replace(/\{DD\}/g, pad2(now.getDate()))
        .replace(/\{period\}/g, getPeriodTag(cycle));

    const parts = numberFormat.split(/\{seq(?::\d+)?\}/);
    return {
      head: render(parts[0] || ''),
      tail: render(parts[1] || ''),
    };
  };

  /** 掃描業務 App 現有最大號碼 */
  const scanMax = (codes, head, tail, pad) => {
    let max = 0;
    let sample = '';
    const odd = [];

    codes.forEach((code) => {
      if (!code.startsWith(head)) return;
      if (tail && !code.endsWith(tail)) return;

      const middle = code.slice(head.length, tail ? code.length - tail.length : undefined);
      if (!/^\d+$/.test(middle)) return;

      if (middle.length !== Number(pad)) {
        if (odd.length < 5) odd.push(code);
        return;
      }

      const seq = Number(middle);
      if (seq > max) {
        max = seq;
        sample = code;
      }
    });

    return { max, sample, odd };
  };

  // ── 核心計畫產生（Build Plan）────────────────────────────────────────────

  const buildPlan = async (cfg) => {
    cfg.hasUniqueKey = await hasUniqueKeyField();
    const counterForm = await getCounterForm();

    // 檢查不支援型別的必填欄位（例如 FILE, SUBTABLE）
    const { unfillableRequired } = await getRequiredFieldsInfo();
    if (unfillableRequired.length) {
      throw new Error(
        '以下必填欄位的型別本工具無法自動填值（例如附件或子表格），' +
          '請先到 Counter App 將其改為非必填：\n  ' +
          unfillableRequired.map((f) => `${f.label}（${f.code}・${f.type}）`).join('、')
      );
    }

    // 解析 reset_cycle 選項
    const { map: resetCycleMap, optionValues: resetCycleOptions } = await resolveResetCycleOptions();
    const missingCycles = [...new Set(cfg.modes.map((m) => MODE_SPEC[m] && MODE_SPEC[m].resetCycle))]
      .filter(Boolean)
      .filter((semantic) => !resetCycleMap[semantic]);
    if (missingCycles.length) {
      throw new Error(
        `Counter App 的「${F.resetCycle}」欄位選項裡找不到：${missingCycles.join('、')}\n` +
          `目前選項：${resetCycleOptions.join('、') || '（無）'}`
      );
    }

    // ① 從業務 App 取得分組選項
    const form = await api('/k/v1/app/form/fields', 'GET', { app: cfg.sourceApp });
    const field = form.properties && form.properties[cfg.field];
    if (!field || !field.options) {
      throw new Error(`業務 App ${cfg.sourceApp} 找不到分組欄位「${cfg.field}」或該欄位沒有選項清單`);
    }

    const options = Object.values(field.options)
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((o) => o.label);

    // ② 取得既有 Counter App 記錄（帶出所有比對所需欄位）
    const fetchFieldCodes = [
      '$id',
      F.sourceAppId,
      F.categoryKey,
      F.current,
      F.pad,
      F.numberFormat,
      F.resetCycle,
      F.prefix,
      F.active,
      F.periodTag,
      F.uniqueKey,
      ...(cfg.extraFields || []).map((r) => r.field),
    ];

    const existingRecords = await fetchAll(
      cfg.counterApp,
      `${F.sourceAppId} = ${cfg.sourceApp}`,
      [...new Set(fetchFieldCodes)]
    );

    const existingMap = new Map();
    existingRecords.forEach((r) => {
      const key = r[F.categoryKey] && r[F.categoryKey].value;
      if (key) existingMap.set(key, r);
    });

    // ③ 掃描業務 App 現有編號
    const codeRecords = await fetchAll(
      cfg.sourceApp,
      `${cfg.numberField} != ""`,
      [cfg.numberField]
    );
    const codes = codeRecords
      .map((r) => r[cfg.numberField] && r[cfg.numberField].value)
      .filter(Boolean)
      .map((v) => String(v).trim());

    // ④ 規劃待建立與待更新清單
    const plannedToCreate = [];
    const plannedToUpdate = [];
    const rows = [];
    const oddCodes = [];

    options.forEach((option) => {
      cfg.modes.forEach((mode) => {
        const spec = MODE_SPEC[mode];
        if (!spec) {
          throw new Error(`未定義的情境「${mode}」，請在 MODE_SPEC 中定義。`);
        }

        const categoryKey = `${option}${mode}`;
        const prefix = `${cfg.prefix}${option}`;
        const targetResetCycleValue = resetCycleMap[spec.resetCycle];
        const periodTag = getPeriodTag(spec.resetCycle);

        const { head, tail } = splitFormat(spec.numberFormat, prefix, spec.resetCycle);
        const found = scanMax(codes, head, tail, cfg.pad);
        found.odd.forEach((c) => oddCodes.length < 10 && oddCodes.push(c));

        const existingRecord = existingMap.get(categoryKey);

        if (existingRecord) {
          const recId = existingRecord.$id.value;
          const existingCurrent = (existingRecord[F.current] && existingRecord[F.current].value) || '0';
          const existingFormat = (existingRecord[F.numberFormat] && existingRecord[F.numberFormat].value) || '';
          const existingPad = (existingRecord[F.pad] && existingRecord[F.pad].value) || '';
          const existingCycle = (existingRecord[F.resetCycle] && existingRecord[F.resetCycle].value) || '';
          const existingPrefix = (existingRecord[F.prefix] && existingRecord[F.prefix].value) || '';

          // 判斷是否需要更新既有記錄
          if (cfg.updateExisting) {
            const updatePayload = {};
            const diffs = [];

            // 1. 編號樣式
            if (cfg.updateFields.numberFormat && existingFormat !== spec.numberFormat) {
              updatePayload[F.numberFormat] = { value: spec.numberFormat };
              diffs.push(`樣式: ${existingFormat || '(預設)'} → ${spec.numberFormat}`);
            }

            // 2. 流水號位數
            if (cfg.updateFields.pad && existingPad !== String(cfg.pad)) {
              updatePayload[F.pad] = { value: String(cfg.pad) };
              diffs.push(`位數: ${existingPad} → ${cfg.pad}`);
            }

            // 3. 重置週期
            if (cfg.updateFields.resetCycle && existingCycle !== targetResetCycleValue) {
              updatePayload[F.resetCycle] = { value: targetResetCycleValue };
              diffs.push(`週期: ${existingCycle} → ${targetResetCycleValue}`);
            }

            // 4. 前綴
            if (cfg.updateFields.prefix && existingPrefix !== prefix) {
              updatePayload[F.prefix] = { value: prefix };
              diffs.push(`前綴: ${existingPrefix} → ${prefix}`);
            }

            // 5. 啟用狀態
            if (cfg.updateFields.active) {
              const curActive = (existingRecord[F.active] && existingRecord[F.active].value) || [];
              if (!curActive.includes(ACTIVE_VALUE)) {
                updatePayload[F.active] = { value: [ACTIVE_VALUE] };
                diffs.push(`啟用狀態: 設為啟用`);
              }
            }

            // 6. 其他必填 / 自訂欄位（含 USER_SELECT 等）
            if (cfg.updateFields.extraFields && cfg.extraFields && cfg.extraFields.length) {
              cfg.extraFields.forEach(({ field: extraCode, value: extraVal }) => {
                const fieldProp = counterForm.properties && counterForm.properties[extraCode];
                const fieldType = (fieldProp && fieldProp.type) || 'SINGLE_LINE_TEXT';
                const formattedNew = formatFieldValue(fieldType, extraVal);
                const curValDisplay = extractRawValueForDiff(fieldType, existingRecord[extraCode]);
                const newValDisplay = extractRawValueForDiff(fieldType, formattedNew);

                if (curValDisplay !== newValDisplay) {
                  updatePayload[extraCode] = formattedNew;
                  diffs.push(`${fieldProp ? fieldProp.label : extraCode}: ${curValDisplay || '(空)'} → ${newValDisplay}`);
                }
              });
            }

            // 7. 流水號校正 (Current Drift Fix)
            let updatedCurrent = existingCurrent;
            if (cfg.fixDrift && found.max > Number(existingCurrent)) {
              updatePayload[F.current] = { value: String(found.max) };
              diffs.push(`流水號校正: ${existingCurrent} → ${found.max}`);
              updatedCurrent = String(found.max);

              // 同步更新 period_tag
              if (periodTag) {
                updatePayload[F.periodTag] = { value: periodTag };
              }
            } else if (cfg.forceCurrent && String(found.max) !== existingCurrent) {
              updatePayload[F.current] = { value: String(found.max) };
              diffs.push(`強制流水號: ${existingCurrent} → ${found.max}`);
              updatedCurrent = String(found.max);
            }

            // 8. 複合鍵補寫（若有欄位且值不符）
            if (cfg.hasUniqueKey) {
              const wantKey = buildUniqueKey(cfg.sourceApp, categoryKey);
              const curKey = (existingRecord[F.uniqueKey] && existingRecord[F.uniqueKey].value) || '';
              if (curKey !== wantKey) {
                updatePayload[F.uniqueKey] = { value: wantKey };
                diffs.push(`唯一鍵更新`);
              }
            }

            const willUpdate = Object.keys(updatePayload).length > 0;
            if (willUpdate) {
              plannedToUpdate.push({
                id: recId,
                record: updatePayload,
              });
            }

            rows.push({
              categoryKey,
              head,
              status: willUpdate ? '待更新' : '已存在（無變更）',
              existingCurrent,
              targetCurrent: updatedCurrent,
              diffs,
              found,
              isNew: false,
              nextCode: `${head}${String(Number(updatedCurrent) + 1).padStart(Number(cfg.pad), '0')}${tail}`,
            });
          } else {
            // 不更新既有記錄
            rows.push({
              categoryKey,
              head,
              status: '已存在（略過）',
              existingCurrent,
              targetCurrent: existingCurrent,
              diffs: [],
              found,
              isNew: false,
              nextCode: `${head}${String(Number(existingCurrent) + 1).padStart(Number(cfg.pad), '0')}${tail}`,
            });
          }
          return;
        }

        // ── 待新建發號機 ──
        const newRec = {
          [F.sourceAppId]: { value: String(cfg.sourceApp) },
          [F.categoryKey]: { value: categoryKey },
          [F.active]: { value: [ACTIVE_VALUE] },
          [F.prefix]: { value: prefix },
          [F.pad]: { value: String(cfg.pad) },
          [F.numberFormat]: { value: spec.numberFormat },
          [F.resetCycle]: { value: targetResetCycleValue },
          [F.periodTag]: { value: periodTag },
          [F.current]: { value: String(found.max) },
        };

        if (cfg.hasUniqueKey) {
          newRec[F.uniqueKey] = { value: buildUniqueKey(cfg.sourceApp, categoryKey) };
        }

        (cfg.extraFields || []).forEach(({ field: extraCode, value: extraVal }) => {
          const fieldProp = counterForm.properties && counterForm.properties[extraCode];
          const fieldType = (fieldProp && fieldProp.type) || 'SINGLE_LINE_TEXT';
          newRec[extraCode] = formatFieldValue(fieldType, extraVal);
        });

        plannedToCreate.push(newRec);

        rows.push({
          categoryKey,
          head,
          status: '待建立',
          existingCurrent: '—',
          targetCurrent: String(found.max),
          periodTag,
          numberFormat: spec.numberFormat,
          resetCycle: targetResetCycleValue,
          found,
          diffs: ['新建記錄'],
          isNew: true,
          nextCode: `${head}${String(found.max + 1).padStart(Number(cfg.pad), '0')}${tail}`,
        });
      });
    });

    return {
      options,
      plannedToCreate,
      plannedToUpdate,
      rows,
      oddCodes,
      scanned: codes.length,
    };
  };

  /** 分批新增記錄（每批 100 筆） */
  const createAll = async (counterApp, records, onProgress) => {
    let done = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      await api('/k/v1/records', 'POST', { app: counterApp, records: chunk });
      done += chunk.length;
      if (typeof onProgress === 'function') onProgress(done);
    }
    return done;
  };

  /** 分批更新記錄（每批 100 筆） */
  const updateAll = async (counterApp, records, onProgress) => {
    let done = 0;
    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      await api('/k/v1/records', 'PUT', { app: counterApp, records: chunk });
      done += chunk.length;
      if (typeof onProgress === 'function') onProgress(done);
    }
    return done;
  };

  // ── 畫面互動（Modal Dialog）──────────────────────────────────────────────

  const openDialog = async () => {
    const counterApp = kintone.app.getId();

    const overlay = el('div', { class: 'cs-overlay' });
    const body = el('div', { class: 'cs-body' });
    const foot = el('div', { class: 'cs-foot' });
    const modal = el('div', { class: 'cs-modal' }, [
      el('div', { class: 'cs-head' }, [
        el('span', {}, ['批量建立與更新編號規則']),
        el('button', { class: 'cs-btn cs-btn--ghost cs-btn--small', onclick: () => overlay.remove() }, ['✕']),
      ]),
      body,
      foot,
    ]);
    overlay.appendChild(modal);

    const close = () => overlay.remove();
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    // 狀態暫存（切換預覽時保留使用者填寫的內容）
    const formState = {
      sourceApp: DEFAULTS.sourceApp,
      field: DEFAULTS.field,
      modes: DEFAULTS.modes,
      prefix: DEFAULTS.prefix,
      pad: DEFAULTS.pad,
      numberField: DEFAULTS.numberField,
      updateExisting: true, // 預設一併更新既有規則
      updateFields: {
        numberFormat: true,
        pad: true,
        resetCycle: true,
        prefix: true,
        active: true,
        extraFields: true,
      },
      fixDrift: true, // 預設自動校正落後的 current
      forceCurrent: false,
      extraFields: [], // [{ field: 'code', label: 'label', type: 'type', value: 'val', isRequired: true/false }]
    };

    // 預先抓取本 App 必填欄位
    let requiredFieldsInfo = null;
    let availableExtraOptions = null;

    try {
      requiredFieldsInfo = await getRequiredFieldsInfo();
      availableExtraOptions = await getExtraFieldOptions();

      // 將自訂必填欄位預設加入 extraFields（USER_SELECT 自動預設當前登入者）
      if (formState.extraFields.length === 0 && requiredFieldsInfo.customRequired.length > 0) {
        const loginUser = kintone.getLoginUser();
        formState.extraFields = requiredFieldsInfo.customRequired.map((f) => ({
          field: f.code,
          label: f.label,
          type: f.type,
          value: f.type === 'USER_SELECT' ? (loginUser ? loginUser.code : '') : '',
          isRequired: true,
        }));
      }
    } catch (err) {
      console.warn('[counter-seed] 表單欄位資訊取得失敗', err);
    }

    // ── 步驟一：參數設定表單 ──
    const renderForm = () => {
      body.textContent = '';
      foot.textContent = '';

      body.appendChild(
        el('div', { class: 'cs-info' }, [
          `目前使用的 Counter App ID：${counterApp}（本工具可同時批量新增與更新既有的編號規則）`,
        ])
      );

      // 基本發號規則區
      body.appendChild(el('div', { class: 'cs-section-title' }, ['1. 發號與業務 App 參數']));

      const inputs = {};
      const addRow = (key, label, isRequired, hint, defVal) => {
        const val = formState[key] !== undefined ? formState[key] : defVal;
        const input = el('input', { type: 'text', value: val || '' });
        inputs[key] = input;
        input.addEventListener('input', (e) => { formState[key] = e.target.value; });

        const labelEl = el('label', {}, [
          isRequired ? el('span', { class: 'cs-req-star' }, ['*']) : null,
          label,
        ]);
        body.appendChild(el('div', { class: 'cs-row' }, [labelEl, input]));
        if (hint) body.appendChild(el('div', { class: 'cs-hint' }, [hint]));
      };

      addRow('sourceApp', '業務 App ID', true, '要為哪一個 App 建立編號規則。開啟該業務 App，網址 /k/123/ 裡的 123。', '');
      addRow('field', '分組欄位代碼', true, '決定產生幾台計數器的業務欄位（下拉選單/單選按鈕），自動讀取其選項清單。', DEFAULTS.field);
      addRow('modes', '情境（逗號分隔）', true, `目前支援：${Object.keys(MODE_SPEC).join('、')}。`, DEFAULTS.modes);
      addRow('prefix', '編號前綴 (Prefix)', false, '前綴文字，例如 NX。將與分組選項自動組合。', DEFAULTS.prefix);
      addRow('pad', '流水號補零位數', true, '例如 3 → 001；4 → 0001。', DEFAULTS.pad);
      addRow('numberField', '業務 App 編號欄位', true, '掃描業務 App 現有編號以接續最大號，防止第一次發號撞號。', DEFAULTS.numberField);

      // 本 App 原生必填與自訂欄位設定區
      body.appendChild(el('div', { class: 'cs-section-title' }, ['2. 本 Counter App 欄位設定（原生必填與自訂值）']));

      const extraContainer = el('div', { class: 'cs-card-box' });

      const renderExtraRows = () => {
        extraContainer.textContent = '';

        if (!formState.extraFields.length) {
          extraContainer.appendChild(
            el('div', { style: { color: '#888', fontSize: '13px', marginBottom: '8px' } }, [
              '本 App 無其他必填欄位。若有其他欄位需統一填值，可點擊下方按鈕新增。',
            ])
          );
        }

        formState.extraFields.forEach((row, i) => {
          const rowEl = el('div', { class: 'cs-extra-row' });

          // 決定型別提示
          let typeHint = '';
          let placeholder = '設定值';
          if (row.type === 'USER_SELECT') {
            typeHint = '（使用者選擇）';
            placeholder = '使用者代碼（例: 24136，多位以逗號分隔）';
          } else if (row.type === 'ORGANIZATION_SELECT') {
            typeHint = '（組織選擇）';
            placeholder = '組織代碼（多個以逗號分隔）';
          } else if (row.type === 'GROUP_SELECT') {
            typeHint = '（群組選擇）';
            placeholder = '群組代碼（多個以逗號分隔）';
          } else if (row.type === 'CHECK_BOX' || row.type === 'MULTI_SELECT') {
            typeHint = '（多選）';
            placeholder = '選項名稱（多個以逗號分隔）';
          }

          if (row.isRequired) {
            // 原生必填欄位：固定代碼不可刪除，顯示必填標籤
            rowEl.appendChild(
              el('div', { style: { width: '180px', flex: 'none', fontWeight: 'bold', color: '#333' } }, [
                el('span', { class: 'cs-req-star' }, ['*']),
                `${row.label || row.field}${typeHint}`,
              ])
            );
          } else {
            // 自選擴充欄位：可切換下拉選單
            const fieldSelect = el('select', { style: { width: '180px', flex: 'none' } });
            fieldSelect.appendChild(el('option', { value: '' }, ['— 選擇欄位 —']));
            (availableExtraOptions || []).forEach((opt) => {
              fieldSelect.appendChild(
                el('option', { value: opt.code }, [`${opt.label}（${opt.code}）`])
              );
            });
            fieldSelect.value = row.field;
            fieldSelect.addEventListener('change', (e) => {
              row.field = e.target.value;
              const selectedOpt = (availableExtraOptions || []).find((opt) => opt.code === row.field);
              row.type = selectedOpt ? selectedOpt.type : 'SINGLE_LINE_TEXT';
              row.label = selectedOpt ? selectedOpt.label : row.field;
              renderExtraRows();
            });
            rowEl.appendChild(fieldSelect);
          }

          const valInput = el('input', {
            type: 'text',
            placeholder,
            value: row.value || '',
          });
          valInput.addEventListener('input', (e) => {
            row.value = e.target.value;
          });
          rowEl.appendChild(valInput);

          if (!row.isRequired) {
            const removeBtn = el('button', { class: 'cs-btn cs-btn--ghost cs-btn--small' }, ['✕']);
            removeBtn.onclick = () => {
              formState.extraFields.splice(i, 1);
              renderExtraRows();
            };
            rowEl.appendChild(removeBtn);
          }

          extraContainer.appendChild(rowEl);
        });

        const addCustomBtn = el('button', { class: 'cs-btn cs-btn--ghost cs-btn--small', style: { marginTop: '4px' } }, ['+ 增加自訂欄位']);
        addCustomBtn.onclick = () => {
          formState.extraFields.push({ field: '', value: '', type: 'SINGLE_LINE_TEXT', isRequired: false });
          renderExtraRows();
        };
        extraContainer.appendChild(addCustomBtn);
      };

      renderExtraRows();
      body.appendChild(extraContainer);

      // 已存在記錄更新策略區
      body.appendChild(el('div', { class: 'cs-section-title' }, ['3. 已存在的規則要不要一起更新']));

      const updateCard = el('div', { class: 'cs-card-box' });

      // 主開關：是否同步更新既有記錄
      const updateToggle = el('input', {
        type: 'checkbox',
        id: 'cs-toggle-update',
        checked: formState.updateExisting,
      });
      updateToggle.addEventListener('change', (e) => {
        formState.updateExisting = e.target.checked;
        subOptionsBox.style.display = formState.updateExisting ? 'block' : 'none';
      });

      const toggleLabel = el('label', { for: 'cs-toggle-update', style: { fontWeight: 'bold', cursor: 'pointer' } }, [
        '規則已存在時，一併更新它的欄位（不勾選就只建立缺少的，既有的直接略過）',
      ]);
      updateCard.appendChild(el('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '10px' } }, [updateToggle, toggleLabel]));

      // 細項勾選容器
      const subOptionsBox = el('div', { style: { display: formState.updateExisting ? 'block' : 'none', paddingLeft: '22px', borderLeft: '2px solid #3498db' } });

      const addFieldCheckbox = (fieldKey, labelText) => {
        const cb = el('input', { type: 'checkbox', checked: formState.updateFields[fieldKey] });
        cb.addEventListener('change', (e) => { formState.updateFields[fieldKey] = e.target.checked; });
        return el('label', { class: 'cs-checkbox-item' }, [cb, labelText]);
      };

      const fieldsGroup = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', margin: '6px 0 10px 0' } }, [
        addFieldCheckbox('numberFormat', '編號樣式 (number_format)'),
        addFieldCheckbox('pad', '流水號位數 (pad)'),
        addFieldCheckbox('resetCycle', '重置週期 (reset_cycle)'),
        addFieldCheckbox('prefix', '編號前綴 (prefix)'),
        addFieldCheckbox('active', '啟用狀態 (active)'),
        addFieldCheckbox('extraFields', '必填／其他自訂欄位'),
      ]);

      subOptionsBox.appendChild(el('div', { style: { fontSize: '13px', fontWeight: '500', color: '#333' } }, ['勾選要一併更新的欄位：']));
      subOptionsBox.appendChild(fieldsGroup);

      // 流水號 current 安全保護與校正
      const fixDriftCb = el('input', { type: 'checkbox', checked: formState.fixDrift });
      fixDriftCb.addEventListener('change', (e) => { formState.fixDrift = e.target.checked; });
      subOptionsBox.appendChild(
        el('label', { class: 'cs-checkbox-item', style: { color: '#2c3e50', marginTop: '6px' } }, [
          fixDriftCb,
          '【安全校正】若業務 App 實際已使用的最大號大於既有 current，自動調升 current 至最新號（修復落後撞號）',
        ])
      );

      updateCard.appendChild(subOptionsBox);
      body.appendChild(updateCard);

      const msgEl = el('div', { class: 'cs-error' });
      body.appendChild(msgEl);

      const previewBtn = el('button', { class: 'cs-btn cs-btn--success' }, ['預覽變更清單']);
      previewBtn.onclick = async () => {
        msgEl.textContent = '';

        const cfg = {
          counterApp,
          sourceApp: (inputs.sourceApp.value || '').trim(),
          field: (inputs.field.value || '').trim(),
          modes: (inputs.modes.value || '').split(',').map((s) => s.trim()).filter(Boolean),
          prefix: (inputs.prefix.value || '').trim(),
          pad: (inputs.pad.value || '').trim(),
          numberField: (inputs.numberField.value || '').trim(),
          updateExisting: formState.updateExisting,
          updateFields: { ...formState.updateFields },
          fixDrift: formState.fixDrift,
          forceCurrent: formState.forceCurrent,
        };

        if (!/^\d+$/.test(cfg.sourceApp)) {
          msgEl.textContent = '請輸入正確的業務 App ID（必須為數字）';
          return;
        }
        if (!cfg.field) {
          msgEl.textContent = '請填寫分組欄位代碼';
          return;
        }
        if (!cfg.modes.length) {
          msgEl.textContent = '請至少填寫一個情境名稱';
          return;
        }
        if (!cfg.numberField) {
          msgEl.textContent = '請填寫業務 App 的編號欄位代碼';
          return;
        }
        if (!/^\d+$/.test(cfg.pad)) {
          msgEl.textContent = '補零位數必須為數字';
          return;
        }

        // 驗證自訂/必填欄位
        const validExtras = [];
        for (const item of formState.extraFields) {
          const code = (item.field || '').trim();
          const val = item.value !== undefined ? String(item.value).trim() : '';

          if (item.isRequired && !val) {
            msgEl.textContent = `本 App 必填欄位「${item.label || code}」尚未填寫值！`;
            return;
          }
          if (code) {
            validExtras.push({ field: code, value: val, type: item.type });
          }
        }
        cfg.extraFields = validExtras;

        previewBtn.disabled = true;
        previewBtn.textContent = '掃描與比對中...';

        try {
          const plan = await buildPlan(cfg);
          renderPreview(cfg, plan);
        } catch (err) {
          msgEl.textContent = `讀取失敗：${describeApiError(err)}`;
          previewBtn.disabled = false;
          previewBtn.textContent = '預覽變更清單';
        }
      };

      foot.appendChild(el('button', { class: 'cs-btn cs-btn--ghost', onclick: close }, ['取消']));
      foot.appendChild(previewBtn);
    };

    // ── 步驟二：預覽與確認執行 ──
    const renderPreview = (cfg, plan) => {
      body.textContent = '';
      foot.textContent = '';

      const numCreate = plan.plannedToCreate.length;
      const numUpdate = plan.plannedToUpdate.length;
      const numTotal = plan.rows.length;

      body.appendChild(
        el('div', { class: 'cs-info' }, [
          `業務 App（ID: ${cfg.sourceApp}）分組欄位「${cfg.field}」共 ${plan.options.length} 個選項：${plan.options.join('、')}\n` +
            `已掃描現有業務編號 ${plan.scanned} 筆 ➔ 需要 ${numTotal} 組編號規則：待建立 ${numCreate} 組、待更新 ${numUpdate} 組、無變更 ${numTotal - numCreate - numUpdate} 組`,
        ])
      );

      // 表格列出所有發號機規劃
      const table = el('table', { class: 'cs-table' });
      table.appendChild(
        el('thead', {}, [
          el('tr', {}, [
            '編號種類代碼 (category_key)',
            '狀態',
            '現有最大號',
            '預定 current',
            '下一號預覽',
            '變更明細',
          ].map((h) => el('th', {}, [h]))),
        ])
      );

      const tbody = el('tbody');
      plan.rows.forEach((r) => {
        const trClass = r.isNew ? '' : (r.status === '待更新' ? '' : 'cs-muted');
        const badgeClass = r.isNew
          ? 'cs-badge cs-badge--new'
          : (r.status === '待更新' ? 'cs-badge cs-badge--update' : 'cs-badge cs-badge--skip');

        const diffHtml = r.diffs && r.diffs.length
          ? r.diffs.map((d) => el('div', { class: 'cs-diff-text' }, [d]))
          : [el('span', { style: { color: '#999' } }, ['無變更'])];

        tbody.appendChild(
          el('tr', { class: trClass }, [
            el('td', { style: { fontWeight: 'bold' } }, [r.categoryKey]),
            el('td', {}, [el('span', { class: badgeClass }, [r.status])]),
            el('td', {}, [r.found.sample ? `${r.found.sample} (#${r.found.max})` : '無']),
            el('td', {}, [
              r.isNew
                ? `${r.targetCurrent} (接續)`
                : (r.targetCurrent !== r.existingCurrent ? `${r.existingCurrent} → ${r.targetCurrent}` : `${r.existingCurrent} (不變)`)
            ]),
            el('td', {}, [r.nextCode || '—']),
            el('td', {}, diffHtml),
          ])
        );
      });
      table.appendChild(tbody);
      body.appendChild(table);

      if (plan.oddCodes.length) {
        body.appendChild(
          el('div', { class: 'cs-warn' }, [
            `⚠ 掃描時發現 ${plan.oddCodes.length} 筆編號開頭吻合但流水號長度與「${cfg.pad}」不符（未納入計算，請留意是否為舊版格式）：\n` +
              plan.oddCodes.join('、'),
          ])
        );
      }

      const msgEl = el('div', { class: 'cs-error' });
      body.appendChild(msgEl);

      const backBtn = el('button', { class: 'cs-btn cs-btn--ghost', onclick: renderForm }, ['上一步（調整設定）']);
      foot.appendChild(backBtn);

      if (numCreate === 0 && numUpdate === 0) {
        body.appendChild(el('div', { class: 'cs-info' }, ['所有編號規則都已存在，而且欄位都與設定相符，不需要建立或更新。']));
        foot.appendChild(el('button', { class: 'cs-btn', onclick: close }, ['關閉']));
        return;
      }

      const actionText = `確認執行（新增 ${numCreate} 台、更新 ${numUpdate} 台）`;
      const confirmBtn = el('button', { class: 'cs-btn cs-btn--success' }, [actionText]);

      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        backBtn.disabled = true;
        msgEl.textContent = '';

        const total = numCreate + numUpdate;
        try {
          let createdCount = 0;
          let updatedCount = 0;

          uiProgress.open('正在建立編號規則');

          // 1. 執行批次建立
          if (numCreate > 0) {
            uiProgress.update('正在建立編號規則…', 0, total);
            createdCount = await createAll(cfg.counterApp, plan.plannedToCreate, (done) => {
              confirmBtn.textContent = `建立中... ${done}/${numCreate}`;
              uiProgress.update('正在建立編號規則…', done, total);
            });
          }

          // 2. 執行批次更新
          if (numUpdate > 0) {
            uiProgress.update('正在更新編號規則…', createdCount, total);
            updatedCount = await updateAll(cfg.counterApp, plan.plannedToUpdate, (done) => {
              confirmBtn.textContent = `更新中... ${done}/${numUpdate}`;
              uiProgress.update('正在更新編號規則…', createdCount + done, total);
            });
          }

          await uiProgress.finish('全部完成！');

          await uiAlert(
            'success',
            '作業完成',
            `・新增了 ${createdCount} 組編號規則\n` +
              `・更新了 ${updatedCount} 組編號規則\n\n` +
              `請確認業務 App 的編號欄位已勾選「值的唯一性」以確保編號安全。`
          );
          location.reload();
        } catch (err) {
          uiProgress.close();
          msgEl.textContent = `執行失敗：${describeApiError(err)}`;
          await uiAlert('error', '執行失敗', describeApiError(err));
          confirmBtn.disabled = false;
          backBtn.disabled = false;
          confirmBtn.textContent = actionText;
        }
      };

      foot.appendChild(confirmBtn);
    };

    renderForm();
    document.body.appendChild(overlay);
  };

  // ── unique_key 既有記錄補寫（一次性遷移工具）────────────────────────────

  const backfillUniqueKeys = async () => {
    if (!(await hasUniqueKeyField())) {
      await uiAlert(
        'warning',
        `找不到「${F.uniqueKey}」欄位`,
        `請先新增一個「文字（單行）」欄位、欄位代碼設為 ${F.uniqueKey}，補寫完成後再勾選「值的重複禁止」。`
      );
      return;
    }

    const counterApp = kintone.app.getId();
    const all = await fetchAll(counterApp, '', ['$id', F.sourceAppId, F.categoryKey, F.uniqueKey]);

    const toFix = [];
    const seen = new Map();
    const dup = [];

    all.forEach((r) => {
      const src = (r[F.sourceAppId] && r[F.sourceAppId].value) || '';
      const key = (r[F.categoryKey] && r[F.categoryKey].value) || '';
      if (!src || !key) return;

      const want = buildUniqueKey(src, key);
      const now = (r[F.uniqueKey] && r[F.uniqueKey].value) || '';

      if (seen.has(want)) dup.push(want);
      else seen.set(want, r.$id.value);

      if (now !== want) toFix.push({ id: r.$id.value, record: { [F.uniqueKey]: { value: want } } });
    });

    if (dup.length) {
      await uiAlert(
        'error',
        '發現重複的編號規則',
        `同一個 App 有重複的 ${F.categoryKey}，無法補寫：\n\n` +
          [...new Set(dup)].join('\n') +
          '\n\n請先人工確認並刪除多餘的記錄。'
      );
      return;
    }

    if (toFix.length === 0) {
      await uiAlert('success', '不需要補寫', `所有記錄的 ${F.uniqueKey} 都已正確。`);
      return;
    }

    const go = await uiConfirm(
      '要現在補寫嗎？',
      `共 ${all.length} 筆記錄，其中 ${toFix.length} 筆需要補寫 ${F.uniqueKey}。`,
      '開始補寫'
    );
    if (!go) return;

    uiProgress.open('正在補寫');
    try {
      await updateAll(counterApp, toFix, (done) => {
        uiProgress.update(`正在補寫 ${F.uniqueKey}…`, done, toFix.length);
      });
      await uiProgress.finish('補寫完成！');
    } catch (err) {
      uiProgress.close();
      throw err;
    }

    await uiAlert(
      'success',
      `已補寫 ${toFix.length} 筆`,
      `最後一步：到「${F.uniqueKey}」欄位勾選「值的重複禁止」並更新 App。`
    );
    location.reload();
  };

  // ── 進入點：清單頁按鈕注入 ──────────────────────────────────────────────

  kintone.events.on('app.record.index.show', (event) => {
    if (document.getElementById(BUTTON_ID)) return event;

    if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(kintone.getLoginUser().code)) {
      return event;
    }

    injectStyle();

    const header = kintone.app.getHeaderMenuSpaceElement();
    if (!header) return event;

    const button = el('button', { id: BUTTON_ID, class: 'cs-btn' }, ['批量建立／更新編號規則']);
    button.onclick = openDialog;
    header.appendChild(button);

    const fixBtn = el('button', { class: 'cs-btn cs-btn--ghost' }, [`補寫 ${F.uniqueKey}`]);
    fixBtn.onclick = async () => {
      fixBtn.disabled = true;
      try {
        await backfillUniqueKeys();
      } catch (err) {
        console.error('[counter-seed] 補寫失敗', err);
        await uiAlert('error', '補寫失敗', describeApiError(err));
      }
      fixBtn.disabled = false;
    };
    header.appendChild(fixBtn);

    return event;
  });

  // ── 表單存檔時自動補齊 unique_key ───────────────────────────────────────
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit',
     'mobile.app.record.create.submit', 'mobile.app.record.edit.submit'],
    async (event) => {
      const record = event.record;
      if (!record[F.uniqueKey]) return event;

      const src = (record[F.sourceAppId] && record[F.sourceAppId].value) || '';
      const key = (record[F.categoryKey] && record[F.categoryKey].value) || '';
      if (!src || !key) {
        event.error = `請先填寫「${F.sourceAppId}」與「${F.categoryKey}」`;
        return event;
      }

      record[F.uniqueKey].value = buildUniqueKey(src, key);
      return event;
    }
  );
})();
