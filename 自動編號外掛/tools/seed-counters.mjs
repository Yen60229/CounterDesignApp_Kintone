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

  // ③ 組出待建立的發號機
  //    新增 → 依年度歸零，號碼含年碼：NXN126001
  //    修改 → 不歸零，號碼固定用 99 區段：NXN199001
  const MODE_SPEC = {
    新增: { format: '{prefix}{YY}{seq}', reset: 'YEARLY' },
    修改: { format: '{prefix}99{seq}', reset: 'NONE' },
  };

  const planned = [];
  const skipped = [];

  options.forEach((option) => {
    modes.forEach((mode) => {
      const spec = MODE_SPEC[mode];
      if (!spec) throw new Error(`未定義的情境「${mode}」，請在 MODE_SPEC 中補上格式與歸零週期`);

      const categoryKey = `${option}${mode}`;
      if (existing.has(categoryKey)) { skipped.push(categoryKey); return; }

      const rec = {
        source_app_id: { value: String(sourceApp) },
        category_key: { value: categoryKey },
        active: { value: ['啟用'] },
        prefix: { value: `${prefixBase}${option}` },
        pad: { value: pad },
        number_format: { value: spec.format },
        reset_cycle: { value: spec.reset },
        period_tag: { value: '' },
        // I3：current 的語意是「已發出的最大號碼」，先 +1 再使用，故必為 0
        current: { value: '0' },
      };

      if (hasUniqueKey) rec.unique_key = { value: `${sourceApp}-${categoryKey}` };

      extraFields.forEach(({ field, value }) => { rec[field] = { value }; });

      planned.push(rec);
    });
  });

  // ④ 輸出預覽
  console.log(`待建立 ${planned.length} 台，略過 ${skipped.length} 台（已存在）`);
  console.log('');
  console.log('category_key'.padEnd(16) + 'prefix'.padEnd(10) + 'number_format'.padEnd(22) + 'reset');
  console.log('-'.repeat(64));
  planned.forEach((r) => {
    console.log(
      r.category_key.value.padEnd(16) +
        r.prefix.value.padEnd(10) +
        r.number_format.value.padEnd(22) +
        r.reset_cycle.value
    );
  });
  console.log('');

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
