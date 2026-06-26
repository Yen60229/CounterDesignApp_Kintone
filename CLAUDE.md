# 供應商編號系統 — Counter App 發號機制設計文件

> 本文件為 kintone 供應商編號（流水號）系統的完整設計與實作說明，供後續開發、維護與交接使用。
> 核心精神：**把「發號」與「業務記錄」徹底解耦**，發號由一個獨立的計數器 App 統一管理，靠樂觀鎖（revision）保證號碼唯一、不重複。

---

## 一、背景與需求

兩個獨立的 kintone App 需要供應商編號：

- **一般供應商 App**（範例 App ID：`685`）
- **營運供應商 App**（範例 App ID：`686`）

兩者皆依表單欄位「供應商分類」決定編號規則，分類有三種：國內、境外、NX 集團。

### 編號規則矩陣

|                | 國內          | 境外              | NX 集團           |
| -------------- | ------------- | ----------------- | ----------------- |
| **一般供應商** | 統一編號 8 碼 | `GO` + 6 碼流水號 | `GN` + 6 碼流水號 |
| **營運供應商** | 統一編號 8 碼 | `RO` + 6 碼流水號 | `RN` + 6 碼流水號 |

### 關鍵分流：6 格只有 4 格需要發號

- **境外、NX 集團（4 格）**：`前綴 + 6 碼流水號`，需由 Counter App 遞增發號。
- **國內（2 格）**：「統一編號 8 碼」是**廠商本身的稅籍編號**，由使用者填表時輸入的既有資料，**不是系統流水發出來的**。因此國內供應商**走旁路，不經過 Counter App**——你無法、也不該對一個公司的統編做流水遞增。

---

## 二、為什麼用計數器而非 offset

過去常見用 `offset` 或「數現有幾筆 +1」來推算下一號，這在記錄增長後有兩個致命問題：

1. **效能**：offset 越大，DB 仍要掃過前面所有列再丟棄，退化為 O(N)。kintone offset 上限 10000，超過直接報錯。
2. **正確性**：分頁過程中若有人新增/刪除記錄，offset 會錯位，造成重複或漏號。對「編號唯一」是致命的。

**正解**：編號該來自一個只增不減的獨立計數器（類似資料庫 `AUTO_INCREMENT` 或統一發票發號機），跟實際開了幾張票無關。查詢恆為 O(1)（靠複合鍵查單筆），與業務記錄總量無關。

---

## 三、Counter App 設計

### 3.1 核心觀念

- Counter App 的記錄數 **= 需要發號的種類數**，固定不增長。本案為 **4 筆**。
- 每筆是一台獨立發號機，靠**各自的 `revision` 樂觀鎖**保證同種編號被同時發號時不撞號。
- 不同種類因為是不同筆記錄，天生平行、零競爭；revision 只在「同一種編號被同時發號」時介入仲裁。
- 加入「適用 App ID」欄位後，定位鍵從單鍵（key）升級為**複合鍵（app_id + key）**，使不同 App 即使用同名 key 也不衝突，讓此 Counter App 成為**全公司通用的發號中台**。

### 3.2 欄位設計

> 顯示名（中文，給人看）與欄位代碼（英文，給程式用）分離，是 kintone 最佳實踐。

