# 自動編號外掛 — 架構規格（給 AI / GPT 模型快速理解用）

> **這份文件的用途**：讓 LLM（GPT / Claude 等）在**單次讀取**內完整掌握本外掛的職責、資料契約、執行流程與不變量（invariants），以便後續安全地優化、除錯或擴充。
> **閱讀順序建議**：§1 心智模型 → §3 資料契約 → §5 執行流程 → §7 不變量 → §8 擴充點。
> **配套文件**：使用說明見 [README.md](README.md)；發號機制完整設計理念見 [../CLAUDE.md](../CLAUDE.md)。修改程式時，這三份與 `dist/*.js` 必須同步。

---

## 1. 一句話心智模型

> 把「**發號**」與「**業務記錄**」解耦。發號由一個獨立的 **Counter App**（固定 N 筆，每筆是一台發號機）統一管理；本外掛掛在**業務 App** 上，在使用者儲存／推進流程時，依分類規則向 Counter App 以 **revision 樂觀鎖** 遞增取號，組成最終編號後回寫業務記錄。號碼的**樣式**由 Counter App 每筆的 `number_format` 欄位決定，後台可改、免動程式。

設計三支柱：
1. **複合鍵定位**：`(source_app_id, category_key)` 唯一鎖定一台發號機 → 同一份外掛貼到任何 App 免修改（`source_app_id` 由 `kintone.app.getId()` 自動帶入）。
2. **revision 樂觀鎖防撞號**：同種編號併發發號時，由 kintone 後端把「比對 revision + 更新」序列化，搶輸者收 `GAIA_CO02` 自動重試取下一號。
3. **純前端、無後端**：安全靠 kintone 權限 + 業務 App 編號欄位「值的唯一性」當最後防線（不靠藏 Token，藏不住）。

---

## 2. 檔案地圖

| 路徑 | 角色 | 何時改 |
| --- | --- | --- |
| `contents/manifest.json` | 外掛宣告（版本、進入點、設定畫面資源） | 改版本、增刪資源檔 |
| `contents/dist/desktop.js` | **執行期主程式**（桌面）。事件綁定 + 發號引擎 | 改發號行為 |
| `contents/dist/mobile.js` | 執行期主程式（行動）。**內容與 desktop.js 完全相同** | 與 desktop.js **同步** |
| `contents/dist/config.js` | **設定畫面**邏輯（無框架，純 DOM 生成）。讀寫 plugin config | 改設定 UI／欄位 |
| `contents/source/html/config.html` | 設定畫面容器（只有一個 `#ui-section`） | 幾乎不動 |
| `contents/source/css/config.css` | 設定畫面樣式 | 改外觀 |
| `contents/3rd_parties/kintone-config-helper.js` | 第三方：抓業務 App 欄位清單供下拉選擇 | 不動 |
| `auto-numbering.ppk` / `.pub` | 打包用金鑰對。**決定 plugin ID，務必保管勿外流** | 不動 |
| `plugin.zip` | 打包產物 | 由打包指令重生 |

> **同步鐵則**：`desktop.js` 與 `mobile.js` 必須位元組相同。改完 `desktop.js` 後務必覆蓋 `mobile.js` 再打包。

打包指令（於 `自動編號外掛/` 下）：
```bash
npx @kintone/plugin-packer contents --ppk auto-numbering.ppk --out plugin.zip
```

---

## 3. 資料契約

### 3.1 Plugin Config（存於 kintone，`config.js` 寫、`desktop.js` 讀）

以 `JSON.stringify` 存在 `data` 鍵下。Schema：

```jsonc
{
  "version": "1.0",
  "counterApp": "100",            // Counter App ID（字串）
  "counterToken": "",             // 選填：Counter App 的 API Token（"記錄編輯"權限）
  "selfToken": "",                // 選填：本業務 App 的 API Token（回寫編號用）
  "numberField": "供應商編號",     // 寫入目標欄位代碼
  "categoryField": "供應商分類",   // 決定套哪條規則的欄位代碼
  "activeQuery": "active in (\"啟用\")", // Counter App 啟用條件（對應其 active 欄位實際值）
  "triggers": ["create.submit", "edit.submit", "process.proceed"], // 可多選
  "statusCond": "*",              // edit.submit 限定狀態；* = 任意
  "toStatus": "*",                // process.proceed 的到達狀態；* = 任意
  "actionName": "*",              // process.proceed 的動作名；* = 任意
  "confirmMessage": "…",          // 儲存前確認 UI 文字
  "maxRetry": 5,                  // revision 衝突重試上限
  "categories": [                 // 分類規則陣列（順序即比對優先序，取首個 match）
    { "match": "境外供應商", "mode": "issue", "copyField": "", "validate": "" },
    { "match": "國內供應商", "mode": "copy",  "copyField": "統一編號", "validate": "taxId8" }
  ]
}
```

