/**
 * 發號機批量建檔（掛在「編號計數器」App 上使用）
 *
 * 【用途】
 * 自動編號外掛的「計數器代碼」支援 {欄位代碼} 樣板後，一個業務 App 可能需要
 * 幾十台發號機（例：設備代號依「設備種類 × 設備需求」分組 → 18 種類 × 2 需求 ＝ 36 台）。
 * 手動一筆筆建不切實際，本工具在清單頁提供按鈕一次建完。
 *
 * 【特色】
 * ・分組用的選項清單**直接讀業務 App 的表單設定**，不寫死在程式裡，
 *   日後表單新增設備種類，重跑一次就補齊缺的，不會與表單漂移。
 * ・**接續既有編號**：建檔前先掃描業務 App 現有的編號，算出每一台
 *   「種類 × 情境」目前已經發到哪一號，把 current 設成該值。
 *   若一律從 0 開始，第一次發號就會產生 NXN126001 而與現有記錄撞號。
 *   同時把 period_tag 設成當期標記——YEARLY 的計數器若 period_tag 為空，
 *   外掛會判定成跨週期而把號碼歸零到 1，照樣撞號。
 * ・冪等：已存在相同 (source_app_id, category_key) 的發號機自動略過，
 *   重複執行不會重複建檔，也不會覆蓋既有的 current（不會把號碼歸零）。
 * ・先預覽再建檔：確認清單無誤才會真的寫入。
 * ・走登入者自身的 session 權限，不需要 API Token。
 *
 * 【安裝】
 * 編號計數器 App → 設定 → JavaScript / CSS 自訂 → 電腦版 JavaScript → 上傳本檔。
 *
 * 【使用】
 * 清單頁右上「批量建立發號機」→ 填業務 App ID 等參數 → 預覽 → 確認建立。
 */