| 欄位名稱（顯示） | 欄位代碼          | 類型         | 必填 | 唯一 | 說明                                                           |
| ---------------- | ----------------- | ------------ | ---- | ---- | -------------------------------------------------------------- |
| 適用 App ID      | `source_app_id`   | 數值         | ✅   |      | 此發號機所屬的業務 App                                         |
| 編號類別代碼     | `category_key`    | 文字（單行） | ✅   |      | 該 App 內的編號種類識別                                        |
| 唯一識別鍵       | `unique_key`      | 文字（單行） | ✅   | ✅   | App ID＋類別組成，防止重複設定                                 |
| 適用 App 名稱    | `source_app_name` | 文字（單行） |      |      | 方便辨識歸屬                                                   |
| 用途說明         | `description`     | 文字（多行） |      |      | 用途與規則備註                                                 |
| 編號前綴         | `prefix`          | 文字（單行） |      |      | 號碼開頭文字（GO/GN/RO/RN）                                    |
| 流水號位數       | `pad`             | 數值         | ✅   |      | 補零長度（6 → 000001）                                         |
| 編號樣式         | `number_format`   | 文字（單行） |      |      | 號碼排版樣板，後台改這欄即可換樣式（留空＝`{prefix}{seq}`）。詳見 §3.4 |
| 重置週期         | `reset_cycle`     | 下拉選單     | ✅   |      | 不重置／每年／每月／每日，控制歸零頻率                         |
| 目前週期標記     | `period_tag`      | 文字（單行） |      |      | 記錄上次發號所屬週期，發號時比對以判斷是否歸零（程式自動寫入） |
| 目前流水號       | `current`         | 數值         | ✅   |      | 已發出的最大號碼                                               |
| 號碼上限         | `max_value`       | 數值         |      |      | 發號上限，接近可預警                                           |
| 啟用狀態         | `active`          | 核取方塊     |      |      | 停用而不刪除                                                   |
| 最後發號時間     | `last_issued_at`  | 日期時間     |      |      | 每次發號自動更新，供稽核                                       |
| 維護負責人       | `owner`           | 使用者選擇   |      |      | 此發號機的管理者                                               |
| 備註             | `note`            | 文字（多行） |      |      | 異動紀錄、特殊說明                                             |

**重置週期下拉選項**（顯示標籤／實際值分離）：

| 顯示標籤           | 實際值    |
| ------------------ | --------- |
| 不重置（永久累加） | `NONE`    |
| 每年重置           | `YEARLY`  |
| 每月重置           | `MONTHLY` |
| 每日重置           | `DAILY`   |

### 3.3 重要實作注意

- **`key` 是 kintone 保留字**，欄位代碼務必改為 `category_key`（或其他非保留字），否則查詢條件會解析失敗。
- **`active` 核取方塊查詢**：`in (...)` 裡要放選項的「實際值」。請先確認選項值是什麼——若顯示「啟用」且值即為 `啟用`，則寫 `active in ("啟用")`；建議實際值設成英數（如 `enabled`）以避免中文在 query 的潛在編碼困擾。
- **唯一識別鍵不要用計算欄位**：kintone 的「值的唯一性」**不支援計算欄位**，會失去最重要的防呆。改用一般文字欄位 + 勾選唯一性，搭配 JS 自動組鍵（見第六節）。

### 3.4 編號樣式可由後台自訂（`number_format`）

> **需求情境**：同一套發號機制，A App 想要 `RN000001`，B App 想要 `RN-001`、`2026-RN-001`。
> 樣式不該寫死在程式裡——它是「每一台發號機」的屬性，所以放在 **Counter App 的 `number_format` 欄位**，由後台維護人員直接編輯該筆記錄即可換樣式，**完全不用改 JS、不用重打包外掛**。

`number_format` 是一個**樣板字串**，發號時程式把以下 token 代換成實際值，其餘文字（`-`、`/`、年份等）原樣保留：

| Token            | 代換為                              | 範例（pad=6、流水號=1、前綴 RN、2026/06/26） |
| ---------------- | ----------------------------------- | -------------------------------------------- |
| `{prefix}`       | 前綴欄位 `prefix`                   | `RN`                                         |
| `{seq}`          | 流水號，補零到 `pad` 位             | `000001`                                     |
| `{seq:N}`        | 流水號，補零到 **N** 位（覆寫 pad） | `{seq:3}` → `001`                            |
| `{period}`       | 目前週期標記 `period_tag`           | 每年制 → `2026`                              |
| `{YYYY}` `{YY}`  | 發號當下西元年 / 兩碼年             | `2026` / `26`                                |
| `{MM}` `{DD}`    | 發號當下月 / 日（補零）             | `06` / `26`                                  |

**`number_format` 留空 → 預設為 `{prefix}{seq}`**，行為與舊版完全相同（向下相容，既有 4 筆計數器不必動）。

#### 常見樣式對照

