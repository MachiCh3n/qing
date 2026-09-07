import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, timingSafeEqual } from "node:crypto";

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.QING_DATA_DIR ? resolve(process.env.QING_DATA_DIR) : join(ROOT, "data");
const PORT = Number(process.env.PORT || 8000);
const ADMIN_KEY = process.env.ADMIN_KEY || "qing-admin";
const REMINDER_MINUTES = 5;
const STORE_NAME = "慶壽喜燒";
const QUEUE_FILE = join(DATA_DIR, "queue.json");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");
const SMS_LOG_FILE = join(DATA_DIR, "sms-log.json");

mkdirSync(DATA_DIR, { recursive: true });

const defaults = {
  storeId: "qing-linkou",
  defaultWaitMinutes: 25,
  avgMinutesPerGroup: 5,
  currentNumber: "A000",
  reminderMinutes: REMINDER_MINUTES
};

function readJson(file, fallback) {
  if (!existsSync(file)) return structuredClone(fallback);
  const raw = readFileSync(file, "utf8").trim();
  return raw ? JSON.parse(raw) : structuredClone(fallback);
}

function writeJson(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

function readQueue() { return readJson(QUEUE_FILE, []); }
function writeQueue(queue) { writeJson(QUEUE_FILE, queue); }
function readSettings() { return { ...defaults, ...readJson(SETTINGS_FILE, {}) }; }
function writeSettings(settings) { writeJson(SETTINGS_FILE, { ...defaults, ...settings, reminderMinutes: REMINDER_MINUTES }); }

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(payload);
}

function fail(res, status, message) { sendJson(res, status, { message }); }

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error("資料內容過大");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("JSON 格式錯誤"); }
}

function cleanPhone(value) { return String(value || "").replace(/\D/g, ""); }
function validPhone(value) { return /^09\d{8}$/.test(value); }
function validNumber(value) { return /^[A-Z]\d{3,4}$/.test(String(value || "").toUpperCase()); }
function dateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function nextTicketNumber(queue) {
  const today = dateKey();
  const max = queue.filter(t => t.dateKey === today).reduce((n, t) => Math.max(n, Number(String(t.number).replace(/\D/g, "")) || 0), 0);
  return `A${String(max + 1).padStart(3, "0")}`;
}

function publicTicket(ticket, queue = readQueue()) {
  const { phone, reminderError, ...safe } = ticket;
  const ahead = ticket.status === "waiting" ? queue.filter(item => item.status === "waiting" && new Date(item.joinedAt) < new Date(ticket.joinedAt)).length : 0;
  return { ...safe, ahead, currentNumber: readSettings().currentNumber };
}

