const REMINDER_MINUTES = 5;
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
function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

async function getSettings(env) {
  const result = await env.DB.prepare("SELECT key, value FROM settings").all();
  const stored = Object.fromEntries((result.results || []).map(row => [row.key, row.value]));
  return {
    ...DEFAULT_SETTINGS,
    defaultWaitMinutes: Number(stored.defaultWaitMinutes ?? DEFAULT_SETTINGS.defaultWaitMinutes),
    avgMinutesPerGroup: Number(stored.avgMinutesPerGroup ?? DEFAULT_SETTINGS.avgMinutesPerGroup),
    currentNumber: stored.currentNumber || DEFAULT_SETTINGS.currentNumber
  };
}

async function saveSettings(env, settings) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind("defaultWaitMinutes", String(settings.defaultWaitMinutes), now),
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind("avgMinutesPerGroup", String(settings.avgMinutesPerGroup), now),
    env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").bind("currentNumber", settings.currentNumber, now)
  ]);
  return settings;
}

function rowToTicket(row) {
  return {
    id: row.id, dateKey: row.date_key, number: row.number, storeId: row.store_id, name: row.name, phone: row.phone,
    status: row.status, currentNumber: row.current_number, ahead: row.ahead, estimatedMinutes: row.estimated_minutes,
    estimatedEntryAt: row.estimated_entry_at, joinedAt: row.joined_at, updatedAt: row.updated_at, calledAt: row.called_at,
    seatedAt: row.seated_at, cancelledAt: row.cancelled_at, reminderSentAt: row.reminder_sent_at,
    reminderProvider: row.reminder_provider, reminderProviderId: row.reminder_provider_id, reminderError: row.reminder_error,
    callMessageSentAt: row.call_message_sent_at, callMessageProvider: row.call_message_provider, callMessageError: row.call_message_error
  };
}

async function getTicket(env, id) {
  const row = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
  return row ? rowToTicket(row) : null;
}

async function publicTicket(env, ticket) {
  const settings = await getSettings(env);
  const aheadRow = ticket.status === "waiting" ? await env.DB.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'waiting' AND joined_at < ?").bind(ticket.joinedAt).first() : { count: 0 };
  const { phone, reminderError, ...safe } = ticket;
  return { ...safe, ahead: Number(aheadRow?.count || 0), currentNumber: settings.currentNumber };
}

function isAdmin(request, env) {
  const expected = String(env.ADMIN_KEY || "");
  const actual = String(request.headers.get("X-Admin-Key") || "");
  if (!expected || expected.length !== actual.length) return false;
  let different = 0;
  for (let index = 0; index < expected.length; index += 1) different |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return different === 0;
}