| 想要的號碼      | `number_format`          | `pad` | 備註                          |
| --------------- | ------------------------ | ----- | ----------------------------- |
| `RN000001`      | （留空）或 `{prefix}{seq}` | 6     | 預設樣式                      |
| `RN-001`        | `{prefix}-{seq}`         | 3     | 加分隔線、改 3 碼             |
| `RN-001`        | `{prefix}-{seq:3}`       | 任意  | 用 `{seq:3}` 直接鎖 3 碼      |
| `2026-RN-0001`  | `{YYYY}-{prefix}-{seq}`  | 4     | 年份前綴，建議搭配每年重置    |
| `RN2026060001`  | `{prefix}{YYYY}{MM}{seq}`| 4     | 年月內嵌                      |
| `001`           | `{seq}`                  | 3     | 純流水號、不要前綴            |

> **提醒**：跨週期歸零後號碼字串可能重複（如每年都從 `RN-001` 起跳），若要讓號碼本身就帶年份以保唯一，請在樣板放入 `{YYYY}` 或 `{period}`。最終仍由業務 App「供應商編號」欄位的**值的唯一性**做最後把關（見第八節）。

---

## 四、需建立的計數器記錄（共 4 筆）

> 國內供應商走旁路不建記錄，故 6 格只建 4 筆。App ID 請替換為實際值。

| #   | 適用 App ID | 編號類別代碼 | 唯一識別鍵   | 適用 App 名稱 | 編號前綴 | 流水號位數 | 編號樣式 | 重置週期 | 目前流水號 | 啟用 |
| --- | ----------- | ------------ | ------------ | ------------- | -------- | ---------- | -------- | -------- | ---------- | ---- |
| 1   | 685         | OVERSEAS     | 685_OVERSEAS | 一般供應商    | GO       | 6          | 留空     | 不重置   | 0          | ✅   |
| 2   | 685         | NX           | 685_NX       | 一般供應商    | GN       | 6          | 留空     | 不重置   | 0          | ✅   |
| 3   | 686         | OVERSEAS     | 686_OVERSEAS | 營運供應商    | RO       | 6          | 留空     | 不重置   | 0          | ✅   |
| 4   | 686         | NX           | 686_NX       | 營運供應商    | RN       | 6          | 留空     | 不重置   | 0          | ✅   |

> 「編號樣式」(`number_format`) 留空＝預設 `{prefix}{seq}`，產出 `GO000001`…。要改成 `RN-001` 這類樣式，把該筆改成 `{prefix}-{seq}` 並調整 `pad` 即可，見 §3.4。

產出範例：`GO000001`、`GN000001`、`RO000001`、`RN000001`

**兩個建檔鐵則**：

1. **`目前流水號` 一律填 0**（不是 1）。發號邏輯是「先 +1 再用」，第一次 0→1 得 `GO000001`。填 1 會跳掉 000001。
2. **`唯一識別鍵` 須與前兩欄一致**：格式為 `適用App ID` + `_` + `編號類別代碼`（如 `685_OVERSEAS`）。建議由 JS 自動產生（見第六節）。

---

## 五、發號邏輯（業務 App 端 JS）

> 掛在**業務 App**（一般/營運供應商），非 Counter App。`kintone.app.getId()` 會自動帶入當前 App ID，故同一份程式碼貼到兩個 App 皆免修改。

```javascript
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

// 編號樣式樣板：把 token 套進 Counter App 的 number_format 欄位（後台改樣式免改程式）
// {prefix} 前綴 / {seq} 補零到 pad 位 / {seq:N} 補零到 N 位 / {period} 週期標記 /
// {YYYY}{YY}{MM}{DD} 發號當下日期。number_format 留空 → 預設 {prefix}{seq}（向下相容）。
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
      // 依 Counter App 該筆「編號樣式」組出最終編號（樣式由後台維護，免改程式）
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
  if (category === '境外供應商') return await issueSerial('OVERSEAS');
  if (category === 'NX集團供應商') return await issueSerial('NX');

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
```

### 為何在 `submit.success`（儲存成功後）而非 `submit`

若在 `submit` 階段就發號，但使用者後續取消或驗證失敗，號碼已被計數器吃掉造成跳號。等記錄確實落地（`submit.success`）才發號，可避免無謂跳號。代價是多一次 API 回寫。

### 週期歸零機制（`reset_cycle` / `period_tag`）

