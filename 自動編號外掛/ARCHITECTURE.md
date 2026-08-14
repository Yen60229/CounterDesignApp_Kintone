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
3. **純前端、無後端架構**：安全性依賴 kintone 原生權限，並以業務 App 編號欄位的「值的唯一性」作為最後防線。選填的 API Token（用於補償使用者權限不足）不以明文存放於一般設定，而是透過外掛代理設定（`setProxyConfig` / `kintone.plugin.app.proxy()`）加密存放於 kintone 伺服器，執行時由伺服器端注入，瀏覽器端看不到 Token 明文（詳見 §3.1、§5.5，作法沿用 `status-driven-actions-plugin` 的 Token 儲存模式）。

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
| `tools/seed-counters.mjs` | Counter App 發號機**批量建檔**工具（Node，零相依）。讀業務 App 表單設定列舉選項，冪等、預設 dry-run | 新增分組欄位或情境時 |

> **同步原則**：`desktop.js` 與 `mobile.js` 內容必須完全一致。修改 `desktop.js` 後，務必同步覆蓋 `mobile.js` 再重新打包。

打包指令（於 `自動編號外掛/` 目錄下執行）：
```bash
npx @kintone/plugin-packer contents --ppk auto-numbering.ppk --out plugin.zip
```

---

## 3. 資料契約

### 3.1 Plugin Config（儲存於 kintone，由 `config.js` 寫入、`desktop.js` 讀取）

以 `JSON.stringify` 序列化後存於 `data` 鍵。**Token 一律不以明文存於此處**（`counterToken` / `selfToken` 存好即被清空，只留 `hasCounterToken` / `hasSelfToken` 旗標）；Token 明文另存於外掛代理設定，見 §3.2。資料結構（Schema）如下：

```jsonc
{
  "version": "1.0",
  "counterApp": "100",            // Counter App ID（字串）
  "counterToken": "",             // 一律為空字串：Token 已搬至加密代理設定（§3.2），此欄只保留相容性
  "hasCounterToken": true,        // 非機密旗標：Counter App 是否已設定 Token（決定要不要走代理）
  "selfToken": "",                // 一律為空字串：Token 已搬至加密代理設定（§3.2）
  "hasSelfToken": false,          // 非機密旗標：本 App 是否已設定 Token
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
    // counterKey：Counter App 的 category_key；留空＝沿用 match。多列填相同值即共用同一台計數器
    { "match": "境外供應商", "counterKey": "", "mode": "issue", "copyField": "", "validate": "" },
    { "match": "國內供應商", "counterKey": "", "mode": "copy",  "copyField": "統一編號", "validate": "taxId8" }
  ],
  "codeMaps": [                   // 代碼對照表（選用）：欄位值 → 代碼，供 number_format 的自訂 token 使用
    { "token": "level", "field": "事故級別",
      "pairs": [ { "from": "一般事故", "to": "G" }, { "from": "重大事故", "to": "M" } ] }
  ]
}
```

> **舊版相容**：更新程式後、管理者尚未重新於設定畫面按「儲存」前，設定檔仍可能帶有 §5.5 所述的舊版明文 `counterToken` / `selfToken`。此時 `apiWithToken` 會沿用舊的 `fetch` 直送路徑，功能不受影響；管理者一按「儲存」，Token 即自動搬入加密代理設定，此後 `counterToken` / `selfToken` 恆為空字串。

### 3.2 Plugin 代理設定（Proxy Config，加密存於 kintone 伺服器）

Token 明文透過 `kintone.plugin.app.setProxyConfig()` 存放，僅 kintone 伺服器可讀，一般使用者（含開發者工具）無法取得：

