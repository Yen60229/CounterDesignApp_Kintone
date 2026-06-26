# 自動編號外掛 — 架構規格文件

> **文件用途**：完整說明本外掛的職責劃分、資料契約、執行流程與系統不變量（invariants），供後續維護、除錯與功能擴充時參考。
> **建議閱讀順序**：§1 設計概念 → §3 資料契約 → §5 執行流程 → §7 不變量 → §8 擴充點。
> **配套文件**：操作說明請見 [README.md](README.md)；發號機制的完整設計理念請見 [../CLAUDE.md](../CLAUDE.md)。修改程式時，此三份文件與 `dist/*.js` 必須同步維護。

---

## 1. 設計概念

本外掛的核心精神，是將「**發號**」與「**業務記錄**」徹底解耦。發號作業由一個獨立的 **Counter App** 統一管理（固定筆數，每筆記錄即一台發號機）；本外掛部署於**業務 App** 上，於使用者儲存記錄或推進流程時，依分類規則向 Counter App 透過 **revision 樂觀鎖** 遞增取號，組合出最終編號後回寫至業務記錄。編號的**樣式**由 Counter App 各筆記錄的 `number_format` 欄位決定，可由後台維護人員調整，無須修改程式。

設計建立於三項支柱之上：

1. **複合鍵定位**：以 `(source_app_id, category_key)` 唯一鎖定一台發號機，使同一份外掛部署至任何 App 皆無須修改（`source_app_id` 由 `kintone.app.getId()` 自動帶入）。
2. **revision 樂觀鎖防止撞號**：同種編號併發發號時，由 kintone 後端將「比對 revision 與更新」序列化處理，衝突方收到 `GAIA_CO02` 後自動重試取得下一號。
3. **純前端、無後端架構**：安全性依賴 kintone 原生權限，並以業務 App 編號欄位的「值的唯一性」作為最後防線（不依賴隱藏 Token，因前端環境無法真正隱藏）。

---

## 2. 檔案結構

| 路徑 | 角色 | 修改時機 |
| --- | --- | --- |
| `contents/manifest.json` | 外掛宣告（版本、進入點、設定畫面資源） | 改版本、增刪資源檔 |
| `contents/dist/desktop.js` | **執行期主程式**（桌面）。負責事件綁定與發號引擎 | 調整發號行為 |
| `contents/dist/mobile.js` | 執行期主程式（行動）。**內容與 desktop.js 完全相同** | 須與 desktop.js **同步** |
| `contents/dist/config.js` | **設定畫面**邏輯（無框架，純 DOM 生成）。讀寫 plugin config | 調整設定介面與欄位 |
| `contents/source/html/config.html` | 設定畫面容器（僅一個 `#ui-section`） | 幾乎不需變動 |
| `contents/source/css/config.css` | 設定畫面樣式 | 調整外觀 |
| `contents/3rd_parties/kintone-config-helper.js` | 第三方套件：取得業務 App 欄位清單供下拉選擇 | 不需變動 |
| `auto-numbering.ppk` / `.pub` | 打包用金鑰對。**決定 plugin ID，務必妥善保管、勿外流** | 不需變動 |
| `plugin.zip` | 打包產物 | 由打包指令重新產生 |

> **同步原則**：`desktop.js` 與 `mobile.js` 內容必須完全一致。修改 `desktop.js` 後，務必同步覆蓋 `mobile.js` 再重新打包。

打包指令（於 `自動編號外掛/` 目錄下執行）：
```bash
npx @kintone/plugin-packer contents --ppk auto-numbering.ppk --out plugin.zip
```

---

## 3. 資料契約

### 3.1 Plugin Config（儲存於 kintone，由 `config.js` 寫入、`desktop.js` 讀取）

以 `JSON.stringify` 序列化後存於 `data` 鍵。資料結構（Schema）如下：

```jsonc
{
  "version": "1.0",
  "counterApp": "100",            // Counter App ID（字串）
  "counterToken": "",             // 選填：Counter App 的 API Token（須具「記錄編輯」權限）
  "selfToken": "",                // 選填：本業務 App 的 API Token（回寫編號用）
  "numberField": "供應商編號",     // 寫入目標欄位代碼
  "categoryField": "供應商分類",   // 決定套用規則的欄位代碼
  "activeQuery": "active in (\"啟用\")", // Counter App 啟用條件（對應其 active 欄位實際值）
  "triggers": ["create.submit", "edit.submit", "process.proceed"], // 可複選
  "statusCond": "*",              // edit.submit 限定狀態；* 表示任意
  "toStatus": "*",                // process.proceed 的到達狀態；* 表示任意
  "actionName": "*",              // process.proceed 的動作名稱；* 表示任意
  "confirmMessage": "…",          // 儲存前確認訊息文字
  "maxRetry": 5,                  // revision 衝突重試上限
  "categories": [                 // 分類規則陣列（順序即比對優先序，取首個符合者）
    { "match": "境外供應商", "mode": "issue", "copyField": "", "validate": "" },
    { "match": "國內供應商", "mode": "copy",  "copyField": "統一編號", "validate": "taxId8" }
  ]
}
```

