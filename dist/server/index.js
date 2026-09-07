const REMINDER_MINUTES = 5;
const SEAT_HOLD_MINUTES = 10;
const STORE_NAME = "慶壽喜燒";
const DEFAULT_SETTINGS = {
  storeId: "qing-linkou",
  defaultWaitMinutes: 25,
  avgMinutesPerGroup: 5,
  currentNumber: "A000",
  reminderMinutes: REMINDER_MINUTES
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.CORS_ORIGIN || "https://machich3n.github.io").split(",").map(value => value.trim());
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  };
  if (origin && (allowed.includes("*") || allowed.includes(origin))) {
    headers["Access-Control-Allow-Origin"] = allowed.includes("*") ? "*" : origin;
    headers.Vary = "Origin";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Admin-Key";
    headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function json(request, env, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(request, env) });
}

function fail(request, env, status, message) { return json(request, env, { message }, status); }

async function readBody(request) {
  try { return await request.json(); }
  catch { throw new Error("JSON 格式錯誤"); }
}

function cleanPhone(value) { return String(value || "").replace(/\D/g, ""); }
function validPhone(value) { return /^09\d{8}$/.test(value); }
function validNumber(value) { return /^[A-Z]\d{3,4}$/.test(String(value || "").toUpperCase()); }
function validPushEndpoint(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return new URL(value).protocol === "https:" && (
      hostname === "fcm.googleapis.com" ||
      hostname === "web.push.apple.com" ||
      hostname === "updates.push.services.mozilla.com" ||
      hostname.endsWith(".notify.windows.com")
    );
  } catch { return false; }
}
function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function fiveMinuteValue(value, min, max, fallback) {
  const number = Number(value);
  const normalized = Number.isFinite(number) ? Math.round(number / 5) * 5 : fallback;
  return Math.max(min, Math.min(max, normalized));
}

function settingsFromRows(rows = [], effectiveCurrentNumber = "") {
  const stored = Object.fromEntries(rows.map(row => [row.key, row.value]));
  return {
    ...DEFAULT_SETTINGS,
    defaultWaitMinutes: fiveMinuteValue(stored.defaultWaitMinutes, 0, 600, DEFAULT_SETTINGS.defaultWaitMinutes),
    avgMinutesPerGroup: fiveMinuteValue(stored.avgMinutesPerGroup, 5, 120, DEFAULT_SETTINGS.avgMinutesPerGroup),
    currentNumber: effectiveCurrentNumber || stored.currentNumber || DEFAULT_SETTINGS.currentNumber
  };
}

function countdownMinutes(estimatedEntryAt, fallback = 0, now = Date.now()) {
  const target = new Date(estimatedEntryAt).getTime();
  if (!Number.isFinite(target)) return Number(fallback || 0);
  return Math.max(0, Math.ceil((target - now) / 60_000));
}

function effectiveCurrentNumberStatement(env, day = dateKey()) {
  return env.DB.prepare(`
    SELECT COALESCE(
      (SELECT number FROM tickets WHERE date_key = ? AND status = 'called' ORDER BY called_at DESC LIMIT 1),
      (SELECT number FROM tickets WHERE date_key = ? AND number = (SELECT value FROM settings WHERE key = 'currentNumber') AND status IN ('waiting', 'missed') LIMIT 1),
      (SELECT number FROM tickets WHERE date_key = ? AND status IN ('waiting', 'missed') ORDER BY queue_order, joined_at LIMIT 1),
      (SELECT value FROM settings WHERE key = 'currentNumber'),
      ?
    ) AS number
  `).bind(day, day, day, DEFAULT_SETTINGS.currentNumber);
}

async function getSettings(env) {
  const [settingsResult, currentResult] = await env.DB.batch([
    env.DB.prepare("SELECT key, value FROM settings"),
    effectiveCurrentNumberStatement(env)
  ]);
  return settingsFromRows(settingsResult.results || [], currentResult.results?.[0]?.number);
}

