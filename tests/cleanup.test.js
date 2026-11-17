import { test } from "node:test";
import assert from "node:assert/strict";
import { deleteCreativeFiles } from "../src/cleanup.js";

test("cleanup deletes physical objects in bounded batches before finalizing", async () => {
  const calls = [],
    paths = Array.from({ length: 205 }, (_, i) => `owner/file-${i}`);
  const client = {
    rpc: async (name, args) => {
      calls.push([name, args]);
      return {
        data:
          name === "club_begin_cleanup"
            ? { jobId: "job", paths, completedAt: null }
            : { ok: true, filesDeleted: 205, bytesFreed: 2050 },
      };
    },
    storage: {
      from: (bucket) => ({
        remove: async (items) => {
          assert.equal(bucket, "creatives");
          calls.push(["remove", items]);
          return { data: items };
        },
      }),
    },
  };
  const result = await deleteCreativeFiles(client, "post", 4);
  assert.equal(result.filesDeleted, 205);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["club_begin_cleanup", "remove", "remove", "remove", "club_finish_cleanup"],
  );
  assert.deepEqual(
    calls.filter((c) => c[0] === "remove").map((c) => c[1].length),
    [100, 100, 5],
  );
});
test("storage failure leaves cleanup pending for a retry; denied requests delete nothing", async () => {
  let removed = 0,
    finished = 0,
    denied = false;
  const client = {
    rpc: async (name) => {
      if (name === "club_begin_cleanup")
        return denied
          ? { error: { message: "Not permitted" } }
          : { data: { jobId: "job", paths: ["file"] } };
      finished++;
      return { data: { ok: true } };
    },
    storage: {
      from: () => ({
        remove: async () => {
          removed++;
          return { error: { message: "Connection failed" } };
        },
      }),
    },
  };
  await assert.rejects(
    deleteCreativeFiles(client, "post", 1),
    /Connection failed/,
  );
  assert.equal(removed, 1);
  assert.equal(finished, 0);
  denied = true;
  await assert.rejects(deleteCreativeFiles(client, "post", 1), /Not permitted/);
  assert.equal(removed, 1);
});
