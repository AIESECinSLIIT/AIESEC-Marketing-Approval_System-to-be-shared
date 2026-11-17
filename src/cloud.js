import { createClient } from "@supabase/supabase-js";
import { deleteCreativeFiles } from "./cleanup.js";
import { uploadMime, validateUploads } from "./uploads.js";
import { createSignedUrlCache } from "./signed-url-cache.js";
import { normalizeDriveLink } from "./workflow.js";

export const cloudEnabled = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY,
);
let activeAccount = null,
  activeProfile = null;
const profilePreference = (id) => {
  try {
    return localStorage.getItem("approval-profile:" + id);
  } catch {
    return null;
  }
};
function setProfile(id, persist = true) {
  activeProfile = id;
  signedCache.setScope(activeAccount + ":" + (id || ""));
  if (persist && activeAccount)
    try {
      localStorage.setItem("approval-profile:" + activeAccount, id);
    } catch {}
}
const signedCache = createSignedUrlCache();
const client = cloudEnabled
  ? createClient(
      import.meta.env.VITE_SUPABASE_URL,
      import.meta.env.VITE_SUPABASE_ANON_KEY,
      {
        global: {
          fetch: (input, init = {}) => {
            const headers = new Headers(
              init.headers ||
                (input instanceof Request ? input.headers : undefined),
            );
            if (activeProfile)
              headers.set(
                "x-client-info",
                "approval-hub approval-profile=" + activeProfile,
              );
            return fetch(input, { ...init, headers });
          },
        },
      },
    )
  : null;