function rowToTicket(row) {
  const status = row.status;
  const estimatedMinutes = ["waiting", "missed"].includes(status)
    ? countdownMinutes(row.estimated_entry_at, row.estimated_minutes)
    : Number(row.estimated_minutes || 0);
  return {
    id: row.id, dateKey: row.date_key, number: row.number, storeId: row.store_id, name: row.name, phone: row.phone,
    status, queueOrder: Number(row.queue_order || 0), missedCount: Number(row.missed_count || 0),
    currentNumber: row.current_number, ahead: row.ahead, estimatedMinutes,
    estimatedEntryAt: row.estimated_entry_at, joinedAt: row.joined_at, updatedAt: row.updated_at, calledAt: row.called_at,
    missedAt: row.missed_at, seatedAt: row.seated_at, cancelledAt: row.cancelled_at, reminderSentAt: row.reminder_sent_at,
    reminderProvider: row.reminder_provider, reminderProviderId: row.reminder_provider_id, reminderError: row.reminder_error,
    callMessageSentAt: row.call_message_sent_at, callMessageProvider: row.call_message_provider, callMessageError: row.call_message_error
  };
}

async function getTicket(env, id) {
  const row = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
  return row ? rowToTicket(row) : null;
}

function toPublicTicket(ticket, currentNumber, aheadValue) {
  const queued = ticket.status === "waiting" || ticket.status === "missed";
  const { phone, reminderError, ...safe } = ticket;
  const ahead = queued ? Number(aheadValue || 0) : 0;
  return { ...safe, ahead, queuePosition: queued ? ahead + 1 : null, currentNumber };
}

async function getPublicTicket(env, id) {
  const row = await env.DB.prepare(`
    SELECT t.*,
      COALESCE(
        (SELECT number FROM tickets WHERE date_key = t.date_key AND status = 'called' ORDER BY called_at DESC LIMIT 1),
        (SELECT number FROM tickets WHERE date_key = t.date_key AND number = (SELECT value FROM settings WHERE key = 'currentNumber') AND status IN ('waiting', 'missed') LIMIT 1),
        (SELECT number FROM tickets WHERE date_key = t.date_key AND status IN ('waiting', 'missed') ORDER BY queue_order, joined_at LIMIT 1),
        (SELECT value FROM settings WHERE key = 'currentNumber'),
        ?
      ) AS live_current_number,
      CASE WHEN t.status IN ('waiting', 'missed') THEN (
        SELECT COUNT(*) FROM tickets q
        WHERE q.status IN ('waiting', 'missed')
          AND (q.queue_order < t.queue_order OR (q.queue_order = t.queue_order AND q.joined_at < t.joined_at))
      ) ELSE 0 END AS live_ahead
    FROM tickets t WHERE t.id = ?
  `).bind(DEFAULT_SETTINGS.currentNumber, id).first();
  if (!row) return null;
  return toPublicTicket(rowToTicket(row), row.live_current_number, row.live_ahead);
}

async function isAdmin(request, env) {
  const expected = String(env.ADMIN_KEY || "");
  const actual = String(request.headers.get("X-Admin-Key") || "");
  if (!expected) return false;
  const encoder = new TextEncoder();
  const [expectedHash, actualHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual))
  ]);
  return crypto.subtle.timingSafeEqual(expectedHash, actualHash);
}

const textEncoder = new TextEncoder();

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), character => character.charCodeAt(0));
}

function toBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function joinBytes(...parts) {
  const bytes = parts.map(part => part instanceof Uint8Array ? part : new Uint8Array(part));
  const joined = new Uint8Array(bytes.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of bytes) { joined.set(part, offset); offset += part.length; }
  return joined;
}

async function hmacSha256(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function hkdf(salt, inputKeyMaterial, info, length) {
  const pseudoRandomKey = await hmacSha256(salt, inputKeyMaterial);
  const output = await hmacSha256(pseudoRandomKey, joinBytes(info, new Uint8Array([1])));
  return output.slice(0, length);
}

async function encryptPushPayload(subscription, payload) {
  const clientPublicKey = fromBase64Url(subscription.p256dh);
  const authSecret = fromBase64Url(subscription.auth);
  if (clientPublicKey.length !== 65 || authSecret.length !== 16) throw new Error("推播訂閱金鑰格式錯誤");

  const serverKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const clientKey = await crypto.subtle.importKey("raw", clientPublicKey, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const sharedSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, serverKeys.privateKey, 256));
  const serverPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", serverKeys.publicKey));
  const inputKeyMaterial = await hkdf(authSecret, sharedSecret, joinBytes(textEncoder.encode("WebPush: info\0"), clientPublicKey, serverPublicKey), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentEncryptionKey = await hkdf(salt, inputKeyMaterial, textEncoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, inputKeyMaterial, textEncoder.encode("Content-Encoding: nonce\0"), 12);
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = joinBytes(textEncoder.encode(JSON.stringify(payload)), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext));
  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return joinBytes(salt, recordSize, new Uint8Array([serverPublicKey.length]), serverPublicKey, ciphertext);
}

