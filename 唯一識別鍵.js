(() => {
  'use strict';

  const CONFIG = {
    APP_ID_FIELD: 'source_app_id', // 欄位代碼：適用 App ID
    KEY_FIELD: 'category_key',     // 欄位代碼：編號類別代碼
    UNIQUE_FIELD: 'unique_key',    // 欄位代碼：唯一識別鍵
  };

  // 儲存前自動產生唯一識別鍵，並寫入對應欄位
  kintone.events.on(['app.record.create.submit', 'app.record.edit.submit'], (event) => {
    const record = event.record;
    const appId = record[CONFIG.APP_ID_FIELD].value;
    const key = record[CONFIG.KEY_FIELD].value;

    // 驗證必要欄位：兩者皆須填寫，方可產生識別鍵
    if (!appId || !key) {
      event.error = '「適用 App ID」與「編號類別代碼」皆為必填，無法產生唯一識別鍵';
      return event;
    }

    // 依格式 {App ID}_{類別代碼} 組合後寫入唯一識別鍵欄位，例如：685_OVERSEAS
    record[CONFIG.UNIQUE_FIELD].value = `${appId}_${key}`;
    return event;
  });
})();
