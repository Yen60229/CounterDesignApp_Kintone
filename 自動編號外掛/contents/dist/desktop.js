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
  const COUNTER_TOKEN = String(CONFIG.counterToken || '').trim();
  const SELF_TOKEN    = String(CONFIG.selfToken || '').trim();
  const NUMBER_FIELD  = CONFIG.numberField || '';
  const CATEGORY_FIELD = CONFIG.categoryField || '';
  const ACTIVE_QUERY  = (CONFIG.activeQuery || 'active in ("啟用")').trim();
  const TRIGGERS      = Array.isArray(CONFIG.triggers) ? CONFIG.triggers : ['create.submit', 'edit.submit'];
  const STATUS_COND   = CONFIG.statusCond || '*';
  const TO_STATUS     = CONFIG.toStatus || '*';
  const ACTION_NAME   = CONFIG.actionName || '*';
  const CONFIRM_MSG   = CONFIG.confirmMessage || '此記錄將於儲存後自動產生編號，是否繼續？';
  const MAX_RETRY     = Number(CONFIG.maxRetry) > 0 ? Number(CONFIG.maxRetry) : 5;
  const CATEGORIES    = Array.isArray(CONFIG.categories) ? CONFIG.categories : [];

  const TOKENS = {};
  if (COUNTER_APP && COUNTER_TOKEN) TOKENS[COUNTER_APP] = COUNTER_TOKEN;

  const ENABLED = !!(COUNTER_APP && NUMBER_FIELD && CATEGORY_FIELD && CATEGORIES.length);

  // ── 平台命名空間（桌面 / 行動共用同一份）──
  const APP_NS = (() => { try { return kintone.app; } catch (e) { return null; } })();
  const MOBILE_NS = (() => { try { return kintone.mobile && kintone.mobile.app; } catch (e) { return null; } })();

  const getAppId = () => {
    if (APP_NS && APP_NS.getId) return String(APP_NS.getId());
    if (MOBILE_NS && MOBILE_NS.getId) return String(MOBILE_NS.getId());
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

  // ── API 呼叫：有 Token 走 fetch + header，否則退回 kintone.api（使用者 session）──
  const apiWithToken = async (path, method, body, appIdForToken) => {
    const token = TOKENS[String(appIdForToken)] || (String(appIdForToken) === getAppId() ? SELF_TOKEN : '');
    if (!token) return kintone.api(kintone.api.url(path, true), method, body);
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
        headers: { 'X-Cybozu-API-Token': token },
      });
      if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
      return r.json();
    }
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Cybozu-API-Token': token },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
    return r.json();
  };

  // ── UI 訊息（有 SweetAlert2 用 Swal，否則退回原生 confirm/alert）──
  const uiConfirm = async (text) => {
    if (window.Swal) {
      const res = await window.Swal.fire({
        icon: 'question', title: '自動編號', text,
        showCancelButton: true, confirmButtonText: '確定儲存', cancelButtonText: '取消',
      });
      return res.isConfirmed;
    }
    return window.confirm(text);
  };

  const uiToast = async (icon, title, text) => {
    if (window.Swal) { await window.Swal.fire({ icon, title, text }); return; }
    window.alert(`${title}\n${text || ''}`);
  };

  // ── 週期歸零：依重置週期算出當前週期標記 ──
  const pad2 = (n) => String(n).padStart(2, '0');
  const getPeriodTag = (cycle) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    switch (cycle) {
      case 'YEARLY':  return `${y}`;
      case 'MONTHLY': return `${y}${m}`;
      case 'DAILY':   return `${y}${m}${d}`;
      default:        return ''; // NONE：永久累加
    }
  };

  // ── 編號樣式樣板：token 套進 Counter App 的 number_format 欄位，後台改樣式免改 code ──
  // {prefix} 前綴 / {seq} 補零到 pad 位 / {seq:N} 補零到 N 位 / {period} 週期標記 /
  // {YYYY}{YY}{MM}{DD} 發號當下日期。number_format 留空 → 預設 {prefix}{seq}（向下相容）。
  const buildSerial = (template, opts) => {
    const now = new Date();
    const yyyy = String(now.getFullYear());
    const seq = opts.seq;
    const tpl = (template && template.trim()) || '{prefix}{seq}';
    return tpl
      .replace(/\{prefix\}/g, opts.prefix || '')
      .replace(/\{seq:(\d+)\}/g, (_, n) => String(seq).padStart(Number(n), '0'))
      .replace(/\{seq\}/g, String(seq).padStart(Number(opts.pad) || 0, '0'))
      .replace(/\{period\}/g, opts.period || '')
      .replace(/\{YYYY\}/g, yyyy)
      .replace(/\{YY\}/g, yyyy.slice(-2))
      .replace(/\{MM\}/g, pad2(now.getMonth() + 1))
      .replace(/\{DD\}/g, pad2(now.getDate()));
  };

  // ── 發號引擎：靠 Counter App 各筆記錄的 revision 樂觀鎖保證唯一 ──
  const issueSerial = async (categoryKey) => {
    const appId = getAppId();

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const queryParts = [
        `source_app_id = ${appId}`,
        `category_key in ("${categoryKey}")`,
      ];
      if (ACTIVE_QUERY) queryParts.push(ACTIVE_QUERY);
      const _query = queryParts.join(' and ') + ' limit 1';
      console.log('[anum] issueSerial query:', _query, '| COUNTER_APP:', COUNTER_APP);
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
      const next = nowTag !== lastTag ? 1 : Number(r.current.value) + 1;

      try {
        await apiWithToken('/k/v1/record.json', 'PUT', {
          app: COUNTER_APP,
          id: r.$id.value,
          revision: r.$revision.value, // 樂觀鎖：revision 不符會被擋下
          record: {
            current:        { value: String(next) },
            period_tag:     { value: nowTag },
            last_issued_at: { value: new Date().toISOString() },
          },
        }, COUNTER_APP);

        // 依 Counter App 該筆「編號樣式」組出最終編號（樣式由後台維護，免改 code）
        return buildSerial(r.number_format ? r.number_format.value : '', {
          prefix: r.prefix ? (r.prefix.value || '') : '',
          seq: next,
          pad: r.pad ? r.pad.value : 0,
          period: nowTag,
        }); // 預設 {prefix}{seq} → GO000001；改 {prefix}-{seq:3} → GO-001
      } catch (e) {
        if (errorCodeOf(e) === 'GAIA_CO02') continue; // revision 衝突 → 重新讀取重試
        throw e;
      }
    }
    throw new Error(`發號失敗，併發重試 ${MAX_RETRY} 次仍衝突：類別「${categoryKey}」`);
  };

  // ── 依分類決定最終編號 ──
  const matchCategory = (record) => {
    const fv = record[CATEGORY_FIELD];
    const catVal = fv == null ? '' : String(fv.value == null ? '' : fv.value);
    return CATEGORIES.find((c) => c && c.match === catVal) || null;
  };

  const resolveSerial = async (record, cat) => {
    if (cat.mode === 'copy') {
      // 旁路：抄錄既有欄位（如國內供應商的統一編號），不經過 Counter App
      const src = record[cat.copyField];
      const v = src ? String(src.value == null ? '' : src.value).trim() : '';
      if (cat.validate === 'taxId8' && !/^\d{8}$/.test(v)) {
        throw new Error(`「${cat.copyField}」須為 8 碼數字（目前值：「${v}」）`);
      }
      if (!v) throw new Error(`「${cat.copyField}」為空，無法抄錄為編號`);
      return v;
    }
    // 發號：直接用分類選項值當 category_key 查 Counter App（兩邊保持一致）
    return issueSerial(cat.match);
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

  // ── 流程 1：儲存（create/edit）── 提交前確認，提交成功後發號回寫
  let _pendingIssue = false;

  const onSubmit = (trigger) => async (event) => {
    _pendingIssue = false;
    if (!ENABLED || !TRIGGERS.includes(trigger)) return event;
    const record = event.record;
    if (!record) return event;
    if (alreadyNumbered(record)) return event;          // 已有編號不重發
    if (trigger === 'edit.submit' && !statusOkOnSubmit(record)) return event;
    const cat = matchCategory(record);
    if (!cat) return event;                             // 分類無對應規則 → 不發號

    const ok = await uiConfirm(CONFIRM_MSG);
    if (!ok) { event.error = '已取消，未儲存（也未產生編號）。'; return event; }

    _pendingIssue = true;                               // 標記：待 submit.success 發號
    return event;
  };

  const onSubmitSuccess = () => async (event) => {
    if (!_pendingIssue) return event;
    _pendingIssue = false;

    const record = event.record;
    const recordId = event.recordId || (record.$id && record.$id.value);
    const cat = matchCategory(record);
    if (!cat || !recordId) return event;

    try {
      const serial = await resolveSerial(record, cat);
      const appId = getAppId();
      await apiWithToken('/k/v1/record.json', 'PUT', {
        app: appId, id: recordId, record: { [NUMBER_FIELD]: { value: serial } },
      }, appId);
      await uiToast('success', '編號已產生', `${NUMBER_FIELD}：${serial}`);
      // 轉向詳細頁自動顯示新編號
      window.location.href = `/k/${appId}/show#record=${recordId}`;
    } catch (e) {
      console.error('[anum] 發號/回寫失敗', e);
      await uiToast('error', '編號產生失敗', friendlyError(e, '自動編號'));
    }
    return event;
  };

  // ── 流程 2：流程推進（process.proceed）── 無 success 事件，發號後直接寫入 event.record 一起原子儲存
  const onProceed = async (event) => {
    if (!ENABLED || !TRIGGERS.includes('process.proceed')) return event;
    const record = event.record;
    if (!record) return event;
    if (alreadyNumbered(record)) return event;
    if (!statusOkOnProceed(event)) return event;
    const cat = matchCategory(record);
    if (!cat) return event;

    const ok = await uiConfirm(CONFIRM_MSG);
    if (!ok) { event.error = '已取消，未推進流程。'; return event; }

    try {
      const serial = await resolveSerial(record, cat);
      if (record[NUMBER_FIELD]) record[NUMBER_FIELD].value = serial;
      else throw new Error(`本記錄找不到編號欄位「${NUMBER_FIELD}」`);
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