async function createVapidToken(endpoint, env) {
  const publicKey = fromBase64Url(env.VAPID_PUBLIC_KEY);
  const privateKey = String(env.VAPID_PRIVATE_KEY || "");
  if (publicKey.length !== 65 || privateKey.length < 40) throw new Error("Web Push 尚未完成金鑰設定");
  const key = await crypto.subtle.importKey("jwk", {
    kty: "EC", crv: "P-256", x: toBase64Url(publicKey.slice(1, 33)), y: toBase64Url(publicKey.slice(33)), d: privateKey, ext: true
  }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = toBase64Url(textEncoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = toBase64Url(textEncoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 43_200,
    sub: String(env.VAPID_SUBJECT || "mailto:pcc1005@gmail.com")
  })));
  const unsignedToken = `${header}.${claims}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, textEncoder.encode(unsignedToken));
  return `${unsignedToken}.${toBase64Url(signature)}`;
}

async function sendWebPush(env, subscription, payload) {
  const endpoint = new URL(subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("推播服務網址不安全");
  const [body, token] = await Promise.all([encryptPushPayload(subscription, payload), createVapidToken(endpoint, env)]);
  return fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${token}, k=${env.VAPID_PUBLIC_KEY}`,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "600",
      Urgency: "high"
    },
    body
  });
}

function pushReminderPayload(ticket, env) {
  const siteUrl = String(env.PUBLIC_SITE_URL || "https://machich3n.github.io/qing/").replace(/\/?$/, "/");
  const body = `${ticket.number} 號預計約 ${REMINDER_MINUTES} 分鐘後入席，請於 ${SEAT_HOLD_MINUTES} 分鐘內到店。`;
  return {
    title: `${STORE_NAME}｜即將入席`,
    body,
    icon: `${siteUrl}logo/icon-192.png`,
    badge: `${siteUrl}logo/badge-96.png`,
    tag: `queue-${ticket.number}`,
    ticketId: ticket.id,
    url: `${siteUrl}#ticket=${encodeURIComponent(ticket.id)}&speak=1`,
    speakText: `${STORE_NAME}提醒，您的候位號碼 ${ticket.number}，預計約 ${REMINDER_MINUTES} 分鐘後可入席，請於 ${SEAT_HOLD_MINUTES} 分鐘內到店，並至櫃檯報到。`
  };
}

async function sendTicketPushes(env, ticket) {
  const result = await env.DB.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE ticket_id = ?").bind(ticket.id).all();
  const subscriptions = result.results || [];
  if (!subscriptions.length) return { sent: 0, unavailable: true };
  const payload = pushReminderPayload(ticket, env);
  let sent = 0;
  let lastError = null;
  for (const subscription of subscriptions) {
    const sentAt = new Date().toISOString();
    try {
      const response = await sendWebPush(env, subscription, payload);
      await env.DB.prepare("INSERT INTO push_logs (ticket_id, endpoint, status_code, sent_at) VALUES (?, ?, ?, ?)").bind(ticket.id, subscription.endpoint, response.status, sentAt).run();
      if (response.status === 404 || response.status === 410) {
        await env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id = ? AND endpoint = ?").bind(ticket.id, subscription.endpoint).run();
      } else if (!response.ok) {
        lastError = new Error(`推播服務回應 ${response.status}`);
      } else {
        sent += 1;
      }
    } catch (error) {
      lastError = error;
      await env.DB.prepare("INSERT INTO push_logs (ticket_id, endpoint, status_code, sent_at) VALUES (?, ?, 0, ?)").bind(ticket.id, subscription.endpoint, sentAt).run();
    }
  }
  if (!sent && lastError) throw lastError;
  return { sent, unavailable: false };
}