發號引擎依每筆計數器的 `reset_cycle` 設定，自動在跨週期時把流水號歸零重算：

- **`reset_cycle`**：決定歸零頻率——`NONE`（永久累加）／`YEARLY`（每年）／`MONTHLY`（每月）／`DAILY`（每日）。
- **`period_tag`**：記錄該計數器「上次發號時所屬的週期」，作為比對基準。

運作流程：發號時 `getPeriodTag()` 依當下時間算出「當前週期標記」（如每年制得 `2026`、每月制得 `202606`），再與記錄裡存的 `period_tag` 比對：

- **標記相同**（同一週期內）→ `current + 1`，照常累加。
- **標記不同**（已跨入新週期）→ 流水號重設為 `1`，並把 `period_tag` 更新為新標記。

更新 `current` 與 `period_tag` 的動作同樣包在 revision 樂觀鎖內，因此「歸零＋發號」這個複合動作在併發下仍是原子的，不會兩人同時歸零各拿到 1。

> **設定提醒**：本案 4 筆計數器若採永久累加，`reset_cycle` 填 `NONE` 即可，`period_tag` 留空，歸零邏輯自動略過（`NONE` 的標記恆為空字串，永遠相等）。要啟用歸零時，把該筆 `reset_cycle` 改成對應週期即可，程式不需改動。
>
> **號碼長相**：歸零後號碼維持原本的 `前綴 + 流水號` 格式（如歸零後仍是 `GO000001`），不另外把週期標記塞進號碼。跨週期可能產生相同號碼字串，由業務 App「供應商編號」欄位的**值的唯一性**把關（見第八節）。

---

## 六、唯一識別鍵自動產生（Counter App 端 JS）

> 掛在 **Counter App**，儲存前自動把 `source_app_id` + `category_key` 組成 `unique_key`，維護者免手填。

```javascript
(() => {
  'use strict';

  const CONFIG = {
    APP_ID_FIELD: 'source_app_id',
    KEY_FIELD: 'category_key',
    UNIQUE_FIELD: 'unique_key',
  };

  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {
    const record = event.record;
    const appId = record[CONFIG.APP_ID_FIELD].value;
    const key = record[CONFIG.KEY_FIELD].value;

    if (!appId || !key) {
      event.error = '「適用 App ID」與「編號類別代碼」皆為必填，無法產生唯一識別鍵';
      return event;
    }

    record[CONFIG.UNIQUE_FIELD].value = `${appId}_${key}`; // 685_OVERSEAS
    return event;
  });
})();
```

**搭配**：`unique_key` 欄位設為「文字（單行）」並勾選**值的唯一性**；表單上可設為唯讀，避免人為破壞。JS 負責自動組鍵、kintone 唯一性約束負責擋重複，兩者搭配完整防呆。

---

## 七、併發處理：同時按儲存會怎樣

樂觀鎖（revision）保護的是**同一筆**記錄的併發。執行序如下（兩人同時發同一發號機，當前 `current=5`、`revision=20`）：

1. A、B 幾乎同時 GET，都讀到 `current=5`、`revision=20`。
2. A 先 PUT（帶 rev=20）→ kintone 接受 → `current=6`、`revision=21`。
3. B 後 PUT（仍帶 rev=20）→ kintone 發現實際 rev 已是 21 → 擲出 `GAIA_CO02` 拒絕。
4. B 進入重試 → 重新 GET 讀到 `current=6`、`revision=21` → PUT 成功 → 拿到 `7`。

結果：A 得 `OV-000006`、B 得 `OV-000007`，**絕不撞號**。關鍵在於 kintone 的「比對 revision + 更新」是原子操作，會把同一筆記錄的更新序列化，不可能兩個都帶 rev=20 同時成功。

- **同種編號同時發**：靠 revision 仲裁，搶輸者自動拿下一號。
- **不同種編號同時發**：動到不同筆記錄，本就獨立，互不影響。
- **重試不會無限迴圈**：每次衝突都有一方確定成功推進 revision，`MAX_RETRY = 5` 對一般辦公併發綽綽有餘。

---

## 八、安全性：純 JS 環境的限制與對策

