const CONFIG = { COUNTER_APP: 100, MAX_RETRY: 5 };

/**
 * 依重置週期設定，計算當前週期標記字串。
 * 週期對應格式如下：
 *   NONE    → 空字串（永久累加，不執行歸零）
 *   YEARLY  → 年份四碼，例如 2026
 *   MONTHLY → 年月六碼，例如 202606
 *   DAILY   → 年月日八碼，例如 20260625
 */
const getPeriodTag = (cycle) => {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
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

/**
 * 依 Counter App 中各計數器記錄的「編號樣式」欄位（number_format），
 * 將樣板 Token 替換為實際值，組合出最終編號字串。
 *
 * 後台維護人員僅需修改 Counter App 中對應記錄的 number_format 與 pad 欄位，
 * 即可變更編號格式，無須調整程式碼。
 *
 * 支援的 Token 說明：
 *   {prefix}       → 前綴欄位（prefix）內容
 *   {seq}          → 流水號，依 pad 位數補零（pad=6 時，1 → 000001）
 *   {seq:N}        → 流水號，補零至指定 N 位（覆寫 pad 設定，例如 {seq:3} → 001）
 *   {period}       → 當前週期標記（period_tag，例如 2026 或 202606）
 *   {YYYY}         → 發號當下西元年（四碼）
 *   {YY}           → 發號當下西元年（後兩碼）
 *   {MM}           → 發號當下月份（補零兩碼）
 *   {DD}           → 發號當下日期（補零兩碼）
 *
 * number_format 留空時，預設使用 {prefix}{seq}，輸出結果與舊版相同（例如 GO000001）。
 */
const buildSerial = (template, { prefix, seq, pad, period }) => {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const tpl = (template && template.trim()) || '{prefix}{seq}';
  return tpl
    .replace(/\{prefix\}/g, prefix || '')
    .replace(/\{seq:(\d+)\}/g, (_, n) => String(seq).padStart(Number(n), '0'))
    .replace(/\{seq\}/g, String(seq).padStart(Number(pad) || 0, '0'))
    .replace(/\{period\}/g, period || '')
    .replace(/\{YYYY\}/g, yyyy)
    .replace(/\{YY\}/g, yyyy.slice(-2))
    .replace(/\{MM\}/g, String(now.getMonth() + 1).padStart(2, '0'))
    .replace(/\{DD\}/g, String(now.getDate()).padStart(2, '0'));
};

/**
 * 通用發號引擎。
 * 呼叫端僅需傳入 category_key，所屬 App ID 由 kintone.app.getId() 自動取得，
 * 因此同一份程式碼可直接部署於多個業務 App，無需個別修改。
 */
const issueSerial = async (categoryKey) => {
  const appId = kintone.app.getId();

  for (let attempt = 0; attempt < CONFIG.MAX_RETRY; attempt++) {
    const res = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: CONFIG.COUNTER_APP,
      query: `source_app_id = "${appId}" and category_key = "${categoryKey}" and active in ("啟用") limit 1`,
    });
    if (res.records.length === 0) {
      throw new Error(`找不到對應的發號機設定：App ${appId} / ${categoryKey}`);
    }

    const r = res.records[0];

    // 判斷是否跨越週期，決定下一個流水號的起始值
    const cycle = r.reset_cycle.value;
    const nowTag = getPeriodTag(cycle);
    const lastTag = r.period_tag.value;
    // 週期標記不同（已跨入新週期）→ 流水號從 1 重新起算；標記相同 → current + 1 繼續累加
    const next = nowTag !== lastTag ? 1 : Number(r.current.value) + 1;

    try {
      await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
        app: CONFIG.COUNTER_APP,
        id: r.$id.value,
        revision: r.$revision.value, // 樂觀鎖：revision 不符時請求將被拒絕，觸發重試
        record: {
          current: { value: String(next) },
          period_tag: { value: nowTag },
          last_issued_at: { value: new Date().toISOString() },
        },
      });
      // 依該計數器記錄的「編號樣式」欄位組合最終編號（樣式由後台設定維護，無需修改程式）
      return buildSerial(r.number_format ? r.number_format.value : '', {
        prefix: r.prefix ? r.prefix.value : '',
        seq: next,
        pad: r.pad.value,
        period: nowTag,
      });
    } catch (e) {
      if (e.code === 'GAIA_CO02') continue; // revision 衝突，重新嘗試取號
      throw e;
    }
  }
  throw new Error(`發號作業失敗，於 ${CONFIG.MAX_RETRY} 次重試後仍無法完成：App ${appId} / ${categoryKey}`);
};

/**
 * 依供應商分類決定編號來源：
 *   國內供應商 → 直接沿用統一編號（稅籍號碼），不經計數器發號
 *   境外供應商 → 由計數器發號（類別代碼：OVERSEAS）
 *   NX 集團供應商 → 由計數器發號（類別代碼：NX）
 */
const resolveSerial = async (record) => {
  const category = record['供應商分類'].value;

  if (category === '國內供應商') {
    const taxId = record['統一編號'].value;
    if (!/^\d{8}$/.test(taxId)) throw new Error('國內供應商統一編號須為 8 碼數字');
    return taxId;
  }
  if (category === '境外供應商') return await issueSerial('OVERSEAS');
  if (category === 'NX集團供應商') return await issueSerial('NX');

  throw new Error(`未定義的供應商分類：${category}`);
};

// 於記錄儲存成功後觸發發號，並將結果回寫至供應商編號欄位
kintone.events.on(['app.record.create.submit.success', 'app.record.edit.submit.success'], async (event) => {
  const record = event.record;

  // （選用）可限制僅於特定流程狀態下觸發發號，例如：
  // if (record['狀態'].value !== '審核通過') return event;

  if (record['供應商編號'].value) return event; // 已存在編號者，不重複發號

  try {
    const serial = await resolveSerial(record);
    await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
      app: kintone.app.getId(),
      id: event.recordId || record.$id.value,
      record: { 供應商編號: { value: serial } },
    });
  } catch (e) {
    Swal.fire('編號產生失敗', e.message, 'error');
  }
  return event;
});
