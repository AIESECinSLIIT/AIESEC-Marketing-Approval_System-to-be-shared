const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error(
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Netlify before deploying. The local SQLite server is not a hosted backend.",
  );
  process.exit(1);
}
try {
  if (new URL(url).protocol !== "https:") throw new Error();
} catch {
  console.error("VITE_SUPABASE_URL must be an HTTPS project URL.");
  process.exit(1);
}
if (key.startsWith("sb_secret_")) {
  console.error(
    "Use a publishable or anon key, never a server secret in VITE_ variables.",
  );
  process.exit(1);
}
try {
  const payload = JSON.parse(
    Buffer.from(key.split(".")[1] || "", "base64url").toString(),
  );
  if (payload.role === "service_role") throw new Error("service-role");
} catch (e) {
  if (e.message === "service-role") {
    console.error("A service-role key must never be exposed to the browser.");
    process.exit(1);
  }
}
console.log("Public cloud configuration is present.");