| 註冊網址 | 用途 |
| --- | --- |
| `/k/v1/record.json` 所在前綴（GET / POST / PUT 各一筆） | 執行期 `kintone.plugin.app.proxy()` 呼叫 `/k/v1/record*.json` 時，由 kintone 伺服器比對網址前綴，自動注入 `X-Cybozu-API-Token` header |
| `https://anum-plugin.invalid/token-map`（POST，網址故意設為 `.invalid`、永不會被實際呼叫） | 僅供**設定畫面** `getProxyConfig()` 讀回、回填 Token 輸入框編輯用；不參與執行期發號流程 |

`config.js` 儲存時以 `chainProxy()` 依序呼叫 4 次 `setProxyConfig`，全部成功後才呼叫 `setConfig()` 寫入 §3.1 的非機密中繼資料。

**`categories[].mode` 模式說明**：
- `issue`：向 Counter App 發號。`category_key` 取 `counterKey`（留空則沿用 `match`）；`counterKey` 含 `{欄位代碼}` 時先依當筆記錄解析（見 §3.3）。
- `copy`：旁路抄錄，以 `copyField` 欄位的值作為編號；設定 `validate: "taxId8"` 時會檢查是否為 8 碼數字。

**`categories[].match` 的萬用比對**：填 `*` 表示「任意非空的分類值」。比對順序為**先精確、後萬用**（`matchCategory`）。分類值為空時萬用規則不生效——分類都還沒選就發號沒有意義。使用萬用時 `counterKey` 為必填（否則 `category_key` 會變成無意義的 `*`，執行期會擲錯擋下）。

### 3.3 計數器代碼樣板（`counterKey` 的 `{欄位代碼}`）

當「要用哪一台計數器」取決於記錄上的多個欄位時，逐一列舉規則會使設定畫面爆炸。`counterKey` 支援 `{欄位代碼}` 樣板，由 `resolveKeyTemplate(record, tpl)` 於發號前代入該筆記錄的欄位值。

例（MIS作業申請單的設備代號）：設備代號依「設備種類 × 設備需求」分組，18 種設備種類 × {新增, 修改} ＝ **36 台計數器**，但分類規則只需兩條：

| `match`（分類欄位＝設備需求） | `counterKey` | 執行期解析結果 |
| --- | --- | --- |
| `新增` | `{設備種類}新增` | `N1新增`、`P1新增`… |
| `修改` | `{設備種類}修改` | `N1修改`、`P1修改`… |

（`刪除` 不建規則 → `matchCategory` 找不到 → 不發號。）

防呆：樣板中的欄位不存在、或該欄位值為空時**直接擲錯中止**，不會產生 `N1` 這種殘缺的 key 而誤取到別台計數器。此設計與 §4.1 `codeMaps` 的防呆原則一致——寧可中止，也不寫入錯誤的編號。

> **與 `codeMaps` 的分工**：`counterKey` 樣板決定「用哪一台計數器」（影響序號分組）；`codeMaps` 決定「號碼字串裡的可變代碼」（不影響分組）。兩者正交。

Counter App 的 36 筆發號機可用 `tools/seed-counters.mjs` 批量建檔（直接讀業務 App 的表單設定取得選項清單，故不會與表單漂移）。

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

`buildSerial(template, {prefix, seq, pad, period, codes})` 負責將 token 替換為實際值，其餘字元原樣保留。`template` 為空字串時，退回預設 `'{prefix}{seq}'`（向下相容）。

| Token | 替換為 |
| --- | --- |
| `{prefix}` | `prefix` 欄位值 |
| `{seq}` | `seq`，補零至 `pad` 位 |
| `{seq:N}` | `seq`，補零至 N 位（覆寫 pad），N 為正整數 |
| `{period}` | `period_tag`（當前週期標記） |
| `{YYYY}` `{YY}` | 發號當下西元年 / 末兩碼 |
| `{MM}` `{DD}` | 發號當下月 / 日（補零至兩位） |
| `{自訂名稱}` | 代碼對照表（`codeMaps`）解析出的代碼，見下方 §4.1 |

範例：`{prefix}-{seq}` 搭配 prefix=RN、pad=3、seq=1，產出 `RN-001`；`{YYYY}-{prefix}-{seq}` 產出 `2026-RN-000001`。

