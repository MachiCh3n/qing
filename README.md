# 慶壽喜燒候位系統

此專案包含消費者取號頁、店員管理後台、JSON API、候位資料保存與入席前五分鐘簡訊排程。

## 啟動

需要 Node.js 20 以上版本。

```bash
ADMIN_KEY='請換成安全密碼' npm start
```

- 消費者頁：`http://127.0.0.1:8000/`
- 管理後台：`http://127.0.0.1:8000/admin`
- 健康檢查：`GET /api/health`

若未設定 `ADMIN_KEY`，本機預設密碼為 `qing-admin`。正式上線前務必更換。

## GitHub Pages 注意事項

GitHub Pages 只能發布 HTML、CSS、JavaScript 等靜態檔案，不能執行 `server.js`，因此單獨上傳 GitHub Pages 時，後台登入、JSON API、資料保存與簡訊排程都不會運作。

若前台保留在 GitHub Pages，請另行部署 Node.js 後端，並修改 `config.js`：

```js
window.QING_API_BASE = "https://你的後端網址/api";
```

後端啟動時也要把 GitHub Pages 網址加入允許來源：

```bash
CORS_ORIGIN='https://你的帳號.github.io' ADMIN_KEY='安全密碼' npm start
```

`CORS_ORIGIN` 可用逗號分隔多個允許的前台網址。正式環境不建議設定為 `*`。

## 簡訊設定

可選擇 Twilio 或自有簡訊 Webhook。將 `.env.example` 內對應值設定為系統環境變數後再啟動。

Twilio 需要：

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM`

自有簡訊服務需要：

- `SMS_WEBHOOK_URL`
- `SMS_WEBHOOK_TOKEN`（若供應商需要）

Webhook 會收到：

```json
{
  "to": "0912345678",
  "message": "慶壽喜燒提醒：您的候位號碼 A001，預計約 5 分鐘後可入席，請前往餐廳櫃台報到。",
  "ticketId": "候位識別碼",
  "number": "A001",
  "event": "five-minute-reminder"
}
```

未設定簡訊供應商時，系統會使用測試模式，將訊息寫入 `data/sms-log.json`，方便先驗收完整流程。

## JSON API

- `POST /api/queue`：新增候位
- `GET /api/queue/:id`：查詢候位進度
- `DELETE /api/queue/:id`：取消候位
- `GET /api/admin/queue`：取得後台候位名單
- `PATCH /api/admin/settings`：調整預設等候時間與目前叫號
- `PATCH /api/admin/queue/:id`：調整單筆等候時間
- `POST /api/admin/queue/:id/remind`：立即發送提醒
- `POST /api/admin/queue/:id/call`：叫號並發送入席通知
- `POST /api/admin/queue/:id/complete`：標記已入席

所有 `/api/admin/*` 請求都必須帶上 `X-Admin-Key` 標頭。
