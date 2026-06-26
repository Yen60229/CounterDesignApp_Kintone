(() => {
  'use strict';

  const CONFIG = {
    APP_ID_FIELD: 'source_app_id', // 適用 App ID 欄位代碼
    KEY_FIELD: 'category_key', // 編號類別代碼 欄位代碼
    UNIQUE_FIELD: 'unique_key', // 唯一識別鍵 欄位代碼
  };

  // 在儲存前(submit)自動組出唯一識別鍵
  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {
    const record = event.record;
    const appId = record[CONFIG.APP_ID_FIELD].value;
    const key = record[CONFIG.KEY_FIELD].value;

    // 必填檢查:缺一不可組鍵
    if (!appId || !key) {
      event.error = '「適用 App ID」與「編號類別代碼」皆為必填,無法產生唯一識別鍵';
      return event;
    }

    // 組成 685_OVERSEAS 格式並寫回
    record[CONFIG.UNIQUE_FIELD].value = `${appId}_${key}`;
    return event;
  });
})();
