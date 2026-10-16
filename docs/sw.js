// Caches only the static app shell. Supabase/API responses (financial data)
// are cross-origin and never cached.
const CACHE = "vat-shell-v5";
const SHELL = ["./", "index.html", "styles.css", "script.js", "calc.js", "config.js", "motion.js", "sheet.js", "ptr.js",
  "manifest.webmanifest", "icon.svg", "icon-180.png", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

// Network-first so deploys show up immediately; cache is the offline fallback.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request)),
  );
});

// Push notifications from the sync-mydata function (new documents, VAT deadline).
self.addEventListener("push", (e) => {
  let msg = { title: "Ισοζύγιο ΦΠΑ", body: "" };
  try {
    msg = { ...msg, ...e.data.json() };
  } catch (_) {
    if (e.data) msg.body = e.data.text();
  }
  e.waitUntil(self.registration.showNotification(msg.title, {
    body: msg.body,
    tag: msg.tag,
    icon: "icon-192.png",
    badge: "icon-192.png",
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => c.url.startsWith(self.registration.scope));
    if (open) return open.focus();
    return self.clients.openWindow("./");
  })());
});
