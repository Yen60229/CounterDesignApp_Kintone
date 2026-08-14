#!/usr/bin/env node
// =========================================================================
// Counter App 發號機批量建檔工具
//
// 用途：當「計數器代碼」使用 {欄位代碼} 樣板時，Counter App 需要對應數量的發號機記錄。
//      例：MIS作業申請單的設備代號依「設備種類 × 設備需求」分組，
//          18 種設備種類 × {新增, 修改} = 36 台計數器，手動建檔不切實際。
//
// 本工具直接讀取「業務 App 表單設定」取得設備種類的實際選項清單，
// 因此不會有「程式裡寫死的清單」與「表單實際選項」漂移的問題。
//
// 用法：
//   node tools/seed-counters.mjs --source-app=123 --counter-app=456           # 預覽（dry-run）
//   node tools/seed-counters.mjs --source-app=123 --counter-app=456 --apply   # 實際建檔
//
// 選用參數：
//   --field=設備種類     決定計數器台數的欄位（預設：設備種類）
//   --modes=新增,修改    每個選項要建立的情境（預設：新增,修改）
//   --prefix=NX          編號前綴（預設：NX）
//   --pad=3              流水號補零位數（預設：3）
//   --number-field=設備代號  業務 App 存放編號的欄位（預設：設備代號）。
//                        建檔前會掃描此欄位現有的值，把每台計數器的 current 接續到
//                        目前已使用的最大號，避免第一次發號就與既有記錄撞號。
//   --set=欄位代碼=值     Counter App 若還有其他欄位（例如部門、負責人），且本次建立的
//                        每一筆都要填同樣的值，可重複帶多個 --set。例：
//                        --set=部門=資訊部 --set=負責人=王小明
//                        不可用來設定 source_app_id / category_key / prefix / pad /
//                        number_format / reset_cycle / period_tag / current / unique_key
//                        ——這些欄位的值由本工具批量計算，自行覆蓋會破壞結果。
//
// 認證（擇一，寫在專案根目錄的 .env 或直接用環境變數）：
//   KINTONE_BASE_URL=https://xxx.cybozu.com
//   KINTONE_USERNAME=... / KINTONE_PASSWORD=...      ← 較簡單，一組帳密涵蓋兩個 App
//   或
//   KINTONE_SOURCE_TOKEN=...   ← 業務 App 的 API Token（需「檢視記錄」＋可讀表單設定）
//   KINTONE_COUNTER_TOKEN=...  ← Counter App 的 API Token（需「新增記錄」「檢視記錄」）
//
// 本工具為冪等：已存在相同 (source_app_id, category_key) 的發號機會自動略過，
// 重複執行不會建出重複的計數器，也不會覆蓋既有的 current 值。
//
// reset_cycle 欄位若使用中文選項（不重置/每年重置…）也能自動辨識，不需要事先
// 知道這台 Counter App 用的是英文常數還是中文選項；建立前也會先檢查 Counter App
// 有沒有本工具不知道、卻被設成必填的欄位，有的話直接列出來，不必等到寫入失敗才知道原因。
// =========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 極簡 .env 讀取（不引入相依套件）────────────────────────────────────
const loadEnv = () => {
  // 由本檔往上找 .env，最多找五層（涵蓋 外掛/ → 編號計數器/ → kintone/）
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const file = path.join(dir, '.env');
    if (fs.existsSync(file)) {
      fs.readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .forEach((line) => {
          const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
          if (!m) return;
          const value = m[2].trim().replace(/^["']|["']$/g, '');
          if (process.env[m[1]] === undefined) process.env[m[1]] = value;
        });
      return file;
    }
    dir = path.dirname(dir);
  }
  return null;
};

// ── 參數解析 ────────────────────────────────────────────────────────────
const parseArgs = () => {
  const out = { apply: false, set: [] };
  process.argv.slice(2).forEach((arg) => {
    if (arg === '--apply') { out.apply = true; return; }

    // --set 可重複出現，逐一收集，不可像其他參數一樣後蓋前
    const setMatch = arg.match(/^--set=([^=]+)=(.*)$/);
    if (setMatch) { out.set.push({ field: setMatch[1], value: setMatch[2] }); return; }

    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  });
  return out;
};

// 已經由本工具決定值的欄位代碼——--set 不可以填這些，否則會覆蓋掉前面算好的分組結果。
const RESERVED_FIELDS = new Set([
  'source_app_id', 'category_key', 'active', 'prefix', 'pad',
  'number_format', 'reset_cycle', 'period_tag', 'current', 'unique_key',
]);

// --set 只接受這些型別——都是「填一個字串就能寫入」的型別。
// 用於必填欄位檢查：不在這個集合裡的必填欄位無法透過 --set 補值。
const ALLOWED_EXTRA_TYPES = new Set([
  'SINGLE_LINE_TEXT', 'MULTI_LINE_TEXT', 'NUMBER', 'LINK',
  'RADIO_BUTTON', 'DROP_DOWN', 'DATE', 'TIME', 'DATETIME',
]);

// reset_cycle 是各 Counter App 自建的下拉欄位，選項文字由管理者自己決定；
// 目前並存兩種寫法：英文常數（NONE/YEARLY/MONTHLY/DAILY，外掛原始文件的寫法）
// 與中文選項（不重置/每年重置/每月重置/每日重置）。下方 MODE_SPEC 內部一律用
// 英文語意值，實際要寫入 kintone 的字串於 resolveResetCycleOptions() 依這台
// Counter App 真正的下拉選項動態解析——寫錯字串 kintone 會直接拒絕整批寫入
// （下拉選單嚴格檢查值是否存在於選項清單），這樣就不必事先知道欄位用的是哪種語言。
const RESET_CYCLE_ALIASES = {
  NONE: 'NONE', '不重置': 'NONE',
  YEARLY: 'YEARLY', '每年重置': 'YEARLY',
  MONTHLY: 'MONTHLY', '每月重置': 'MONTHLY',
  DAILY: 'DAILY', '每日重置': 'DAILY',
};

// 各「情境」對應的編號樣式與歸零週期。reset 為內部語意值，
// 實際寫入 kintone 的字串於執行時依 Counter App 的選項解析（見 resetCycleMap）。
//   {prefix}{YY}{seq} → NXN126001（每年歸零）
//   {prefix}99{seq}   → NXN199001（不歸零，固定 99 區段）
const MODE_SPEC_PREVIEW = {
  新增: { format: '{prefix}{YY}{seq}', reset: 'YEARLY' },
  修改: { format: '{prefix}99{seq}', reset: 'NONE' },
  // 別名：若表單的「設備需求」選項寫的是「調整」而非「修改」，直接用 調整 即可
  調整: { format: '{prefix}99{seq}', reset: 'NONE' },
};

/** 與外掛 desktop.js 的 getPeriodTag() 邏輯一致，唯一差異是 cycle 這裡固定吃語意值。 */
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

/**
 * 把 number_format 拆成「{seq} 之前／之後的固定字串」，並代換 {prefix}/{YYYY}/{YY}/
 * {MM}/{DD}/{period}。用途：判斷「現有哪些編號屬於這台計數器」，才能算出起始 current。
 * 與 發號機批量建檔.js 的 splitFormat() 邏輯一致。
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

  const parts = numberFormat.split(/\{seq(?::\d+)?\}/);
  return { head: render(parts[0] || ''), tail: render(parts[1] || '') };
};

/**
 * 在現有編號中找出屬於這台計數器的最大流水號。
 * 與 發號機批量建檔.js 的 scanMax() 邏輯一致：位數不符的視為舊制編號，不列入計算。
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

    if (middle.length !== Number(pad)) {
      if (odd.length < 5) odd.push(code);
      return;
    }

    const seq = Number(middle);
    if (seq > max) { max = seq; sample = code; }
  });

  return { max, sample, odd };
};

/** 分頁取回所有記錄（業務 App 的記錄數可能超過單次 500 筆上限）。 */
const fetchAllRecords = async (client, app, query, fields) => {
  const all = [];
  let offset = 0;
  for (;;) {
    const resp = await client('records', 'GET', {
      app,
      query: `${query} limit 500 offset ${offset}`.trim(),
      fields,
    });
    const batch = resp.records || [];
    all.push(...batch);
    if (batch.length < 500) return all;
    offset += 500;
  }
};

// ── kintone REST 呼叫 ───────────────────────────────────────────────────
const makeClient = (baseUrl, token) => {
  const headers = { 'Content-Type': 'application/json' };

  if (token) {
    headers['X-Cybozu-API-Token'] = token;
  } else if (process.env.KINTONE_USERNAME && process.env.KINTONE_PASSWORD) {
    headers['X-Cybozu-Authorization'] = Buffer.from(
      `${process.env.KINTONE_USERNAME}:${process.env.KINTONE_PASSWORD}`
    ).toString('base64');
  } else {
    throw new Error('缺少認證資訊：請設定 KINTONE_USERNAME/PASSWORD，或對應的 API Token');
  }

  return async (endpoint, method, payload) => {
    const url = new URL(`/k/v1/${endpoint}.json`, baseUrl);
    const init = { method, headers };

    if (method === 'GET') {
      // kintone 的 GET 參數若為陣列，須展開成 fields[0]=x&fields[1]=y，
      // 不能整包丟 JSON 字串（會被當成一個欄位名而查不到東西）。
      Object.entries(payload || {}).forEach(([k, v]) => {
        if (Array.isArray(v)) v.forEach((item, i) => url.searchParams.set(`${k}[${i}]`, item));
        else url.searchParams.set(k, v);
      });
    } else {
      init.body = JSON.stringify(payload || {});
    }

    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

    if (!res.ok) {
      throw new Error(
        `${method} ${endpoint} 失敗 (HTTP ${res.status})：${body.message || text}` +
          (body.errors ? `\n${JSON.stringify(body.errors, null, 2)}` : '')
      );
    }
    return body;
  };
};

// ── 主流程 ──────────────────────────────────────────────────────────────
const main = async () => {
  const envFile = loadEnv();
  const args = parseArgs();

  const baseUrl = process.env.KINTONE_BASE_URL;
  const sourceApp = args['source-app'];
  const counterApp = args['counter-app'];

  if (!baseUrl) throw new Error('缺少 KINTONE_BASE_URL');
  if (!sourceApp) throw new Error('缺少 --source-app=<業務 App ID>');
  if (!counterApp) throw new Error('缺少 --counter-app=<Counter App ID>');

  const fieldCode = args.field || '設備種類';
  const modes = (args.modes || '新增,修改').split(',').map((s) => s.trim()).filter(Boolean);
  const prefixBase = args.prefix || 'NX';
  const pad = String(args.pad || '3');
  const numberField = args['number-field'] || '設備代號';

  const extraFields = args.set || [];
  const badSet = extraFields.find((r) => RESERVED_FIELDS.has(r.field));
  if (badSet) {
    throw new Error(
      `--set 不可使用「${badSet.field}」——這是本工具已經在管理的欄位，自行填值會覆蓋掉批量計算出來的內容。`
    );
  }
  if (extraFields.length) {
    console.log(`每一台待建立的計數器都會一併填入：${extraFields.map((r) => `${r.field}=${r.value}`).join('、')}`);
    console.log('');
  }

  const sourceApi = makeClient(baseUrl, process.env.KINTONE_SOURCE_TOKEN);
  const counterApi = makeClient(baseUrl, process.env.KINTONE_COUNTER_TOKEN);

  console.log('=== 自動編號 — Counter App 發號機批量建檔 ===');
  if (envFile) console.log(`讀取設定檔：${envFile}`);
  console.log(`kintone     ：${baseUrl}`);
  console.log(`業務 App    ：${sourceApp}`);
  console.log(`Counter App ：${counterApp}`);
  console.log(`分組欄位    ：${fieldCode}`);
  console.log(`情境        ：${modes.join(' / ')}`);
  console.log('');

  // ① 從業務 App 的表單設定取得該欄位的實際選項（不寫死清單，避免日後漂移）
  const form = await sourceApi('app/form/fields', 'GET', { app: sourceApp });
  const field = form.properties && form.properties[fieldCode];
  if (!field) {
    throw new Error(`業務 App ${sourceApp} 找不到欄位代碼「${fieldCode}」`);
  }
  if (!field.options) {
    throw new Error(`欄位「${fieldCode}」型別為 ${field.type}，沒有選項可列舉（需為下拉/單選）`);
  }

  // 依表單設定的顯示順序排列
  const options = Object.values(field.options)
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((o) => o.label);

  console.log(`取得「${fieldCode}」選項 ${options.length} 個：${options.join(', ')}`);
  console.log('');

  // ②-0 Counter App 有沒有 unique_key 欄位？
  //     發號機的鍵是複合鍵 (source_app_id, category_key)，而 kintone 的「值的唯一性」
  //     只能套在單一欄位，故需另存一個組合值欄位來承載唯一性約束。
  //     沒有這個欄位時自動略過，不影響其他功能。
  let hasUniqueKey = false;
  let counterForm = { properties: {} };
  try {
    counterForm = await counterApi('app/form/fields', 'GET', { app: counterApp });
    hasUniqueKey = !!(counterForm.properties && counterForm.properties.unique_key);
  } catch {
    hasUniqueKey = false;
  }
  console.log(`Counter App ${hasUniqueKey ? '有' : '沒有'} unique_key 欄位` +
    (hasUniqueKey ? '，將一併寫入複合鍵組合值。' : '（略過；建議新增以取得唯一性防線）。'));
  console.log('');

  // ①-1 必填欄位檢查：Counter App 若有「本工具不知道、但被設成必填」的欄位，
  //     一定會在建立時被 kintone 擋下，且錯誤訊息通常不會講是哪個欄位（只會說「輸入錯誤」）。
  //     這裡先攔截、直接把欄位列出來，--set 可以補、其餘型別需請管理者調整。
  const requiredFields = Object.values(counterForm.properties || {}).filter((f) => f.required);
  const covered = new Set([...RESERVED_FIELDS, ...extraFields.map((r) => r.field)]);
  const missingRequired = requiredFields.filter((f) => !covered.has(f.code));

  if (missingRequired.length) {
    const fillable = missingRequired.filter((f) => ALLOWED_EXTRA_TYPES.has(f.type));
    const unfillable = missingRequired.filter((f) => !ALLOWED_EXTRA_TYPES.has(f.type));
    const lines = [];
    if (fillable.length) {
      lines.push('以下必填欄位尚未設定值，請加上 --set 補：\n  ' +
        fillable.map((f) => `${f.label}（${f.code}）`).join('、'));
    }
    if (unfillable.length) {
      lines.push('以下必填欄位的型別本工具無法自動填值（需要陣列或物件值），' +
        '請到 Counter App 的欄位設定將它們改為非必填，或建立後再手動逐筆補值：\n  ' +
        unfillable.map((f) => `${f.label}（${f.code}・${f.type}）`).join('、'));
    }
    throw new Error(lines.join('\n\n'));
  }

  // ①-2 reset_cycle 的實際選項字串由這台 Counter App 自己決定（英文或中文皆可）。
  //     先確認本次會用到的每個情境都能對應到一個實際選項，找不到就先中止，
  //     不要等到批次寫入時才被 kintone 用「輸入錯誤」擋下、卻看不出是哪個欄位。
  const resetCycleField = counterForm.properties && counterForm.properties.reset_cycle;
  if (!resetCycleField || !resetCycleField.options) {
    throw new Error('Counter App 找不到「reset_cycle」欄位，或它不是下拉/單選型別');
  }
  const resetCycleOptionValues = Object.keys(resetCycleField.options);
  const resetCycleMap = {};
  resetCycleOptionValues.forEach((v) => {
    const semantic = RESET_CYCLE_ALIASES[v];
    if (semantic) resetCycleMap[semantic] = v;
  });

  const neededCycles = [...new Set(modes.map((m) => (MODE_SPEC_PREVIEW[m] || {}).reset))].filter(Boolean);
  const missingCycles = neededCycles.filter((semantic) => !resetCycleMap[semantic]);
  if (missingCycles.length) {
    throw new Error(
      `Counter App 的「reset_cycle」欄位選項裡，找不到對應下列週期的選項：${missingCycles.join('、')}\n` +
        `目前的選項：${resetCycleOptionValues.join('、') || '（無）'}\n` +
        '請到欄位設定新增對應選項（例如「每年重置」或英文 YEARLY 皆可），' +
        '或於本檔調整 RESET_CYCLE_ALIASES 對照表。'
    );
  }

  // ② 查出 Counter App 已存在的發號機，避免重複建檔
  const existingResp = await counterApi('records', 'GET', {
    app: counterApp,
    query: `source_app_id = ${sourceApp} limit 500`,
    fields: ['category_key'],
  });
  const existing = new Set(
    (existingResp.records || []).map((r) => r.category_key && r.category_key.value).filter(Boolean)
  );
  if (existing.size) console.log(`Counter App 已有 ${existing.size} 台發號機，將自動略過。\n`);

  // ②-1 掃描業務 App 現有的編號，決定每一台的起始 current。
  //     若一律從 0 開始，第一次發號就會產生與現有記錄相同的號碼而撞號。
  const codeRecords = await fetchAllRecords(sourceApi, sourceApp, `${numberField} != ""`, [numberField]);
  const codes = codeRecords
    .map((r) => r[numberField] && r[numberField].value)
    .filter(Boolean)
    .map((v) => String(v).trim());
  console.log(`已掃描「${numberField}」現有編號 ${codes.length} 筆。\n`);
  const oddCodes = [];

  // ③ 組出待建立的發號機
  const planned = [];
  const skipped = [];

  options.forEach((option) => {
    modes.forEach((mode) => {
      const spec = MODE_SPEC_PREVIEW[mode];
      if (!spec) throw new Error(`未定義的情境「${mode}」，請在 MODE_SPEC_PREVIEW 中補上格式與歸零週期`);

      const categoryKey = `${option}${mode}`;
      if (existing.has(categoryKey)) { skipped.push(categoryKey); return; }

      // 掃描現有編號，決定這台計數器的起始 current（接續已使用的最大號）
      const prefix = `${prefixBase}${option}`;
      const { head, tail } = splitFormat(spec.format, prefix, spec.reset);
      const found = scanMax(codes, head, tail, pad);
      found.odd.forEach((c) => oddCodes.length < 10 && oddCodes.push(c));

      const rec = {
        source_app_id: { value: String(sourceApp) },
        category_key: { value: categoryKey },
        active: { value: ['啟用'] },
        prefix: { value: prefix },
        pad: { value: pad },
        number_format: { value: spec.format },
        // 寫入實際存在於這台 Counter App 選項清單裡的字串，而非寫死的英文語意值
        reset_cycle: { value: resetCycleMap[spec.reset] },
        // 必須設成當期標記，否則外掛第一次發號會判定跨週期而把號碼歸零到 1
        period_tag: { value: getPeriodTag(spec.reset) },
        // I3：current 的語意是「已發出的最大號碼」，先 +1 再使用。
        // 接續現有編號，避免第一次發號就與既有記錄撞號。
        current: { value: String(found.max) },
      };

      if (hasUniqueKey) rec.unique_key = { value: `${sourceApp}-${categoryKey}` };

      extraFields.forEach(({ field, value }) => { rec[field] = { value }; });

      planned.push(rec);
    });
  });

  // ④ 輸出預覽
  console.log(`待建立 ${planned.length} 台，略過 ${skipped.length} 台（已存在）`);
  console.log('');
  console.log(
    'category_key'.padEnd(16) + 'prefix'.padEnd(10) + 'number_format'.padEnd(22) +
    'current'.padEnd(9) + 'period_tag'.padEnd(12) + 'reset_cycle'
  );
  console.log('-'.repeat(84));
  planned.forEach((r) => {
    console.log(
      r.category_key.value.padEnd(16) +
        r.prefix.value.padEnd(10) +
        r.number_format.value.padEnd(22) +
        r.current.value.padEnd(9) +
        (r.period_tag.value || '(空)').padEnd(12) +
        r.reset_cycle.value
    );
  });
  console.log('');

  if (oddCodes.length) {
    console.log(
      `⚠ 有編號的開頭吻合、但流水號位數與「${pad}」不符，未列入 current 計算，` +
      `請確認是否為舊制編號：${oddCodes.join('、')}`
    );
    console.log('');
  }

  if (planned.length === 0) {
    console.log('沒有需要建立的發號機，結束。');
    return;
  }

  if (!args.apply) {
    console.log('※ 這是預覽（dry-run），尚未寫入任何資料。');
    console.log('※ 確認無誤後，加上 --apply 重新執行即可實際建檔。');
    return;
  }

  // ⑤ 實際建檔（/k/v1/records 單次上限 100 筆）
  for (let i = 0; i < planned.length; i += 100) {
    const chunk = planned.slice(i, i + 100);
    const resp = await counterApi('records', 'POST', { app: counterApp, records: chunk });
    console.log(`已建立 ${resp.ids.length} 筆（${i + 1} ~ ${i + chunk.length}）`);
  }

  console.log('');
  console.log('完成。請至 Counter App 確認記錄內容，並確認業務 App 的編號欄位已勾選「值的唯一性」。');
};

main().catch((err) => {
  console.error('\n[錯誤]', err.message);
  process.exitCode = 1;
});
