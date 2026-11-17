// Explicit live QA: creates disposable accounts only; prints no credentials.
// prepare -> trusted operator promotes the returned account -> verify.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
const url = process.env.VITE_SUPABASE_URL,
  key = process.env.VITE_SUPABASE_ANON_KEY;
if (!url || !key)
  throw Error("Set the target project URL and public key explicitly.");
const client = () =>
  createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const checked = ({ data, error }) => {
  if (error) throw error;
  return data;
};
if (process.argv[2] === "prepare") {
  const suffix = randomBytes(8).toString("hex");
  const state = {
    url,
    email: `qa-admin-${suffix}@example.com`,
    password: randomBytes(24).toString("base64url"),
    childEmail: `qa-member-${suffix}@example.com`,
  };
  const c = client();
  const data = checked(
    await c.auth.signUp({
      email: state.email,
      password: state.password,
      options: {
        data: { name: "Release QA temporary admin", role: "MARKETING_MEMBER" },
      },
    }),
  );
  assert.ok(data.session);
  state.adminId = data.user.id;
  const file = mkdtempSync("/private/tmp/approval-admin-qa-") + "/state.json";
  writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  console.log(
    JSON.stringify({
      stateFile: file,
      adminId: state.adminId,
      email: state.email,
    }),
  );
} else if (process.argv[2] === "verify") {
  const file = process.argv[3];
  const state = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(state.url, url);
  const admin = client();
  checked(
    await admin.auth.signInWithPassword({
      email: state.email,
      password: state.password,
    }),
  );
  assert.equal(checked(await admin.rpc("club_me")).role, "ADMIN");
  const action = async (body) =>
    checked(await admin.functions.invoke("manage-users", { body }));
  try {
    const created = await action({
      action: "create",
      name: "Release QA member",
      email: state.childEmail,
      password: state.password,
      role: "B2C_MEMBER",
      organization: "EXAMPLE_IG",
    });
    state.childId = created.id;
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    const member = client();
    checked(
      await member.auth.signInWithPassword({
        email: state.childEmail,
        password: state.password,
      }),
    );
    let profile = checked(await member.rpc("club_me"));
    assert.equal(profile.organization, "EXAMPLE_IG");
    assert.equal(profile.role, "B2C_MEMBER");
    assert.ok(
      (
        await member.functions.invoke("manage-users", {
          body: { action: "create", role: "ADMIN" },
        })
      ).error,
    );
    await action({
      action: "update",
      id: state.childId,
      name: "Release QA IGVP",
      email: state.childEmail,
      role: "IGVP_OGV",
      organization: "ENTITY",
      active: true,
    });
    profile = checked(await member.rpc("club_me"));
    assert.equal(profile.role, "IGVP_OGV");
    assert.equal(profile.organization, "EXAMPLE_IG");
    const object = state.childId + "/qa-image.png";
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    checked(
      await member.storage
        .from("creatives")
        .upload(object, image, { contentType: "image/png" }),
    );
    await action({
      action: "update",
      id: state.childId,
      name: "Release QA IGVP",
      email: state.childEmail,
      role: "IGVP_OGV",
      active: false,
    });
    assert.ok((await member.rpc("club_me")).error);
    assert.ok(
      (
        await client().auth.signInWithPassword({
          email: state.childEmail,
          password: state.password,
        })
      ).error,
    );
    await action({
      action: "update",
      id: state.childId,
      name: "Release QA member restored",
      email: state.childEmail,
      role: "MARKETING_MEMBER",
      organization: "ENTITY",
      active: true,
    });
    checked(
      await member.auth.signInWithPassword({
        email: state.childEmail,
        password: state.password,
      }),
    );
    assert.equal(checked(await member.rpc("club_me")).role, "MARKETING_MEMBER");
    await action({ action: "delete", id: state.childId });
    assert.ok((await member.rpc("club_me")).error);
    assert.ok(
      (await member.storage.from("creatives").createSignedUrl(object, 60))
        .error,
    );
    assert.ok(
      !checked(await admin.rpc("club_users")).users.some(
        (u) => u.id === state.childId,
      ),
    );
    state.childDeleted = true;
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    console.log(
      "PASS: live admin creation, forced EXAMPLE_IG routing, non-admin denial, role edits, disable/re-enable, private upload and account/file deletion.",
    );
  } finally {
    if (state.childId && !state.childDeleted)
      await action({ action: "delete", id: state.childId });
    await action({ action: "delete", id: state.adminId });
    console.log(
      JSON.stringify({
        cleanupIds: [state.adminId, state.childId].filter(Boolean),
      }),
    );
  }
} else throw Error("Choose prepare or verify; no action taken.");
