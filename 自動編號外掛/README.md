# 自動編號外掛 — 使用說明

> 適用版本：v1.0.0
>
> 把 [供應商編號系統設計文件](../CLAUDE.md) 的「Counter App 發號機制」包成 kintone 外掛：
> **於特定狀態下儲存時跳出 UI 確認訊息，儲存成功後由 Counter App 發號並回寫編號。**

---

## 這個外掛做什麼？

1. 使用者在符合條件的狀態下按「儲存」。
2. 外掛跳出 **UI 確認訊息**（SweetAlert2，無則退回瀏覽器原生 confirm）。
3. 確認後記錄存檔。
4. **儲存成功**的瞬間，外掛依「供應商分類」決定編號規則：
   - **發號類**（境外 / NX 集團等）→ 向 Counter App 以 **revision 樂觀鎖** 遞增取號（如 `GO000001`），回寫到編號欄位。
   - **抄錄類**（國內供應商）→ **旁路**，直接抄錄既有欄位（如統一編號 8 碼），不經過 Counter App。
5. 完成後彈出成功訊息並重新整理顯示編號。

> 「儲存成功後才發號」可避免使用者取消或驗證失敗造成的跳號（見設計文件第五節）。

---

## 設計對應

| 設計文件概念 | 外掛實作 |
| --- | --- |
| 複合鍵（app_id + category_key）定位發號機 | 執行時自動帶入 `kintone.app.getId()`，query 用 `source_app_id` + `category_key` |
| revision 樂觀鎖防撞號 | `issueSerial()` 帶 `$revision` PUT，遇 `GAIA_CO02` 自動重試（次數可設） |
| 週期歸零（NONE/YEARLY/MONTHLY/DAILY） | `getPeriodTag()` 比對 `period_tag`，跨週期歸零，動作包在樂觀鎖內 |
| 國內走旁路抄統編 | 分類規則「抄錄欄位」模式 + `taxId8` 驗證 |
| 純 JS 無後端、Token 風險 | Counter Token 走前端 fetch；安全靠 kintone 權限 + 編號欄位唯一性（見設計文件第八節） |

---

## 安裝與設定

### 1. 上傳外掛
系統管理 → 外掛程式管理 → 匯入 `plugin.zip`。

### 2. 加入 App
目標業務 App → App 設定 → 外掛程式 → 勾選本外掛 → 更新 App。

### 3. 設定畫面（齒輪圖示）

| 區塊 | 欄位 | 說明 |
| --- | --- | --- |
| **1. 計數器** | Counter App ID | 共用發號中台的 App ID |
| | Counter API Token | 建議填，具「記錄編輯」權限，使用者無權限也能發號 |
| | 本 App Token | 選填，回寫編號用；流程推進後無編輯權時需要 |
| | active 查詢條件 | 預設 `active in ("啟用")`，對應 Counter App 啟用值 |
| **2. 業務欄位** | 編號欄位 | 寫入目標（建議勾「值的唯一性」） |
| | 分類欄位 | 決定套哪條規則（如「供應商分類」） |
| **3. 觸發** | 觸發時機 | create.submit / edit.submit / process.proceed 可多選 |
| | 確認訊息文字 | 儲存前彈出的 UI 提示 |
| | 狀態條件 / 到狀態 / 動作名稱 | `*` 任意，或限定特定狀態才發號 |
| | 併發重試次數 | 預設 5 |
| **4. 分類規則** | 分類值 | 與分類欄位選項完全相同（會直接用此值當 Counter App 的 `category_key` 查詢） |
| | 模式 | 發號 / 抄錄 |
| | 來源欄位（抄錄用） | 抄錄模式填來源欄位代碼；發號模式留空 |
| | 驗證 | 抄錄可選「統一編號 8 碼」 |

### 設定範例（對應設計文件四筆計數器）

| 分類值 | 模式 | 參數 |
| --- | --- | --- |
| 國內供應商 | 抄錄欄位 | `統一編號`（來源欄位代碼） |
| 境外供應商 | 發號 | （無；用分類值本身） |
| NX集團供應商 | 發號 | （無；用分類值本身） |

> 一般供應商 App（685）與營運供應商 App（686）貼**同一份外掛**，`source_app_id` 自動帶入，互不衝突。

### 編號樣式怎麼改（RN000001 → RN-001）

**樣式不在這個外掛設定，也不用改 code**。它由 **Counter App 該筆發號機的 `number_format` 欄位**決定，後台維護人員直接編輯該筆記錄即可：

| 想要的號碼 | `number_format` | `pad` |
| --- | --- | --- |
| `RN000001`（預設） | 留空 或 `{prefix}{seq}` | 6 |
| `RN-001` | `{prefix}-{seq}` | 3 |
| `RN-001`（鎖 3 碼） | `{prefix}-{seq:3}` | 任意 |
| `2026-RN-0001` | `{YYYY}-{prefix}-{seq}` | 4 |

可用 token：`{prefix}`、`{seq}`、`{seq:N}`（補零 N 位）、`{period}`、`{YYYY}`/`{YY}`/`{MM}`/`{DD}`。完整說明見[設計文件 §3.4](../CLAUDE.md)。

> 因為每個 App 用各自的 Counter 記錄，**A App 維持 `RN000001`、B App 改成 `RN-001` 互不影響**，這正是「樣式放在發號機本身」的好處。修改後**毋須重新打包外掛**。

---

## 重新打包（修改程式後）

修改 `contents/dist/*.js` 後（`desktop.js` 與 `mobile.js` 內容相同，改完記得同步），用 **本外掛專屬私鑰** 重新打包：

```bash
npx @kintone/plugin-packer contents --ppk auto-numbering.ppk --out plugin.zip
```

- 私鑰 `auto-numbering.ppk`（公鑰 `auto-numbering.pub`）為本外掛專用，**請妥善保管、勿外流**。
- 用相同 `.ppk` 維持相同 plugin ID，於後台「更新」即可覆蓋升級、設定自動保留。

---

## 上線檢查清單

- [ ] Counter App 4 筆發號機建立完成，`current` 皆為 0、`category_key` 未用保留字 `key`。
- [ ] （要自訂樣式時）Counter App 已加 `number_format` 文字欄位並填好樣板；不填＝預設 `{prefix}{seq}`。
- [ ] `active` 查詢條件與 Counter App 啟用值一致。
- [ ] 業務 App「編號欄位」勾選「值的唯一性」（最後防線）。
- [ ] 分類規則的「分類值」與分類欄位選項完全相同。
- [ ] Counter App 對一般使用者設「僅檢視」、`current` 表單唯讀。
- [ ] （建議）填 Counter API Token，避免使用者權限不足發號失敗。
- [ ] SweetAlert2（`Swal`）若環境未載入，會自動退回原生 confirm/alert，仍可運作。
