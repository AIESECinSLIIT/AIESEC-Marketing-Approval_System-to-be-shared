import { api, json } from "./lib.jsx";

export const pushAvailable = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
export function pushSupport() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (
    ios &&
    !window.matchMedia("(display-mode: standalone)").matches &&
    !navigator.standalone
  )
    return "On iPhone or iPad, use Share → Add to Home Screen, then open the app from that icon.";
  if (
    !window.isSecureContext ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !("Notification" in window)
  )
    return "Push notifications are unavailable in this browser. Try an updated Safari, Chrome, Edge or Firefox.";
  return "";
}
export async function pushRegistration() {
  await navigator.serviceWorker.register("/sw.js");
  return navigator.serviceWorker.ready;
}
export async function pushStatus() {
  const registration = await pushRegistration();
  const subscription = await registration.pushManager.getSubscription();
  const status = await api(
    "/push/status",
    json("POST", { endpoint: subscription?.endpoint }),
  );
  return {
    ...status,
    enabled: Boolean(
      subscription && status.enabled && Notification.permission === "granted",
    ),
  };
}
export async function enablePush(publicKey) {
  // Called directly from a button: iOS requires a user gesture for the prompt.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error(
      "Notifications were not allowed. Enable them in your browser or device settings.",
    );
  const registration = await pushRegistration();
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) await subscription.unsubscribe();
  const padded =
    publicKey.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (publicKey.length % 4)) % 4);
  subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)),
  });
  try {
    await api(
      "/push/subscribe",
      json("POST", { subscription: subscription.toJSON() }),
    );
  } catch (error) {
    await subscription.unsubscribe();
    throw error;
  }
}
export async function disablePush() {
  if (!("serviceWorker" in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration("/");
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription) return;
  await subscription.unsubscribe();
  // Even if the session has expired, the browser endpoint is now revoked.
  await api(
    "/push/unsubscribe",
    json("POST", { endpoint: subscription.endpoint }),
  ).catch(() => {});
  for (const notification of await registration.getNotifications())
    notification.close();
}
export async function testPush() {
  const registration = await pushRegistration();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) throw new Error("Enable notifications first.");
  await api("/push/test", json("POST", { endpoint: subscription.endpoint }));
}