function isAdmin(req) {
  const provided = String(req.headers["x-admin-key"] || "");
  const expected = Buffer.from(ADMIN_KEY);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function updateTicket(id, updater) {
  const queue = readQueue();
  const index = queue.findIndex(ticket => ticket.id === id);
  if (index < 0) return null;
  queue[index] = updater({ ...queue[index] });
  queue[index].updatedAt = new Date().toISOString();
  writeQueue(queue);
  return queue[index];
}

async function sendSms(ticket, message, event) {
  const payload = { to: ticket.phone, message, ticketId: ticket.id, number: ticket.number, event };
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;

  if (sid && token && from) {
    const to = ticket.phone.startsWith("09") ? `+886${ticket.phone.slice(1)}` : ticket.phone;
    const form = new URLSearchParams({ To: to, From: from, Body: message });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { "Authorization": `Basic ${Buffer.from(`${sid}:${token}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) throw new Error(`Twilio 簡訊發送失敗（${response.status}）`);
    const result = await response.json();
    return { provider: "twilio", providerId: result.sid || null };
  }

  if (process.env.SMS_WEBHOOK_URL) {
    const headers = { "Content-Type": "application/json" };
    if (process.env.SMS_WEBHOOK_TOKEN) headers.Authorization = `Bearer ${process.env.SMS_WEBHOOK_TOKEN}`;
    const response = await fetch(process.env.SMS_WEBHOOK_URL, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`簡訊 Webhook 發送失敗（${response.status}）`);
    return { provider: "webhook", providerId: null };
  }

  const log = readJson(SMS_LOG_FILE, []);
  log.push({ ...payload, simulated: true, sentAt: new Date().toISOString() });
  writeJson(SMS_LOG_FILE, log);
  console.log(`[簡訊模擬] ${ticket.phone}：${message}`);
  return { provider: "simulation", providerId: null };
}

function reminderMessage(ticket) {
  return `${STORE_NAME}提醒：您的候位號碼 ${ticket.number}，預計約 ${REMINDER_MINUTES} 分鐘後可入席，請前往餐廳櫃台報到。`;
}

async function deliverReminder(ticket, event = "five-minute-reminder") {
  const delivery = await sendSms(ticket, reminderMessage(ticket), event);
  return updateTicket(ticket.id, current => ({
    ...current,
    reminderSentAt: new Date().toISOString(),
    reminderProvider: delivery.provider,
    reminderProviderId: delivery.providerId,
    reminderError: null
  }));
}

async function processDueReminders() {
  const now = Date.now();
  const due = readQueue().filter(ticket => {
    if (ticket.status !== "waiting" || ticket.reminderSentAt || !ticket.estimatedEntryAt) return false;
    return new Date(ticket.estimatedEntryAt).getTime() - now <= REMINDER_MINUTES * 60_000;
  });

  for (const ticket of due) {
    try { await deliverReminder(ticket); }
    catch (error) {
      updateTicket(ticket.id, current => ({ ...current, reminderError: error.message }));
      console.error(`候位 ${ticket.number} 的五分鐘簡訊失敗：${error.message}`);
    }
  }
}

function mimeType(file) {
  return ({ ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" })[extname(file).toLowerCase()] || "application/octet-stream";
}

function serveFile(res, pathname) {
  const mapped = pathname === "/" ? "/index.html" : pathname === "/admin" ? "/admin.html" : pathname;
  let decoded;
  try { decoded = decodeURIComponent(mapped); } catch { return false; }
  const file = resolve(ROOT, `.${decoded}`);
  if (!(file === ROOT || file.startsWith(`${ROOT}${sep}`)) || !existsSync(file) || !statSync(file).isFile()) return false;
  const body = readFileSync(file);
  res.writeHead(200, { "Content-Type": mimeType(file), "Content-Length": body.length, "Cache-Control": extname(file) === ".html" ? "no-store" : "public, max-age=3600", "X-Content-Type-Options": "nosniff" });
  res.end(body);
  return true;
}

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  if (req.method === "GET" && pathname === "/api/health") return sendJson(res, 200, { ok: true, reminderMinutes: REMINDER_MINUTES });

  if (req.method === "POST" && pathname === "/api/queue") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    const phone = cleanPhone(body.phone);
    if (name.length < 2 || name.length > 30) return fail(res, 400, "姓名需為 2 至 30 個字");
    if (!validPhone(phone)) return fail(res, 400, "請輸入正確的台灣手機號碼");
    const queue = readQueue();
    const settings = readSettings();
    const ahead = queue.filter(ticket => ticket.status === "waiting").length;
    const estimatedMinutes = Math.max(settings.defaultWaitMinutes, (ahead + 1) * settings.avgMinutesPerGroup);
    const now = new Date();
    const ticket = {
      id: randomUUID(), storeId: body.storeId || settings.storeId, dateKey: dateKey(now), number: nextTicketNumber(queue),
      name, phone, status: "waiting", currentNumber: settings.currentNumber, ahead, estimatedMinutes,
      estimatedEntryAt: new Date(now.getTime() + estimatedMinutes * 60_000).toISOString(), joinedAt: now.toISOString(), updatedAt: now.toISOString(),
      calledAt: null, seatedAt: null, cancelledAt: null, reminderSentAt: null, reminderProvider: null, reminderProviderId: null, reminderError: null
    };
    queue.push(ticket);
    writeQueue(queue);
    return sendJson(res, 201, publicTicket(ticket, queue));
  }

  const publicMatch = pathname.match(/^\/api\/queue\/([0-9a-f-]+)$/i);
  if (publicMatch && req.method === "GET") {
    const queue = readQueue();
    const ticket = queue.find(item => item.id === publicMatch[1]);
    return ticket ? sendJson(res, 200, publicTicket(ticket, queue)) : fail(res, 404, "找不到候位資料");
  }
  if (publicMatch && req.method === "DELETE") {
    const ticket = updateTicket(publicMatch[1], current => ({ ...current, status: "cancelled", cancelledAt: new Date().toISOString() }));
    return ticket ? sendJson(res, 200, { ok: true, status: ticket.status }) : fail(res, 404, "找不到候位資料");
  }

  if (pathname.startsWith("/api/admin/") && !isAdmin(req)) return fail(res, 401, "後台密碼錯誤");

  if (req.method === "GET" && pathname === "/api/admin/queue") {
    const status = searchParams.get("status") || "active";
    let queue = readQueue();
    const allTickets = queue;
    if (status === "active") queue = queue.filter(ticket => ["waiting", "called"].includes(ticket.status));
    else if (status !== "all") queue = queue.filter(ticket => ticket.status === status);
    queue.sort((a, b) => new Date(a.joinedAt) - new Date(b.joinedAt));
    const today = dateKey();
    const stats = {
      waiting: allTickets.filter(ticket => ticket.status === "waiting").length,
      called: allTickets.filter(ticket => ticket.status === "called").length,
      seated: allTickets.filter(ticket => ticket.status === "seated").length,
      todayTotal: allTickets.filter(ticket => ticket.dateKey === today).length
    };
    return sendJson(res, 200, { tickets: queue, stats, settings: readSettings(), checkedAt: new Date().toISOString() });
  }

  if (req.method === "GET" && pathname === "/api/admin/settings") return sendJson(res, 200, readSettings());
  if (req.method === "PATCH" && pathname === "/api/admin/settings") {
    const body = await readBody(req);
    const settings = readSettings();
    if (body.defaultWaitMinutes !== undefined) settings.defaultWaitMinutes = Math.max(0, Math.min(600, Number(body.defaultWaitMinutes) || 0));
    if (body.avgMinutesPerGroup !== undefined) settings.avgMinutesPerGroup = Math.max(1, Math.min(120, Number(body.avgMinutesPerGroup) || 1));
    if (body.currentNumber !== undefined) {
      const number = String(body.currentNumber).toUpperCase().trim();
      if (!validNumber(number)) return fail(res, 400, "目前叫號格式需為 A001");
      settings.currentNumber = number;
    }
    writeSettings(settings);
    return sendJson(res, 200, settings);
  }

  const adminMatch = pathname.match(/^\/api\/admin\/queue\/([0-9a-f-]+)(?:\/(remind|call|complete))?$/i);
  if (adminMatch && req.method === "PATCH" && !adminMatch[2]) {
    const body = await readBody(req);
    const ticket = updateTicket(adminMatch[1], current => {
      if (body.estimatedMinutes !== undefined) {
        const minutes = Math.max(0, Math.min(600, Number(body.estimatedMinutes) || 0));
        current.estimatedMinutes = minutes;
        current.estimatedEntryAt = new Date(Date.now() + minutes * 60_000).toISOString();
        current.reminderSentAt = minutes > REMINDER_MINUTES ? null : current.reminderSentAt;
        current.reminderError = null;
      }
      if (body.ahead !== undefined) current.ahead = Math.max(0, Math.min(999, Number(body.ahead) || 0));
      if (body.currentNumber !== undefined && validNumber(body.currentNumber)) current.currentNumber = String(body.currentNumber).toUpperCase();
      return current;
    });
    if (!ticket) return fail(res, 404, "找不到候位資料");
    setTimeout(processDueReminders, 0);
    return sendJson(res, 200, ticket);
  }

  if (adminMatch && req.method === "POST" && adminMatch[2] === "remind") {
    const ticket = readQueue().find(item => item.id === adminMatch[1]);
    if (!ticket) return fail(res, 404, "找不到候位資料");
    try { return sendJson(res, 200, await deliverReminder(ticket, "manual-reminder")); }
    catch (error) { return fail(res, 502, error.message); }
  }

  if (adminMatch && req.method === "POST" && adminMatch[2] === "call") {
    let ticket = updateTicket(adminMatch[1], current => ({ ...current, status: "called", calledAt: new Date().toISOString(), estimatedMinutes: 0, estimatedEntryAt: new Date().toISOString(), currentNumber: current.number }));
    if (!ticket) return fail(res, 404, "找不到候位資料");
    const settings = readSettings();
    settings.currentNumber = ticket.number;
    writeSettings(settings);
    try {
      const delivery = await sendSms(ticket, `${STORE_NAME}通知：候位號碼 ${ticket.number} 已叫號，請儘速至櫃台報到入席。`, "called");
      ticket = updateTicket(ticket.id, current => ({ ...current, callMessageSentAt: new Date().toISOString(), callMessageProvider: delivery.provider }));
    } catch (error) {
      ticket = updateTicket(ticket.id, current => ({ ...current, callMessageError: error.message }));
    }
    return sendJson(res, 200, ticket);
  }

  if (adminMatch && req.method === "POST" && adminMatch[2] === "complete") {
    const ticket = updateTicket(adminMatch[1], current => ({ ...current, status: "seated", seatedAt: new Date().toISOString() }));
    return ticket ? sendJson(res, 200, ticket) : fail(res, 404, "找不到候位資料");
  }

  return fail(res, 404, "找不到 API 路徑");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }
    if (!serveFile(res, url.pathname)) fail(res, 404, "找不到頁面");
  } catch (error) {
    console.error(error);
    fail(res, error.message === "JSON 格式錯誤" || error.message === "資料內容過大" ? 400 : 500, error.message || "伺服器錯誤");
  }
});

server.listen(PORT, () => {
  console.log(`${STORE_NAME}候位系統：http://127.0.0.1:${PORT}`);
  console.log(`管理後台：http://127.0.0.1:${PORT}/admin`);
  if (!process.env.ADMIN_KEY) console.warn("目前使用預設後台密碼 qing-admin，上線前請設定 ADMIN_KEY。");
  if (!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) && !process.env.SMS_WEBHOOK_URL) console.warn("尚未設定簡訊供應商，目前簡訊會寫入 data/sms-log.json 作為測試紀錄。");
});

setInterval(processDueReminders, 30_000).unref();
setTimeout(processDueReminders, 1_000);