> **設計考量**：樣式儲存於 Counter App 記錄（資料層）而非 plugin config（業務 App 設定層），因為每個 App 使用各自的 Counter 記錄，可自然達成「不同 App 不同樣式、互不影響」，且調整樣式毋須重新打包。

### 4.1 自訂 token（代碼對照表 `codeMaps`）

內建 token 的值，要嘛來自計數器記錄本身（`prefix`、`seq`），要嘛來自發號當下的時間。但有些號碼需要嵌入**逐筆記錄變動**的代碼——例如事故級別（一般=G／重大=M）——這類值無法寫死於計數器的 `number_format`。

`codeMaps` 即為此設計：宣告「token 名稱 ← 某欄位的值經對照表轉出的代碼」，由 `resolveCodeTokens(record)` 在發號前解析成 `{ token: {code, field, raw} }`，再交給 `buildSerial` 代換。

解析規則與防呆：

- 內建 token **先**代換完畢，因此自訂名稱不會覆蓋內建行為；設定畫面亦禁止使用內建名稱。
- 僅當樣板**實際出現** `{token}` 時才檢查該 token，避免其他計數器的樣式被無關設定牽連。
- 若樣板用到該 token，但記錄的欄位值在對照表中查無代碼（含欄位為空），**直接擲錯中止發號**，不產生 `2026001--CA` 這類殘缺號碼。此時計數器已完成 +1，該號碼會被跳過——寧可跳號，也不寫入錯誤格式。

> **與 `counterKey` 的分工**：`counterKey` 決定「用哪一台計數器」（影響序號分組），`codeMaps` 決定「號碼字串裡的可變代碼」（不影響序號分組）。兩者正交，可各自獨立使用。

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

### 5.4 發號引擎 `issueSerial(categoryKey, codes)`（核心）

`categoryKey` 由 `resolveSerial` 決定：取分類規則的 `counterKey`，留空則沿用 `match`（向下相容）；若 `counterKey` 含 `{欄位代碼}`，先經 `resolveKeyTemplate` 依當筆記錄解析（見 §3.3）。因此多個分類值可指向同一 `categoryKey`、共用一台計數器，序號連續不重號。`codes` 為 `resolveCodeTokens(record)` 的產物（見 §4.1）。

查詢前會將 `categoryKey` 中的 `"` 跳脫，避免解析出的值破壞 kintone 查詢語法。

```
迴圈 maxRetry 次：
  GET Counter：source_app_id=appId AND category_key in (categoryKey) AND <activeQuery> limit 1
    找不到 → throw（提示建檔或啟用）
  讀取 reset_cycle → getPeriodTag(now) 得 nowTag；與 period_tag 比對
    跨週期 → next = 1；同週期 → next = current + 1
  PUT Counter（帶 $revision）：current=next, period_tag=nowTag, last_issued_at=now
    GAIA_CO02（revision 衝突）→ continue 重試
    其他錯誤 → throw
  成功 → return buildSerial(number_format, {prefix, seq:next, pad, period:nowTag, codes})
重試耗盡 → throw
```

### 5.5 API 呼叫策略 `apiWithToken`
三條路徑依序判斷（與 `status-driven-actions-plugin` 的 `apiWithToken` 同一套模式）：

1. **舊版明文 Token**（`CONFIG.counterToken` / `CONFIG.selfToken` 尚未被清空）→ 走 `fetch` 並帶 `X-Cybozu-API-Token` header 直送。僅在管理者尚未於新版設定畫面按過「儲存」時會命中，屬遷移期相容路徑。
2. **加密代理**（`CONFIG.hasCounterToken` / `CONFIG.hasSelfToken` 為 `true`）→ 走 `kintone.plugin.app.proxy(PLUGIN_ID, url, method, {}, data)`，Token 由 kintone 伺服器依 §3.2 註冊的網址前綴比對後注入，前端完全不接觸 Token 明文。GET / DELETE 的參數需先轉為 query string（陣列展開為 `k[]`），因代理不會轉送 `data`。
3. **無 Token** → 退回 `kintone.api()`，沿用呼叫者本身的 session 權限，行為與未設定 Token 前完全相同。

