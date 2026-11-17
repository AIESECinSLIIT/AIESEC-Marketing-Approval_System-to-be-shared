import { createClient } from "npm:@supabase/supabase-js@2.119.0";

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers });
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers });
  if (req.method !== "POST")
    return response({ error: "Method not allowed" }, 405);
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = createClient(
    url,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const token = req.headers.get("Authorization")?.replace(/^Bearer /i, "");
  if (!token) return response({ error: "Sign in first." }, 401);
  const { data: identity, error: authError } =
    await service.auth.getUser(token);
  if (authError || !identity.user)
    return response({ error: "Invalid session." }, 401);
  const caller = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-client-info": req.headers.get("x-client-info") || "approval-hub",
      },
    },
    auth: { persistSession: false },
  });
  const { data: admin, error: profileError } = await caller.rpc("club_me");
  if (
    profileError ||
    !["ADMIN", "EM_VP", "IGP"].includes(admin?.role) ||
    !admin.active
  )
    return response({ error: "Administrator access required." }, 403);
  try {
    const body = await req.json();
    if (!["create", "update", "delete"].includes(body.action))
      throw new Error("Invalid action.");
    const checked = <T>(result: { data: T; error: unknown }): T => {
      if (result.error) throw result.error;
      return result.data;
    };
    const rpc = async (name: string, args: Record<string, unknown>) =>
      checked(await service.rpc(name, args));
    const { users } = checked(await caller.rpc("club_users"));
    const target = users.find((u: { id: string }) => u.id === body.id);
    if (body.action !== "create" && !target)
      throw new Error("Account not found.");
    if (body.action === "delete") {
      const job = await rpc("club_remove_account", {
        p_actor: admin.id,
        p_id: body.id,
        p_finish: false,
      });
      for (let i = 0; i < job.paths.length; i += 100)
        checked(
          await service.storage
            .from("creatives")
            .remove(job.paths.slice(i, i + 100)),
        );
      if (job.deleteAuth) {
        const deleted = await service.auth.admin.deleteUser(job.accountId);
        if (
          deleted.error &&
          deleted.error.status !== 404 &&
          deleted.error.code !== "user_not_found"
        )
          throw deleted.error;
      }
      await rpc("club_remove_account", {
        p_actor: admin.id,
        p_id: body.id,
        p_finish: true,
      });
      return response({ ok: true });
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const roles = [
      "CREATOR",
      "EM_VP",
      "IGP",
      "EVENT_MANAGER",
      "OCP",
      "MARKETING_MEMBER",
      "B2C_MEMBER",
      "MARKETING_VP",
      "B2C_VP",
      "IGVP_MARKETING",
      "IGVP_OGV",
      "ADMIN",
    ];
    if (!name || name.length > 100 || !roles.includes(body.role))
      throw new Error("Enter a name and valid role.");
    if (
      body.password !== undefined &&
      (typeof body.password !== "string" ||
        body.password.length < 12 ||
        body.password.length > 200)
    )
      throw new Error("Use a password of 12–200 characters.");
    if (body.active !== undefined && typeof body.active !== "boolean")
      throw new Error("Invalid account status.");
    const email =
      typeof body.email === "string"
        ? body.email.trim().toLowerCase()
        : target?.email;
    if (
      !email ||
      email.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    )
      throw new Error("Enter a valid email address.");
    let organization = body.organization || target?.organization || "ENTITY";
    let eventId = body.eventId || null;
    if (["CREATOR", "OCP", "EVENT_MANAGER"].includes(body.role)) {
      const { events } = checked(
        await caller.rpc("club_events", { p_all: true }),
      );
      if (
        !(body.active === false && !eventId) &&
        !events.some(
          (e: { id: string; active: boolean }) =>
            e.id === eventId && (e.active || target?.eventId === eventId),
        )
      )
        throw new Error("Choose an ongoing event.");
      organization =
        events.find((e: { id: string }) => e.id === eventId)?.organization ||
        organization;
    } else eventId = null;
    if (["ADMIN", "EM_VP", "MARKETING_VP", "B2C_VP"].includes(body.role))
      organization = "ENTITY";
    await rpc("club_authorize_account", {
      p_actor: admin.id,
      p_target: target?.id || null,
      p_role: body.role,
      p_organization: organization,
      p_event: eventId,
    });
    const profileArgs = (id: string, details: any) => ({
      p_actor: admin.id,
      p_id: id,
      p_name: details.name,
      p_role: details.role,
      p_active: details.active !== false,
      p_organization: details.organization,
      p_event: details.eventId || null,
      p_email: details.email,
    });
    const details = {
      name,
      email,
      role: body.role,
      active: body.active !== false,
      organization,
      eventId,
    };
    let id = body.id;
    if (body.action === "create") {
      const existing = await rpc("club_find_account", {
        p_actor: admin.id,
        p_email: email,
      });
      if (existing) {
        if (details.active)
          checked(
            await service.auth.admin.updateUserById(existing, {
              ban_duration: "none",
            }),
          );
        id = await rpc("club_add_managed_profile", {
          p_actor: admin.id,
          p_account: existing,
          p_name: name,
          p_role: body.role,
          p_active: details.active,
          p_organization: organization,
          p_event: eventId,
        });
        // Adding a profile never changes an existing person's password.
      } else {
        if (!body.password)
          throw new Error("Enter an initial password for this new login.");
        const created = checked(
          await service.auth.admin.createUser({
            email,
            password: body.password,
            email_confirm: true,
            user_metadata: { name, role: "MARKETING_MEMBER", organization },
          }),
        );
        id = created.user.id;
        try {
          await rpc("club_appoint_account", profileArgs(id, details));
          if (!details.active)
            checked(
              await service.auth.admin.updateUserById(id, {
                ban_duration: "876000h",
              }),
            );
        } catch (error) {
          await rpc("club_delete_account", { p_id: id, p_finish: false });
          checked(await service.auth.admin.deleteUser(id));
          await rpc("club_delete_account", { p_id: id, p_finish: true });
          throw error;
        }
      }
    } else {
      const access = await rpc("club_login_access", {
        p_actor: admin.id,
        p_target: id,
      });
      if ((email !== target.email || body.password) && !access.canManageLogin)
        throw new Error(
          "This person has other profiles outside your access. Ask the super admin to change their login email or password.",
        );
      await rpc("club_administer_account", profileArgs(id, details));
      const updatedAccess = await rpc("club_login_access", {
        p_actor: admin.id,
        p_target: id,
      });
      try {
        checked(
          await service.auth.admin.updateUserById(access.accountId, {
            ...(email !== target.email ? { email, email_confirm: true } : {}),
            ...(body.password ? { password: body.password } : {}),
            ban_duration: updatedAccess.active ? "none" : "876000h",
          }),
        );
      } catch (error) {
        await rpc("club_administer_account", profileArgs(id, target));
        throw error;
      }
    }
    return response({ ok: true, id });
  } catch (error) {
    return response(
      {
        error:
          error instanceof Error
            ? error.message
            : (error as { message?: string })?.message ||
              "Account could not be saved.",
      },
      400,
    );
  }
});
