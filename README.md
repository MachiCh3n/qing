# 慶壽喜燒候位系統

此專案包含消費者取號頁、店員管理後台、JSON API、候位資料保存與入席前五分鐘簡訊排程。

## 正式服務

- 消費者頁：`https://machich3n.github.io/qing/`
- 管理後台：`https://machich3n.github.io/qing/admin`
- 共用資料：Sites Worker 與 D1 雲端資料庫

前台與後台會透過 `config.js` 連到同一個雲端 API，因此不同裝置會看到相同的候位資料。

## 簡訊設定

可選擇 Twilio 或自有簡訊 Webhook，並將 `.env.example` 內對應值設定到 Sites 執行環境。

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

未設定簡訊供應商時，系統會使用測試模式，將提醒紀錄保存在雲端資料庫，但不會發送真實簡訊。

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
