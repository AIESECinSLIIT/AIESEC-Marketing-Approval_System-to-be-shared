import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import webpush from "web-push";
import {
  createPushHandler,
  safeEndpoint,
} from "../supabase/functions/send-push/handler.mjs";
import { uploadMime, validateUploads, MAX_FILE_SIZE } from "../src/uploads.js";

test("phone file types, empty/oversize/unsupported uploads and count limits", () => {
  assert.equal(
    uploadMime({ name: "recording.MOV", type: "" }),
    "video/quicktime",
  );
  for (const [name, type] of [
    ["film.mp4", "video/mp4"],
    ["film.mov", "video/quicktime"],
    ["film.webm", "video/webm"],
  ])
    assert.doesNotThrow(() =>
      validateUploads([{ name, type, size: MAX_FILE_SIZE }]),
    );
  assert.throws(() =>
    validateUploads([
      { name: "large.mp4", type: "video/mp4", size: MAX_FILE_SIZE + 1 },
    ]),
  );
  assert.throws(() =>
    validateUploads([{ name: "blank.mp4", type: "video/mp4", size: 0 }]),
  );
  assert.throws(() =>
    validateUploads([{ name: "bad.svg", type: "image/svg+xml", size: 10 }]),
  );
  assert.throws(() =>
    validateUploads(
      Array(9).fill({ name: "x.png", type: "image/png", size: 1 }),
    ),
  );
});
test("push authenticates the dispatcher, encrypts payloads and records retry/expiry status", async () => {
  const vapid = webpush.generateVAPIDKeys(),
    receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const secret = "a".repeat(64),
    calls = [],
    deliveries = [];
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/test",
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
  let httpStatus = 201;
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return {
        data:
          name === "club_push_config"
            ? { ...vapid, secret }
            : name === "club_claim_push"
              ? [
                  {
                    id: "job",
                    attempt: 1,
                    subscription,
                    payload: { body: "An update is available" },
                  },
                ]
              : null,
        error: null,
      };
    },
  };
  const handle = createPushHandler({
    client,
    webpush,
    fetcher: async (url, options) => {
      deliveries.push({ url, options });
      return new Response(null, { status: httpStatus });
    },
  });
  assert.equal(
    (await handle(new Request("https://example.test", { method: "POST" })))
      .status,
    401,
  );
  assert.equal(calls.length, 0);
  assert.equal(
    (
      await handle(
        new Request("https://example.test", {
          method: "POST",
          headers: { "X-Push-Secret": "b".repeat(64) },
        }),
      )
    ).status,
    401,
  );
  assert.equal(deliveries.length, 0);
  for (const status of [201, 410, 503]) {
    httpStatus = status;
    const result = await handle(
      new Request("https://example.test", {
        method: "POST",
        headers: { "X-Push-Secret": secret },
      }),
    );
    assert.equal(result.status, 200);
    assert.equal(calls.at(-1)[1].p_status, status);
  }
  assert.equal(deliveries[0].options.headers["Content-Encoding"], "aes128gcm");
  assert.ok(
    !Buffer.from(deliveries[0].options.body).includes(
      Buffer.from("An update is available"),
    ),
  );
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.attacker.test/x",
    "https://user@fcm.googleapis.com/x",
    "https://fcm.googleapis.com:444/x",
  ])
    assert.equal(safeEndpoint(endpoint), false);
});
