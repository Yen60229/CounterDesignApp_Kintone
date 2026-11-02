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

  // ── 共用設定（計數器連線）：整個外掛只有一份 ──
  const COUNTER_APP   = String(CONFIG.counterApp || '').trim();

  // ---------- TOKEN MODEL ----------
  // API Token 一律不以明文存在設定檔（getConfig 可被任何使用者讀取）。正式作法：
  // Token 存在外掛代理設定（setProxyConfig，加密於 kintone 伺服器），執行期以
  // kintone.plugin.app.proxy() 由伺服器端注入，瀏覽器永遠看不到 Token。
  // 這裡只保留「非機密」中繼資料：counter / self 是否有設定 Token（用來決定要不要走代理）。
  //
  // 舊版相容：更新程式後、管理者尚未重新儲存設定前，設定檔仍可能帶有明文 Token。
  // 此時沿用舊的 fetch 直送路徑，確保功能不中斷；管理者一旦重新儲存，Token 就會搬進
  // 加密代理設定，之後這條舊路徑不再被觸發（COUNTER_TOKEN / SELF_TOKEN 皆為空）。
  const COUNTER_TOKEN = String(CONFIG.counterToken || '').trim(); // 舊版明文相容
  const SELF_TOKEN    = String(CONFIG.selfToken || '').trim();    // 舊版明文相容
  const HAS_SECURED_COUNTER = CONFIG.hasCounterToken === true;
  const HAS_SECURED_SELF    = CONFIG.hasSelfToken === true;

  const ACTIVE_QUERY  = (CONFIG.activeQuery || 'active in ("啟用")').trim();
  const MAX_RETRY     = Number(CONFIG.maxRetry) > 0 ? Number(CONFIG.maxRetry) : 5;

  // ── 號碼組（profiles）：一個 App 可以有多組號碼，各自的欄位／時機／規則 ──
  // v1.6.0 起設定存成 profiles[]；更早版本是平面欄位（一個 App 只有一組），
  // 讀到舊格式時視為只有一組，管理者不必重新設定也能照常運作。
  const LEGACY_PROFILE_KEYS = [
    'numberLabel', 'numberField', 'categoryField', 'target', 'subtableCode',
    'triggers', 'statusCond', 'toStatus', 'actionName', 'confirmMessage',
    'categories', 'codeMaps',
  ];
  const RAW_PROFILES = (() => {
    if (Array.isArray(CONFIG.profiles)) return CONFIG.profiles;
    if (!CONFIG.numberField) return [];
    const legacy = {};
    LEGACY_PROFILE_KEYS.forEach((k) => { legacy[k] = CONFIG[k]; });
    return [legacy];
  })();

  // ── 平台命名空間（桌面 / 行動共用同一份）──
  const APP_NS = (() => { try { return kintone.app; } catch (e) { return null; } })();
  const MOBILE_NS = (() => { try { return kintone.mobile && kintone.mobile.app; } catch (e) { return null; } })();

  const getAppId = () => {
    const desktopId = APP_NS && APP_NS.getId && APP_NS.getId();
    if (desktopId != null) return String(desktopId);
    const mobileId = MOBILE_NS && MOBILE_NS.getId && MOBILE_NS.getId();
    if (mobileId != null) return String(mobileId);
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

  // errorText：不加前綴的原因說明（擋下動作時標題已講「產生失敗」，內文不必再重複）
  const errorText = (err) => {
    switch (errorCodeOf(err)) {
      case 'CB_AU01':
        return SESSION_EXPIRED_MESSAGE;
      case 'GAIA_NO01': case 'GAIA_NO02': case 'CB_NO01': case 'CB_NO02': case 'GAIA_DA02':
        return PERMISSION_DENIED_MESSAGE;
      default:
        return (err && err.message) || String(err);
    }
  };

  const friendlyError = (err, prefix) => {
    const text = errorText(err);
    return text === SESSION_EXPIRED_MESSAGE || text === PERMISSION_DENIED_MESSAGE ? text : `${prefix}：${text}`;
  };

  // ── 欄位顯示名稱：給使用者看的訊息一律用表單上的欄位名稱，不出現欄位代碼 ──
  // 第一次需要時讀一次本 App 的欄位設定（含子表格內欄位）並快取；讀不到時退回顯示欄位代碼。
  let _fieldLabels = {};
  let _fieldLabelsPromise = null;
  const loadFieldLabels = () => {
    if (_fieldLabelsPromise) return _fieldLabelsPromise;
    const appId = getAppId();
    if (!appId) return Promise.resolve(_fieldLabels);
    _fieldLabelsPromise = (async () => {
      try {
        const res = await kintone.api(kintone.api.url('/k/v1/app/form/fields.json', true), 'GET', { app: appId });
        const map = {};
        const collect = (props) => Object.values(props || {}).forEach((f) => {
          if (f && f.code && f.label) map[f.code] = f.label;
          if (f && f.type === 'SUBTABLE') collect(f.fields);
        });
        collect(res.properties);
        _fieldLabels = map;
      } catch (e) {
        console.warn('[anum] 讀取欄位名稱失敗，訊息改顯示欄位代碼', e);
      }
      return _fieldLabels;
    })();
    return _fieldLabelsPromise;
  };
  const fieldLabel = (code) => _fieldLabels[code] || code;

  // ── API 呼叫：帶權限的 REST 呼叫（Counter App 發號 / 本 App 補償回寫）。三種路徑依序判斷：
  //   1) 舊版明文 Token 仍在設定檔（尚未遷移）→ 沿用 fetch 直送，維持相容。
  //   2) Token 已加密存於代理設定 → 走 kintone.plugin.app.proxy，由伺服器端注入 Token，
  //      前端拿不到也看不到（代理設定以「網址前置比對」注入，故 /k/v1/ 底下皆涵蓋）。
  //   3) 該對象沒有設定 Token → 用呼叫者本身的 session（kintone.api），行為與原本一致。
  const apiWithToken = async (path, method, body, appIdForToken) => {
    const sApp = String(appIdForToken);
    const isSelf = sApp === getAppId();
    const isCounter = !!COUNTER_APP && sApp === COUNTER_APP;

    // 1) 舊版明文 Token（遷移前的相容路徑；遷移後 COUNTER_TOKEN / SELF_TOKEN 皆空，不會進來）
    const rawToken = (isCounter && COUNTER_TOKEN) || (isSelf && SELF_TOKEN) || '';
    if (rawToken) {
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
          headers: { 'X-Cybozu-API-Token': rawToken },
        });
        if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
        return r.json();
      }
      const r = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Cybozu-API-Token': rawToken },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`API ${path} ${r.status}: ${await r.text()}`);
      return r.json();
    }

    // 2) 加密代理路徑：Token 由 kintone 伺服器注入，前端完全不接觸
    const secured = (isCounter && HAS_SECURED_COUNTER) || (isSelf && HAS_SECURED_SELF);
    if (secured) {
      let url = kintone.api.url(path, true);
      let data = body;
      if (method === 'GET' || method === 'DELETE') {
        // 代理對 GET / DELETE 會忽略 data，參數需放在 query string
        const qs = new URLSearchParams();
        Object.entries(body || {}).forEach(([k, v]) => {
          if (Array.isArray(v)) v.forEach((x) => qs.append(`${k}[]`, x));
          else qs.append(k, v);
        });
        url = `${url}?${qs}`;
        data = {};
      }
      // proxy 回傳 [body(字串), status(數字), headers(物件)]；非 2xx 需自行判斷
      const [respBody, status] = await kintone.plugin.app.proxy(PLUGIN_ID, url, method, {}, data);
      if (status < 200 || status >= 300) throw new Error(`API ${path} ${status}: ${respBody}`);
      return respBody ? JSON.parse(respBody) : {};
    }

    // 3) 無 Token → 用呼叫者自身 session
    return kintone.api(kintone.api.url(path, true), method, body);
  };

  // ── UI 訊息：一律用 SweetAlert2（外掛自帶 3rd_parties/sweetalert2.all.min.js；App 已自行載入 Swal 時沿用它）。
  // 原生 confirm/alert 只是 Swal 載入失敗時的最後備案，確保訊息不會整個消失。──
  // 字級/間距特別放大，對象鎖定 35–55 歲使用者：優先求「一眼看清楚」而非精緻小巧。
  const injectSwalStyle = (() => {
    let done = false;
    return () => {
      if (done || document.getElementById('anum-swal-style')) return;
      done = true;
      const style = document.createElement('style');
      style.id = 'anum-swal-style';
      style.textContent = `
        .anum-swal-popup { width: auto !important; max-width: 92vw; padding: 28px 32px 30px; border-radius: 12px; }
        .anum-swal-title { font-size: 22px !important; font-weight: 700 !important; margin-bottom: 6px !important; }
        .anum-swal-text  { font-size: 17px !important; line-height: 1.7 !important; color: #333 !important; }
        /* 訊息句子不自動換行（視窗寬度跟著文字走），只在原文有換行處換行；超過畫面寬度才橫向捲動 */
        .anum-swal-nowrap { white-space: pre !important; overflow-x: auto; }
        .anum-swal-confirm, .anum-swal-cancel {
          font-size: 17px !important; font-weight: 600 !important;
          padding: 11px 28px !important; border-radius: 8px !important;
        }
        .anum-swal-icon { width: 4.2em !important; height: 4.2em !important; }

        /* ── 視窗進出場動畫 ── */
        @keyframes anumPopIn {
          from { transform: scale(.9) translateY(10px); opacity: 0; }
          to   { transform: none; opacity: 1; }
        }
        @keyframes anumPopOut {
          from { transform: none; opacity: 1; }
          to   { transform: scale(.94) translateY(4px); opacity: 0; }
        }
        .anum-anim-in  { animation: anumPopIn .28s cubic-bezier(.22,1,.36,1); }
        .anum-anim-out { animation: anumPopOut .16s ease-in forwards; }
        @keyframes anumFadeIn { from { opacity: 0 } to { opacity: 1 } }
        .anum-backdrop-in { animation: anumFadeIn .2s ease-out; }

        /* ── 進度條 ── */
        .anum-prog { min-width: 340px; max-width: 460px; margin: 6px auto 2px; }
        .anum-prog-label {
          font-size: 16px; color: #33404e; margin-bottom: 12px;
          min-height: 24px; transition: opacity .15s;
        }
        .anum-prog-track {
          height: 12px; background: #e6ebf1; border-radius: 999px;
          overflow: hidden; box-shadow: inset 0 1px 2px rgba(16,24,40,.08);
        }
        .anum-prog-bar {
          height: 100%; width: 0%; border-radius: 999px;
          background: linear-gradient(90deg, #2b6cb0 0%, #57a5e5 50%, #2b6cb0 100%);
          background-size: 200% 100%;
          animation: anumShimmer 1.5s linear infinite;
          transition: width .4s cubic-bezier(.4,0,.2,1);
        }
        @keyframes anumShimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        .anum-prog-count {
          margin-top: 10px; font-size: 14px; color: #6b7480;
          font-variant-numeric: tabular-nums;
        }
        /* 完成時停止流動、轉為綠色，給一個明確的「結束」訊號 */
        .anum-prog-bar.is-done {
          animation: none;
          background: linear-gradient(90deg, #2f9e5f, #46b877);
        }

        /* ── 處理中視窗 ── */
        .anum-loading { min-width: 300px; padding: 8px 0 4px; text-align: center; }
        .anum-spinner {
          width: 46px; height: 46px; margin: 4px auto 16px; box-sizing: border-box;
          border: 5px solid #e6ebf1; border-top-color: #2b6cb0; border-radius: 50%;
          animation: anumSpin .8s linear infinite;
        }
        @keyframes anumSpin { to { transform: rotate(360deg); } }
        .anum-loading-text { font-size: 16px; color: #33404e; }
      `;
      document.head.appendChild(style);
    };
  })();

  // SweetAlert2 內建的進出場動畫換成自訂的（較柔和、位移較小，長者較不易頭暈）
  const SWAL_ANIM = {
    showClass: { popup: 'anum-anim-in', backdrop: 'anum-backdrop-in' },
    hideClass: { popup: 'anum-anim-out' },
  };

  const SWAL_CUSTOM_CLASS = {
    popup: 'anum-swal-popup',
    title: 'anum-swal-title',
    htmlContainer: 'anum-swal-text',
    confirmButton: 'anum-swal-confirm',
    cancelButton: 'anum-swal-cancel',
    icon: 'anum-swal-icon',
  };
  const SWAL_MESSAGE_CLASS = Object.assign({}, SWAL_CUSTOM_CLASS, { htmlContainer: 'anum-swal-text anum-swal-nowrap' });

  const uiConfirm = async (title, text) => {
    if (window.Swal) {
      injectSwalStyle();
      const res = await window.Swal.fire(Object.assign({
        icon: 'question', title, text,
        width: 'auto',
        showCancelButton: true, confirmButtonText: '確定儲存', cancelButtonText: '取消',
        customClass: SWAL_MESSAGE_CLASS,
        confirmButtonColor: '#2b6cb0',
        cancelButtonColor: '#8a94a3',
        reverseButtons: true,
        focusConfirm: true,
      }, SWAL_ANIM));
      return res.isConfirmed;
    }
    return window.confirm(text);
  };

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));

  // lines：多組號碼時一行一組。Swal 的 text 不會換行，故改用跳脫後的 html 呈現。
  const uiToast = async (icon, title, text, lines) => {
    if (window.Swal) {
      injectSwalStyle();
      const body = Array.isArray(lines) && lines.length
        ? { html: lines.map(escapeHtml).join('<br>') }
        : { text };
      await window.Swal.fire(Object.assign({
        icon, title,
        width: 'auto',
        confirmButtonText: '好，我知道了',
        customClass: SWAL_MESSAGE_CLASS,
        confirmButtonColor: '#2b6cb0',
      }, body, SWAL_ANIM));
      return;
    }
    window.alert(`${title}\n${Array.isArray(lines) && lines.length ? lines.join('\n') : (text || '')}`);
  };

  // ── 發號進度視窗 ──
  // 子表格逐列發號時，每個計數器代碼都要一次「讀取＋樂觀鎖更新」的往返，
  // 列數多時會停頓數秒。沒有回饋的話使用者會以為當掉而重複點擊，故顯示進度。
  const uiProgress = (() => {
    let active = false;
    const $ = (id) => document.getElementById(id);

    return {
      open(title) {
        if (!window.Swal) return;
        injectSwalStyle();
        active = true;
        window.Swal.fire(Object.assign({
          title,
          html:
            '<div class="anum-prog">' +
              '<div class="anum-prog-label" id="anum-prog-label">正在準備…</div>' +
              '<div class="anum-prog-track"><div class="anum-prog-bar" id="anum-prog-bar"></div></div>' +
              '<div class="anum-prog-count" id="anum-prog-count"></div>' +
            '</div>',
          width: 'auto',
          allowOutsideClick: false,   // 發號進行中不可關閉，避免使用者以為取消得掉
          allowEscapeKey: false,
          showConfirmButton: false,
          customClass: SWAL_CUSTOM_CLASS,
        }, SWAL_ANIM));
      },

      update(label, done, total) {
        if (!active) return;
        const l = $('anum-prog-label'), b = $('anum-prog-bar'), c = $('anum-prog-count');
        if (l && label) l.textContent = label;
        if (b && total > 0) b.style.width = `${Math.min(100, Math.round((done / total) * 100))}%`;
        if (c && total > 0) c.textContent = `${done} / ${total} 列`;
      },

      // 收尾：進度條填滿並轉綠，短暫停留讓使用者看見「完成」再切換到結果視窗
      async finish(label) {
        if (!active) return;
        const l = $('anum-prog-label'), b = $('anum-prog-bar');
        if (b) { b.style.width = '100%'; b.classList.add('is-done'); }
        if (l && label) l.textContent = label;
        await new Promise((r) => setTimeout(r, 450));
        active = false;
      },

      close() {
        active = false;
        if (window.Swal && window.Swal.isVisible && window.Swal.isVisible()) window.Swal.close();
      },
    };
  })();

  // ── 處理中視窗 ──
  // 從按下儲存／流程動作到拿到號碼，中間要經過「kintone 存檔 → 讀計數器 → 推進計數器 → 回寫」
  // 好幾趟往返，約 1～2 秒畫面毫無動靜，使用者會以為沒按到而重複點擊。
  // 因此事件一觸發就先彈出這個視窗，之後由進度視窗或結果視窗直接接手替換。
  //
  // autoCloseMs：儲存（submit）時用。kintone 若在存檔階段失敗（必填未填、值重複、其他自訂擋下…），
  // 不會觸發 submit.success，這個視窗就沒人關；逾時自動關閉，讓使用者看得到 kintone 的錯誤訊息。
  const uiLoading = (() => {
    let timer = null;
    const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
    const isMine = () => !!document.getElementById('anum-loading');
    const close = () => {
      clearTimer();
      if (window.Swal && window.Swal.isVisible && window.Swal.isVisible() && isMine()) window.Swal.close();
    };
    return {
      open(title, text, autoCloseMs) {
        if (!window.Swal) return;
        injectSwalStyle();
        clearTimer();
        window.Swal.fire(Object.assign({
          title,
          html:
            '<div class="anum-loading" id="anum-loading">' +
              '<div class="anum-spinner"></div>' +
              `<div class="anum-loading-text">${escapeHtml(text || '')}</div>` +
            '</div>',
          width: 'auto',
          allowOutsideClick: false,
          allowEscapeKey: false,
          showConfirmButton: false,
          customClass: SWAL_CUSTOM_CLASS,
        }, SWAL_ANIM));
        if (autoCloseMs) timer = setTimeout(close, autoCloseMs);
      },
      // 已確定會接手（submit.success 已到），取消逾時自動關閉
      hold: clearTimer,
      close,
    };
  })();

  // ── 擋下儲存／流程推進：kintone 頂端紅條只放短句，完整原因改用 SweetAlert 視窗 ──
  // 紅條空間小、長句會被截斷換行，看不清楚；視窗寬度跟著文字走，一句話完整顯示。
  // 頁面沒有載入 SweetAlert2 時，原因仍直接寫在紅條，確保訊息不會消失。
  const NATIVE_BLOCK_TEXT = '發生錯誤，原因請見訊息視窗';
  const blockEvent = (event, title, message) => {
    uiLoading.close();
    if (window.Swal) {
      event.error = NATIVE_BLOCK_TEXT;
      uiToast('error', title, message);
    } else {
      event.error = message;
    }
    return event;
  };

  // 存檔通常 1 秒內完成；超過這個時間還沒等到 submit.success，視為存檔失敗而關閉處理中視窗
  const SAVE_WAIT_MS = 8000;

  // 少量幾列時進度視窗只會一閃而過，反而干擾；達到這個列數才顯示
  const PROGRESS_MIN_ROWS = 3;

  // ── 週期歸零：依重置週期算出當前週期標記 ──
  //
  // reset_cycle 是各 Counter App 自建的下拉欄位，選項文字由管理者自己決定；
  // 目前並存兩種寫法：英文常數（NONE/YEARLY/MONTHLY/DAILY，本外掛原始文件的寫法）
  // 與中文選項（不重置/每年重置/每月重置/每日重置）。
  // 若只認英文，中文值會落入 default 分支——不會報錯，但等同被當成「不重置」，
  // 該歸零卻永久累加，是不會被發現的靜默錯誤，比直接失敗更危險。
  // 故先正規化再判斷，不論欄位用哪種語言的選項都能正確運作。
  const RESET_CYCLE_ALIASES = {
    NONE: 'NONE', '不重置': 'NONE',
    YEARLY: 'YEARLY', '每年重置': 'YEARLY',
    MONTHLY: 'MONTHLY', '每月重置': 'MONTHLY',
    DAILY: 'DAILY', '每日重置': 'DAILY',
  };
  const normalizeResetCycle = (raw) => RESET_CYCLE_ALIASES[String(raw || '').trim()] || 'NONE';

  // ── 欄位值 → 字串 ──
  // 組織／使用者／群組選擇、建立人、核取方塊、複選這類欄位的 value 是陣列（前三者是 [{code,name}]），
  // 直接 String() 會變成 "[object Object]"，對照表與分類比對永遠對不到。
  // valuesOf 回傳「可拿來比對的候選字串」：物件取 name（顯示名稱），並附上 code（名稱改了仍可比對）。
  // textOf 回傳顯示用字串：多選以逗號串接（與舊版 String(陣列) 結果相同，既有分類值不受影響），物件只取 name。
  const valuesOf = (fv) => {
    const v = fv == null ? null : fv.value;
    if (v == null) return [];
    if (!Array.isArray(v)) {
      if (typeof v === 'object') return [v.name, v.code].filter(Boolean).map((s) => String(s).trim());
      const s = String(v).trim();
      return s ? [s] : [];
    }
    const out = [];
    v.forEach((item) => {
      if (item == null) return;
      if (typeof item === 'object') {
        if (item.name) out.push(String(item.name).trim());
        if (item.code && item.code !== item.name) out.push(String(item.code).trim());
      } else if (String(item).trim()) {
        out.push(String(item).trim());
      }
    });
    return out;
  };
  const textOf = (fv) => {
    const v = fv == null ? null : fv.value;
    if (v == null) return '';
    if (!Array.isArray(v)) return typeof v === 'object' ? String(v.name || v.code || '') : String(v);
    return v
      .map((item) => (item && typeof item === 'object' ? (item.name || item.code || '') : String(item == null ? '' : item)))
      .filter(Boolean)
      .join(',');
  };

  // ── 代碼對照：欄位值 → 代碼 ──
  // pairs 的 from 支援三種寫法，比對優先順序如下（與填寫順序無關）：
  //   1. 完全相同      `一般事故=G`
  //   2. 開頭相符      `事業本部*=A`（值以「事業本部」開頭即算；多條符合時取最長的那條）
  //   3. 其餘任意值    `*=X`（值非空、前兩種都沒對到時才用）
  // 組織選擇等多值欄位會逐一比對每個候選字串（name 與 code），先比完所有候選的「完全相同」才輪到「開頭相符」。
  const matchCodePair = (pairs, candidates) => {
    const list = (pairs || []).filter((p) => p && p.from);
    if (!candidates.length) return null;
    for (const c of candidates) {
      const hit = list.find((p) => p.from === c);
      if (hit) return hit;
    }
    let best = null;
    list.forEach((p) => {
      if (p.from === '*' || !p.from.endsWith('*')) return;
      const head = p.from.slice(0, -1);
      if (!candidates.some((c) => c.startsWith(head))) return;
      if (!best || head.length > best.from.length - 1) best = p;
    });
    if (best) return best;
    return list.find((p) => p.from === '*') || null;
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  const getPeriodTag = (cycle) => {
    const now = new Date();
    const y = now.getFullYear();
    const m = pad2(now.getMonth() + 1);
    const d = pad2(now.getDate());
    switch (normalizeResetCycle(cycle)) {
      case 'YEARLY':  return `${y}`;
      case 'MONTHLY': return `${y}${m}`;
      case 'DAILY':   return `${y}${m}${d}`;
      default:        return ''; // NONE：永久累加
    }
  };

  // ════════════════════════════════════════════════════════════════════════
  // 單一號碼組的發號邏輯。每組各自一份閉包，函式內容與 v1.5.0（單組版）相同，
  // 只是設定值改由 P（這一組的設定）提供，而非整個外掛共用。
  // ════════════════════════════════════════════════════════════════════════
  const makeProfile = (P, profileIndex) => {
    const NUMBER_FIELD   = P.numberField || '';
    const CATEGORY_FIELD = P.categoryField || '';

    // ---------- 編號寫入位置 ----------
    // 'field'    ：一筆記錄一個號，寫入單一欄位（預設）
    // 'subtable' ：子表格一列一個號，一張單可一次產生多個編號
    //   此模式下 NUMBER_FIELD / CATEGORY_FIELD 指的是「子表格列內」的欄位代碼。
    const TARGET        = P.target === 'subtable' ? 'subtable' : 'field';
    const SUBTABLE_CODE = P.subtableCode || '';
    const IS_SUBTABLE   = TARGET === 'subtable' && !!SUBTABLE_CODE;
    const TRIGGERS      = Array.isArray(P.triggers) ? P.triggers : ['create.submit', 'edit.submit'];
    const STATUS_COND   = P.statusCond || '*';
    const TO_STATUS     = P.toStatus || '*';
    const ACTION_NAME   = P.actionName || '*';
    // 號碼在這張表單叫什麼（設備代號／事故編號／供應商編號…）。
    // 所有給使用者看的訊息都用這個詞，不出現「發號機」「計數器」這類內部術語。
    const NUMBER_LABEL  = String(P.numberLabel || '').trim() || '編號';
    const CONFIRM_MSG   = P.confirmMessage || `此記錄將於儲存後自動產生${NUMBER_LABEL}，是否繼續？`;
    const SKIP_CONFIRM  = CONFIRM_MSG.trim() === '*'; // 填 * → 不彈確認視窗，儲存/推進後只跳出成功編號視窗
    const CATEGORIES    = Array.isArray(P.categories) ? P.categories : [];
    const CODE_MAPS     = Array.isArray(P.codeMaps) ? P.codeMaps : [];

    const ENABLED = !!(
      COUNTER_APP && NUMBER_FIELD && CATEGORY_FIELD && CATEGORIES.length &&
      (TARGET !== 'subtable' || SUBTABLE_CODE)
    );

    // ── 代碼對照表：把記錄上某個欄位的值轉成代碼，供 number_format 的自訂 token 使用 ──
    // 例：{ token:'level', field:'事故級別', pairs:[{from:'一般事故',to:'G'},{from:'重大事故',to:'M'}] }
    // → 記錄的事故級別＝「一般事故」時，number_format 內的 {level} 會被代換成 G。
    // 用途：號碼中「逐筆變動」的代碼（級別、部門…）無法寫死在計數器的 number_format，故由此動態解析。
    // ── 取值範圍（scope）──
    // scope = { record, row }。row 為子表格的一列（{ id, value: {...} }），可省略。
    // 查找順序：**先找子表格列內的欄位，找不到再找表頭欄位**。
    // 如此一來「設備種類在列內、設備需求在表頭」這種混合擺法也能運作，
    // 設定上不需要指定每個欄位到底在哪一層。
    const scopeOf = (record, row) => ({ record, row });

    const fieldIn = (scope, code) => {
      if (scope.row && scope.row.value && scope.row.value[code] !== undefined) {
        return scope.row.value[code];
      }
      return scope.record ? scope.record[code] : undefined;
    };

    const valueIn = (scope, code) => textOf(fieldIn(scope, code));

    const resolveCodeTokens = (scope) => {
      const out = {};
      CODE_MAPS.forEach((m) => {
        if (!m || !m.token || !m.field) return;
        const fv = fieldIn(scope, m.field);
        const hit = matchCodePair(m.pairs, valuesOf(fv));
        out[m.token] = { code: hit ? hit.to : '', field: m.field, raw: textOf(fv).trim() };
      });
      return out;
    };

    // ── 編號樣式樣板：token 套進 Counter App 的 number_format 欄位，後台改樣式免改 code ──
    // {prefix} 前綴 / {seq} 補零到 pad 位 / {seq:N} 補零到 N 位 / {period} 週期標記 /
    // {YYYY}{YY}{MM}{DD} 發號當下日期 / 其餘 {自訂token} 由代碼對照表提供。
    // number_format 留空 → 預設 {prefix}{seq}（向下相容）。
    const buildSerial = (template, opts) => {
      const now = new Date();
      const yyyy = String(now.getFullYear());
      const seq = opts.seq;
      const tpl = (template && template.trim()) || '{prefix}{seq}';
      let out = tpl
        .replace(/\{prefix\}/g, opts.prefix || '')
        .replace(/\{seq:(\d+)\}/g, (_, n) => String(seq).padStart(Number(n), '0'))
        .replace(/\{seq\}/g, String(seq).padStart(Number(opts.pad) || 0, '0'))
        .replace(/\{period\}/g, opts.period || '')
        .replace(/\{YYYY\}/g, yyyy)
        .replace(/\{YY\}/g, yyyy.slice(-2))
        .replace(/\{MM\}/g, pad2(now.getMonth() + 1))
        .replace(/\{DD\}/g, pad2(now.getDate()));

      // 自訂 token（代碼對照表）；內建 token 先代換完，故不會被自訂名稱蓋掉。
      // 只在樣板真的用到該 token 時才檢查，避免其他計數器的樣式受無關設定牽連。
      Object.keys(opts.codes || {}).forEach((name) => {
        const ph = `{${name}}`;
        if (out.indexOf(ph) === -1) return;
        const info = opts.codes[name];
        if (!info.code) {
          throw new Error(
            `「${fieldLabel(info.field)}」目前填的是「${info.raw}」，系統沒有對應的代號可用，無法產生${NUMBER_LABEL}。請聯繫系統管理員補設定。`
          );
        }
        out = out.split(ph).join(info.code);
      });
      return out;
    };

    // ── 計數器代碼樣板：{欄位代碼} → 記錄上該欄位的值 ──
    // 用途：當「要用哪一台計數器」取決於記錄上的多個欄位時，避免規則數量爆炸。
    // 例：設備代號依「設備種類 × 設備需求」分組，18 種類 × 2 需求 = 36 台計數器，
    //     但分類規則只需一條：counterKey = '{設備種類}新增' → 執行期解析成 'N1新增'。
    //
    // 與 codeMaps 的分工：
    //   counterKey 樣板 → 決定「用哪一台計數器」（影響序號分組）
    //   codeMaps       → 決定「號碼字串裡的可變代碼」（不影響分組）
    //
    // 欄位不存在或值為空時直接擲錯中止，不產生 'N1' 這種殘缺的 key 而誤取到別台計數器。
    const resolveKeyTemplate = (scope, tpl) =>
      tpl.replace(/\{([^{}]+)\}/g, (_, name) => {
        const code = String(name).trim();
        const fv = fieldIn(scope, code);
        if (fv === undefined) {
          throw new Error(`這張表單找不到「${fieldLabel(code)}」欄位，無法決定要產生哪一種${NUMBER_LABEL}。請聯繫系統管理員檢查設定。`);
        }
        const raw = textOf(fv).trim();
        if (!raw) {
          throw new Error(`請先填寫「${fieldLabel(code)}」，系統才能決定要產生哪一種${NUMBER_LABEL}。`);
        }
        return raw;
      });

    // ── 發號引擎：靠 Counter App 各筆記錄的 revision 樂觀鎖保證唯一 ──
    // codes：由 resolveCodeTokens(record) 產生的自訂 token 值，供 number_format 代換。
    //
    // count > 1 時為「批次預留」：一次把 current 推進 N，取得連續的 N 個號碼。
    // 子表格一次要發很多號時，若逐列各跑一次樂觀鎖，10 列就是 10 次 GET+PUT，
    // 慢且彼此 revision 互撞；改為一次預留整段，呼叫次數與列數脫鉤。
    //
    // 回傳發號所需的原料，由呼叫端逐一組出號碼字串（各列的 codes 可能不同）。
    //
    // codesList：這次要組號的各筆 codes。寫入計數器「之前」先用讀到的 number_format 試組一次，
    // 例如事故級別查無代碼時就在這裡中止——計數器還沒動，不會白白消耗一個號碼（跳號）。
    const reserveRange = async (categoryKey, count, codesList) => {
      const appId = getAppId();
      // category_key 可能來自樣板解析（含記錄上的欄位值），需跳脫雙引號避免查詢語法被破壞。
      const safeKey = String(categoryKey).replace(/"/g, '\\"');

      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        const queryParts = [
          `source_app_id = ${appId}`,
          `category_key in ("${safeKey}")`,
        ];
        if (ACTIVE_QUERY) queryParts.push(ACTIVE_QUERY);
        const _query = queryParts.join(' and ') + ' limit 1';
        const res = await apiWithToken('/k/v1/records.json', 'GET', {
          app: COUNTER_APP,
          query: _query,
        }, COUNTER_APP);

        if (!res.records || res.records.length === 0) {
          throw new Error(`系統尚未設定「${categoryKey}」這一種${NUMBER_LABEL}，請聯繫系統管理員新增後再試。`);
        }

        const r = res.records[0];
        const cycle  = r.reset_cycle ? r.reset_cycle.value : 'NONE';
        const nowTag = getPeriodTag(cycle);
        const lastTag = r.period_tag ? (r.period_tag.value || '') : '';
        // 跨週期 → 從 1 重算；同週期 → current + 1
        const start = nowTag !== lastTag ? 1 : Number(r.current.value) + 1;
        // 一次預留 count 個號：current 直接推進到整段的最後一號
        const end = start + count - 1;

        const range = {
          start,
          count,
          numberFormat: r.number_format ? r.number_format.value : '',
          prefix: r.prefix ? (r.prefix.value || '') : '',
          pad: r.pad ? r.pad.value : 0,
          period: nowTag,
        };
        (codesList || []).forEach((codes) => {
          buildSerial(range.numberFormat, Object.assign({}, range, { seq: start, codes: codes || {} }));
        });

        try {
          await apiWithToken('/k/v1/record.json', 'PUT', {
            app: COUNTER_APP,
            id: r.$id.value,
            revision: r.$revision.value, // 樂觀鎖：revision 不符會被擋下
            record: {
              current:        { value: String(end) },
              period_tag:     { value: nowTag },
              last_issued_at: { value: new Date().toISOString() },
            },
          }, COUNTER_APP);

          return range;
        } catch (e) {
          if (errorCodeOf(e) === 'GAIA_CO02') continue; // revision 衝突 → 重新讀取重試
          throw e;
        }
      }
      throw new Error(`目前同時使用的人較多，${NUMBER_LABEL}暫時產生不出來，請稍等一下再儲存一次。`);
    };

    /** 單筆發號（一般欄位模式）：預留 1 個號並組出字串。 */
    const issueSerial = async (categoryKey, codes) => {
      const rg = await reserveRange(categoryKey, 1, [codes]);
      // 依 Counter App 該筆「編號樣式」組出最終編號（樣式由後台維護，免改 code）
      return buildSerial(rg.numberFormat, {
        prefix: rg.prefix,
        seq: rg.start,
        pad: rg.pad,
        period: rg.period,
        codes: codes || {},
      }); // 預設 {prefix}{seq} → GO000001；改 {prefix}-{seq:3} → GO-001
    };

    // ── 依分類決定最終編號 ──
    // 比對順序：先找完全相同的分類值，找不到才退到萬用規則（match === '*'）。
    // 萬用規則刻意要求分類值非空——分類還沒選就發號沒有意義，也避免誤觸。
    const matchCategory = (scope) => {
      const catVal = valueIn(scope, CATEGORY_FIELD);
      const exact = CATEGORIES.find((c) => c && c.match === catVal);
      if (exact) return exact;
      if (!catVal) return null;
      return CATEGORIES.find((c) => c && c.match === '*') || null;
    };

    /** 解析出這筆（或這列）要用哪一台計數器；copy 模式不需要計數器故回傳 null。 */
    const resolveCounterKey = (scope, cat) => {
      // 發號：以「計數器代碼」查 Counter App；留空時沿用分類選項值（向下相容）。
      // 設定 counterKey 可讓多個分類值共用同一台計數器（如兩種物損事故共用 CA，序號連續不重複）。
      let counterKey = (cat.counterKey || '').trim() || cat.match;

      // 萬用規則若沒有指定 counterKey，'*' 不是有效的計數器代碼，明確擋下並提示。
      if (counterKey === '*') {
        throw new Error(`${NUMBER_LABEL}的設定不完整（萬用規則缺少代碼），請聯繫系統管理員。`);
      }

      // counterKey 含 {欄位代碼} → 依當筆記錄／當列解析（見 resolveKeyTemplate）。
      if (counterKey.indexOf('{') !== -1) {
        counterKey = resolveKeyTemplate(scope, counterKey);
      }
      return counterKey;
    };

    /** copy 模式：旁路抄錄既有欄位（如國內供應商的統一編號），不經過 Counter App。 */
    const resolveCopy = (scope, cat) => {
      const src = fieldIn(scope, cat.copyField);
      const v = textOf(src).trim();
      if (cat.validate === 'taxId8' && !/^\d{8}$/.test(v)) {
        throw new Error(`「${fieldLabel(cat.copyField)}」須為 8 碼數字（目前值：「${v}」）`);
      }
      if (!v) throw new Error(`請先填寫「${fieldLabel(cat.copyField)}」，才能產生${NUMBER_LABEL}。`);
      return v;
    };

    const resolveSerial = async (record, cat) => {
      const scope = scopeOf(record);
      if (cat.mode === 'copy') return resolveCopy(scope, cat);
      return issueSerial(resolveCounterKey(scope, cat), resolveCodeTokens(scope));
    };

    // ── 子表格模式：一列一號 ──────────────────────────────────────────────
    //
    // 流程刻意分成「規劃」與「取號」兩段：
    //   規劃階段把所有列的計數器代碼、抄錄值都先解析完，任何一列有問題就整批中止；
    //   確定全部沒問題才開始向計數器取號。
    // 這樣就不會發生「前三列已經消耗了號碼、第四列才發現欄位沒填」而白白跳號。

    const subtableRows = (record) => {
      const t = record[SUBTABLE_CODE];
      return t && Array.isArray(t.value) ? t.value : [];
    };

    const rowHasNumber = (row) => {
      const f = row.value ? row.value[NUMBER_FIELD] : null;
      return !!(f && f.value != null && String(f.value) !== '');
    };

    /**
     * 規劃：找出所有「需要發號」的列，並解析出各自要用哪台計數器。
     * @returns {{ index:number, row:object, cat:object, counterKey:string, codes:object, copyValue:string }[]}
     */
    const planSubtable = (record) => {
      const plan = [];

      subtableRows(record).forEach((row, index) => {
        if (rowHasNumber(row)) return; // 已有編號的列不重發
        const scope = scopeOf(record, row);
        const cat = matchCategory(scope);
        if (!cat) return; // 該列的分類沒有對應規則 → 不發號

        if (cat.mode === 'copy') {
          plan.push({ index, row, cat, copyValue: resolveCopy(scope, cat) });
        } else {
          plan.push({
            index,
            row,
            cat,
            counterKey: resolveCounterKey(scope, cat),
            codes: resolveCodeTokens(scope),
          });
        }
      });

      return plan;
    };

    /**
     * 取號：把待發號的列依計數器代碼分組，每組只做一次樂觀鎖預留整段連號。
     * @returns {Map<number, string>} 列索引 → 編號
     */
    const issueForPlan = async (plan, onProgress) => {
      const serials = new Map();
      const report = typeof onProgress === 'function' ? onProgress : () => {};

      // copy 模式不經計數器，直接落值
      plan.filter((p) => p.cat.mode === 'copy').forEach((p) => serials.set(p.index, p.copyValue));

      // 發號模式：依 counterKey 分組
      const groups = new Map();
      plan
        .filter((p) => p.cat.mode !== 'copy')
        .forEach((p) => {
          if (!groups.has(p.counterKey)) groups.set(p.counterKey, []);
          groups.get(p.counterKey).push(p);
        });

      report(`表格共 ${plan.length} 列要產生${NUMBER_LABEL}`, serials.size, plan.length);

      let groupNo = 0;
      for (const [, items] of groups) {
        groupNo++;
        // 只講進度，不提 counterKey——那是給系統對照用的內部代碼，使用者看了只會困惑
        report(
          groups.size > 1
            ? `正在產生${NUMBER_LABEL}…（第 ${groupNo} 種，共 ${groups.size} 種）`
            : `正在產生${NUMBER_LABEL}…`,
          serials.size,
          plan.length
        );
        const counterKey = items[0].counterKey;
        const rg = await reserveRange(counterKey, items.length, items.map((p) => p.codes));
        // 依子表格的列順序配號，讓號碼與表上的順序一致
        items.forEach((p, i) => {
          serials.set(
            p.index,
            buildSerial(rg.numberFormat, {
              prefix: rg.prefix,
              seq: rg.start + i,
              pad: rg.pad,
              period: rg.period,
              codes: p.codes || {},
            })
          );
        });
        report(`已完成 ${serials.size} 列`, serials.size, plan.length);
      }

      return serials;
    };

    /**
     * 把編號寫回子表格。
     * ⚠ kintone 的子表格是「整包覆蓋」：PUT 時必須送出**所有列並帶上原本的 id**，
     *   否則沒送到的列會被刪除、有送但沒 id 的列會被當成新列重建（既有資料連帶遺失）。
     */
    const writeBackSubtable = async (recordId, record, serials) => {
      const rows = subtableRows(record).map((row) => ({
        id: row.id,
        value: Object.assign({}, row.value),
      }));

      serials.forEach((serial, index) => {
        if (!rows[index]) return;
        rows[index].value[NUMBER_FIELD] = { value: serial };
      });

      const appId = getAppId();
      await apiWithToken('/k/v1/record.json', 'PUT', {
        app: appId,
        id: recordId,
        record: { [SUBTABLE_CODE]: { value: rows } },
      }, appId);
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

    /** 這筆記錄現在有沒有東西要發號？（子表格模式＝有沒有待發號的列） */
    const nothingToIssue = (record) =>
      IS_SUBTABLE ? planSubtable(record).length === 0 : alreadyNumbered(record) || !matchCategory(scopeOf(record));

    /**
     * 儲存成功後發號並回寫（create/edit.submit.success）。
     * 錯誤不往外拋：同一次儲存的其他號碼組仍要繼續處理，結果統一由呼叫端彙整顯示。
     * @returns {{ label, serials?:string[], error?:string } | null}  null＝這組不需要發號
     */
    const issueOnSaved = async (record, recordId) => {
      if (IS_SUBTABLE) return issueOnSavedSubtable(recordId);

      const cat = matchCategory(scopeOf(record));
      if (!cat) return null;
      try {
        const serial = await resolveSerial(record, cat);
        const appId = getAppId();
        await apiWithToken('/k/v1/record.json', 'PUT', {
          app: appId, id: recordId, record: { [NUMBER_FIELD]: { value: serial } },
        }, appId);
        return { label: NUMBER_LABEL, serials: [serial] };
      } catch (e) {
        console.error(`[anum] 第 ${profileIndex + 1} 組（${NUMBER_LABEL}）發號/回寫失敗`, e);
        return { label: NUMBER_LABEL, error: friendlyError(e, `產生${NUMBER_LABEL}時發生問題`) };
      }
    };

    // 子表格模式的 submit.success：
    // event.record 的子表格列在「新增」時不一定帶得到 id，而回寫子表格**必須帶 id**，
    // 否則整個子表格會被重建。因此改為重新讀一次剛存好的記錄，以它為準。
    // （多組號碼時，前一組的回寫也已經在這次重讀的結果裡，不會被覆蓋掉。）
    const issueOnSavedSubtable = async (recordId) => {
      let showing = false;
      try {
        const appId = getAppId();
        const fresh = await apiWithToken('/k/v1/record.json', 'GET', {
          app: appId, id: recordId,
        }, appId);
        const saved = fresh.record;

        const plan = planSubtable(saved);
        if (plan.length === 0) return null;

        showing = plan.length >= PROGRESS_MIN_ROWS;
        if (showing) uiProgress.open(`正在產生${NUMBER_LABEL}`);

        const serials = await issueForPlan(plan, showing ? uiProgress.update : null);

        if (showing) uiProgress.update('正在寫入表格…', serials.size, plan.length);
        await writeBackSubtable(recordId, saved, serials);
        if (showing) await uiProgress.finish('全部完成！');

        return { label: NUMBER_LABEL, serials: [...serials.values()], perRow: true };
      } catch (e) {
        console.error(`[anum] 第 ${profileIndex + 1} 組（${NUMBER_LABEL}）子表格發號/回寫失敗`, e);
        if (showing) uiProgress.close();
        return { label: NUMBER_LABEL, error: friendlyError(e, `產生${NUMBER_LABEL}時發生問題`) };
      }
    };

    /**
     * 流程推進（process.proceed）：沒有 success 事件，號碼直接寫進 event.record，
     * 隨流程推進一併原子儲存（不另發 PUT，子表格也就不需要列的 id）。
     * 失敗時拋出錯誤，由呼叫端設定 event.error 阻擋推進。
     */
    const issueIntoRecord = async (record) => {
      if (IS_SUBTABLE) {
        let showing = false;
        try {
          const plan = planSubtable(record);
          if (plan.length === 0) return null;
          showing = plan.length >= PROGRESS_MIN_ROWS;
          if (showing) uiProgress.open(`正在產生${NUMBER_LABEL}`);

          const serials = await issueForPlan(plan, showing ? uiProgress.update : null);
          const rows = subtableRows(record);
          serials.forEach((serial, index) => {
            if (rows[index] && rows[index].value[NUMBER_FIELD]) {
              rows[index].value[NUMBER_FIELD].value = serial;
            }
          });
          if (showing) await uiProgress.finish('全部完成！');
          return { label: NUMBER_LABEL, serials: [...serials.values()], perRow: true };
        } catch (e) {
          if (showing) uiProgress.close();
          throw e;
        }
      }

      const cat = matchCategory(scopeOf(record));
      if (!cat) return null;
      if (!record[NUMBER_FIELD]) {
        throw new Error(`這張表單找不到存放${NUMBER_LABEL}的欄位（${fieldLabel(NUMBER_FIELD)}），請聯繫系統管理員。`);
      }
      const serial = await resolveSerial(record, cat);
      record[NUMBER_FIELD].value = serial;
      return { label: NUMBER_LABEL, serials: [serial] };
    };

    return {
      index: profileIndex,
      enabled: ENABLED,
      label: NUMBER_LABEL,
      confirmMessage: CONFIRM_MSG,
      skipConfirm: SKIP_CONFIRM,
      // 這組在此事件需不需要發號（已有號碼、分類無對應規則、狀態不符 → 不需要）
      dueOnSubmit: (trigger, record) =>
        TRIGGERS.includes(trigger) &&
        (trigger !== 'edit.submit' || statusOkOnSubmit(record)) &&
        !nothingToIssue(record),
      dueOnProceed: (event) =>
        TRIGGERS.includes('process.proceed') &&
        statusOkOnProceed(event) &&
        !nothingToIssue(event.record),
      issueOnSaved,
      issueIntoRecord,
    };
  };


  // ════════════════════════════════════════════════════════════════════════
  // 事件編排：每個事件只註冊一個 handler，依設定順序逐組處理。
  // 不讓每組各自註冊 handler —— kintone 同一事件的多個 async handler 會並行觸發，
  // 會疊出多個確認／結果視窗，也可能同時回寫同一筆記錄。
  // ════════════════════════════════════════════════════════════════════════
  const PROFILES = RAW_PROFILES
    .map((p, i) => makeProfile(p || {}, i))
    .filter((p) => p.enabled);

  const listText = (list) =>
    list.length <= 10 ? list.join('、') : `${list.slice(0, 10).join('、')} …等 ${list.length} 個`;

  const labelsOf = (profiles) => profiles.map((p) => p.label).join('、');

  // 多組同時要發號時只問一次；各組的確認訊息去重後合併，全部填 * 則不詢問
  const confirmFor = async (due) => {
    const msgs = [...new Set(due.filter((p) => !p.skipConfirm).map((p) => p.confirmMessage))];
    if (!msgs.length) return true;
    return uiConfirm(`產生${labelsOf(due)}`, msgs.join('\n'));
  };

  // 彙整各組結果成一個視窗（單組時與 v1.5.0 的訊息完全相同）
  const resultLine = (r) => {
    if (r.error) return `${r.label}：${r.error}`;
    return r.perRow
      ? `${r.label}：已產生 ${r.serials.length} 個（${listText(r.serials)}）`
      : `${r.label}：${r.serials[0]}`;
  };

  const reportResults = async (results) => {
    const list = results.filter(Boolean);
    if (!list.length) { uiLoading.close(); return; }
    const failed = list.filter((r) => r.error);

    if (list.length === 1) {
      const r = list[0];
      if (r.error) return uiToast('error', `${r.label}產生失敗`, r.error);
      if (r.perRow) return uiToast('success', `已產生 ${r.serials.length} 個${r.label}`, listText(r.serials));
      return uiToast('success', `${r.label}已產生`, r.serials[0]);
    }

    if (!failed.length) return uiToast('success', '編號已產生', '', list.map(resultLine));
    return uiToast(
      failed.length === list.length ? 'error' : 'warning',
      failed.length === list.length ? '編號產生失敗' : '部分編號產生失敗',
      '',
      list.map(resultLine)
    );
  };

  // ── 流程 1：儲存（create/edit）── 提交前確認，提交成功後發號回寫
  let _pending = []; // 待 submit.success 發號的號碼組

  const onSubmit = (trigger) => async (event) => {
    _pending = [];
    const record = event.record;
    if (!record) return event;

    await loadFieldLabels();
    const due = PROFILES.filter((p) => p.dueOnSubmit(trigger, record));
    if (!due.length) return event;

    // 使用者自己按了取消、已知道原因，紅條只放短句，不再另跳視窗
    const ok = await confirmFor(due);
    if (!ok) { event.error = '已取消儲存'; return event; }

    _pending = due;
    // 一觸發就顯示處理中，存檔與發號期間不留空白；submit.success 接手後換成結果視窗
    uiLoading.open(`正在產生${labelsOf(due)}`, '正在儲存並取得號碼，請稍候…', SAVE_WAIT_MS);
    return event;
  };

  const onSubmitSuccess = () => async (event) => {
    if (!_pending.length) return event;
    const due = _pending;
    _pending = [];
    uiLoading.hold();

    const record = event.record;
    const recordId = event.recordId || (record.$id && record.$id.value);
    if (!recordId) { uiLoading.close(); return event; }

    // 逐組依序處理（不並行），後一組的子表格重讀才看得到前一組的回寫
    const results = [];
    for (const p of due) results.push(await p.issueOnSaved(record, recordId));
    await reportResults(results);
    // 不手動導頁：序號已寫入 DB（上面已 await），kintone 在 submit.success 後會自行
    // 由編輯表單轉到詳細頁並重新讀取記錄，屆時即顯示新編號。手動導頁反而會觸發
    // 「未儲存變更」原生警告，或停在 hash 路由不重抓資料（需手動重整）。
    return event;
  };

  // ── 流程 2：流程推進（process.proceed）── 無 success 事件，發號後直接寫入 event.record 一起原子儲存
  const onProceed = async (event) => {
    const record = event.record;
    if (!record) return event;

    await loadFieldLabels();
    const due = PROFILES.filter((p) => p.dueOnProceed(event));
    if (!due.length) return event;

    const ok = await confirmFor(due);
    if (!ok) { event.error = '已取消，未推進流程'; return event; }

    uiLoading.open(`正在產生${labelsOf(due)}`, '正在取得號碼，請稍候…');

    const results = [];
    for (const p of due) {
      try {
        results.push(await p.issueIntoRecord(record));
      } catch (e) {
        console.error(`[anum] 第 ${p.index + 1} 組（${p.label}）發號失敗`, e);
        return blockEvent(event, `${p.label}產生失敗`, errorText(e)); // 任一組失敗就整個不推進，避免只存到一半的號碼
      }
    }
    // 此時 record 尚未實際寫入 DB（由 kintone 隨流程推進一併儲存），但編號已確定，可提前告知。
    await reportResults(results);
    return event;
  };

  // ── 事件註冊（桌面 + 行動共用）──
  const E = (names) => names.flatMap((n) => [`app.record.${n}`, `mobile.app.record.${n}`]);

  const guard = (fn) => async (event) => {
    try { return await fn(event); }
    catch (err) {
      console.error('[anum]', err);
      uiLoading.close();
      if (event && event.type && /submit|process/.test(event.type)) {
        return blockEvent(event, '編號產生失敗', errorText(err));
      }
      return event;
    }
  };

  if (!PROFILES.length) return;

  loadFieldLabels();

  kintone.events.on(E(['create.submit']), guard(onSubmit('create.submit')));
  kintone.events.on(E(['edit.submit']),   guard(onSubmit('edit.submit')));
  kintone.events.on(E(['create.submit.success']), guard(onSubmitSuccess()));
  kintone.events.on(E(['edit.submit.success']),   guard(onSubmitSuccess()));
  kintone.events.on(E(['detail.process.proceed']), guard(onProceed));

})();