### 8.1 為什麼不能用 API Token（重要）

理想架構是用 FastAPI 後端代理持有 API Token、把 Counter App 寫入收口到後端。**但本案後台只能上傳 JS 檔，沒有可部署的後端**，因此：

- **API Token 不能用**。Token 一旦寫進前端 JS，執行時會出現在使用者瀏覽器的網路請求中，打開 F12 即可竊取。
- **包成 kintone Plugin（外掛）也無法藏 Token**。外掛只是把 JS 打包並提供設定畫面，執行時其 JS 仍在**前端瀏覽器**跑，Token 在發出 API 請求那一刻照樣曝光。外掛解決的是「設定彈性與部署便利」，**不是安全**。

> 結論：Token 要安全，唯一的路是有個使用者碰不到的後端持有它。沒有後端，這條路關閉。

### 8.2 純 JS 環境的實際對策

改靠 **kintone 原生權限 + revision 樂觀鎖 + 結果欄位唯一性**：

| 防護目標     | 對策                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| 防併發撞號   | **revision 樂觀鎖**（純 JS 環境照樣有效，是核心防線）                                                     |
| 防手改計數器 | Counter App 對一般使用者設**僅檢視**；`current` 欄位表單上設唯讀                                          |
| 最後防線     | 業務 App 的**供應商編號欄位設「值的唯一性」**——即使計數器被亂改導致撞號，kintone 也會在寫入時擋下重複編號 |

失去的只是「權限硬隔離」這層，用「編號欄位唯一性」當最後防線補上，實務上足夠。

### 8.3 外掛要不要做

值得做，但**理由是設定彈性而非安全**：讓管理者透過設定畫面填 Counter App ID、各分類前綴、觸發狀態，免改 code，符合 CONFIG 驅動精神。若做外掛，內部仍應用 `kintone.api()`（繼承使用者權限）發號，不要塞 Token。

---

## 九、上線檢查清單

- [ ] Counter App 欄位建置完成，`category_key` 未使用保留字 `key`。
- [ ] Counter App 已新增 `number_format` 文字欄位（要自訂樣式才需填；留空＝預設 `{prefix}{seq}`）。
- [ ] `unique_key` 設文字欄位 + 勾選值的唯一性，並掛上自動組鍵 JS（第六節）。
- [ ] 4 筆計數器記錄建立完成，`目前流水號` 皆為 0。
- [ ] 確認 `active` 核取方塊的實際選項值，並對應修改 query 中 `active in (...)` 的值。
- [ ] 確認各筆 `reset_cycle` 設定（永久累加填 `NONE`、`period_tag` 留空；需歸零則設對應週期）。
- [ ] 業務 App 的「供應商編號」欄位勾選**值的唯一性**（最後防線）。
- [ ] Counter App 權限：一般使用者僅檢視；`current` 表單上唯讀。
- [ ] 發號 JS（第五節）掛上一般供應商與營運供應商兩個 App，確認 `供應商分類`、`統一編號`、`供應商編號` 欄位代碼與實際一致。
- [ ] 確認 `CONFIG.COUNTER_APP` 為實際的 Counter App ID。
- [ ] `Swal`（SweetAlert2）已於環境中可用。

---

## 十、核心設計總結

1. **發號與業務記錄解耦**：Counter App 是固定 N 筆的小表，永不隨業務量增長，發號恆為 O(1)。
2. **複合鍵（app_id + category_key）定位**：各 App 命名空間隔離，同一份 JS 貼到任何 App 免修改，成為通用發號中台。
3. **revision 樂觀鎖保證唯一**：同種編號同時發號時由 kintone 後端序列化仲裁，搶輸者自動重試拿下一號。
4. **國內走旁路**：統一編號是廠商稅籍身分，屬「驗證 + 抄錄」而非「發號」，不經過 Counter App。
5. **支援週期歸零**：依 `reset_cycle` 設定，跨年/月/日自動把流水號歸零重算，歸零動作包在樂觀鎖內維持原子性；不需歸零者設 `NONE` 即永久累加。
6. **純 JS 環境放棄 Token**：安全交給 kintone 權限 + 編號欄位唯一性，樂觀鎖仍完整守住不重複發號。
