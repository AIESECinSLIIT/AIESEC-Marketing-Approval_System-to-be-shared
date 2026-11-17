// Opt-in live integration fixture. Never selects or deletes real club submissions.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { deleteCreativeFiles } from "../src/cleanup.js";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to test the configured project.");
const file = ".supabase/cleanup-fixture.json";
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const make = () =>
  createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const checked = (r) => {
  if (r.error) throw r.error;
  return r.data;
};
if (process.argv.includes("--setup")) {
  const state = { accounts: [], paths: [] };
  mkdirSync(".supabase", { recursive: true });
  const save = () =>
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
  for (const role of ["CREATOR", "MARKETING_VP", "B2C_VP"]) {
    const client = make(),
      email = `cleanup-qa-${randomUUID()}@example.com`,
      password = randomBytes(32).toString("base64url");
    const signup = checked(
      await client.auth.signUp({
        email,
        password,
        options: { data: { name: "Temporary cleanup check" } },
      }),
    );
    state.accounts.push({ id: signup.user.id, email, password, role });
    save();
    if (role === "CREATOR") {
      const path = `${signup.user.id}/${randomUUID()}/cleanup.png`;
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      );
      state.paths.push(path);
      save();
      checked(
        await client.storage
          .from("creatives")
          .upload(path, png, { contentType: "image/png" }),
      );
      const post = {
        title: "Temporary storage cleanup verification",
        event: "QA",
        category: "MARKETING",
        status: "DRAFT",
        contentType: "Social post",
        platform: "Instagram",
        caption: "Retain this caption",
        notes: "",
      };
      const draft = checked(
        await client.rpc("club_save", {
          p_id: null,
          p_data: post,
          p_files: [{ path, name: "cleanup.png", mime: "image/png" }],
        }),
      );
      state.submissionId = draft.submission.id;
      save();
      checked(
        await client.rpc("club_save", {
          p_id: state.submissionId,
          p_data: { ...post, version: 1 },
          p_files: [],
        }),
      );
      state.signedUrl = checked(
        await client.storage.from("creatives").createSignedUrl(path, 600),
      ).signedUrl;
      save();
    }
  }
  console.log(
    JSON.stringify({
      accounts: state.accounts.map(({ id, role }) => ({ id, role })),
      submissionId: state.submissionId,
      paths: state.paths,
    }),
  );
} else {
  const state = JSON.parse(readFileSync(file, "utf8")),
    clients = {};
  for (const account of state.accounts) {
    const client = make();
    checked(
      await client.auth.signInWithPassword({
        email: account.email,
        password: account.password,
      }),
    );
    clients[account.role] = client;
  }
  if (process.argv.includes("--cleanup-storage")) {
    checked(
      await clients.CREATOR.storage.from("creatives").remove(state.paths),
    );
    console.log("Fixture storage removed");
    process.exit(0);
  }
  assert.ok(
    (
      await clients.CREATOR.rpc("club_begin_cleanup", {
        p_id: state.submissionId,
        p_version: 3,
      })
    ).error,
  );
  assert.ok(
    (
      await clients.B2C_VP.rpc("club_begin_cleanup", {
        p_id: state.submissionId,
        p_version: 3,
      })
    ).error,
  );
  assert.ok(
    (
      await clients.MARKETING_VP.rpc("club_begin_cleanup", {
        p_id: state.submissionId,
        p_version: 2,
      })
    ).error,
  );
  const list = checked(await clients.MARKETING_VP.rpc("club_storage"));
  const row = list.submissions.find((s) => s.id === state.submissionId);
  assert.equal(row.fileCount, 1);
  const result = await deleteCreativeFiles(
    clients.MARKETING_VP,
    state.submissionId,
    3,
  );
  assert.equal(result.filesDeleted, 1);
  assert.equal(result.bytesFreed, row.bytes);
  const detail = checked(
    await clients.CREATOR.rpc("club_detail", { p_id: state.submissionId }),
  );
  assert.equal(detail.files.length, 0);
  assert.equal(detail.submission.caption, "Retain this caption");
  assert.equal(detail.revisions.length, 2);
  assert.ok(detail.submission.creativesDeletedAt);
  assert.ok(detail.history.some((h) => h.action === "CREATIVES_DELETED"));
  const signed = await clients.CREATOR.storage
    .from("creatives")
    .createSignedUrl(state.paths[0], 60);
  assert.ok(signed.error);
  assert.equal(
    (await deleteCreativeFiles(clients.MARKETING_VP, state.submissionId, 3))
      .filesDeleted,
    0,
  );
  console.log(
    JSON.stringify({
      passed: true,
      filesDeleted: result.filesDeleted,
      bytesFreed: result.bytesFreed,
      checks: [
        "creator denied",
        "other category denied",
        "stale version denied",
        "duplicate revision paths counted once",
        "physical Storage API deletion",
        "history and captions retained",
        "retry idempotency",
      ],
    }),
  );
}