(() => {
  'use strict';

  // ── 可調整的設定 ────────────────────────────────────────────────────────

  // 允許使用本工具的帳號代碼。清空陣列（[]）＝不限制。
  const AUTHORIZED_USERS = ['24136'];

  // Counter App 的欄位代碼。若你的 App 欄位代碼不同，改這裡。
  const F = {
    sourceAppId: 'source_app_id',
    categoryKey: 'category_key',
    active: 'active',
    prefix: 'prefix',
    pad: 'pad',
    numberFormat: 'number_format',
    resetCycle: 'reset_cycle',
    periodTag: 'period_tag',
    current: 'current',

    // 複合鍵的唯一性防線（選用，但強烈建議）。
    //
    // 發號機的鍵是「(source_app_id, category_key)」的**複合鍵** —— 不同業務 App
    // 本來就會有相同的 category_key（App 123 和 App 456 都可以有 N1新增），
    // 所以 category_key 本身不能勾唯一性，勾了會把合法記錄擋掉。
    // 而 kintone 的「值的唯一性」只能套在單一欄位，沒有複合唯一約束。
    //
    // 解法：多一個文字（單行）欄位存兩者的組合值，唯一性勾在它身上，
    // 就能擋下「同一個 App 重複建了同一台計數器」——那是真正會產生重號的情境。
    //
    // 本欄位為選用：Counter App 沒有這個欄位時，工具會自動略過相關處理。
    uniqueKey: 'unique_key',
  };

  /** 複合鍵的組合值。 */
  const buildUniqueKey = (sourceAppId, categoryKey) => `${sourceAppId}-${categoryKey}`;

  // active 欄位（核取方塊）的啟用值，需與 App 設定一致。
  const ACTIVE_VALUE = '啟用';

  /**
   * 各「情境」對應的編號樣式與歸零週期。
   * 要新增情境（例如「借用」），在這裡加一筆，畫面上的「情境」欄位填該名稱即可。
   *
   *   {prefix}{YY}{seq} → NXN126001（每年歸零）
   *   {prefix}99{seq}   → NXN199001（不歸零，固定 99 區段）
   */
  const MODE_SPEC = {
    新增: { numberFormat: '{prefix}{YY}{seq}', resetCycle: 'YEARLY' },
    修改: { numberFormat: '{prefix}99{seq}', resetCycle: 'NONE' },
    // 別名：若表單的「設備需求」選項寫的是「調整」而非「修改」，直接填 調整 即可
    調整: { numberFormat: '{prefix}99{seq}', resetCycle: 'NONE' },
  };

  // 表單預設值
  const DEFAULTS = {
    sourceApp: '',
    field: '設備種類',
    modes: '新增,修改',
    prefix: 'NX',
    pad: '3',
    numberField: '設備代號',
  };

  // kintone /k/v1/records 的單次上限
  const BATCH_SIZE = 100;
  const QUERY_LIMIT = 500;

  const BUTTON_ID = 'counter-seed-button';
  const STYLE_ID = 'counter-seed-style';

  // ── 共用小工具 ──────────────────────────────────────────────────────────

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
      .cs-btn {
        background-color: #3498db; color: #fff; font-size: 14px; font-weight: bold;
        padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; margin: 0 8px;
      }
      .cs-btn:hover { background-color: #2980b9; }
      .cs-btn:disabled { background-color: #bdc3c7; cursor: not-allowed; }
      .cs-btn--ghost { background-color: #95a5a6; }
      .cs-btn--ghost:hover { background-color: #7f8c8d; }

      .cs-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center; z-index: 10000;
      }
      .cs-modal {
        background: #fff; border-radius: 6px; width: min(760px, 92vw);
        max-height: 88vh; display: flex; flex-direction: column;
        box-shadow: 0 8px 32px rgba(0,0,0,.25); font-size: 14px;
      }
      .cs-head {
        padding: 16px 20px; border-bottom: 1px solid #e5e5e5;
        font-size: 16px; font-weight: bold; color: #2c3e50;
      }
      .cs-body { padding: 16px 20px; overflow: auto; }
      .cs-foot {
        padding: 12px 20px; border-top: 1px solid #e5e5e5;
        display: flex; justify-content: flex-end; align-items: center; gap: 4px;
      }
      .cs-row { display: flex; align-items: center; margin-bottom: 12px; }
      .cs-row > label { width: 150px; flex: none; color: #555; }
      .cs-row > input { flex: 1; padding: 6px 8px; border: 1px solid #ccc; border-radius: 3px; }
      .cs-hint { color: #888; font-size: 12px; margin: 4px 0 14px 150px; }

      .cs-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      .cs-table th, .cs-table td {
        border: 1px solid #e5e5e5; padding: 5px 8px; text-align: left; font-size: 13px;
      }
      .cs-table th { background: #f7f7f7; }
      .cs-summary { margin-bottom: 8px; }
      .cs-skip { color: #999; font-size: 12px; margin-top: 10px; }
      .cs-muted td { color: #aaa; background: #fafafa; }
      .cs-error { color: #c0392b; white-space: pre-wrap; }
      .cs-warn { color: #b9770e; }
    `;
    document.head.appendChild(style);
  };

  const api = (endpoint, method, params) =>
    kintone.api(kintone.api.url(endpoint, true), method, params);

  /**
   * Counter App 自己有沒有 unique_key 欄位？（查一次就記住）
   * 沒有的話所有與它相關的處理都自動略過，不會因為缺欄位而報錯。
   */
  let _hasUniqueKey = null;
  const hasUniqueKeyField = async () => {
    if (_hasUniqueKey !== null) return _hasUniqueKey;
    try {
      const form = await api('/k/v1/app/form/fields', 'GET', { app: kintone.app.getId() });
      _hasUniqueKey = !!(form.properties && form.properties[F.uniqueKey]);
    } catch {
      _hasUniqueKey = false;
    }
    return _hasUniqueKey;
  };

  /** 分頁取回所有記錄（Counter App 台數可能超過單次上限）。 */
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

  // ── 編號解析 ────────────────────────────────────────────────────────────

  const pad2 = (n) => String(n).padStart(2, '0');

  /**
   * 當期標記，必須與外掛 desktop.js 的 getPeriodTag() 完全一致。
   * 建檔時若沒把 period_tag 設成當期值，外掛第一次發號會判定成
   * 「跨週期」而把號碼歸零到 1 —— 那就白掃描了。
   */
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
        return ''; // NONE：永久累加
    }
  };

  /**
   * 把 number_format 拆成「{seq} 之前的固定字串」與「之後的固定字串」，
   * 並把 {prefix}/{YYYY}/{YY}/{MM}/{DD}/{period} 代換成當下的實際值。
   *
   * 例：'{prefix}{YY}{seq}' + prefix=NXN1 + 2026 年 → head='NXN126', tail=''
   *     '{prefix}99{seq}'                          → head='NXN199', tail=''
   *
   * 於是「現有編號屬於哪一台計數器」就是看它是否以 head 開頭、以 tail 結尾，
   * 中間剩下的就是流水號。
   */
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

    // {seq} 或 {seq:N} 皆視為流水號位置
    const parts = numberFormat.split(/\{seq(?::\d+)?\}/);
    return {
      head: render(parts[0] || ''),
      tail: render(parts[1] || ''),
    };
  };

  /**
   * 在現有編號中找出屬於這台計數器的最大流水號。
   *
   * @returns {{ max: number, sample: string, odd: string[] }}
   *   max    已發到的最大號（找不到為 0）
   *   sample 對應的實際編號（供預覽核對）
   *   odd    開頭吻合、但流水號位數不符的異常編號（供人工確認，不列入計算）
   */
  const scanMax = (codes, head, tail, pad) => {
    let max = 0;
    let sample = '';
    const odd = [];

    codes.forEach((code) => {
      if (!code.startsWith(head)) return;
      if (tail && !code.endsWith(tail)) return;

      const middle = code.slice(head.length, tail ? code.length - tail.length : undefined);
      if (!/^\d+$/.test(middle)) return;

      // 位數不符代表格式與現在的設定不同（可能是舊制編號），
      // 不納入計算以免號碼被灌到離譜的值，但要讓人看得到。
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

  // ── 核心：算出要建立哪些發號機 ──────────────────────────────────────────

  /**
   * @returns {{ options: string[], planned: object[], skipped: string[] }}
   */
  const buildPlan = async (cfg) => {
    cfg.hasUniqueKey = await hasUniqueKeyField();

    // ① 從業務 App 的表單設定取得分組欄位的實際選項
    const form = await api('/k/v1/app/form/fields', 'GET', { app: cfg.sourceApp });
    const field = form.properties && form.properties[cfg.field];

    if (!field) {
      throw new Error(`業務 App ${cfg.sourceApp} 找不到欄位代碼「${cfg.field}」`);
    }
    if (!field.options) {
      throw new Error(
        `欄位「${cfg.field}」型別為 ${field.type}，沒有選項可列舉。\n` +
          '分組欄位需為下拉選單或單選按鈕。'
      );
    }

    const options = Object.values(field.options)
      .sort((a, b) => Number(a.index) - Number(b.index))
      .map((o) => o.label);

    // ② 查出已存在的發號機，避免重複建檔（連 current 一起帶回，預覽時顯示）
    const existingRecords = await fetchAll(
      cfg.counterApp,
      `${F.sourceAppId} = ${cfg.sourceApp}`,
      [F.categoryKey, F.current]
    );
    const existing = new Map();
    existingRecords.forEach((r) => {
      const key = r[F.categoryKey] && r[F.categoryKey].value;
      if (key) existing.set(key, (r[F.current] && r[F.current].value) || '0');
    });

    // ③ 掃描業務 App 現有的編號，決定每一台的起始 current
    const codeRecords = await fetchAll(
      cfg.sourceApp,
      `${cfg.numberField} != ""`,
      [cfg.numberField]
    );
    const codes = codeRecords
      .map((r) => r[cfg.numberField] && r[cfg.numberField].value)
      .filter(Boolean)
      .map((v) => String(v).trim());

    // ④ 組出待建立清單
    const planned = [];
    const rows = []; // 預覽用（含已存在者）
    const skipped = [];
    const oddCodes = [];

    options.forEach((option) => {
      cfg.modes.forEach((mode) => {
        const spec = MODE_SPEC[mode];
        if (!spec) {
          throw new Error(
            `未定義的情境「${mode}」。\n請在本檔的 MODE_SPEC 中補上它的編號樣式與歸零週期。`
          );
        }

        const categoryKey = `${option}${mode}`;
        const prefix = `${cfg.prefix}${option}`;
        const { head, tail } = splitFormat(spec.numberFormat, prefix, spec.resetCycle);
        const found = scanMax(codes, head, tail, cfg.pad);
        found.odd.forEach((c) => oddCodes.length < 10 && oddCodes.push(c));

        if (existing.has(categoryKey)) {
          skipped.push(categoryKey);
          rows.push({
            categoryKey,
            head,
            status: '已存在',
            existingCurrent: existing.get(categoryKey),
            found,
          });
          return;
        }

        const periodTag = getPeriodTag(spec.resetCycle);

        const rec = {
          [F.sourceAppId]: { value: String(cfg.sourceApp) },
          [F.categoryKey]: { value: categoryKey },
          [F.active]: { value: [ACTIVE_VALUE] },
          [F.prefix]: { value: prefix },
          [F.pad]: { value: cfg.pad },
          [F.numberFormat]: { value: spec.numberFormat },
          [F.resetCycle]: { value: spec.resetCycle },
          // 必須設成當期標記，否則外掛第一次發號會判定跨週期而歸零到 1
          [F.periodTag]: { value: periodTag },
          // current 的語意是「已發出的最大號碼」，先 +1 再使用。
          // 接續現有編號，避免第一次發號就與既有記錄撞號。
          [F.current]: { value: String(found.max) },
        };

        // 有 unique_key 欄位才寫，讓沒建這個欄位的 Counter App 也能正常使用
        if (cfg.hasUniqueKey) {
          rec[F.uniqueKey] = { value: buildUniqueKey(cfg.sourceApp, categoryKey) };
        }

        planned.push(rec);

        rows.push({
          categoryKey,
          head,
          status: '待建立',
          periodTag,
          numberFormat: spec.numberFormat,
          resetCycle: spec.resetCycle,
          found,
          nextCode: `${head}${String(found.max + 1).padStart(Number(cfg.pad), '0')}${tail}`,
        });
      });
    });

    return { options, planned, rows, skipped, oddCodes, scanned: codes.length };
  };

  /** 實際寫入（每批最多 100 筆）。 */
  const createAll = async (counterApp, planned, onProgress) => {
    let done = 0;
    for (let i = 0; i < planned.length; i += BATCH_SIZE) {
      const chunk = planned.slice(i, i + BATCH_SIZE);
      await api('/k/v1/records', 'POST', { app: counterApp, records: chunk });
      done += chunk.length;
      onProgress(done);
    }
    return done;
  };

  // ── 畫面 ────────────────────────────────────────────────────────────────

  const openDialog = () => {
    const counterApp = kintone.app.getId();

    const overlay = el('div', { class: 'cs-overlay' });
    const body = el('div', { class: 'cs-body' });
    const foot = el('div', { class: 'cs-foot' });
    const modal = el('div', { class: 'cs-modal' }, [
      el('div', { class: 'cs-head' }, ['批量建立發號機']),
      body,
      foot,
    ]);
    overlay.appendChild(modal);

    const close = () => overlay.remove();
    // 點背景關閉；點面板內部不關
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    const inputs = {};
    const addRow = (key, label, hint) => {
      const input = el('input', { type: 'text', value: DEFAULTS[key] || '' });
      inputs[key] = input;
      body.appendChild(el('div', { class: 'cs-row' }, [el('label', {}, [label]), input]));
      if (hint) body.appendChild(el('div', { class: 'cs-hint' }, [hint]));
    };

    // ── 步驟一：填參數 ──
    const renderForm = () => {
      body.textContent = '';
      foot.textContent = '';

      body.appendChild(
        el('div', { class: 'cs-summary' }, [`本 Counter App ID：${counterApp}（自動帶入）`])
      );

      addRow('sourceApp', '業務 App ID', '要為哪個 App 建發號機。開啟該 App，網址 /k/123/ 裡的 123。');
      addRow('field', '分組欄位代碼', '決定要建幾台計數器的欄位，需為下拉或單選。選項清單會直接讀該 App 的表單設定。');
      addRow('modes', '情境（逗號分隔）', `目前支援：${Object.keys(MODE_SPEC).join('、')}。要新增請改本檔的 MODE_SPEC。`);
      addRow('prefix', '前綴', '會與分組選項值相接，例：NX + N1 → NXN1');
      addRow('pad', '流水號補零位數', '例：3 → 001');
      addRow('numberField', '業務 App 的編號欄位', '要掃描既有編號的欄位代碼。每台計數器的 current 會接續該欄位現有的最大號，避免第一次發號就撞號。');

      const msg = el('div', { class: 'cs-error' });
      body.appendChild(msg);

      const preview = el('button', { class: 'cs-btn' }, ['預覽']);
      preview.onclick = async () => {
        const cfg = {
          counterApp,
          sourceApp: inputs.sourceApp.value.trim(),
          field: inputs.field.value.trim(),
          modes: inputs.modes.value.split(',').map((s) => s.trim()).filter(Boolean),
          prefix: inputs.prefix.value.trim(),
          pad: inputs.pad.value.trim(),
          numberField: inputs.numberField.value.trim(),
        };

        msg.textContent = '';
        if (!/^\d+$/.test(cfg.sourceApp)) {
          msg.textContent = '業務 App ID 必須是數字';
          return;
        }
        if (!cfg.field) {
          msg.textContent = '請填分組欄位代碼';
          return;
        }
        if (!cfg.modes.length) {
          msg.textContent = '請至少填一個情境';
          return;
        }
        if (!cfg.numberField) {
          msg.textContent = '請填業務 App 的編號欄位代碼';
          return;
        }
        if (!/^\d+$/.test(cfg.pad)) {
          msg.textContent = '補零位數必須是數字';
          return;
        }

        preview.disabled = true;
        preview.textContent = '讀取中...';
        try {
          const plan = await buildPlan(cfg);
          renderPreview(cfg, plan);
        } catch (err) {
          msg.textContent = `讀取失敗：${(err && err.message) || err}`;
          preview.disabled = false;
          preview.textContent = '預覽';
        }
      };

      foot.appendChild(el('button', { class: 'cs-btn cs-btn--ghost', onclick: close }, ['取消']));
      foot.appendChild(preview);
    };

    // ── 步驟二：預覽 ──
    const renderPreview = (cfg, plan) => {
      body.textContent = '';
      foot.textContent = '';

      body.appendChild(
        el('div', { class: 'cs-summary' }, [
          `「${cfg.field}」共 ${plan.options.length} 個選項：${plan.options.join('、')}`,
        ])
      );
      body.appendChild(
        el('div', { class: 'cs-summary' }, [
          `已掃描「${cfg.numberField}」現有編號 ${plan.scanned} 筆，` +
            `待建立 ${plan.planned.length} 台，略過 ${plan.skipped.length} 台（已存在）`,
        ])
      );

      // 每一台都列出來：包含已存在者，方便核對目前號碼
      const table = el('table', { class: 'cs-table' });
      table.appendChild(
        el('thead', {}, [
          el(
            'tr',
            {},
            ['category_key', '編號樣式', '現有最大號', 'current', 'period_tag', '下一號', '狀態'].map(
              (h) => el('th', {}, [h])
            )
          ),
        ])
      );
      const tbody = el('tbody');
      plan.rows.forEach((r) => {
        const isNew = r.status === '待建立';
        tbody.appendChild(
          el('tr', isNew ? {} : { class: 'cs-muted' }, [
            el('td', {}, [r.categoryKey]),
            el('td', {}, [isNew ? `${r.head}###` : '—']),
            el('td', {}, [r.found.sample ? `${r.found.sample}（${r.found.max}）` : '無']),
            el('td', {}, [isNew ? String(r.found.max) : `${r.existingCurrent}（不變更）`]),
            el('td', {}, [isNew ? r.periodTag || '(空)' : '—']),
            el('td', {}, [isNew ? r.nextCode : '—']),
            el('td', {}, [r.status]),
          ])
        );
      });
      table.appendChild(tbody);
      body.appendChild(table);

      body.appendChild(
        el('div', { class: 'cs-skip' }, [
          'current ＝「已發出的最大號碼」，發號時先 +1 再使用，所以下一號就是上表的「下一號」。' +
            '已存在的發號機一律不動，避免把正在使用的號碼改掉。',
        ])
      );

      if (plan.oddCodes.length) {
        body.appendChild(
          el('div', { class: 'cs-warn' }, [
            `⚠ 有編號的開頭吻合、但流水號位數與「${cfg.pad}」不符，未列入計算，請確認是否為舊制編號：` +
              plan.oddCodes.join('、'),
          ])
        );
      }

      const msg = el('div', { class: 'cs-error' });
      body.appendChild(msg);

      if (plan.planned.length === 0) {
        body.appendChild(el('div', { class: 'cs-warn' }, ['沒有需要建立的發號機，全部都已存在。']));
        foot.appendChild(
          el('button', { class: 'cs-btn cs-btn--ghost', onclick: renderForm }, ['上一步'])
        );
        foot.appendChild(el('button', { class: 'cs-btn', onclick: close }, ['關閉']));
        return;
      }

      const confirm = el('button', { class: 'cs-btn' }, [`確認建立 ${plan.planned.length} 台`]);
      confirm.onclick = async () => {
        confirm.disabled = true;
        msg.textContent = '';
        try {
          await createAll(cfg.counterApp, plan.planned, (done) => {
            confirm.textContent = `建立中... ${done}/${plan.planned.length}`;
          });
          alert(`已建立 ${plan.planned.length} 台發號機。\n\n請確認業務 App 的編號欄位已勾選「值的唯一性」。`);
          location.reload();
        } catch (err) {
          msg.textContent =
            `建立失敗：${(err && err.message) || err}\n` +
            '請確認本 App 具備上述所有欄位代碼，且您有新增記錄的權限。';
          confirm.disabled = false;
          confirm.textContent = `確認建立 ${plan.planned.length} 台`;
        }
      };

      foot.appendChild(el('button', { class: 'cs-btn cs-btn--ghost', onclick: renderForm }, ['上一步']));
      foot.appendChild(confirm);
    };

    renderForm();
    document.body.appendChild(overlay);
  };

  // ── unique_key 補寫（既有記錄的一次性遷移）──────────────────────────────
  //
  // 要對 unique_key 勾「值的唯一性」之前，既有記錄必須先全部填好——
  // 一堆空值會被視為重複值而讓約束勾不起來。本功能就是補這一段。
  const backfillUniqueKeys = async () => {
    if (!(await hasUniqueKeyField())) {
      alert(
        `本 App 沒有「${F.uniqueKey}」欄位。\n\n` +
          '請先新增一個「文字（單行）」欄位、欄位代碼設為 ' + F.uniqueKey + '，\n' +
          '補寫完成後再回到該欄位設定勾選「值的重複禁止」。'
      );
      return;
    }

    const counterApp = kintone.app.getId();
    const all = await fetchAll(counterApp, '', [F.sourceAppId, F.categoryKey, F.uniqueKey]);

    const toFix = [];
    const seen = new Map();
    const dup = [];

    all.forEach((r) => {
      const src = (r[F.sourceAppId] && r[F.sourceAppId].value) || '';
      const key = (r[F.categoryKey] && r[F.categoryKey].value) || '';
      if (!src || !key) return;

      const want = buildUniqueKey(src, key);
      const now = (r[F.uniqueKey] && r[F.uniqueKey].value) || '';

      // 順便找出「同一個 App 重複建了同一台計數器」——那正是會產生重號的情境，
      // 有重複就不能直接補寫（補了也會因唯一性衝突而失敗），必須先由人工處理。
      if (seen.has(want)) dup.push(want);
      else seen.set(want, r.$id.value);

      if (now !== want) toFix.push({ id: r.$id.value, record: { [F.uniqueKey]: { value: want } } });
    });

    if (dup.length) {
      alert(
        `發現重複的發號機（同一個 App 有兩台以上相同的 ${F.categoryKey}），無法補寫：\n\n` +
          [...new Set(dup)].join('\n') +
          '\n\n這正是會造成重號的情況，請先人工確認並刪除多餘的記錄。'
      );
      return;
    }

    if (toFix.length === 0) {
      alert(`所有記錄的 ${F.uniqueKey} 都已正確，不需要補寫。\n\n可以放心去勾選「值的重複禁止」了。`);
      return;
    }

    if (!confirm(`共 ${all.length} 筆記錄，其中 ${toFix.length} 筆需要補寫 ${F.uniqueKey}。\n\n要現在補寫嗎？`)) {
      return;
    }

    for (let i = 0; i < toFix.length; i += BATCH_SIZE) {
      await api('/k/v1/records', 'PUT', { app: counterApp, records: toFix.slice(i, i + BATCH_SIZE) });
    }

    alert(
      `已補寫 ${toFix.length} 筆。\n\n` +
        `最後一步：到「${F.uniqueKey}」欄位的設定勾選「值的重複禁止」，並更新 App。`
    );
    location.reload();
  };

  // ── 進入點 ──────────────────────────────────────────────────────────────

  kintone.events.on('app.record.index.show', (event) => {
    if (document.getElementById(BUTTON_ID)) return event;

    if (AUTHORIZED_USERS.length && !AUTHORIZED_USERS.includes(kintone.getLoginUser().code)) {
      return event;
    }

    injectStyle();

    const header = kintone.app.getHeaderMenuSpaceElement();
    if (!header) return event;

    const button = el('button', { id: BUTTON_ID, class: 'cs-btn' }, ['批量建立發號機']);
    button.onclick = openDialog;
    header.appendChild(button);

    const fixBtn = el('button', { class: 'cs-btn cs-btn--ghost' }, [`補寫 ${F.uniqueKey}`]);
    fixBtn.onclick = async () => {
      fixBtn.disabled = true;
      try {
        await backfillUniqueKeys();
      } catch (err) {
        console.error('[counter-seed] 補寫失敗', err);
        alert(`補寫失敗：${(err && err.message) || err}`);
      }
      fixBtn.disabled = false;
    };
    header.appendChild(fixBtn);

    return event;
  });

  // ── 手動建檔／修改時自動維護 unique_key ─────────────────────────────────
  // 沒有這段的話，管理者手動新增一台計數器就會漏掉 unique_key，
  // 唯一性約束等於出現破口。
  kintone.events.on(
    ['app.record.create.submit', 'app.record.edit.submit',
     'mobile.app.record.create.submit', 'mobile.app.record.edit.submit'],
    async (event) => {
      const record = event.record;
      if (!record[F.uniqueKey]) return event; // App 沒有這個欄位 → 不處理

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
