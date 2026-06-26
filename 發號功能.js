const CONFIG = { COUNTER_APP: 100, MAX_RETRY: 5 };

// 依重置週期計算「當前週期標記」
// NONE → 空字串；YEARLY → 2026；MONTHLY → 202606；DAILY → 20260625
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
      return ''; // NONE：永久累加，不歸零
  }
};

// 編號樣式樣板：把 token 套進 Counter App 的「編號樣式」(number_format) 欄位
// 後台人員只要改 Counter App 該筆記錄的 number_format / pad，就能換樣式，免改程式。
// 支援 token：
//   {prefix}   → 前綴欄位（prefix）
//   {seq}      → 流水號，補零到 pad 位（pad=6 → 000001）
//   {seq:N}    → 流水號，補零到 N 位（覆寫 pad，例 {seq:3} → 001）
//   {period}   → 目前週期標記（period_tag，如 2026 / 202606）
//   {YYYY}{YY}{MM}{DD} → 發號當下的西元年/兩碼年/月/日
// number_format 留空 → 退回預設 {prefix}{seq}（向下相容舊資料：GO000001）
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

// 通用發號引擎：呼叫端只傳 category_key，app_id 自動帶入
const issueSerial = async (categoryKey) => {
  const appId = kintone.app.getId(); // 自動取得當前業務 App ID

  for (let attempt = 0; attempt < CONFIG.MAX_RETRY; attempt++) {
    const res = await kintone.api(kintone.api.url('/k/v1/records', true), 'GET', {
      app: CONFIG.COUNTER_APP,
      query: `source_app_id = "${appId}" and category_key = "${categoryKey}" and active in ("啟用") limit 1`,
    });
    if (res.records.length === 0) {
      throw new Error(`找不到發號機：App ${appId} / ${categoryKey}`);
    }

    const r = res.records[0];

    // ── 週期歸零判斷 ──
    const cycle = r.reset_cycle.value; // NONE / YEARLY / MONTHLY / DAILY
    const nowTag = getPeriodTag(cycle); // 當前週期標記
    const lastTag = r.period_tag.value; // 記錄裡存的上次週期標記
    // 跨週期（標記不同）→ 從 1 重新算；同週期 → current + 1
    const next = nowTag !== lastTag ? 1 : Number(r.current.value) + 1;

    try {
      await kintone.api(kintone.api.url('/k/v1/record', true), 'PUT', {
        app: CONFIG.COUNTER_APP,
        id: r.$id.value,
        revision: r.$revision.value, // 樂觀鎖：revision 不符會被擋下
        record: {
          current: { value: String(next) },
          period_tag: { value: nowTag }, // 同步更新週期標記
          last_issued_at: { value: new Date().toISOString() },
        },
      });
      // 依 Counter App 該筆的「編號樣式」組出最終編號（樣式由後台維護，免改程式）
      return buildSerial(r.number_format ? r.number_format.value : '', {
        prefix: r.prefix ? r.prefix.value : '',
        seq: next,
        pad: r.pad.value,
        period: nowTag,
      }); // 預設 {prefix}{seq} → GO000001；改成 {prefix}-{seq:3} → GO-001
    } catch (e) {
      if (e.code === 'GAIA_CO02') continue; // revision 衝突 → 重試
      throw e;
    }
  }
  throw new Error(`發號失敗，併發重試 ${CONFIG.MAX_RETRY} 次仍失敗：App ${appId} / ${categoryKey}`);
};

// 依分類決定最終編號（國內抄統編、境外/NX 才發號）
const resolveSerial = async (record) => {
  const category = record['供應商分類'].value;

  if (category === '國內供應商') {
    const taxId = record['統一編號'].value;
    if (!/^\d{8}$/.test(taxId)) throw new Error('國內供應商統編須為 8 碼數字');
    return taxId; // 抄統編，不發號
  }
  if (category === '境外供應商') return await issueSerial('境外供應商');
  if (category === 'NX集團供應商') return await issueSerial('NX集團供應商');

  throw new Error(`未定義的供應商分類：${category}`);
};

// 在特定狀態下、儲存成功後觸發發號並回寫
kintone.events.on(['app.record.create.submit.success', 'app.record.edit.submit.success'], async (event) => {
  const record = event.record;

  // （選用）僅在特定狀態才發號，例如審核通過：
  // if (record['狀態'].value !== '審核通過') return event;

  if (record['供應商編號'].value) return event; // 已有編號不重發

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
