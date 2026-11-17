import { createClient } from "npm:@supabase/supabase-js@2.119.0";
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST") return reply({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!,
    key = Deno.env.get("SUPABASE_ANON_KEY")!;
  const token = req.headers.get("Authorization")?.replace(/^Bearer /i, "");
  if (!token) return reply({ error: "Sign in first." }, 401);
  const caller = createClient(url, key, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-client-info": req.headers.get("x-client-info") || "approval-hub",
      },
    },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: identity, error: authError } = await caller.auth.getUser(token);
  if (authError || !identity.user)
    return reply({ error: "Invalid session." }, 401);
  try {
    const { id, decision, comment, version, password } = await req.json();
    const { data: user, error } = await caller.rpc("club_me");
    if (error) throw error;
    if (user.role !== "ADMIN" || user.email !== "admin@your-entity.example")
      return reply({ error: "Supreme administrator required." }, 403);
    if (typeof password !== "string" || password.length > 200)
      return reply({ error: "Enter your administrator password." }, 400);
    const verifier = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const verified = await verifier.auth.signInWithPassword({
      email: user.email,
      password,
    });
    if (verified.error || verified.data.user?.id !== user.accountId)
      return reply({ error: "Administrator password is incorrect." }, 403);
    // Revoke only this short-lived verification session, leaving the app session intact.
    await verifier.auth.signOut({ scope: "local" });
    const service = createClient(
      url,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
    const proof = await service.rpc("club_authorize_override", {
      p_actor: user.id,
      p_id: id,
      p_version: version,
      p_decision: decision,
    });
    if (proof.error) throw proof.error;
    const result = await caller.rpc("club_review_verified", {
      p_id: id,
      p_decision: decision,
      p_comment: comment || "",
      p_version: version,
      p_proof: proof.data,
    });
    if (result.error) throw result.error;
    return reply(result.data);
  } catch (e) {
    return reply(
      { error: (e as Error).message || "Decision could not be recorded." },
      400,
    );
  }
});