**`categories[].mode`**：
- `issue`：向 Counter App 發號，用 `match`（分類選項值）當 `category_key` 查詢。**注意：發號查的是 `cat.match`，不是 `cat.categoryKey`**（見 §7 不變量 I4）。
- `copy`：旁路抄錄，把 `copyField` 欄位值當編號；`validate: "taxId8"` 會檢查 8 碼數字。

### 3.2 Counter App 記錄（每筆＝一台發號機）

執行期讀取的欄位代碼（缺欄位多會被 `r.xxx ? … : 預設` 容錯，但**建檔應齊全**）：

| 欄位代碼 | 型別 | 讀/寫 | 用途 |
| --- | --- | --- | --- |
| `source_app_id` | 數值 | 讀(查) | 複合鍵之一，= 業務 App ID |
| `category_key` | 文字 | 讀(查) | 複合鍵之一，= 分類選項值 |
| `active` | 核取 | 讀(查) | 啟用過濾，對應 `activeQuery` |
| `prefix` | 文字 | 讀 | 前綴，`{prefix}` token |
| `pad` | 數值 | 讀 | 補零位數，`{seq}` 用 |
| `number_format` | 文字 | 讀 | **編號樣式樣板**（見 §4）；留空＝`{prefix}{seq}` |
| `reset_cycle` | 下拉 | 讀 | `NONE`/`YEARLY`/`MONTHLY`/`DAILY` |
| `period_tag` | 文字 | 讀+寫 | 上次發號週期標記，跨週期歸零的比對基準 |
| `current` | 數值 | 讀+寫 | 已發出的最大號 |
| `last_issued_at` | 日期時間 | 寫 | 稽核用 |
| `$revision` | 系統 | 讀+帶入PUT | 樂觀鎖 |

---

## 4. 編號樣式樣板（`number_format`）— Token 文法

`buildSerial(template, {prefix, seq, pad, period})` 把 token 代換，其餘字元原樣保留。`template` 空字串 → 退回 `'{prefix}{seq}'`（向下相容）。

| Token | 代換 |
| --- | --- |
| `{prefix}` | `prefix` 欄位值 |
| `{seq}` | `seq` 補零到 `pad` 位 |
| `{seq:N}` | `seq` 補零到 N 位（覆寫 pad），N 為正整數 |
| `{period}` | `period_tag`（當前週期標記） |
| `{YYYY}` `{YY}` | 發號當下西元年 / 末兩碼 |
| `{MM}` `{DD}` | 發號當下月 / 日（補零 2 位） |

範例：`{prefix}-{seq}` + prefix=RN + pad=3 + seq=1 → `RN-001`。`{YYYY}-{prefix}-{seq}` → `2026-RN-000001`。

> **設計取捨**：樣式放在 Counter App 記錄（資料）而非 plugin config（業務 App 設定），因為每個 App 用各自的 Counter 記錄，天然做到「不同 App 不同樣式、互不影響」，且改樣式毋須重打包。

---

## 5. 執行流程（`desktop.js`）

### 5.1 啟動
讀 plugin config → 解析 → 算出常數。`ENABLED = counterApp && numberField && categoryField && categories.length`，任一缺則整個外掛靜默不動作。

### 5.2 觸發 A：儲存（create / edit）— **兩段式**
> 「儲存成功後才發號」避免使用者取消／驗證失敗造成跳號。代價：多一次回寫 PUT。

```
app.record.{create|edit}.submit          → onSubmit
  ├ 已有編號 / 分類無規則 / 狀態不符 → 放行不發號
  ├ 跳出確認 UI；取消 → event.error 擋存
  └ 通過 → 設旗標 _pendingIssue = true
app.record.{create|edit}.submit.success  → onSubmitSuccess
  └ 若 _pendingIssue → resolveSerial() 取號 → PUT 回寫 numberField
     → 成功 toast → 轉址 /k/{appId}/show#record={id} 顯示新號
```
> ⚠ `_pendingIssue` 是**模組級單一布林**，跨「桌面/行動」與多事件共用。單頁單次儲存無虞，但屬潛在狀態耦合點（見 §9）。

### 5.3 觸發 B：流程推進（process.proceed）— **單段原子**
`detail.process.proceed` **沒有 success 事件**，故發號後直接寫進 `event.record[numberField]`，跟著流程推進一起原子儲存（不另發 PUT）。失敗 → `event.error` 擋下推進。

