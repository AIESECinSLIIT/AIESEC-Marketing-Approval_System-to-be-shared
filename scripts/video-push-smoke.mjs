// Explicit opt-in integration check; fixture credentials stay in ignored local storage.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes, randomUUID, createECDH } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { uploadResumable } from "../src/resumable.js";
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to test the configured project.");
const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, "")];
    }),
);
const client = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false },
});
const file = ".supabase/video-push-fixture.json";
const checked = (r) => {
  if (r.error) throw r.error;
  return r.data;
};
if (process.argv.includes("--cleanup-storage")) {
  const fixture = JSON.parse(readFileSync(file, "utf8"));
  checked(
    await client.auth.signInWithPassword({
      email: fixture.email,
      password: fixture.password,
    }),
  );
  checked(await client.storage.from("creatives").remove(fixture.paths));
  console.log(JSON.stringify({ storageRemoved: true, userId: fixture.userId }));
  process.exit(0);
}
const fixture = {
  email: `push-video-qa-${randomUUID()}@example.com`,
  password: randomBytes(32).toString("base64url"),
  paths: [],
};
const signup = checked(
  await client.auth.signUp({
    email: fixture.email,
    password: fixture.password,
    options: { data: { name: "Temporary video/push check" } },
  }),
);
fixture.userId = signup.user.id;
mkdirSync(".supabase", { recursive: true });
const save = () =>
  writeFileSync(file, JSON.stringify(fixture), { mode: 0o600 });
save();
console.log(JSON.stringify({ createdFixture: fixture.userId }));
const files = [];
for (const [extension, mime, size] of [
  ["mov", "video/quicktime", 27 * 1024 * 1024],
  ["mp4", "video/mp4", 1024],
  ["webm", "video/webm", 1024],
]) {
  const path = `${fixture.userId}/${randomUUID()}/test.${extension}`;
  fixture.paths.push(path);
  save();
  const buffer = Buffer.alloc(size); // Synthetic storage fixture; no claim of codec playback validation.
  if (extension === "webm") Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).copy(buffer);
  else {
    buffer.writeUInt32BE(24);
    buffer.write("ftyp", 4);
    buffer.write(extension === "mov" ? "qt  " : "isom", 8);
  }
  let progress = 0;
  if (size > 6 * 1024 * 1024)
    await uploadResumable({
      file: buffer,
      path,
      mime,
      bucket: "creatives",
      url: env.VITE_SUPABASE_URL,
      key: env.VITE_SUPABASE_ANON_KEY,
      token: signup.session.access_token,
      onProgress: (n) => {
        progress = n;
      },
    });
  else
    checked(
      await client.storage
        .from("creatives")
        .upload(path, buffer, { contentType: mime }),
    );
  if (size > 6 * 1024 * 1024) assert.equal(progress, size);
  files.push({ path, name: `test.${extension}`, mime, size });
  console.log(JSON.stringify({ uploaded: extension, bytes: size }));
}
const draft = checked(
  await client.rpc("club_save", {
    p_id: null,
    p_data: {
      title: "Temporary video check",
      event: "QA",
      category: "MARKETING",
      status: "DRAFT",
      contentType: "Video / reel",
      platform: "Instagram",
      caption: "Temporary verification",
      notes: "",
    },
    p_files: files,
  }),
);
fixture.submissionId = draft.submission.id;
save();
assert.equal(draft.submission.fileCount, 3);
const signed = checked(
  await client.storage.from("creatives").createSignedUrl(files[0].path, 60),
);
const ranged = await fetch(signed.signedUrl, {
  headers: { Range: "bytes=0-31" },
});
assert.equal(ranged.status, 206);
await ranged.body.cancel();
const status = checked(
  await client.rpc("club_push_status", { p_endpoint: "" }),
);
assert.ok(status.publicKey);
const denied = await client.rpc("club_push_config");
assert.ok(denied.error);
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const subscription = {
  endpoint: `https://fcm.googleapis.com/fcm/send/invalid-qa-${randomUUID()}`,
  keys: {
    p256dh: ecdh.getPublicKey().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  },
};
checked(
  await client.rpc("club_push_subscribe", { p_subscription: subscription }),
);
checked(
  await client.rpc("club_push_test", { p_endpoint: subscription.endpoint }),
);
const unauthorized = await fetch(
  `${env.VITE_SUPABASE_URL}/functions/v1/send-push`,
  { method: "POST" },
);
assert.equal(unauthorized.status, 401);
console.log(
  JSON.stringify({
    passed: true,
    userId: fixture.userId,
    submissionId: fixture.submissionId,
    checks: [
      "27MB MOV resumable upload and progress",
      "MP4/WebM uploads",
      "private draft persistence",
      "video range requests",
      "push subscription/test enqueue",
      "secret access denied",
      "webhook authentication",
    ],
  }),
);