const BUCKET = "creatives";
client?.auth.onAuthStateChange((_event, session) => {
  const id = session?.user.id || null;
  if (id !== activeAccount) {
    activeAccount = id;
    setProfile(id ? profilePreference(id) : null, false);
  }
});
function checked(result) {
  if (result.error) {
    const error = new Error(result.error.message || "Please try again.");
    error.status = ["PGRST301", "42501"].includes(result.error.code)
      ? 403
      : 400;
    throw error;
  }
  return result.data;
}
async function rpc(name, args) {
  return checked(await client.rpc(name, args));
}
async function currentUser() {
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) {
    const e = new Error("Please sign in to continue.");
    e.status = 401;
    throw e;
  }
  if (activeAccount !== data.user.id) {
    activeAccount = data.user.id;
    setProfile(profilePreference(activeAccount), false);
  }
  return data.user;
}
function decorateProfile(profile) {
  return {
    ...profile,
    logoUrl:
      profile.organization === "ENTITY"
        ? "/entity-logo.svg"
        : profile.logoPath
          ? client.storage.from("ig-logos").getPublicUrl(profile.logoPath).data
              .publicUrl
          : null,
  };
}
async function accountProfile(preferred, strict = false) {
  await currentUser();
  const { profiles: rows } = await rpc("club_profiles");
  const profiles = rows.map(decorateProfile);
  const requested = preferred || activeProfile;
  const selected =
    profiles.find((p) => p.id === requested) ||
    profiles.find((p) => p.id === activeAccount) ||
    profiles[0];
  if (!selected) {
    const e = new Error("No active profiles. Contact your administrator.");
    e.status = 401;
    throw e;
  }
  if (strict && preferred && !profiles.some((p) => p.id === preferred))
    throw new Error("This profile is unavailable.");
  setProfile(selected.id);
  return { ...decorateProfile(await rpc("club_me")), profiles };
}
async function signedPaths(paths) {
  return signedCache.resolve(paths, async (missing) =>
    checked(await client.storage.from(BUCKET).createSignedUrls(missing, 3600)),
  );
}
async function hydrateList(payload) {
  const submissions = payload.submissions || [];
  const urls = await signedPaths(submissions.map((s) => s.thumbnailPath));
  return {
    ...payload,
    submissions: submissions.map((s) => ({
      ...s,
      organizationLogoUrl: s.organizationLogoPath
        ? client.storage.from("ig-logos").getPublicUrl(s.organizationLogoPath)
            .data.publicUrl
        : null,
      thumbnailUrl: urls[s.thumbnailPath] || null,
    })),
  };
}
async function hydrateDetail(payload) {
  if (payload.submission?.cleanupRequestedAt) return { ...payload, files: [] };
  const urls = await signedPaths(
    (payload.files || []).map((f) => f.storagePath || f.path),
  );
  return {
    ...payload,
    files: (payload.files || []).map((f) => ({
      ...f,
      url: urls[f.storagePath || f.path],
    })),
    submission: {
      ...payload.submission,
      organizationLogoUrl: payload.submission.organizationLogoPath
        ? client.storage
            .from("ig-logos")
            .getPublicUrl(payload.submission.organizationLogoPath).data
            .publicUrl
        : null,
      thumbnailUrl: urls[payload.submission.thumbnailPath] || null,
    },
  };
}
async function uploadCreative(file, path, mime, onProgress) {
  if (file.size <= 6 * 1024 * 1024) {
    checked(
      await client.storage
        .from(BUCKET)
        .upload(path, file, { contentType: mime, upsert: false }),
    );
    onProgress(file.size);
    return;
  }
  const { uploadResumable } = await import("./resumable.js");
  const session = checked(await client.auth.getSession()).session;
  if (!session) throw new Error("Please sign in again before uploading.");
  await uploadResumable({
    file,
    path,
    mime,
    bucket: BUCKET,
    url: import.meta.env.VITE_SUPABASE_URL,
    key: import.meta.env.VITE_SUPABASE_ANON_KEY,
    token: session.access_token,
    onProgress,
  });
}
async function saveSubmission(id, form, onProgress = () => {}) {
  const user = await currentUser();
  const data = Object.fromEntries(
    [...form.entries()].filter(([key]) => key !== "files"),
  );
  if (data.version) data.version = Number(data.version);
  data.externalUrl = normalizeDriveLink(data.externalUrl);
  const uploads = form
    .getAll("files")
    .filter((f) => f instanceof File && f.size);
  validateUploads(uploads);
  const total = uploads.reduce((sum, f) => sum + f.size, 0);
  let completed = 0;
  const saved = [];
  const attempted = [];
  try {
    for (const file of uploads) {
      const mime = uploadMime(file);
      const fileId = crypto.randomUUID();
      const filename =
        file.name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) || "creative";
      const storagePath = `${user.id}/${fileId}/${filename}`;
      attempted.push(storagePath);
      await uploadCreative(file, storagePath, mime, (bytes) =>
        onProgress(
          Math.min(100, Math.round(((completed + bytes) * 100) / total)),
        ),
      );
      completed += file.size;
      saved.push({
        id: fileId,
        name: file.name.slice(0, 240),
        mime,
        size: file.size,
        path: storagePath,
      });
    }
    return await rpc("club_save", { p_id: id, p_data: data, p_files: saved });
  } catch (error) {
    // Storage deletion policy permits only unreferenced uploads. Committed
    // creatives remain intact even if a response is lost after a successful save.
    if (attempted.length) await client.storage.from(BUCKET).remove(attempted);
    throw error;
  }
}
async function manageUsers(action, values) {
  const result = await client.functions.invoke("manage-users", {
    body: { action, ...values },
  });
  if (result.error) {
    const details = await result.error.context?.json?.().catch(() => null);
    throw new Error(
      details?.error || result.error.message || "Could not save the account.",
    );
  }
  if (result.data?.error) throw new Error(result.data.error);
  return result.data;
}
async function invokeFunction(name, body) {
  const result = await client.functions.invoke(name, { body });
  if (result.error) {
    let message = result.error.message;
    try {
      message = (await result.error.context.json()).error || message;
    } catch {}
    throw new Error(message);
  }
  if (result.data?.error) throw new Error(result.data.error);
  return result.data;
}
async function groupList(all) {
  const data = await rpc("club_groups", { p_all: all });
  return {
    groups: data.groups.map((g) => ({
      ...g,
      logoUrl: client.storage.from("ig-logos").getPublicUrl(g.logoPath).data
        .publicUrl,
    })),
  };
}
async function saveGroup(id, form, remove = false) {
  let uploaded = null;
  let logo = form instanceof FormData ? form.get("logoPath") : null;
  const file = form instanceof FormData ? form.get("logo") : null;
  if (file?.size && !remove) {
    if (
      file.size > 2 * 1024 * 1024 ||
      !["image/png", "image/jpeg", "image/webp"].includes(file.type)
    )
      throw new Error("Use a PNG, JPG or WebP logo up to 2 MB.");
    const user = await currentUser();
    uploaded =
      user.id +
      "/" +
      crypto.randomUUID() +
      { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }[
        file.type
      ];
    checked(
      await client.storage
        .from("ig-logos")
        .upload(uploaded, file, { contentType: file.type, upsert: false }),
    );
    logo = uploaded;
  }
  try {
    return await rpc("club_group", {
      p_id: id,
      p_name: form instanceof FormData ? form.get("name") : "",
      p_logo: logo,
      p_active:
        form instanceof FormData ? form.get("active") !== "false" : false,
      p_delete: remove,
    });
  } catch (e) {
    if (uploaded) await client.storage.from("ig-logos").remove([uploaded]);
    throw e;
  }
}
export async function cloudApi(path, options = {}) {
  const method = options.method || "GET";
  const body =
    options.body instanceof FormData
      ? options.body
      : options.body
        ? JSON.parse(options.body)
        : {};
  if (path === "/config") return { demoMode: false, registrationEnabled: true };
  if (path === "/groups") return groupList(false);
  if (path === "/events") return rpc("club_events", { p_all: false });
  if (path === "/auth/register") {
    if (body.email?.trim().toLowerCase() === "admin@your-entity.example")
      throw new Error(
        "This email belongs to the administrator. Please sign in.",
      );
    if (body.role === "OCP") {
      const { events } = await rpc("club_events", { p_all: false });
      const event = events.find((e) => e.id === body.eventId);
      if (!event) throw new Error("Choose an ongoing event.");
      if (event.ocpAssigned)
        throw new Error(
          "This event already has an OCP account. Contact the admin if it needs to be changed.",
        );
    }
    const signup = checked(
      await client.auth.signUp({
        email: body.email,
        password: body.password,
        options: {
          data: {
            name: body.name,
            role: body.role,
            organization: body.organization,
            eventId: body.eventId,
          },
          emailRedirectTo: window.location.origin,
        },
      }),
    );
    if (signup.session) await client.auth.signOut({ scope: "local" });
    return {
      message: signup.session
        ? "Your account is ready. You can now sign in."
        : "Check your email and confirm your account, then sign in.",
    };
  }
  if (path === "/auth/login") {
    checked(await client.auth.signInWithPassword(body));
    const requested = new URLSearchParams(window.location.search).get(
      "profile",
    );
    return { user: await accountProfile(requested || undefined) };
  }
  if (path === "/auth/logout") {
    await (await import("./push.js")).disablePush();
    checked(await client.auth.signOut({ scope: "local" }));
    return { ok: true };
  }
  if (path === "/auth/me") {
    const requested = new URLSearchParams(window.location.search).get(
      "profile",
    );
    const user = await accountProfile(requested || undefined);
    if (requested) {
      const url = new URL(window.location.href);
      url.searchParams.delete("profile");
      history.replaceState(null, "", url);
    }
    return { user };
  }
  if (path === "/profiles/switch")
    return { user: await accountProfile(body.id, true) };
  if (path === "/profiles" && method === "POST") {
    await currentUser();
    const result = await rpc("club_add_profile", {
      p_role: body.role,
      p_organization: body.organization || "ENTITY",
      p_event: body.eventId || null,
    });
    return { user: await accountProfile(result.profile.id) };
  }
  if (path === "/auth/password") {
    const user = await currentUser();
    checked(
      await client.auth.signInWithPassword({
        email: user.email,
        password: body.currentPassword,
      }),
    );
    checked(await client.auth.updateUser({ password: body.newPassword }));
    return { ok: true };
  }
  await currentUser();
  if (path === "/admin/groups" && method === "GET") return groupList(true);
  if (path === "/admin/groups" && method === "POST")
    return saveGroup(null, body);
  const group = path.match(/^\/admin\/groups\/([^/]+)$/);
  if (group) return saveGroup(group[1], body, method === "DELETE");
  if (path === "/admin/events" && method === "GET")
    return rpc("club_events", { p_all: true });
  if (path === "/admin/events" && method === "POST")
    return rpc("club_event", {
      p_id: null,
      p_name: body.name,
      p_organization: body.organization || "ENTITY",
      p_active: body.active !== false,
      p_delete: false,
    });
  const event = path.match(/^\/admin\/events\/([^/]+)$/);
  if (event)
    return rpc("club_event", {
      p_id: event[1],
      p_name: body.name || "",
      p_organization: body.organization || null,
      p_active: body.active !== false,
      p_delete: method === "DELETE",
    });
  if (path === "/storage" && method === "GET") return rpc("club_storage");
  const cleanup = path.match(/^\/submissions\/([^/]+)\/creatives$/);
  if (cleanup && method === "DELETE")
    return deleteCreativeFiles(client, cleanup[1], body.version);
  if (path === "/submissions" && method === "GET")
    return hydrateList(await rpc("club_submissions"));
  if (path === "/submissions" && method === "POST")
    return saveSubmission(null, body, options.onUploadProgress);
  const review = path.match(/^\/submissions\/([^/]+)\/review$/);
  if (review && body.password)
    return invokeFunction("review-submission", { id: review[1], ...body });
  if (review)
    return rpc("club_review", {
      p_id: review[1],
      p_decision: body.decision,
      p_comment: body.comment || "",
      p_version: body.version,
    });
  const submission = path.match(/^\/submissions\/([^/]+)$/);
  if (submission)
    return method === "PUT"
      ? saveSubmission(submission[1], body, options.onUploadProgress)
      : hydrateDetail(await rpc("club_detail", { p_id: submission[1] }));
  if (path === "/notifications") return rpc("club_notifications");
  if (path === "/notifications/read") return rpc("club_read_notifications");
  if (path === "/push/status")
    return rpc("club_push_status", { p_endpoint: body.endpoint || "" });
  if (path === "/push/subscribe")
    return rpc("club_push_subscribe", { p_subscription: body.subscription });
  if (path === "/push/unsubscribe")
    return rpc("club_push_unsubscribe", { p_endpoint: body.endpoint });
  if (path === "/push/test")
    return rpc("club_push_test", { p_endpoint: body.endpoint });
  if (path === "/users" && method === "GET") return rpc("club_users");
  if (path === "/users" && method === "POST")
    return manageUsers("create", body);
  const account = path.match(/^\/users\/([^/]+)$/);
  if (account && method === "PATCH")
    return manageUsers("update", { ...body, id: account[1] });
  if (account && method === "DELETE")
    return manageUsers("delete", { id: account[1] });
  throw new Error("This action is unavailable.");
}