### 5.4 發號引擎 `issueSerial(categoryKey)`（核心）
```
loop maxRetry 次：
  GET Counter：source_app_id=appId AND category_key in (categoryKey) AND <activeQuery> limit 1
    找不到 → throw（提示建檔/啟用）
  讀 reset_cycle → getPeriodTag(now) 得 nowTag；比 period_tag
    跨週期 → next = 1；同週期 → next = current + 1
  PUT Counter（帶 $revision）：current=next, period_tag=nowTag, last_issued_at=now
    GAIA_CO02（revision 衝突）→ continue 重試
    其他錯 → throw
  成功 → return buildSerial(number_format, {prefix, seq:next, pad, period:nowTag})
重試耗盡 → throw
```

### 5.5 API 呼叫策略 `apiWithToken`
有對應 Token 走 `fetch` + `X-Cybozu-API-Token` header；否則退回 `kintone.api()`（繼承使用者 session 權限）。GET 用 query string（陣列展開為 `k[]`），非 GET 用 JSON body。

---

## 6. 錯誤處理

- `guard(fn)` 包住每個事件處理：捕捉例外，在 submit/process 類事件寫 `event.error` 擋下操作。
- `friendlyError`：`CB_AU01` → 登入逾時提示；`GAIA_NO01/NO02/CB_NO01/CB_NO02/GAIA_DA02` → 權限不足提示；其餘原文。
- `errorCodeOf`：先看 `err.code`，再從訊息正則撈 `CB_*` / `GAIA_*`。
- UI：有 `window.Swal`（SweetAlert2）用之，否則退回原生 `confirm`/`alert`。

---

## 7. 不變量（修改時不可破壞）

- **I1**：`desktop.js` ≡ `mobile.js`（位元組相同）。
- **I2**：發號的 PUT **必帶 `$revision`**；移除＝失去防撞號核心。
- **I3**：`current` 語意是「已發出的最大號」，邏輯為「先 +1 再用」，故建檔 `current` 必為 **0**。
- **I4**：`issue` 模式查 Counter 用的是 `cat.match`（分類選項值），**Counter 的 `category_key` 必須等於分類選項值**。config UI 的「來源欄位」參數對發號模式無關（發號天然用分類值），只在抄錄模式才填。
- **I5**：發號在 `submit.success`（A）或 `proceed` 原子寫入（B），不可移到 `submit` 階段，否則取消會跳號。
- **I6**：最終防線是業務 App 編號欄位的「值的唯一性」；跨週期歸零可能產生重複字串，靠它擋下。
- **I7**：`number_format` 留空必須等價於 `{prefix}{seq}`（向下相容既有資料）。

---

## 8. 擴充點 / 優化候選（給後續優化的入口）

| 想做的事 | 動哪裡 | 備註 |
| --- | --- | --- |
| 新增樣式 token（如 `{period}` 變體、星期、流水進位字母） | `buildSerial`（desktop+mobile+CLAUDE.md 同步） | 純函數，最安全的擴充點 |
| 即時預覽編號樣板 | `config.js` + `buildSerial`（提前算出範例） | 可加即時預覽，但**真值仍以 Counter 記錄為準** |
| 支援一筆業務記錄發多種號 | `resolveSerial`/`categories`；Counter app 各筆加「發號種類」 | 目前一筆一號 |
| 號碼上限預警（`max_value`） | `issueSerial` 取號後比對，toast 或 log | 欄位已設計，程式尚未用 |
| 把 `_pendingIssue` 改為 per-record（WeakMap/Map by recordId） | `desktop.js` | 解 §9 狀態耦合 |
| 批量補號（既有記錄回填） | 新增 index 工具按鈕或管理畫面功能 | 注意 revision 與速率限制；推薦用 API 而非外掛 |

---

## 9. 已知限制 / 待辦

- **`_pendingIssue` 單例旗標**：模組級布林，理論上多重併發儲存場景可能誤判；單頁互動為主的 kintone 表單實務上安全，但屬技術債。
- **Token 寫在 plugin config**：仍是前端可見，安全模型同設計文件 §8——不靠藏 Token，靠權限 + 唯一性。
- **無自動化測試**：發號引擎建議補單元測試（`buildSerial`、`getPeriodTag`、`issueSerial` 重試邏輯為純函數，最易測）。

---

## 10. 詞彙表

| 詞 | 意思 |
| --- | --- |
| 發號機 | Counter App 裡的一筆記錄，由 `(source_app_id, category_key)` 唯一定位 |
| 複合鍵 | `source_app_id` + `category_key`，跨 App 命名空間隔離 |
| 樂觀鎖 | 帶 `$revision` 的 PUT；rev 不符回 `GAIA_CO02` |
| 週期歸零 | 依 `reset_cycle` 跨年/月/日把 `current` 重設為 1 |
| 旁路（copy） | 國內供應商抄統編，不經 Counter App 發號 |
| 樣式樣板 | `number_format`，token 化的編號排版字串 |