async function logSms(env, ticket, event, message, provider, providerId = null) {
  await env.DB.prepare("INSERT INTO sms_logs (ticket_id, event, recipient, message, provider, provider_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(ticket.id, event, ticket.phone, message, provider, providerId, new Date().toISOString()).run();
}

async function sendSms(env, ticket, message, event) {
  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    const to = ticket.phone.startsWith("09") ? `+886${ticket.phone.slice(1)}` : ticket.phone;
    const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: message });
    const auth = btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`);
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(env.TWILIO_ACCOUNT_SID)}/Messages.json`, { method: "POST", headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" }, body: form });
    if (!response.ok) throw new Error(`Twilio 簡訊發送失敗（${response.status}）`);
    const result = await response.json();
    await logSms(env, ticket, event, message, "twilio", result.sid || null);
    return { provider: "twilio", providerId: result.sid || null };
  }
  if (env.SMS_WEBHOOK_URL) {
    const headers = { "Content-Type": "application/json" };
    if (env.SMS_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${env.SMS_WEBHOOK_TOKEN}`;
    const response = await fetch(env.SMS_WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify({ to: ticket.phone, message, ticketId: ticket.id, number: ticket.number, event }) });
    if (!response.ok) throw new Error(`簡訊 Webhook 發送失敗（${response.status}）`);
    await logSms(env, ticket, event, message, "webhook");
    return { provider: "webhook", providerId: null };
  }
  await logSms(env, ticket, event, message, "simulation");
  return { provider: "simulation", providerId: null };
}

function reminderMessage(ticket) {
  return `${STORE_NAME}提醒：您的候位號碼 ${ticket.number}，預計約 ${REMINDER_MINUTES} 分鐘後可入席，請前往餐廳櫃台報到。`;
}

async function deliverReminder(env, ticket, event = "five-minute-reminder") {
  const delivery = await sendSms(env, ticket, reminderMessage(ticket), event);
  const now = new Date().toISOString();
  await env.DB.prepare("UPDATE tickets SET reminder_sent_at = ?, reminder_provider = ?, reminder_provider_id = ?, reminder_error = NULL, updated_at = ? WHERE id = ?")
    .bind(now, delivery.provider, delivery.providerId, now, ticket.id).run();
  return getTicket(env, ticket.id);
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

async function handleApi(request, env, url) {
  const { pathname, searchParams } = url;
  const method = request.method;
  if (method === "GET" && pathname === "/api/health") return json(request, env, { ok: true, storage: "d1", reminderMinutes: REMINDER_MINUTES });

  if (method === "POST" && pathname === "/api/queue") {
    const body = await readBody(request);
    const name = String(body.name || "").trim();
    const phone = cleanPhone(body.phone);
    if (name.length < 2 || name.length > 30) return fail(request, env, 400, "姓名需為 2 至 30 個字");
    if (!validPhone(phone)) return fail(request, env, 400, "請輸入正確的台灣手機號碼");
    const settings = await getSettings(env);
    const waiting = await env.DB.prepare("SELECT COUNT(*) AS count FROM tickets WHERE status = 'waiting'").first();
    const last = await env.DB.prepare("SELECT MAX(CAST(SUBSTR(number, 2) AS INTEGER)) AS seq FROM tickets WHERE date_key = ?").bind(dateKey()).first();
    const seq = Number(last?.seq || 0) + 1;
    const ahead = Number(waiting?.count || 0);
    const estimatedMinutes = Math.max(settings.defaultWaitMinutes, (ahead + 1) * settings.avgMinutesPerGroup);
    const now = new Date();
    const ticket = {
      id: crypto.randomUUID(), dateKey: dateKey(now), number: `A${String(seq).padStart(3, "0")}`, storeId: body.storeId || settings.storeId,
      name, phone, status: "waiting", currentNumber: settings.currentNumber, ahead, estimatedMinutes,
      estimatedEntryAt: new Date(now.getTime() + estimatedMinutes * 60_000).toISOString(), joinedAt: now.toISOString(), updatedAt: now.toISOString(),
      calledAt: null, seatedAt: null, cancelledAt: null, reminderSentAt: null, reminderProvider: null, reminderProviderId: null,
      reminderError: null, callMessageSentAt: null, callMessageProvider: null, callMessageError: null
    };
    await env.DB.prepare("INSERT INTO tickets (id, date_key, number, store_id, name, phone, status, current_number, ahead, estimated_minutes, estimated_entry_at, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ticket.id, ticket.dateKey, ticket.number, ticket.storeId, ticket.name, ticket.phone, ticket.status, ticket.currentNumber, ticket.ahead, ticket.estimatedMinutes, ticket.estimatedEntryAt, ticket.joinedAt, ticket.updatedAt).run();
    return json(request, env, await publicTicket(env, ticket), 201);
  }

  const publicMatch = pathname.match(/^\/api\/queue\/([0-9a-f-]+)$/i);
  if (publicMatch && method === "GET") {
    await processDueReminders(env);
    const ticket = await getTicket(env, publicMatch[1]);
    return ticket ? json(request, env, await publicTicket(env, ticket)) : fail(request, env, 404, "找不到候位資料");
  }
  if (publicMatch && method === "DELETE") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE id = ?").bind(now, now, publicMatch[1]).run();
    return result.meta.changes ? json(request, env, { ok: true, status: "cancelled" }) : fail(request, env, 404, "找不到候位資料");
  }

  if (pathname.startsWith("/api/admin/") && !isAdmin(request, env)) return fail(request, env, 401, "後台密碼錯誤");
  if (method === "GET" && pathname === "/api/admin/queue") {
    await processDueReminders(env);
    const filter = searchParams.get("status") || "active";
    let query = "SELECT * FROM tickets ORDER BY joined_at";
    if (filter === "active") query = "SELECT * FROM tickets WHERE status IN ('waiting', 'called') ORDER BY joined_at";
    else if (filter !== "all") query = "SELECT * FROM tickets WHERE status = ? ORDER BY joined_at";
    const result = filter !== "all" && filter !== "active" ? await env.DB.prepare(query).bind(filter).all() : await env.DB.prepare(query).all();
    const counts = await env.DB.prepare("SELECT status, COUNT(*) AS count FROM tickets GROUP BY status").all();
    const today = await env.DB.prepare("SELECT COUNT(*) AS count FROM tickets WHERE date_key = ?").bind(dateKey()).first();
    const byStatus = Object.fromEntries((counts.results || []).map(row => [row.status, Number(row.count)]));
    return json(request, env, { tickets: (result.results || []).map(rowToTicket), stats: { waiting: byStatus.waiting || 0, called: byStatus.called || 0, seated: byStatus.seated || 0, todayTotal: Number(today?.count || 0) }, settings: await getSettings(env), checkedAt: new Date().toISOString() });
  }
  if (method === "GET" && pathname === "/api/admin/settings") return json(request, env, await getSettings(env));
  if (method === "PATCH" && pathname === "/api/admin/settings") {
    const body = await readBody(request);
    const settings = await getSettings(env);
    if (body.defaultWaitMinutes !== undefined) settings.defaultWaitMinutes = Math.max(0, Math.min(600, Number(body.defaultWaitMinutes) || 0));
    if (body.avgMinutesPerGroup !== undefined) settings.avgMinutesPerGroup = Math.max(1, Math.min(120, Number(body.avgMinutesPerGroup) || 1));
    if (body.currentNumber !== undefined) {
      const number = String(body.currentNumber).toUpperCase().trim();
      if (!validNumber(number)) return fail(request, env, 400, "目前叫號格式需為 A001");
      settings.currentNumber = number;
    }
    return json(request, env, await saveSettings(env, settings));
  }

  const adminMatch = pathname.match(/^\/api\/admin\/queue\/([0-9a-f-]+)(?:\/(remind|call|complete))?$/i);
  if (adminMatch && method === "PATCH" && !adminMatch[2]) {
    const body = await readBody(request);
    const ticket = await getTicket(env, adminMatch[1]);
    if (!ticket) return fail(request, env, 404, "找不到候位資料");
    const minutes = Math.max(0, Math.min(600, Number(body.estimatedMinutes) || 0));
    const now = new Date().toISOString();
    const estimatedEntryAt = new Date(Date.now() + minutes * 60_000).toISOString();
    await env.DB.prepare("UPDATE tickets SET estimated_minutes = ?, estimated_entry_at = ?, reminder_sent_at = CASE WHEN ? > ? THEN NULL ELSE reminder_sent_at END, reminder_error = NULL, updated_at = ? WHERE id = ?")
      .bind(minutes, estimatedEntryAt, minutes, REMINDER_MINUTES, now, ticket.id).run();
    await processDueReminders(env);
    return json(request, env, await getTicket(env, ticket.id));
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "remind") {
    const ticket = await getTicket(env, adminMatch[1]);
    if (!ticket) return fail(request, env, 404, "找不到候位資料");
    try { return json(request, env, await deliverReminder(env, ticket, "manual-reminder")); }
    catch (error) { return fail(request, env, 502, error.message); }
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "call") {
    let ticket = await getTicket(env, adminMatch[1]);
    if (!ticket) return fail(request, env, 404, "找不到候位資料");
    const now = new Date().toISOString();
    await env.DB.prepare("UPDATE tickets SET status = 'called', called_at = ?, estimated_minutes = 0, estimated_entry_at = ?, current_number = number, updated_at = ? WHERE id = ?").bind(now, now, now, ticket.id).run();
    const settings = await getSettings(env); settings.currentNumber = ticket.number; await saveSettings(env, settings); ticket = await getTicket(env, ticket.id);
    try {
      const message = `${STORE_NAME}通知：候位號碼 ${ticket.number} 已叫號，請儘速至櫃台報到入席。`;
      const delivery = await sendSms(env, ticket, message, "called");
      await env.DB.prepare("UPDATE tickets SET call_message_sent_at = ?, call_message_provider = ?, call_message_error = NULL, updated_at = ? WHERE id = ?").bind(new Date().toISOString(), delivery.provider, new Date().toISOString(), ticket.id).run();
    } catch (error) {
      await env.DB.prepare("UPDATE tickets SET call_message_error = ?, updated_at = ? WHERE id = ?").bind(error.message, new Date().toISOString(), ticket.id).run();
    }
    return json(request, env, await getTicket(env, ticket.id));
  }
  if (adminMatch && method === "POST" && adminMatch[2] === "complete") {
    const now = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE tickets SET status = 'seated', seated_at = ?, updated_at = ? WHERE id = ?").bind(now, now, adminMatch[1]).run();
    return result.meta.changes ? json(request, env, await getTicket(env, adminMatch[1])) : fail(request, env, 404, "找不到候位資料");
  }
  return fail(request, env, 404, "找不到 API 路徑");
}

async function fetchHandler(request, env) {
  const url = new URL(request.url);
  try {
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    if (url.pathname.startsWith("/api/")) return await handleApi(request, env, url);
    return json(request, env, { service: "qing-queue-api", health: "/api/health" });
  } catch (error) {
    return fail(request, env, error.message === "JSON 格式錯誤" ? 400 : 500, error.message || "伺服器錯誤");
  }
}

export default {
  fetch: fetchHandler,
  async scheduled(_controller, env, ctx) { ctx.waitUntil(processDueReminders(env)); }
};
