// Push only: never cache private pages, credentials or creative files.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data?.json() || {};
  } catch {}
  const target = new URL(
    payload.url || "/?notifications=1",
    self.location.origin,
  );
  event.waitUntil(
    self.registration.showNotification(
      typeof payload.title === "string"
        ? payload.title.slice(0, 100)
        : "Approval Hub",
      {
        body: payload.body || "You have a new update.",
        icon: "/icons/icon-192.png",
        badge: "/icons/badge.png",
        tag: payload.tag || "approval-hub",
        data: {
          url:
            target.origin === self.location.origin
              ? target.href
              : self.location.origin,
        },
      },
    ),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const target = new URL(
        event.notification.data?.url || "/",
        self.location.origin,
      );
      if (target.origin !== self.location.origin) return;
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windows) {
        if (
          new URL(client.url).origin === target.origin &&
          "navigate" in client
        ) {
          await client.navigate(target.href);
          await client.focus();
          return;
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
