(() => {
  'use strict';

  const PLUGIN_ID = kintone.$PLUGIN_ID;

  const rawConfig = kintone.plugin.app.getConfig(PLUGIN_ID) || {};
  let CONFIG;
  try {
    CONFIG = JSON.parse(rawConfig.data || '{}');
  } catch (e) {
    console.error('[anum] config parse failed', e);
    CONFIG = {};
  }
  Object.freeze(CONFIG);

  // ── 設定常數（全部來自設定畫面，CONFIG 驅動，貼到任何 App 免改 code）──
  const COUNTER_APP   = String(CONFIG.counterApp || '').trim();

  // ---------- TOKEN MODEL ----------
  // API Token 一律不以明文存在設定檔（getConfig 可被任何使用者讀取）。正式作法：
  // Token 存在外掛代理設定（setProxyConfig，加密於 kintone 伺服器），執行期以
  // kintone.plugin.app.proxy() 由伺服器端注入，瀏覽器永遠看不到 Token。
  // 這裡只保留「非機密」中繼資料：counter / self 是否有設定 Token（用來決定要不要走代理）。
  //
  // 舊版相容：更新程式後、管理者尚未重新儲存設定前，設定檔仍可能帶有明文 Token。
  // 此時沿用舊的 fetch 直送路徑，確保功能不中斷；管理者一旦重新儲存，Token 就會搬進
  // 加密代理設定，之後這條舊路徑不再被觸發（COUNTER_TOKEN / SELF_TOKEN 皆為空）。
  const COUNTER_TOKEN = String(CONFIG.counterToken || '').trim(); // 舊版明文相容
  const SELF_TOKEN    = String(CONFIG.selfToken || '').trim();    // 舊版明文相容
  const HAS_SECURED_COUNTER = CONFIG.hasCounterToken === true;
  const HAS_SECURED_SELF    = CONFIG.hasSelfToken === true;

  const NUMBER_FIELD  = CONFIG.numberField || '';
  const CATEGORY_FIELD = CONFIG.categoryField || '';

  // ---------- 編號寫入位置 ----------
  // 'field'    ：一筆記錄一個號，寫入單一欄位（原本的行為，預設）
  // 'subtable' ：子表格一列一個號，一張單可一次產生多個編號
  //              （例：一張申請單的設備清單有 10 列 → 一次發 10 個設備代號）
  //   此模式下 NUMBER_FIELD / CATEGORY_FIELD 指的是「子表格列內」的欄位代碼。
  const TARGET        = CONFIG.target === 'subtable' ? 'subtable' : 'field';
  const SUBTABLE_CODE = CONFIG.subtableCode || '';
  const IS_SUBTABLE   = TARGET === 'subtable' && !!SUBTABLE_CODE;
  const ACTIVE_QUERY  = (CONFIG.activeQuery || 'active in ("啟用")').trim();
  const TRIGGERS      = Array.isArray(CONFIG.triggers) ? CONFIG.triggers : ['create.submit', 'edit.submit'];
  const STATUS_COND   = CONFIG.statusCond || '*';
  const TO_STATUS     = CONFIG.toStatus || '*';
  const ACTION_NAME   = CONFIG.actionName || '*';
  const CONFIRM_MSG   = CONFIG.confirmMessage || '此記錄將於儲存後自動產生編號，是否繼續？';
  const SKIP_CONFIRM  = CONFIRM_MSG.trim() === '*'; // 填 * → 不彈確認視窗，儲存/推進後只跳出成功編號視窗
  const MAX_RETRY     = Number(CONFIG.maxRetry) > 0 ? Number(CONFIG.maxRetry) : 5;
  const CATEGORIES    = Array.isArray(CONFIG.categories) ? CONFIG.categories : [];
  const CODE_MAPS     = Array.isArray(CONFIG.codeMaps) ? CONFIG.codeMaps : [];

  const ENABLED = !!(
    COUNTER_APP && NUMBER_FIELD && CATEGORY_FIELD && CATEGORIES.length &&
    (TARGET !== 'subtable' || SUBTABLE_CODE)
  );

  // ── 平台命名空間（桌面 / 行動共用同一份）──
  const APP_NS = (() => { try { return kintone.app; } catch (e) { return null; } })();
  const MOBILE_NS = (() => { try { return kintone.mobile && kintone.mobile.app; } catch (e) { return null; } })();

  const getAppId = () => {
    const desktopId = APP_NS && APP_NS.getId && APP_NS.getId();
    if (desktopId != null) return String(desktopId);
    const mobileId = MOBILE_NS && MOBILE_NS.getId && MOBILE_NS.getId();
    if (mobileId != null) return String(mobileId);
    return '';
  };

  // ── 錯誤分類與友善訊息（借用既有外掛慣例）──
  const SESSION_EXPIRED_MESSAGE = '登入已逾時，請開「新分頁」重新登入 kintone 後，回到本頁再試一次（已填寫的內容不會消失）。';
  const PERMISSION_DENIED_MESSAGE = '您沒有執行此操作的權限，請聯繫系統管理員確認權限或 API Token 設定。';

  const errorCodeOf = (err) => {
    if (err && err.code) return err.code;
    const msg = (err && err.message) || '';
    const fromJson = /"code"\s*:\s*"([A-Z0-9_]+)"/.exec(msg);
    if (fromJson) return fromJson[1];
    const fromText = /\b(CB_[A-Z0-9]+|GAIA_[A-Z0-9]+)\b/.exec(msg);
    return fromText ? fromText[1] : '';
  };

  const friendlyError = (err, prefix) => {
    switch (errorCodeOf(err)) {
      case 'CB_AU01':
        return SESSION_EXPIRED_MESSAGE;
      case 'GAIA_NO01': case 'GAIA_NO02': case 'CB_NO01': case 'CB_NO02': case 'GAIA_DA02':
        return PERMISSION_DENIED_MESSAGE;
      default:
        return `${prefix}：${(err && err.message) || String(err)}`;
    }
  };

  // ── API 呼叫：帶權限的 REST 呼叫（Counter App 發號 / 本 App 補償回寫）。三種路徑依序判斷：
  //   1) 舊版明文 Token 仍在設定檔（尚未遷移）→ 沿用 fetch 直送，維持相容。
  //   2) Token 已加密存於代理設定 → 走 kintone.plugin.app.proxy，由伺服器端注入 Token，
  //      前端拿不到也看不到（代理設定以「網址前置比對」注入，故 /k/v1/ 底下皆涵蓋）。
  //   3) 該對象沒有設定 Token → 用呼叫者本身的 session（kintone.api），行為與原本一致。
  const apiWithToken = async (path, method, body, appIdForToken) => {
    const sApp = String(appIdForToken);
    const isSelf = sApp === getAppId();
    const isCounter = !!COUNTER_APP && sApp === COUNTER_APP;

    // 1) 舊版明文 Token（遷移前的相容路徑；遷移後 COUNTER_TOKEN / SELF_TOKEN 皆空，不會進來）
    const rawToken = (isCounter && COUNTER_TOKEN) || (isSelf && SELF_TOKEN) || '';
    if (rawToken) {
      const url = kintone.api.url(path, true);
      if (method === 'GET') {
        const qs = new URLSearchParams();
        Object.entries(body || {}).forEach(([k, v]) => {
          if (Array.isArray(v)) v.forEach((x) => qs.append(`${k}[]`, x));
          else qs.append(k, v);
        });
        // GET 不帶 Content-Type，只帶 Token header
        const r = await fetch(`${url}?${qs}`, {
          method: 'GET',
          headers: { 'X-Cybozu-API-Token': rawToken },
        });
        if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
        return r.json();
      }
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Cybozu-API-Token': rawToken },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
      return r.json();
    }

    // 2) 加密代理路徑：Token 由 kintone 伺服器注入，前端完全不接觸
    const secured = (isCounter && HAS_SECURED_COUNTER) || (isSelf && HAS_SECURED_SELF);
    if (secured) {
      let url = kintone.api.url(path, true);
      let data = body;
      if (method === 'GET' || method === 'DELETE') {
        // 代理對 GET / DELETE 會忽略 data，參數需放在 query string
        const qs = new URLSearchParams();
        Object.entries(body || {}).forEach(([k, v]) => {
          if (Array.isArray(v)) v.forEach((x) => qs.append(`${k}[]`, x));
          else qs.append(k, v);
        });
        url = `${url}?${qs}`;
        data = {};
      }
      // proxy 回傳 [body(字串), status(數字), headers(物件)]；非 2xx 需自行判斷
      const [respBody, status] = await kintone.plugin.app.proxy(PLUGIN_ID, url, method, {}, data);
      if (status < 200 || status >= 300) throw new Error(`API ${path} ${status}: ${respBody}`);
      return respBody ? JSON.parse(respBody) : {};
    }

    // 3) 無 Token → 用呼叫者自身 session
    return kintone.api(kintone.api.url(path, true), method, body);
  };

  // ── UI 訊息（有 SweetAlert2 用 Swal，否則退回原生 confirm/alert）──
  // 字級/間距特別放大，對象鎖定 35–55 歲使用者：優先求「一眼看清楚」而非精緻小巧。
  const injectSwalStyle = (() => {
    let done = false;
    return () => {
      if (done || document.getElementById('anum-swal-style')) return;
      done = true;
      const style = document.createElement('style');
      style.id = 'anum-swal-style';
      style.textContent = `
        .anum-swal-popup { width: auto !important; max-width: 92vw; padding: 28px 32px 30px; border-radius: 12px; }
        .anum-swal-title { font-size: 22px !important; font-weight: 700 !important; margin-bottom: 6px !important; }
        .anum-swal-text  { font-size: 17px !important; line-height: 1.7 !important; color: #333 !important; }
        .anum-swal-confirm, .anum-swal-cancel {
          font-size: 17px !important; font-weight: 600 !important;
          padding: 11px 28px !important; border-radius: 8px !important;
        }
        .anum-swal-icon { width: 4.2em !important; height: 4.2em !important; }
      `;
      document.head.appendChild(style);
    };
  })();

  const SWAL_CUSTOM_CLASS = {
    popup: 'anum-swal-popup',
    title: 'anum-swal-title',
    htmlContainer: 'anum-swal-text',
    confirmButton: 'anum-swal-confirm',
    cancelButton: 'anum-swal-cancel',
    icon: 'anum-swal-icon',
  };

  const uiConfirm = async (text) => {
    if (window.Swal) {
      injectSwalStyle();
      const res = await window.Swal.fire({
        icon: 'question', title: '自動編號', text,
        width: 'auto',
        showCancelButton: true, confirmButtonText: '確定儲存', cancelButtonText: '取消',
        customClass: SWAL_CUSTOM_CLASS,
        confirmButtonColor: '#2b6cb0',
        cancelButtonColor: '#8a94a3',
        reverseButtons: true,
        focusConfirm: true,
      });
      return res.isConfirmed;
    }
    return window.confirm(text);
  };

  const uiToast = async (icon, title, text) => {
    if (window.Swal) {
      injectSwalStyle();
      await window.Swal.fire({
        icon, title, text,
        width: 'auto',
        confirmButtonText: '好，我知道了',
        customClass: SWAL_CUSTOM_CLASS,
        confirmButtonColor: '#2b6cb0',
      });
      return;
    }
    window.alert(`${title}\n${text || ''}`);
  };

  // ── 週期歸零：依重置週期算出當前週期標記 ──
  //
  // reset_cycle 是各 Counter App 自建的下拉欄位，選項文字由管理者自己決定；
  // 目前並存兩種寫法：英文常數（NONE/YEARLY/MONTHLY/DAILY，本外掛原始文件的寫法）
  // 與中文選項（不重置/每年重置/每月重置/每日重置）。
  // 若只認英文，中文值會落入 default 分支——不會報錯，但等同被當成「不重置」，
  // 該歸零卻永久累加，是不會被發現的靜默錯誤，比直接失敗更危險。
  // 故先正規化再判斷，不論欄位用哪種語言的選項都能正確運作。
  const RESET_CYCLE_ALIASES = {
    NONE: 'NONE', '不重置': 'NONE',
    YEARLY: 'YEARLY', '每年重置': 'YEARLY',
    MONTHLY: 'MONTHLY', '每月重置': 'MONTHLY',
    DAILY: 'DAILY', '每日重置': 'DAILY',
  };
  const normalizeResetCycle = (raw) => RESET_CYCLE_ALIASES[String(raw || '').trim()] || 'NONE';

  const pad2 = (n) => String(n).padStart(2, '0');
  const getPeriodTag = (cycle) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    switch (normalizeResetCycle(cycle)) {
      case 'YEARLY':  return `${y}`;
      case 'MONTHLY': return `${y}${m}`;
      case 'DAILY':   return `${y}${m}${d}`;
      default:        return ''; // NONE：永久累加
    }
  };

  // ── 代碼對照表：把記錄上某個欄位的值轉成代碼，供 number_format 的自訂 token 使用 ──
  // 例：{ token:'level', field:'事故級別', pairs:[{from:'一般事故',to:'G'},{from:'重大事故',to:'M'}] }
  // → 記錄的事故級別＝「一般事故」時，number_format 內的 {level} 會被代換成 G。
  // 用途：號碼中「逐筆變動」的代碼（級別、部門…）無法寫死在計數器的 number_format，故由此動態解析。
  // ── 取值範圍（scope）──
  // scope = { record, row }。row 為子表格的一列（{ id, value: {...} }），可省略。
  // 查找順序：**先找子表格列內的欄位，找不到再找表頭欄位**。
  // 如此一來「設備種類在列內、設備需求在表頭」這種混合擺法也能運作，
  // 設定上不需要指定每個欄位到底在哪一層。
  const scopeOf = (record, row) => ({ record, row });

  const fieldIn = (scope, code) => {
    if (scope.row && scope.row.value && scope.row.value[code] !== undefined) {
      return scope.row.value[code];
    }
    return scope.record ? scope.record[code] : undefined;
  };

  const valueIn = (scope, code) => {
    const f = fieldIn(scope, code);
    return f == null || f.value == null ? '' : String(f.value);
  };

  const resolveCodeTokens = (scope) => {
    const out = {};
    CODE_MAPS.forEach((m) => {
      if (!m || !m.token || !m.field) return;
      const fv = fieldIn(scope, m.field);
      const raw = fv == null ? '' : String(fv.value == null ? '' : fv.value).trim();
      const hit = (m.pairs || []).find((p) => p && p.from === raw);
      out[m.token] = { code: hit ? hit.to : '', field: m.field, raw };
    });
    return out;
  };

  // ── 編號樣式樣板：token 套進 Counter App 的 number_format 欄位，後台改樣式免改 code ──
  // {prefix} 前綴 / {seq} 補零到 pad 位 / {seq:N} 補零到 N 位 / {period} 週期標記 /
  // {YYYY}{YY}{MM}{DD} 發號當下日期 / 其餘 {自訂token} 由代碼對照表提供。
  // number_format 留空 → 預設 {prefix}{seq}（向下相容）。
  const buildSerial = (template, opts) => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const seq = opts.seq;
    const tpl = (template && template.trim()) || '{prefix}{seq}';
    let out = tpl
      .replace(/\{prefix\}/g, opts.prefix || '')
      .replace(/\{seq:(\d+)\}/g, (_, n) => String(seq).padStart(Number(n), '0'))
      .replace(/\{seq\}/g, String(seq).padStart(Number(opts.pad) || 0, '0'))
      .replace(/\{period\}/g, opts.period || '')
      .replace(/\{YYYY\}/g, yyyy)
      .replace(/\{YY\}/g, yyyy.slice(-2))
      .replace(/\{MM\}/g, pad2(now.getMonth() + 1))
      .replace(/\{DD\}/g, pad2(now.getDate()));

    // 自訂 token（代碼對照表）；內建 token 先代換完，故不會被自訂名稱蓋掉。
    // 只在樣板真的用到該 token 時才檢查，避免其他計數器的樣式受無關設定牽連。
    Object.keys(opts.codes || {}).forEach((name) => {
      const ph = `{${name}}`;
      if (out.indexOf(ph) === -1) return;
      const info = opts.codes[name];
      if (!info.code) {
        throw new Error(
          `編號樣式用到 {${name}}，但欄位「${info.field}」的值「${info.raw}」在代碼對照表中沒有對應代碼`
        );
      }
      out = out.split(ph).join(info.code);
    });
    return out;
  };

  // ── 計數器代碼樣板：{欄位代碼} → 記錄上該欄位的值 ──
  // 用途：當「要用哪一台計數器」取決於記錄上的多個欄位時，避免規則數量爆炸。
  // 例：設備代號依「設備種類 × 設備需求」分組，18 種類 × 2 需求 = 36 台計數器，
  //     但分類規則只需一條：counterKey = '{設備種類}新增' → 執行期解析成 'N1新增'。
  //
  // 與 codeMaps 的分工：
  //   counterKey 樣板 → 決定「用哪一台計數器」（影響序號分組）
  //   codeMaps       → 決定「號碼字串裡的可變代碼」（不影響分組）
  //
  // 欄位不存在或值為空時直接擲錯中止，不產生 'N1' 這種殘缺的 key 而誤取到別台計數器。
  const resolveKeyTemplate = (scope, tpl) =>
    tpl.replace(/\{([^{}]+)\}/g, (_, name) => {
      const code = String(name).trim();
      const fv = fieldIn(scope, code);
      if (fv === undefined) {
        throw new Error(`計數器代碼樣板用到 {${code}}，但記錄上找不到這個欄位代碼`);
      }
      const raw = fv.value == null ? '' : String(fv.value).trim();
      if (!raw) {
        throw new Error(`計數器代碼樣板用到 {${code}}，但「${code}」欄位為空，無法判斷要使用哪一台計數器`);
      }
      return raw;
    });

  // ── 發號引擎：靠 Counter App 各筆記錄的 revision 樂觀鎖保證唯一 ──
  // codes：由 resolveCodeTokens(record) 產生的自訂 token 值，供 number_format 代換。
  //
  // count > 1 時為「批次預留」：一次把 current 推進 N，取得連續的 N 個號碼。
  // 子表格一次要發很多號時，若逐列各跑一次樂觀鎖，10 列就是 10 次 GET+PUT，
  // 慢且彼此 revision 互撞；改為一次預留整段，呼叫次數與列數脫鉤。
  //
  // 回傳發號所需的原料，由呼叫端逐一組出號碼字串（各列的 codes 可能不同）。
  const reserveRange = async (categoryKey, count) => {
    const appId = getAppId();
    // category_key 可能來自樣板解析（含記錄上的欄位值），需跳脫雙引號避免查詢語法被破壞。
    const safeKey = String(categoryKey).replace(/"/g, '\\"');

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const queryParts = [
        `source_app_id = ${appId}`,
        `category_key in ("${safeKey}")`,
      ];
      if (ACTIVE_QUERY) queryParts.push(ACTIVE_QUERY);
      const _query = queryParts.join(' and ') + ' limit 1';
      const res = await apiWithToken('/k/v1/records.json', 'GET', {
        app: COUNTER_APP,
        query: _query,
      }, COUNTER_APP);

      if (!res.records || res.records.length === 0) {
        throw new Error(`找不到發號機：App ${appId} / 類別「${categoryKey}」（請確認 Counter App 已建檔且為啟用狀態）`);
      }

      const r = res.records[0];
      const cycle  = r.reset_cycle ? r.reset_cycle.value : 'NONE';
      const nowTag = getPeriodTag(cycle);
      const lastTag = r.period_tag ? (r.period_tag.value || '') : '';
      // 跨週期 → 從 1 重算；同週期 → current + 1
      const start = nowTag !== lastTag ? 1 : Number(r.current.value) + 1;
      // 一次預留 count 個號：current 直接推進到整段的最後一號
      const end = start + count - 1;

      try {
        await apiWithToken('/k/v1/record.json', 'PUT', {
          app: COUNTER_APP,
          id: r.$id.value,
          revision: r.$revision.value, // 樂觀鎖：revision 不符會被擋下
          record: {
            current:        { value: String(end) },
            period_tag:     { value: nowTag },
            last_issued_at: { value: new Date().toISOString() },
          },
        }, COUNTER_APP);

        return {
          start,
          count,
          numberFormat: r.number_format ? r.number_format.value : '',
          prefix: r.prefix ? (r.prefix.value || '') : '',
          pad: r.pad ? r.pad.value : 0,
          period: nowTag,
        };
      } catch (e) {
        if (errorCodeOf(e) === 'GAIA_CO02') continue; // revision 衝突 → 重新讀取重試
        throw e;
      }
    }
    throw new Error(`發號失敗，併發重試 ${MAX_RETRY} 次仍衝突：類別「${categoryKey}」`);
  };

  /** 單筆發號（一般欄位模式）：預留 1 個號並組出字串。 */
  const issueSerial = async (categoryKey, codes) => {
    const rg = await reserveRange(categoryKey, 1);
    // 依 Counter App 該筆「編號樣式」組出最終編號（樣式由後台維護，免改 code）
    return buildSerial(rg.numberFormat, {
      prefix: rg.prefix,
      seq: rg.start,
      pad: rg.pad,
      period: rg.period,
      codes: codes || {},
    }); // 預設 {prefix}{seq} → GO000001；改 {prefix}-{seq:3} → GO-001
  };

  // ── 依分類決定最終編號 ──
  // 比對順序：先找完全相同的分類值，找不到才退到萬用規則（match === '*'）。
  // 萬用規則刻意要求分類值非空——分類還沒選就發號沒有意義，也避免誤觸。
  const matchCategory = (scope) => {
    const catVal = valueIn(scope, CATEGORY_FIELD);
    const exact = CATEGORIES.find((c) => c && c.match === catVal);
    if (exact) return exact;
    if (!catVal) return null;
    return CATEGORIES.find((c) => c && c.match === '*') || null;
  };

  /** 解析出這筆（或這列）要用哪一台計數器；copy 模式不需要計數器故回傳 null。 */
  const resolveCounterKey = (scope, cat) => {
    // 發號：以「計數器代碼」查 Counter App；留空時沿用分類選項值（向下相容）。
    // 設定 counterKey 可讓多個分類值共用同一台計數器（如兩種物損事故共用 CA，序號連續不重複）。
    let counterKey = (cat.counterKey || '').trim() || cat.match;

    // 萬用規則若沒有指定 counterKey，'*' 不是有效的計數器代碼，明確擋下並提示。
    if (counterKey === '*') {
      throw new Error('分類規則使用萬用比對（*）時，必須指定「計數器代碼」');
    }

    // counterKey 含 {欄位代碼} → 依當筆記錄／當列解析（見 resolveKeyTemplate）。
    if (counterKey.indexOf('{') !== -1) {
      counterKey = resolveKeyTemplate(scope, counterKey);
    }
    return counterKey;
  };

  /** copy 模式：旁路抄錄既有欄位（如國內供應商的統一編號），不經過 Counter App。 */
  const resolveCopy = (scope, cat) => {
    const src = fieldIn(scope, cat.copyField);
    const v = src ? String(src.value == null ? '' : src.value).trim() : '';
    if (cat.validate === 'taxId8' && !/^\d{8}$/.test(v)) {
      throw new Error(`「${cat.copyField}」須為 8 碼數字（目前值：「${v}」）`);
    }
    if (!v) throw new Error(`「${cat.copyField}」為空，無法抄錄為編號`);
    return v;
  };

  const resolveSerial = async (record, cat) => {
    const scope = scopeOf(record);
    if (cat.mode === 'copy') return resolveCopy(scope, cat);
    return issueSerial(resolveCounterKey(scope, cat), resolveCodeTokens(scope));
  };

  // ── 子表格模式：一列一號 ──────────────────────────────────────────────
  //
  // 流程刻意分成「規劃」與「取號」兩段：
  //   規劃階段把所有列的計數器代碼、抄錄值都先解析完，任何一列有問題就整批中止；
  //   確定全部沒問題才開始向計數器取號。
  // 這樣就不會發生「前三列已經消耗了號碼、第四列才發現欄位沒填」而白白跳號。

  const subtableRows = (record) => {
    const t = record[SUBTABLE_CODE];
    return t && Array.isArray(t.value) ? t.value : [];
  };

  const rowHasNumber = (row) => {
    const f = row.value ? row.value[NUMBER_FIELD] : null;
    return !!(f && f.value != null && String(f.value) !== '');
  };

  /**
   * 規劃：找出所有「需要發號」的列，並解析出各自要用哪台計數器。
   * @returns {{ index:number, row:object, cat:object, counterKey:string, codes:object, copyValue:string }[]}
   */
  const planSubtable = (record) => {
    const plan = [];

    subtableRows(record).forEach((row, index) => {
      if (rowHasNumber(row)) return; // 已有編號的列不重發
      const scope = scopeOf(record, row);
      const cat = matchCategory(scope);
      if (!cat) return; // 該列的分類沒有對應規則 → 不發號

      if (cat.mode === 'copy') {
        plan.push({ index, row, cat, copyValue: resolveCopy(scope, cat) });
      } else {
        plan.push({
          index,
          row,
          cat,
          counterKey: resolveCounterKey(scope, cat),
          codes: resolveCodeTokens(scope),
        });
      }
    });

    return plan;
  };

  /**
   * 取號：把待發號的列依計數器代碼分組，每組只做一次樂觀鎖預留整段連號。
   * @returns {Map<number, string>} 列索引 → 編號
   */
  const issueForPlan = async (plan) => {
    const serials = new Map();

    // copy 模式不經計數器，直接落值
    plan.filter((p) => p.cat.mode === 'copy').forEach((p) => serials.set(p.index, p.copyValue));

    // 發號模式：依 counterKey 分組
    const groups = new Map();
    plan
      .filter((p) => p.cat.mode !== 'copy')
      .forEach((p) => {
        if (!groups.has(p.counterKey)) groups.set(p.counterKey, []);
        groups.get(p.counterKey).push(p);
      });

    for (const [counterKey, items] of groups) {
      const rg = await reserveRange(counterKey, items.length);
      // 依子表格的列順序配號，讓號碼與表上的順序一致
      items.forEach((p, i) => {
        serials.set(
          p.index,
          buildSerial(rg.numberFormat, {
            prefix: rg.prefix,
            seq: rg.start + i,
            pad: rg.pad,
            period: rg.period,
            codes: p.codes || {},
          })
        );
      });
    }

    return serials;
  };

  /**
   * 把編號寫回子表格。
   * ⚠ kintone 的子表格是「整包覆蓋」：PUT 時必須送出**所有列並帶上原本的 id**，
   *   否則沒送到的列會被刪除、有送但沒 id 的列會被當成新列重建（既有資料連帶遺失）。
   */
  const writeBackSubtable = async (recordId, record, serials) => {
    const rows = subtableRows(record).map((row) => ({
      id: row.id,
      value: Object.assign({}, row.value),
    }));

    serials.forEach((serial, index) => {
      if (!rows[index]) return;
      rows[index].value[NUMBER_FIELD] = { value: serial };
    });

    const appId = getAppId();
    await apiWithToken('/k/v1/record.json', 'PUT', {
      app: appId,
      id: recordId,
      record: { [SUBTABLE_CODE]: { value: rows } },
    }, appId);
  };

  // ── 狀態條件 ──
  const curStatus = (record) =>
    (record.$status && record.$status.value) ||
    (record['狀態'] && record['狀態'].value) || '';

  const statusOkOnSubmit = (record) => STATUS_COND === '*' || !STATUS_COND || STATUS_COND === curStatus(record);

  const statusOkOnProceed = (event) => {
    const next = (event.nextStatus && event.nextStatus.value) || '';
    const act  = (event.action && event.action.value) || '';
    if (TO_STATUS && TO_STATUS !== '*' && TO_STATUS !== next) return false;
    if (ACTION_NAME && ACTION_NAME !== '*' && ACTION_NAME !== act) return false;
    return true;
  };

  const alreadyNumbered = (record) => {
    const fv = record[NUMBER_FIELD];
    const v = fv ? fv.value : '';
    return v != null && String(v) !== '';
  };

  /** 這筆記錄現在有沒有東西要發號？（子表格模式＝有沒有待發號的列） */
  const nothingToIssue = (record) =>
    IS_SUBTABLE ? planSubtable(record).length === 0 : alreadyNumbered(record) || !matchCategory(scopeOf(record));

  // ── 流程 1：儲存（create/edit）── 提交前確認，提交成功後發號回寫
  let _pendingIssue = false;

  const onSubmit = (trigger) => async (event) => {
    _pendingIssue = false;
    if (!ENABLED || !TRIGGERS.includes(trigger)) return event;
    const record = event.record;
    if (!record) return event;
    if (trigger === 'edit.submit' && !statusOkOnSubmit(record)) return event;

    // 子表格模式：沒有任何待發號的列就不打擾使用者
    // 一般模式：已有編號、或分類無對應規則 → 不發號
    if (nothingToIssue(record)) return event;

    const ok = SKIP_CONFIRM || await uiConfirm(CONFIRM_MSG);
    if (!ok) { event.error = '已取消，未儲存（也未產生編號）。'; return event; }

    _pendingIssue = true;                               // 標記：待 submit.success 發號
    return event;
  };

  const onSubmitSuccess = () => async (event) => {
    if (!_pendingIssue) return event;
    _pendingIssue = false;

    const record = event.record;
    const recordId = event.recordId || (record.$id && record.$id.value);
    if (!recordId) return event;

    if (IS_SUBTABLE) return onSubmitSuccessSubtable(event, record, recordId);

    const cat = matchCategory(scopeOf(record));
    if (!cat) return event;

    try {
      const serial = await resolveSerial(record, cat);
      const appId = getAppId();
      await apiWithToken('/k/v1/record.json', 'PUT', {
        app: appId, id: recordId, record: { [NUMBER_FIELD]: { value: serial } },
      }, appId);
      await uiToast('success', '編號已產生', `${NUMBER_FIELD}：${serial}`);
      // 不手動導頁：序號已寫入 DB（上面已 await），kintone 在 submit.success 後會自行
      // 由編輯表單轉到詳細頁並重新讀取記錄，屆時即顯示新編號。手動導頁反而會觸發
      // 「未儲存變更」原生警告，或停在 hash 路由不重抓資料（需手動重整）。
    } catch (e) {
      console.error('[anum] 發號/回寫失敗', e);
      await uiToast('error', '編號產生失敗', friendlyError(e, '自動編號'));
    }
    return event;
  };

  // 子表格模式的 submit.success：
  // event.record 的子表格列在「新增」時不一定帶得到 id，而回寫子表格**必須帶 id**，
  // 否則整個子表格會被重建。因此改為重新讀一次剛存好的記錄，以它為準。
  const onSubmitSuccessSubtable = async (event, _record, recordId) => {
    try {
      const appId = getAppId();
      const fresh = await apiWithToken('/k/v1/record.json', 'GET', {
        app: appId, id: recordId,
      }, appId);
      const saved = fresh.record;

      const plan = planSubtable(saved);
      if (plan.length === 0) return event;

      const serials = await issueForPlan(plan);
      await writeBackSubtable(recordId, saved, serials);

      const list = [...serials.values()];
      await uiToast(
        'success',
        `已產生 ${list.length} 個編號`,
        list.length <= 10 ? list.join('、') : `${list.slice(0, 10).join('、')} …等 ${list.length} 個`
      );
    } catch (e) {
      console.error('[anum] 子表格發號/回寫失敗', e);
      await uiToast('error', '編號產生失敗', friendlyError(e, '自動編號'));
    }
    return event;
  };

  // ── 流程 2：流程推進（process.proceed）── 無 success 事件，發號後直接寫入 event.record 一起原子儲存
  const onProceed = async (event) => {
    if (!ENABLED || !TRIGGERS.includes('process.proceed')) return event;
    const record = event.record;
    if (!record) return event;
    if (!statusOkOnProceed(event)) return event;
    if (nothingToIssue(record)) return event;

    const ok = SKIP_CONFIRM || await uiConfirm(CONFIRM_MSG);
    if (!ok) { event.error = '已取消，未推進流程。'; return event; }

    // 子表格模式：推進沒有 success 事件，直接把編號寫進 event.record 的各列，
    // 隨流程推進一併原子儲存（不另發 PUT，也就不需要列的 id）。
    if (IS_SUBTABLE) {
      try {
        const plan = planSubtable(record);
        const serials = await issueForPlan(plan);
        const rows = subtableRows(record);
        serials.forEach((serial, index) => {
          if (rows[index] && rows[index].value[NUMBER_FIELD]) {
            rows[index].value[NUMBER_FIELD].value = serial;
          }
        });
        await uiToast('success', `已產生 ${serials.size} 個編號`, [...serials.values()].join('、'));
      } catch (e) {
        console.error('[anum] 子表格發號失敗', e);
        event.error = friendlyError(e, '自動編號');
      }
      return event;
    }

    const cat = matchCategory(scopeOf(record));
    if (!cat) return event;

    try {
      const serial = await resolveSerial(record, cat);
      if (record[NUMBER_FIELD]) record[NUMBER_FIELD].value = serial;
      else throw new Error(`本記錄找不到編號欄位「${NUMBER_FIELD}」`);
      // 與 create/edit 一致：無論是否跳過事前確認，推進成功後都跳出「編號已產生」視窗。
      // 此時 record 尚未實際寫入 DB（由 kintone 隨流程推進一併儲存），但編號已確定，可提前告知。
      await uiToast('success', '編號已產生', `${NUMBER_FIELD}：${serial}`);
    } catch (e) {
      console.error('[anum] 發號失敗', e);
      event.error = friendlyError(e, '自動編號');
    }
    return event;
  };

  // ── 事件註冊（桌面 + 行動共用）──
  const E = (names) => names.flatMap((n) => [`app.record.${n}`, `mobile.app.record.${n}`]);

  const guard = (fn) => async (event) => {
    try { return await fn(event); }
    catch (err) {
      console.error('[anum]', err);
      if (event && event.type && /submit|process/.test(event.type)) {
        event.error = friendlyError(err, '自動編號');
      }
      return event;
    }
  };

  kintone.events.on(E(['create.submit']), guard(onSubmit('create.submit')));
  kintone.events.on(E(['edit.submit']),   guard(onSubmit('edit.submit')));
  kintone.events.on(E(['create.submit.success']), guard(onSubmitSuccess()));
  kintone.events.on(E(['edit.submit.success']),   guard(onSubmitSuccess()));
  kintone.events.on(E(['detail.process.proceed']), guard(onProceed));

})();