**`categories[].mode` 模式說明**：
- `issue`：向 Counter App 發號，以 `match`（分類選項值）作為 `category_key` 查詢。**請注意：發號查詢使用的是 `cat.match`，而非 `cat.categoryKey`**（詳見 §7 不變量 I4）。
- `copy`：旁路抄錄，以 `copyField` 欄位的值作為編號；設定 `validate: "taxId8"` 時會檢查是否為 8 碼數字。

### 3.2 Counter App 記錄（每筆即一台發號機）

執行期讀取的欄位代碼（多數欄位以 `r.xxx ? … : 預設值` 容錯處理，但**建檔時仍應齊全**）：

| 欄位代碼 | 型別 | 讀/寫 | 用途 |
| --- | --- | --- | --- |
| `source_app_id` | 數值 | 讀（查詢） | 複合鍵之一，等於業務 App ID |
| `category_key` | 文字 | 讀（查詢） | 複合鍵之一，等於分類選項值 |
| `active` | 核取 | 讀（查詢） | 啟用過濾，對應 `activeQuery` |
| `prefix` | 文字 | 讀 | 前綴，對應 `{prefix}` token |
| `pad` | 數值 | 讀 | 補零位數，供 `{seq}` 使用 |
| `number_format` | 文字 | 讀 | **編號樣式樣板**（詳見 §4）；留空即為 `{prefix}{seq}` |
| `reset_cycle` | 下拉 | 讀 | `NONE`／`YEARLY`／`MONTHLY`／`DAILY` |
| `period_tag` | 文字 | 讀＋寫 | 上次發號的週期標記，作為跨週期歸零的比對基準 |
| `current` | 數值 | 讀＋寫 | 已發出的最大號碼 |
| `last_issued_at` | 日期時間 | 寫 | 稽核用途 |
| `$revision` | 系統 | 讀＋帶入 PUT | 樂觀鎖 |

---

## 4. 編號樣式樣板（`number_format`）— Token 語法

`buildSerial(template, {prefix, seq, pad, period})` 負責將 token 替換為實際值，其餘字元原樣保留。`template` 為空字串時，退回預設 `'{prefix}{seq}'`（向下相容）。

| Token | 替換為 |
| --- | --- |
| `{prefix}` | `prefix` 欄位值 |
| `{seq}` | `seq`，補零至 `pad` 位 |
| `{seq:N}` | `seq`，補零至 N 位（覆寫 pad），N 為正整數 |
| `{period}` | `period_tag`（當前週期標記） |
| `{YYYY}` `{YY}` | 發號當下西元年 / 末兩碼 |
| `{MM}` `{DD}` | 發號當下月 / 日（補零至兩位） |

範例：`{prefix}-{seq}` 搭配 prefix=RN、pad=3、seq=1，產出 `RN-001`；`{YYYY}-{prefix}-{seq}` 產出 `2026-RN-000001`。

> **設計考量**：樣式儲存於 Counter App 記錄（資料層）而非 plugin config（業務 App 設定層），因為每個 App 使用各自的 Counter 記錄，可自然達成「不同 App 不同樣式、互不影響」，且調整樣式毋須重新打包。

---

## 5. 執行流程（`desktop.js`）

### 5.1 啟動
讀取 plugin config → 解析 → 計算常數。`ENABLED = counterApp && numberField && categoryField && categories.length`，任一缺漏則整個外掛靜默不動作。

### 5.2 觸發情境 A：儲存（create / edit）— **兩段式**
> 採「儲存成功後才發號」可避免使用者取消或驗證失敗造成跳號。代價為額外一次回寫 PUT。

```
app.record.{create|edit}.submit          → onSubmit
  ├ 已有編號 / 分類無規則 / 狀態不符 → 放行，不發號
  ├ 跳出確認訊息；取消 → event.error 擋下儲存
  └ 通過 → 設定旗標 _pendingIssue = true
app.record.{create|edit}.submit.success  → onSubmitSuccess
  └ 若 _pendingIssue 為真 → resolveSerial() 取號 → PUT 回寫 numberField
     → 成功提示 → 轉址 /k/{appId}/show#record={id} 顯示新編號
```
> 注意：`_pendingIssue` 為**模組級單一布林值**，跨「桌面/行動」與多個事件共用。單頁單次儲存無虞，但屬潛在的狀態耦合點（詳見 §9）。

### 5.3 觸發情境 B：流程推進（process.proceed）— **單段原子**
`detail.process.proceed` **沒有 success 事件**，因此發號後直接寫入 `event.record[numberField]`，隨流程推進一併原子儲存（不另發 PUT）。發號失敗則以 `event.error` 擋下推進。