async function sendSms(env, ticket, message, event) {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    const to = ticket.phone.startsWith("09") ? `+886${ticket.phone.slice(1)}` : ticket.phone;
    const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: message });
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (!response.ok) throw new Error(`Twilio 簡訊發送失敗（${response.status}）`);
    const result = await response.json();
    return { provider: "twilio", providerId: result.sid || null };
  }
  if (env.SMS_WEBHOOK_URL) {
    const headers = { "Content-Type": "application/json" };
    if (env.SMS_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${env.SMS_WEBHOOK_TOKEN}`;
    const response = await fetch(env.SMS_WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify({ to: ticket.phone, message, ticketId: ticket.id, number: ticket.number, event }) });
    if (!response.ok) throw new Error(`簡訊 Webhook 發送失敗（${response.status}）`);
    return { provider: "webhook", providerId: null };
  }
  return { provider: "simulation", providerId: null };
}

function reminderMessage(ticket) {
  return `${STORE_NAME}提醒：您的候位號碼 ${ticket.number}，預計約 ${REMINDER_MINUTES} 分鐘後可入席，請前往餐廳櫃台報到。`;
}

async function deliverReminder(env, ticket, event = "five-minute-reminder") {
  const message = reminderMessage(ticket);
  const delivery = await sendTicketPushes(env, ticket);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sms_logs (ticket_id, event, recipient, message, provider, provider_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(ticket.id, event, ticket.phone, message, delivery.unavailable ? "not-subscribed" : "web-push", delivery.sent ? String(delivery.sent) : null, now),
    env.DB.prepare("UPDATE tickets SET reminder_sent_at = ?, reminder_provider = ?, reminder_provider_id = ?, reminder_error = NULL, updated_at = ? WHERE id = ?")
      .bind(now, delivery.unavailable ? "not-subscribed" : "web-push", delivery.sent ? String(delivery.sent) : null, now, ticket.id)
  ]);
  return { ...ticket, reminderSentAt: now, reminderProvider: delivery.unavailable ? "not-subscribed" : "web-push", reminderProviderId: delivery.sent ? String(delivery.sent) : null, reminderError: null, updatedAt: now };
}

async function processDueReminders(env) {
  const dueAt = new Date(Date.now() + REMINDER_MINUTES * 60_000).toISOString();
  const result = await env.DB.prepare("SELECT * FROM tickets WHERE status = 'waiting' AND reminder_sent_at IS NULL AND estimated_entry_at <= ? ORDER BY estimated_entry_at LIMIT 25").bind(dueAt).all();
  for (const row of result.results || []) {
    const ticket = rowToTicket(row);
    try { await deliverReminder(env, ticket); }
    catch (error) {
      await env.DB.prepare("UPDATE tickets SET reminder_error = ?, updated_at = ? WHERE id = ?").bind(error.message, new Date().toISOString(), ticket.id).run();
    }
  }
}

async function postponeMissedTicket(env, ticket, now) {
  const [result, settingsResult] = await env.DB.batch([
    env.DB.prepare("SELECT id, queue_order, joined_at FROM tickets WHERE status IN ('waiting', 'missed') AND id != ? ORDER BY queue_order, joined_at").bind(ticket.id),
    env.DB.prepare("SELECT key, value FROM settings")
  ]);
  const queue = result.results || [];
  let formerIndex = queue.findIndex(row => Number(row.queue_order) > ticket.queueOrder || (Number(row.queue_order) === ticket.queueOrder && row.joined_at > ticket.joinedAt));
  if (formerIndex < 0) formerIndex = queue.length;
  const newIndex = Math.min(formerIndex + 3, queue.length);
  const targetOrder = newIndex > formerIndex ? Number(queue[newIndex - 1].queue_order) : ticket.queueOrder;
  const settings = settingsFromRows(settingsResult.results || []);
  const estimatedMinutes = Math.max(settings.avgMinutesPerGroup, (newIndex + 1) * settings.avgMinutesPerGroup);
  const estimatedEntryAt = new Date(new Date(now).getTime() + estimatedMinutes * 60_000).toISOString();
  const statements = [];
  if (targetOrder > ticket.queueOrder) {
    statements.push(env.DB.prepare("UPDATE tickets SET queue_order = queue_order - 1 WHERE status IN ('waiting', 'missed') AND queue_order > ? AND queue_order <= ?").bind(ticket.queueOrder, targetOrder));
  }
  statements.push(env.DB.prepare("UPDATE tickets SET status = 'missed', queue_order = ?, missed_count = 1, missed_at = ?, estimated_minutes = ?, estimated_entry_at = ?, reminder_sent_at = NULL, reminder_provider = NULL, reminder_provider_id = NULL, reminder_error = NULL, updated_at = ? WHERE id = ? AND status IN ('waiting', 'called') AND missed_count = 0").bind(targetOrder, now, estimatedMinutes, estimatedEntryAt, now, ticket.id));
  await env.DB.batch(statements);
}

async function cancelAfterSecondMiss(env, ticket, now) {
  await env.DB.batch([
    env.DB.prepare("UPDATE tickets SET status = 'cancelled', missed_count = 2, cancelled_at = ?, updated_at = ? WHERE id = ? AND status IN ('called', 'missed') AND missed_count >= 1").bind(now, now, ticket.id),
    env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id = ?").bind(ticket.id)
  ]);
}

async function processExpiredCalls(env, now = new Date()) {
  const checkedAt = now.toISOString();
  const cutoff = new Date(now.getTime() - SEAT_HOLD_MINUTES * 60_000).toISOString();
  const expired = await env.DB.prepare(`
    SELECT id FROM tickets
    WHERE (status = 'called' AND called_at IS NOT NULL AND called_at <= ?)
       OR (status IN ('waiting', 'missed') AND estimated_entry_at IS NOT NULL AND estimated_entry_at <= ?)
    ORDER BY COALESCE(called_at, estimated_entry_at)
  `).bind(cutoff, cutoff).all();
  for (const row of expired.results || []) {
    const ticket = await getTicket(env, row.id);
    if (!ticket) continue;
    const deadline = ticket.status === "called" ? ticket.calledAt : ticket.estimatedEntryAt;
    if (!deadline || new Date(deadline).getTime() > now.getTime() - SEAT_HOLD_MINUTES * 60_000) continue;
    if (ticket.status === "missed" || ticket.missedCount >= 1) await cancelAfterSecondMiss(env, ticket, checkedAt);
    else await postponeMissedTicket(env, ticket, checkedAt);
  }
}

async function callTicketAndAdvance(env, ticket, now) {
  if (!ticket || !["waiting", "missed", "called"].includes(ticket.status)) throw new Error("此號碼目前無法叫號");
  const preceding = await env.DB.prepare("SELECT id FROM tickets WHERE date_key = ? AND id != ? AND status IN ('waiting', 'missed', 'called') AND queue_order < ? ORDER BY queue_order, joined_at").bind(ticket.dateKey, ticket.id, ticket.queueOrder).all();
  for (const row of preceding.results || []) {
    const earlier = await getTicket(env, row.id);
    if (!earlier) continue;
    if (earlier.status === "missed" || earlier.missedCount >= 1) await cancelAfterSecondMiss(env, earlier, now);
    else await postponeMissedTicket(env, earlier, now);
  }
  let called = await getTicket(env, ticket.id);
  if (!called) throw new Error("找不到候位資料");
  if (called.status !== "called") {
    const result = await env.DB.prepare("UPDATE tickets SET status = 'called', called_at = ?, estimated_minutes = 0, estimated_entry_at = ?, current_number = number, updated_at = ? WHERE id = ? AND status IN ('waiting', 'missed') RETURNING *").bind(now, now, now, ticket.id).run();
    const row = result.results?.[0];
    if (!row) throw new Error("此號碼目前無法叫號");
    called = rowToTicket(row);
  }
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('currentNumber', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(called.number, now).run();
  return called;
}

async function processQueueAutomation(env) {
  await processExpiredCalls(env);
  await processDueReminders(env);
}

async function handleApi(request, env, url, ctx) {
  const { pathname, searchParams } = url;
  const method = request.method;
  if (method === "GET" && pathname === "/api/health") return json(request, env, { ok: true, storage: "d1", reminderMinutes: REMINDER_MINUTES, seatHoldMinutes: SEAT_HOLD_MINUTES, webPush: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) });

  if (method === "POST" && pathname === "/api/queue") {
    const body = await readBody(request);
    const name = String(body.name || "").trim();
    const phone = cleanPhone(body.phone);
    if (name.length < 2 || name.length > 30) return fail(request, env, 400, "姓名需為 2 至 30 個字");
    if (!validPhone(phone)) return fail(request, env, 400, "請輸入正確的台灣手機號碼");
    const now = new Date();
    const today = dateKey(now);
    const timestamp = now.toISOString();
    const result = await env.DB.prepare(`
      INSERT INTO tickets (
        id, date_key, number, store_id, name, phone, status, queue_order, missed_count,
        current_number, ahead, estimated_minutes, estimated_entry_at, joined_at, updated_at
      )
      WITH computed AS (
        SELECT
          (SELECT COUNT(*) FROM tickets WHERE status IN ('waiting', 'missed')) AS ahead_count,
          COALESCE((SELECT MAX(queue_order) FROM tickets), 0) + 1000 AS next_order,
          COALESCE((SELECT MAX(CAST(SUBSTR(number, 2) AS INTEGER)) FROM tickets WHERE date_key = ?), 0) + 1 AS next_sequence,
          COALESCE(CAST((SELECT value FROM settings WHERE key = 'defaultWaitMinutes') AS INTEGER), ?) AS default_wait,
          COALESCE(CAST((SELECT value FROM settings WHERE key = 'avgMinutesPerGroup') AS INTEGER), ?) AS average_wait,
          COALESCE((SELECT value FROM settings WHERE key = 'currentNumber'), ?) AS live_current_number
      ), timing AS (
        SELECT *, MAX(default_wait, (ahead_count + 1) * average_wait) AS wait_minutes FROM computed
      )
      SELECT ?, ?, 'A' || printf('%03d', next_sequence), ?, ?, ?, 'waiting', next_order, 0,
        live_current_number, ahead_count, wait_minutes,
        strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+' || wait_minutes || ' minutes'), ?, ?
      FROM timing
      RETURNING *
    `).bind(
      today, DEFAULT_SETTINGS.defaultWaitMinutes, DEFAULT_SETTINGS.avgMinutesPerGroup, DEFAULT_SETTINGS.currentNumber,
      crypto.randomUUID(), today, body.storeId || DEFAULT_SETTINGS.storeId, name, phone, timestamp, timestamp, timestamp
    ).run();
    const row = result.results?.[0];
    if (!row) return fail(request, env, 500, "建立候位資料失敗");
    const ticket = rowToTicket(row);
    return json(request, env, toPublicTicket(ticket, ticket.currentNumber, ticket.ahead), 201);
  }

  const pushSubscriptionMatch = pathname.match(/^\/api\/queue\/([0-9a-f-]+)\/push-subscription$/i);
  if (pushSubscriptionMatch && method === "POST") {
    const body = await readBody(request);
    const endpoint = String(body.endpoint || "");
    const p256dh = String(body.keys?.p256dh || "");
    const auth = String(body.keys?.auth || "");
    let keysValid = false;
    try { keysValid = fromBase64Url(p256dh).length === 65 && fromBase64Url(auth).length === 16; } catch {}
    if (!validPushEndpoint(endpoint) || !keysValid) return fail(request, env, 400, "網頁推播訂閱格式錯誤");
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`
      INSERT INTO push_subscriptions (ticket_id, endpoint, p256dh, auth, created_at, updated_at)
      SELECT id, ?, ?, ?, ?, ? FROM tickets
      WHERE id = ? AND status IN ('waiting', 'called', 'missed')
      ON CONFLICT(ticket_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, updated_at = excluded.updated_at
      RETURNING ticket_id
    `).bind(endpoint, p256dh, auth, now, now, pushSubscriptionMatch[1]).run();
    return result.results?.[0] ? json(request, env, { ok: true }) : fail(request, env, 404, "找不到可訂閱的候位資料");
  }

  const publicMatch = pathname.match(/^\/api\/queue\/([0-9a-f-]+)$/i);
  if (publicMatch && method === "GET") {
    ctx.waitUntil(processQueueAutomation(env));
    const ticket = await getPublicTicket(env, publicMatch[1]);
    return ticket ? json(request, env, ticket) : fail(request, env, 404, "找不到候位資料");
  }
  if (publicMatch && method === "DELETE") {
    const now = new Date().toISOString();
    const [result] = await env.DB.batch([
      env.DB.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting', 'called', 'missed')").bind(now, now, publicMatch[1]),
      env.DB.prepare("DELETE FROM push_subscriptions WHERE ticket_id = ?").bind(publicMatch[1])
    ]);
    return result.meta.changes ? json(request, env, { ok: true, status: "cancelled" }) : fail(request, env, 404, "找不到候位資料");
  }

  if (pathname.startsWith("/api/admin/") && !(await isAdmin(request, env))) return fail(request, env, 401, "後台密碼錯誤");
  if (method === "GET" && pathname === "/api/admin/queue") {
    await processExpiredCalls(env);
    ctx.waitUntil(processDueReminders(env));
    const filter = searchParams.get("status") || "active";
    let query = "SELECT * FROM tickets ORDER BY joined_at";
    if (filter === "active") query = "SELECT * FROM tickets WHERE status IN ('waiting', 'called', 'missed') ORDER BY CASE WHEN status = 'called' THEN 0 ELSE 1 END, queue_order, joined_at";
    else if (filter !== "all") query = "SELECT * FROM tickets WHERE status = ? ORDER BY queue_order, joined_at";
    const ticketStatement = filter !== "all" && filter !== "active" ? env.DB.prepare(query).bind(filter) : env.DB.prepare(query);
    const todayKey = dateKey();
    const [result, activeOrder, counts, today, settingsResult, currentResult, numberResult] = await env.DB.batch([
      ticketStatement,
      env.DB.prepare("SELECT id FROM tickets WHERE status IN ('waiting', 'missed') ORDER BY queue_order, joined_at"),
      env.DB.prepare("SELECT status, COUNT(*) AS count FROM tickets GROUP BY status"),
      env.DB.prepare("SELECT COUNT(*) AS count FROM tickets WHERE date_key = ?").bind(todayKey),
      env.DB.prepare("SELECT key, value FROM settings"),
      effectiveCurrentNumberStatement(env, todayKey),
      env.DB.prepare("SELECT number FROM tickets WHERE date_key = ? AND status IN ('waiting', 'called', 'missed') ORDER BY CASE WHEN status = 'called' THEN 0 ELSE 1 END, queue_order, joined_at").bind(todayKey)
    ]);
    const positions = new Map((activeOrder.results || []).map((row, index) => [row.id, index + 1]));
    const byStatus = Object.fromEntries((counts.results || []).map(row => [row.status, Number(row.count)]));
    const todayCount = Number(today.results?.[0]?.count || 0);
    return json(request, env, { tickets: (result.results || []).map(row => { const ticket = rowToTicket(row); return { ...ticket, queuePosition: positions.get(ticket.id) || null }; }), availableNumbers: (numberResult.results || []).map(row => row.number), stats: { waiting: byStatus.waiting || 0, called: byStatus.called || 0, missed: byStatus.missed || 0, seated: byStatus.seated || 0, todayTotal: todayCount }, settings: settingsFromRows(settingsResult.results || [], currentResult.results?.[0]?.number), checkedAt: new Date().toISOString() });
  }
  if (method === "GET" && pathname === "/api/admin/settings") return json(request, env, await getSettings(env));
  if (method === "PATCH" && pathname === "/api/admin/settings") {
    const body = await readBody(request);
    const updates = [];
    const now = new Date().toISOString();
    let requestedCurrentNumber = null;
    if (body.currentNumber !== undefined) {
      requestedCurrentNumber = String(body.currentNumber).toUpperCase().trim();
      if (!validNumber(requestedCurrentNumber)) return fail(request, env, 400, "目前叫號格式需為 A001");
    }
    if (body.defaultWaitMinutes !== undefined) {
      const value = fiveMinuteValue(body.defaultWaitMinutes, 0, 600, DEFAULT_SETTINGS.defaultWaitMinutes);
      updates.push(env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('defaultWaitMinutes', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(value), now));
    }
    if (body.avgMinutesPerGroup !== undefined) {
      const value = fiveMinuteValue(body.avgMinutesPerGroup, 5, 120, DEFAULT_SETTINGS.avgMinutesPerGroup);
      updates.push(env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('avgMinutesPerGroup', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind(String(value), now));
    }
    if (updates.length) await env.DB.batch(updates);
    if (requestedCurrentNumber) {
      const selectedRow = await env.DB.prepare("SELECT * FROM tickets WHERE date_key = ? AND number = ? LIMIT 1").bind(dateKey(), requestedCurrentNumber).first();
      if (!selectedRow) return fail(request, env, 404, "今日候位紀錄中找不到這個號碼");
      try { await callTicketAndAdvance(env, rowToTicket(selectedRow), now); }
      catch (error) { return fail(request, env, 409, error.message); }
    }
    return json(request, env, await getSettings(env));
  }

  const adminMatch = pathname.match(/^\/api\/admin\/queue\/([0-9a-f-]+)(?:\/(remind|call|complete|cancel))?$/i);
  if (adminMatch && method === "PATCH" && !adminMatch[2]) {
    const body = await readBody(request);
    const minutes = fiveMinuteValue(body.estimatedMinutes, 0, 600, 0);
    const now = new Date().toISOString();
    const estimatedEntryAt = new Date(Date.now() + minutes * 60_000).toISOString();
    const result = await env.DB.prepare("UPDATE tickets SET estimated_minutes = ?, estimated_entry_at = ?, reminder_sent_at = CASE WHEN ? > ? THEN NULL ELSE reminder_sent_at END, reminder_error = NULL, updated_at = ? WHERE id = ? RETURNING *")
      .bind(minutes, estimatedEntryAt, minutes, REMINDER_MINUTES, now, adminMatch[1]).run();
    const row = result.results?.[0];
    if (!row) return fail(request, env, 404, "找不到候位資料");
    ctx.waitUntil(processDueReminders(env));
    return json(request, env, rowToTicket(row));
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "remind") {
    const ticket = await getTicket(env, adminMatch[1]);
    if (!ticket) return fail(request, env, 404, "找不到候位資料");
    try { return json(request, env, await deliverReminder(env, ticket, "manual-reminder")); }
    catch (error) { return fail(request, env, 502, error.message); }
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "call") {
    const now = new Date().toISOString();
    const original = await getTicket(env, adminMatch[1]);
    let ticket;
    try { ticket = await callTicketAndAdvance(env, original, now); }
    catch (error) { return fail(request, env, 409, error.message); }
    try {
      const message = `${STORE_NAME}通知：候位號碼 ${ticket.number} 已叫號，請儘速至櫃台報到入席。`;
      const delivery = await sendSms(env, ticket, message, "called");
      const sentAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO sms_logs (ticket_id, event, recipient, message, provider, provider_id, sent_at) VALUES (?, 'called', ?, ?, ?, ?, ?)").bind(ticket.id, ticket.phone, message, delivery.provider, delivery.providerId, sentAt),
        env.DB.prepare("UPDATE tickets SET call_message_sent_at = ?, call_message_provider = ?, call_message_error = NULL, updated_at = ? WHERE id = ?").bind(sentAt, delivery.provider, sentAt, ticket.id)
      ]);
      ticket = { ...ticket, callMessageSentAt: sentAt, callMessageProvider: delivery.provider, callMessageError: null, updatedAt: sentAt };
    } catch (error) {
      const failedAt = new Date().toISOString();
      await env.DB.prepare("UPDATE tickets SET call_message_error = ?, updated_at = ? WHERE id = ?").bind(error.message, failedAt, ticket.id).run();
      ticket = { ...ticket, callMessageError: error.message, updatedAt: failedAt };
    }
    return json(request, env, ticket);
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "complete") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE tickets SET status = 'seated', seated_at = ?, updated_at = ? WHERE id = ? AND status = 'called' RETURNING *").bind(now, now, adminMatch[1]).run();
    const row = result.results?.[0];
    return row ? json(request, env, rowToTicket(row)) : fail(request, env, 404, "找不到候位資料");
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "cancel") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ? AND status IN ('waiting', 'called', 'missed') RETURNING *").bind(now, now, adminMatch[1]).run();
    const row = result.results?.[0];
    return row ? json(request, env, rowToTicket(row)) : fail(request, env, 409, "此號碼目前無法取消");
  }
  return fail(request, env, 404, "找不到 API 路徑");
}

async function fetchHandler(request, env, ctx) {
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url, ctx);
    return json(request, env, { service: "qing-queue-api", health: "/api/health" });
  } catch (error) {
    return fail(request, env, error.message === "JSON 格式錯誤" ? 400 : 500, error.message || "伺服器錯誤");
  }
}

export default {
  fetch: fetchHandler,
  async scheduled(_controller, env, ctx) { ctx.waitUntil(processQueueAutomation(env)); }
};
