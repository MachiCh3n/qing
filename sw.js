const CACHE_NAME = "qing-queue-v1";
const APP_SHELL = ["./", "./config.js", "./manifest.webmanifest", "./logo/icon-192.png", "./logo/badge-96.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(Promise.all([
    caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))),
    self.clients.claim()
  ]));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request).then(response => response || caches.match("./"))));
});

self.addEventListener("push", event => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data ? event.data.text() : "候位進度已更新。" }; }
  const ticketId = String(payload.ticketId || "");
  const options = {
    body: payload.body || "預計約 5 分鐘後入席，請儘速前往餐廳。",
    icon: payload.icon || "./logo/icon-192.png",
    badge: payload.badge || "./logo/badge-96.png",
    vibrate: [300, 150, 300],
    requireInteraction: true,
    renotify: true,
    tag: payload.tag || `queue-${ticketId}`,
    data: {
      ticketId,
      url: payload.url || `./#ticket=${encodeURIComponent(ticketId)}&speak=1`,
      speakText: payload.speakText || payload.body || ""
    }
  };
  event.waitUntil(self.registration.showNotification(payload.title || "慶壽喜燒｜即將入席", options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "./", self.registration.scope);
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).pathname === target.pathname);
    if (existing) {
      await existing.navigate(target.href);
      await existing.focus();
      existing.postMessage({ type: "SPEAK_REMINDER", text: data.speakText || "" });
      return;
    }
    await clients.openWindow(target.href);
  })());
});