GET 使用 query string（陣列展開為 `k[]`），非 GET 使用 JSON body（路徑 1、3 皆同）。

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
- **I4**：`issue` 模式查詢 Counter 使用的 `category_key` 由 `resolveSerial` 依序決定：`cat.counterKey`（含 `{欄位代碼}` 樣板時先解析）→ 留空則沿用 `cat.match`。故 **Counter 的 `category_key` 必須等於「解析後的 counterKey」，或在 counterKey 留空時等於分類選項值**。設定介面的「來源欄位」參數與發號模式無關（發號天然使用分類值），僅抄錄模式才需填寫。
  > 舊版本文件此處誤記為「查詢使用 `cat.match` 而非 `cat.counterKey`」，與 `desktop.js` 的實作相反，已於 v1.2.0 更正。
- **I5**：發號須在 `submit.success`（情境 A）或 `proceed` 原子寫入（情境 B）執行，不可移至 `submit` 階段，否則使用者取消時會造成跳號。
- **I6**：最後防線為業務 App 編號欄位的「值的唯一性」；跨週期歸零可能產生重複字串，須靠此約束擋下。
  > **子表格模式的例外**：kintone 的「值的唯一性」不支援子表格內欄位，此模式下 I6 無法成立。
  > 補償措施為 Counter App 的 `current` 設唯讀，並新增 `unique_key` 欄位承載複合鍵的唯一性（見 README）。
- **I10**：Counter App 的鍵是**複合鍵** `(source_app_id, category_key)`。`category_key` 單獨**不具唯一性**
  ——不同業務 App 可以有相同的 `category_key`。若要以 kintone 的「值的唯一性」防止重複建檔，
  必須另設 `unique_key` 欄位存放 `source_app_id-category_key` 的組合值，把約束勾在該欄位上。
- **I8**（子表格模式）：必須「先規劃、再取號」——所有列的 `counterKey` 與抄錄值解析完畢後才可呼叫
  `reserveRange`。若邊解析邊取號，中途某列失敗會留下已消耗但未使用的號碼。
- **I9**（子表格模式）：回寫子表格的 PUT 必須送出**所有列並帶上原本的 `id`**。kintone 的子表格為整包覆蓋，
  漏送的列會被刪除、沒帶 id 的列會被當成新列重建。
- **I7**：`number_format` 留空時必須等價於 `{prefix}{seq}`（向下相容既有資料）。
- **I11**：`reset_cycle` 的實際選項文字由各 Counter App 自建，不保證是英文常數。
  外掛的 `getPeriodTag()` 與兩支批量建檔工具的寫入邏輯，一律先經過
  `RESET_CYCLE_ALIASES` 對照表正規化為 `NONE`/`YEARLY`/`MONTHLY`/`DAILY` 四個內部語意值
  再判斷／解析，不可直接對欄位原始字面值做字串比對。三處（`desktop.js`／`mobile.js`／
  兩支批量建檔工具）的對照表內容須保持一致。
  > 背景：v1.3.0 以前僅認英文常數，若 Counter App 的下拉選項是中文
  > （如「每年重置」），寫入會被 kintone 拒絕；即使手動塞入中文值，
  > `getPeriodTag()` 也會落入 `default` 分支（＝視同「不重置」）而不報錯，
  > 是不易發現的靜默錯誤。v1.3.1 修正。

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
- **Token 已改為加密代理儲存**（見 §3.2、§5.5），一般使用者與開發者工具皆讀不到明文；但安全模型底線仍同設計文件 §8——即使 Token 外洩或未設定，仍依賴 kintone 權限與編號欄位唯一性把關，不視 Token 為唯一防線。
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
