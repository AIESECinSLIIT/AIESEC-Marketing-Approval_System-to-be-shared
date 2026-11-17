import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignedUrlCache } from "../src/signed-url-cache.js";
test("signed URLs stay stable until expiry and never cross account switches", async () => {
  let time = 0,
    calls = 0;
  const cache = createSignedUrlCache({ ttl: 100, now: () => time });
  cache.setScope("a");
  const sign = async (paths) => {
    calls++;
    return paths.map((path) => ({
      path,
      signedUrl: `signed-${calls}-${path}`,
    }));
  };
  const first = await cache.resolve(["one", "one", null], sign);
  assert.deepEqual(await cache.resolve(["one"], sign), first);
  assert.equal(calls, 1);
  time = 101;
  assert.notDeepEqual(await cache.resolve(["one"], sign), first);
  assert.equal(calls, 2);
  cache.setScope("b");
  await cache.resolve(["one"], sign);
  assert.equal(calls, 3);
  let release;
  const old = cache.resolve(
    ["two"],
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  cache.setScope(null);
  cache.setScope("c");
  release([{ path: "two", signedUrl: "old-account" }]);
  await old;
  assert.notEqual((await cache.resolve(["two"], sign)).two, "old-account");
  assert.equal(calls, 4);
  assert.deepEqual(await cache.resolve([], sign), {});
});