### 5.4 發號引擎 `issueSerial(categoryKey)`（核心）
```
迴圈 maxRetry 次：
  GET Counter：source_app_id=appId AND category_key in (categoryKey) AND <activeQuery> limit 1
    找不到 → throw（提示建檔或啟用）
  讀取 reset_cycle → getPeriodTag(now) 得 nowTag；與 period_tag 比對
    跨週期 → next = 1；同週期 → next = current + 1
  PUT Counter（帶 $revision）：current=next, period_tag=nowTag, last_issued_at=now
    GAIA_CO02（revision 衝突）→ continue 重試
    其他錯誤 → throw
  成功 → return buildSerial(number_format, {prefix, seq:next, pad, period:nowTag})
重試耗盡 → throw
```

### 5.5 API 呼叫策略 `apiWithToken`
具備對應 Token 時走 `fetch` 並帶 `X-Cybozu-API-Token` header；否則退回 `kintone.api()`（沿用使用者 session 權限）。GET 使用 query string（陣列展開為 `k[]`），非 GET 使用 JSON body。

---

## 6. 錯誤處理

- `guard(fn)`：包覆每個事件處理函式，捕捉例外；於 submit / process 類事件寫入 `event.error` 以擋下操作。
- `friendlyError`：`CB_AU01` → 顯示登入逾時提示；`GAIA_NO01／NO02／CB_NO01／CB_NO02／GAIA_DA02` → 顯示權限不足提示；其餘維持原文。
- `errorCodeOf`：優先讀取 `err.code`，再以正則表達式從訊息中擷取 `CB_*` / `GAIA_*` 代碼。
- 介面：環境具備 `window.Swal`（SweetAlert2）時使用之，否則退回瀏覽器原生 `confirm` / `alert`。

---

## 7. 不變量（修改時不可破壞）

- **I1**：`desktop.js` 與 `mobile.js` 內容完全相同（位元組層級一致）。
- **I2**：發號的 PUT **必須帶 `$revision`**；移除即失去防撞號的核心機制。
- **I3**：`current` 的語意為「已發出的最大號碼」，邏輯為「先 +1 再使用」，故建檔時 `current` 必為 **0**。
- **I4**：`issue` 模式查詢 Counter 使用的是 `cat.match`（分類選項值），故 **Counter 的 `category_key` 必須等於分類選項值**。設定介面的「來源欄位」參數與發號模式無關（發號天然使用分類值），僅抄錄模式才需填寫。
- **I5**：發號須在 `submit.success`（情境 A）或 `proceed` 原子寫入（情境 B）執行，不可移至 `submit` 階段，否則使用者取消時會造成跳號。
- **I6**：最後防線為業務 App 編號欄位的「值的唯一性」；跨週期歸零可能產生重複字串，須靠此約束擋下。
- **I7**：`number_format` 留空時必須等價於 `{prefix}{seq}`（向下相容既有資料）。

---

## 8. 擴充點 / 優化候選

| 預計實作項目 | 修改位置 | 備註 |
| --- | --- | --- |
| 新增樣式 token（如 `{period}` 變體、星期、流水進位字母） | `buildSerial`（desktop、mobile、CLAUDE.md 同步） | 純函數，最安全的擴充點 |
| 即時預覽編號樣板 | `config.js` + `buildSerial`（提前計算範例） | 可加即時預覽，但**實際值仍以 Counter 記錄為準** |
| 支援單筆業務記錄發放多種編號 | `resolveSerial` / `categories`；Counter App 各筆增設「發號種類」 | 目前為一筆一號 |
| 號碼上限預警（`max_value`） | `issueSerial` 取號後比對，提示或記錄 | 欄位已設計，程式尚未使用 |
| 將 `_pendingIssue` 改為 per-record（以 recordId 為鍵的 WeakMap/Map） | `desktop.js` | 解決 §9 的狀態耦合 |
| 批量補號（既有記錄回填） | 新增清單頁工具按鈕或管理畫面功能 | 須注意 revision 與速率限制；建議以 API 而非外掛實作 |

---

## 9. 已知限制 / 待辦事項

- **`_pendingIssue` 單例旗標**：模組級布林值，理論上於多重併發儲存場景可能誤判；以單頁互動為主的 kintone 表單實務上安全，但屬技術債。
- **Token 儲存於 plugin config**：仍為前端可見，安全模型同設計文件 §8——不依賴隱藏 Token，而依賴權限與唯一性。
- **缺乏自動化測試**：建議為發號引擎補上單元測試（`buildSerial`、`getPeriodTag`、`issueSerial` 的重試邏輯為純函數，最易測試）。

---

## 10. 詞彙表

| 詞彙 | 說明 |
| --- | --- |
| 發號機 | Counter App 中的一筆記錄，由 `(source_app_id, category_key)` 唯一定位 |
| 複合鍵 | `source_app_id` + `category_key`，達成跨 App 命名空間隔離 |
| 樂觀鎖 | 帶 `$revision` 的 PUT；revision 不符時回傳 `GAIA_CO02` |
| 週期歸零 | 依 `reset_cycle` 設定，跨年／月／日時將 `current` 重設為 1 |
| 旁路（copy） | 國內供應商抄錄統一編號，不經 Counter App 發號 |
| 樣式樣板 | `number_format`，token 化的編號排版字串 |
