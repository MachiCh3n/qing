# 慶壽喜燒候位系統

此專案包含消費者取號頁、店員管理後台、JSON API、候位資料保存，以及入席前五分鐘的免費 Web Push、系統通知音、震動與點開後網頁語音播報。

## 正式服務

- 消費者頁：`https://machich3n.github.io/qing/`
- 管理後台：`https://machich3n.github.io/qing/admin`
- 共用資料：Cloudflare Worker 與 D1 雲端資料庫

前台與後台會透過 `config.js` 連到同一個雲端 API，因此不同裝置會看到相同的候位資料。

叫號後席位保留 10 分鐘；第一次逾時會自動標記為「已過號」並將順位延後 3 位，顧客前台會保留過號畫面。再次叫號後仍逾時，系統才會自動取消該號碼。

## Web Push 設定

五分鐘提醒使用瀏覽器標準 Web Push，不需串接每則計費的簡訊或通知供應商。Worker 需要：

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`（例如 `mailto:service@example.com`）
- `PUBLIC_SITE_URL`（正式候位頁網址）

公鑰亦設定於 `config.js`，供瀏覽器建立訂閱。私鑰只能存在 Worker 的加密環境變數，不可提交至版本庫。

Android 與桌面瀏覽器可直接允許通知；iPhone/iPad 需先以 Safari 將網站「加入主畫面」，再從主畫面開啟並允許通知。系統通知音與震動仍受手機靜音、勿擾及通知設定控制。

叫號簡訊仍可選擇性設定 Twilio 或自有簡訊 Webhook：

- `TWILIO_ACCOUNT_SID`、`TWILIO_AUTH_TOKEN`、`TWILIO_FROM`
- 或 `SMS_WEBHOOK_URL`、`SMS_WEBHOOK_TOKEN`

## JSON API

- `POST /api/queue`：新增候位
- `GET /api/queue/:id`：查詢候位進度
- `DELETE /api/queue/:id`：取消候位
- `POST /api/queue/:id/push-subscription`：綁定此裝置的 Web Push 訂閱
- `GET /api/admin/queue`：取得後台候位名單
- `PATCH /api/admin/settings`：調整預設等候時間與目前叫號
- `PATCH /api/admin/queue/:id`：調整單筆等候時間
- `POST /api/admin/queue/:id/remind`：立即發送提醒
- `POST /api/admin/queue/:id/call`：叫號並發送入席通知
- `POST /api/admin/queue/:id/complete`：標記已入席
- `POST /api/admin/queue/:id/cancel`：由後台取消等候中、保留中或已過號的號碼

所有 `/api/admin/*` 請求都必須帶上 `X-Admin-Key` 標頭。
