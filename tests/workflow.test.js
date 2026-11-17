import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const ADMIN_EMAIL = "admin@your-entity.example";
const TEST_PASSWORD = "Workflow-Test-Password123!";

// Exercise production bootstrap using environment configuration, restoring it
// immediately so independent app instances never inherit test credentials.
function configuredApp(
  options,
  password = TEST_PASSWORD,
  name = "Test Administrator",
  environment = {},
) {
  const previous = {
    ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
    ADMIN_NAME: process.env.ADMIN_NAME,
    ...Object.fromEntries(
      Object.keys(environment).map((key) => [key, process.env[key]]),
    ),
  };
  if (password === null) delete process.env.ADMIN_PASSWORD;
  else process.env.ADMIN_PASSWORD = password;
  process.env.ADMIN_NAME = name;
  Object.assign(process.env, environment);
  try {
    return createApp(options);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function testApp(
  t,
  { bootstrap = true, environment = {}, remoteAddress } = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "approval-hub-test-"));
  const service = configuredApp(
    {
      databasePath: path.join(dir, "test.sqlite"),
      uploadDir: path.join(dir, "uploads"),
    },
    bootstrap ? TEST_PASSWORD : null,
    "Test Administrator",
    { NODE_ENV: "development", ...environment },
  );
  if (remoteAddress) {
    const originalHandle = service.app.handle;
    t.mock.method(service.app, "handle", function (req, res, next) {
      Object.defineProperty(req.socket, "remoteAddress", {
        value: remoteAddress,
        configurable: true,
      });
      return originalHandle.call(this, req, res, next);
    });
  }
  const server = service.app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(
    endpoint,
    { cookie, method = "GET", body, headers = {} } = {},
  ) {
    const response = await fetch(base + "/api" + endpoint, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body && !(body instanceof FormData)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body:
        body instanceof FormData
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
    return {
      status: response.status,
      body: await response.json().catch(() => null),
      headers: response.headers,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  async function login(email, password = TEST_PASSWORD) {
    const r = await request("/auth/login", {
      method: "POST",
      body: { email, password },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r;
  }
  async function register(email, extra = {}) {
    const r = await request("/auth/register", {
      method: "POST",
      body: { name: "Test OCVP", email, password: TEST_PASSWORD, ...extra },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.role, ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"].includes(extra.role) ? extra.role : "MARKETING_MEMBER");
    assert.ok(r.cookie);
    assert.equal(r.body.user.password_hash, undefined);
    return r;
  }
  return { dir, service, base, request, login, register };
}

test("approval workflow, authorization, version history, and account access", async (t) => {
  const { dir, request, login, register, base } = await testApp(t);
  function form({
    category = "MARKETING",
    status = "PENDING",
    version,
    caption = "Join our upcoming event. #AIESEC",
    file = true,
    title = "Test creative",
    badFile = false,
  } = {}) {
    const f = new FormData();
    for (const [k, v] of Object.entries({
      title,
      event: "Test Event",
      category,
      status,
      contentType: "Social post",
      platform: "Instagram",
      caption,
      notes: "For integration testing",
      scheduledAt: "2026-12-01T09:00:00.000Z",
      ...(version ? { version } : {}),
    }))
      f.append(k, v);
    if (file)
      f.append(
        "files",
        new Blob([badFile ? "not a real image" : png], { type: "image/png" }),
        "creative.png",
      );
    return f;
  }
  const admin = await login(ADMIN_EMAIL);
  for (const [name, email, role] of [
    ["Marketing Reviewer", "marketing@example.com", "MARKETING_VP"],
    ["B2C Reviewer", "b2c@example.com", "B2C_VP"],
  ]) {
    const r = await request("/users", {
      cookie: admin.cookie,
      method: "POST",
      body: { name, email, password: TEST_PASSWORD, role },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.user.role, role);
  }
  const creator = await register("creator@example.com"),
    marketing = await login("marketing@example.com"),
    b2c = await login("b2c@example.com");
  let submission, firstFile, secondCreator;
  await t.test("anonymous and cross-origin requests are blocked", async () => {
    assert.equal((await request("/submissions")).status, 401);
    assert.equal(
      (
        await request("/auth/login", {
          method: "POST",
          body: { email: "creator@example.com", password: "wrong" },
        })
      ).status,
      401,
    );
    assert.equal(
      (await request("/users", { cookie: creator.cookie })).status,
      403,
    );
    assert.equal(
      (
        await request("/submissions", {
          cookie: creator.cookie,
          method: "POST",
          body: form(),
          headers: { Origin: "https://untrusted.example" },
        })
      ).status,
      403,
    );
  });
  await t.test(
    "uploads require a real supported file and failed uploads leave no file",
    async () => {
      assert.equal(
        (
          await request("/submissions", {
            cookie: creator.cookie,
            method: "POST",
            body: form({ file: false }),
          })
        ).status,
        400,
      );
      const before = readdirSync(path.join(dir, "uploads")).length;
      assert.equal(
        (
          await request("/submissions", {
            cookie: creator.cookie,
            method: "POST",
            body: form({ badFile: true }),
          })
        ).status,
        400,
      );
      assert.equal(readdirSync(path.join(dir, "uploads")).length, before);
    },
  );
  await t.test(
    "creator submits creative and it routes to Marketing only",
    async () => {
      const r = await request("/submissions", {
        cookie: creator.cookie,
        method: "POST",
        body: form(),
      });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      submission = r.body.submission;
      assert.equal(submission.status, "PENDING");
      assert.equal(submission.fileCount, 1);
      for (const reviewer of [marketing, admin]) {
        assert.ok(
          (
            await request("/notifications", { cookie: reviewer.cookie })
          ).body.notifications.some(
            (n) =>
              n.submissionId === submission.id &&
              n.title === "Ready for review",
          ),
        );
      }
      assert.ok(
        !(
          await request("/notifications", { cookie: b2c.cookie })
        ).body.notifications.some((n) => n.submissionId === submission.id),
      );
      assert.ok(
        (
          await request("/submissions", { cookie: marketing.cookie })
        ).body.submissions.some((s) => s.id === submission.id),
      );
      assert.ok(
        !(
          await request("/submissions", { cookie: b2c.cookie })
        ).body.submissions.some((s) => s.id === submission.id),
      );
      assert.equal(
        (await request("/submissions/" + submission.id, { cookie: b2c.cookie }))
          .status,
        404,
      );
      const d = await request("/submissions/" + submission.id, {
        cookie: creator.cookie,
      });
      firstFile = d.body.files[0].id;
      assert.equal((await fetch(base + "/api/files/" + firstFile)).status, 401);
      assert.equal(
        (
          await fetch(base + "/api/files/" + firstFile, {
            headers: { cookie: b2c.cookie },
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await fetch(base + "/api/files/" + firstFile, {
            headers: { cookie: marketing.cookie },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "creators cannot review and reviewers must give rejection feedback",
    async () => {
      const payload = { decision: "APPROVED", version: submission.version };
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: b2c.cookie,
            method: "POST",
            body: payload,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: creator.cookie,
            method: "POST",
            body: payload,
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: marketing.cookie,
            method: "POST",
            body: { ...payload, decision: "REJECTED", comment: "  " },
          })
        ).status,
        400,
      );
      const r = await request("/submissions/" + submission.id + "/review", {
        cookie: marketing.cookie,
        method: "POST",
        body: {
          ...payload,
          decision: "CHANGES_REQUESTED",
          comment: "Add the registration deadline.",
        },
      });
      assert.equal(r.status, 200);
      submission = r.body.submission;
    },
  );
  await t.test(
    "resubmission retains old files, captions, and feedback",
    async () => {
      const r = await request("/submissions/" + submission.id, {
        cookie: creator.cookie,
        method: "PUT",
        body: form({
          version: submission.version,
          caption: "Registration closes on 1 December.",
        }),
      });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      submission = r.body.submission;
      assert.equal(submission.revision, 2);
      assert.equal(submission.status, "PENDING");
      const detail = (
        await request("/submissions/" + submission.id, {
          cookie: creator.cookie,
        })
      ).body;
      assert.equal(detail.files.length, 2);
      assert.equal(detail.revisions.length, 2);
      assert.equal(
        detail.revisions.find((r) => r.revision === 1).snapshot.caption,
        "Join our upcoming event. #AIESEC",
      );
      assert.ok(
        detail.history.some(
          (h) => h.comment === "Add the registration deadline.",
        ),
      );
      assert.equal(
        (
          await fetch(base + "/api/files/" + firstFile, {
            headers: { cookie: creator.cookie },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "stale decisions fail; approved content is immutable",
    async () => {
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: marketing.cookie,
            method: "POST",
            body: { decision: "APPROVED", version: 1 },
          })
        ).status,
        409,
      );
      const r = await request("/submissions/" + submission.id + "/review", {
        cookie: marketing.cookie,
        method: "POST",
        body: { decision: "APPROVED", version: submission.version },
      });
      assert.equal(r.status, 200);
      submission = r.body.submission;
      assert.equal(
        (
          await request("/submissions/" + submission.id, {
            cookie: admin.cookie,
            method: "PUT",
            body: form({ version: submission.version }),
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await request("/submissions/" + submission.id, {
            cookie: creator.cookie,
            method: "PUT",
            body: form({ version: submission.version }),
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: marketing.cookie,
            method: "POST",
            body: {
              decision: "REJECTED",
              comment: "New opinion",
              version: submission.version,
            },
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "admin can override with an explanation and reopen",
    async () => {
      assert.equal(
        (
          await request("/submissions/" + submission.id + "/review", {
            cookie: admin.cookie,
            method: "POST",
            body: { decision: "REJECTED", version: submission.version },
          })
        ).status,
        400,
      );
      let r = await request("/submissions/" + submission.id + "/review", {
        cookie: admin.cookie,
        method: "POST",
        body: {
          decision: "REJECTED",
          comment: "The event has been cancelled.",
          version: submission.version,
        },
      });
      assert.equal(r.status, 200);
      submission = r.body.submission;
      r = await request("/submissions/" + submission.id + "/review", {
        cookie: admin.cookie,
        method: "POST",
        body: {
          decision: "PENDING",
          comment: "The event is happening again.",
          version: submission.version,
        },
      });
      assert.equal(r.status, 200);
      submission = r.body.submission;
      assert.ok(
        (
          await request("/submissions/" + submission.id, {
            cookie: admin.cookie,
          })
        ).body.history.some((h) => h.action === "OVERRIDE_REJECTED"),
      );
    },
  );
  await t.test(
    "B2C routes correctly; admin has authority across categories",
    async () => {
      const b2cMember = await register('b2c-member@example.com', {role: 'B2C_MEMBER'});
      const r = await request("/submissions", {
        cookie: b2cMember.cookie,
        method: "POST",
        body: form({ category: "MARKETING" }),
      });
      assert.equal(r.status, 201);
      const s = r.body.submission;
      assert.equal(s.category, 'B2C');
      assert.equal(
        (await request("/submissions/" + s.id, { cookie: marketing.cookie }))
          .status,
        404,
      );
      assert.equal(
        (await request("/submissions/" + s.id, { cookie: b2c.cookie })).status,
        200,
      );
      assert.equal(
        (
          await request("/submissions/" + s.id + "/review", {
            cookie: admin.cookie,
            method: "POST",
            body: { decision: "APPROVED", version: s.version },
          })
        ).status,
        200,
      );
    },
  );
  await t.test(
    "only admin manages accounts; admin can manage every role while protecting the last administrator",
    async () => {
      for (const user of [creator, marketing, b2c]) {
        assert.equal(
          (
            await request("/users", {
              cookie: user.cookie,
              method: "POST",
              body: {
                name: "Blocked",
                email: "blocked@example.com",
                password: TEST_PASSWORD,
                role: "MARKETING_VP",
              },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await request("/users/" + creator.body.user.id, {
              cookie: user.cookie,
              method: "PATCH",
              body: { role: "MARKETING_VP" },
            })
          ).status,
          403,
        );
        assert.equal(
          (await request("/activity", { cookie: user.cookie })).status,
          403,
        );
      }
      for (const role of ["UNKNOWN"]) {
        assert.equal(
          (
            await request("/users", {
              cookie: admin.cookie,
              method: "POST",
              body: {
                name: "Blocked",
                email: "blocked@example.com",
                password: TEST_PASSWORD,
                role,
              },
            })
          ).status,
          400,
        );
      }
      secondCreator = await register("incoming@example.com");
      assert.equal(
        (
          await request("/submissions/" + submission.id, {
            cookie: secondCreator.cookie,
          })
        ).status,
        404,
      );
      assert.equal(
        (
          await request("/users/" + secondCreator.body.user.id, {
            cookie: admin.cookie,
            method: "PATCH",
            body: { role: "ADMIN" },
          })
        ).status,
        200,
      );
      await request('/users/'+secondCreator.body.user.id,{cookie:admin.cookie,method:'PATCH',body:{role:'MARKETING_MEMBER'}});
      for (const body of [{ active: false }, { role: "MARKETING_MEMBER" }]) {
        assert.equal(
          (
            await request("/users/" + admin.body.user.id, {
              cookie: admin.cookie,
              method: "PATCH",
              body,
            })
          ).status,
          409,
        );
      }
      assert.equal(
        (await request("/users", { cookie: admin.cookie })).body.users.length,
        6,
      );
      const ocvpCreation = await request('/users', {
        cookie: admin.cookie, method: 'POST',
        body: {name: 'Self signup only', email: 'admin-created-ocvp@example.com', password: TEST_PASSWORD, role: 'CREATOR'},
      });
      assert.equal(ocvpCreation.status, 400);
    },
  );
  await t.test(
    "drafts are not exposed to category reviewers; self-approval blocked for admin",
    async () => {
      const draft = await request("/submissions", {
        cookie: creator.cookie,
        method: "POST",
        body: form({ status: "DRAFT", file: false }),
      });
      assert.equal(draft.status, 201);
      assert.equal(
        (
          await request("/submissions/" + draft.body.submission.id, {
            cookie: admin.cookie,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            "/submissions/" + draft.body.submission.id + "/review",
            {
              cookie: admin.cookie,
              method: "POST",
              body: { decision: "APPROVED", version: 1 },
            },
          )
        ).status,
        409,
      );
      assert.equal(
        (
          await request("/submissions/" + draft.body.submission.id, {
            cookie: marketing.cookie,
          })
        ).status,
        404,
      );
      const own = await request("/submissions", {
        cookie: admin.cookie,
        method: "POST",
        body: form(),
      });
      assert.equal(own.status, 201);
      assert.equal(
        (
          await request("/submissions/" + own.body.submission.id + "/review", {
            cookie: admin.cookie,
            method: "POST",
            body: { decision: "APPROVED", version: 1 },
          })
        ).status,
        403,
      );
    },
  );
  await t.test(
    "notifications belong to the user and can be marked read",
    async () => {
      let r = await request("/notifications", { cookie: creator.cookie });
      assert.ok(
        r.body.notifications.some((n) => n.submissionId === submission.id),
      );
      assert.equal(
        (
          await request("/notifications/read", {
            cookie: creator.cookie,
            method: "POST",
            body: {},
          })
        ).status,
        200,
      );
      r = await request("/notifications", { cookie: creator.cookie });
      assert.ok(r.body.notifications.every((n) => n.readAt));
      assert.ok(
        (
          await request("/notifications", { cookie: admin.cookie })
        ).body.notifications.some((n) => !n.readAt),
      );
    },
  );
  await t.test(
    "account role updates revoke sessions and preserve historical authors",
    async () => {
      for (const [user, body] of [
        [marketing, { role: "MARKETING_MEMBER", name: "Former Reviewer" }],
        [secondCreator, { role: "MARKETING_VP" }],
      ]) {
        const r = await request("/users/" + user.body.user.id, {
          cookie: admin.cookie,
          method: "PATCH",
          body,
        });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(
          (await request("/auth/me", { cookie: user.cookie })).status,
          401,
        );
      }
      secondCreator = await login("incoming@example.com");
      assert.equal(secondCreator.body.user.role, "MARKETING_VP");
      const detail = await request("/submissions/" + submission.id, {
        cookie: secondCreator.cookie,
      });
      assert.equal(detail.status, 200);
      assert.ok(
        detail.body.history.some(
          (h) =>
            h.actorName === "Marketing Reviewer" &&
            h.actorRole === "MARKETING_VP" &&
            h.action === "APPROVED",
        ),
      );
      const activity = (await request("/activity", { cookie: admin.cookie }))
        .body.activity;
      assert.ok(activity.some((a) => a.action === "ACCOUNT_UPDATED"));
      assert.ok(activity.some((a) => a.action === "ACCOUNT_CREATED"));
      assert.ok(activity.some((a) => a.action === "ACCOUNT_REGISTERED"));
    },
  );
  await t.test(
    "disabling accounts revokes access and password changes work",
    async () => {
      assert.equal(
        (
          await request("/auth/password", {
            cookie: creator.cookie,
            method: "POST",
            body: { currentPassword: "wrong", newPassword: "NewPassword123!" },
          })
        ).status,
        400,
      );
      assert.equal(
        (
          await request("/auth/password", {
            cookie: creator.cookie,
            method: "POST",
            body: {
              currentPassword: TEST_PASSWORD,
              newPassword: "NewPassword123!",
            },
          })
        ).status,
        200,
      );
      await login("creator@example.com", "NewPassword123!");
      assert.equal(
        (
          await request("/users/" + secondCreator.body.user.id, {
            cookie: admin.cookie,
            method: "PATCH",
            body: { active: false },
          })
        ).status,
        200,
      );
      assert.equal(
        (await request("/auth/me", { cookie: secondCreator.cookie })).status,
        401,
      );
      assert.equal(
        (
          await request("/auth/login", {
            method: "POST",
            body: {
              email: "incoming@example.com",
              password: TEST_PASSWORD,
            },
          })
        ).status,
        401,
      );
    },
  );
});

test("registration ignores requested roles and reserves the administrator email", async (t) => {
  const { request, register, login, service } = await testApp(t);
  assert.deepEqual((await request("/config")).body, {
    demoMode: false,
    registrationEnabled: true,
    setupRequired: false,
    adminEmail: ADMIN_EMAIL,
  });
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    1,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM submissions").get().n,
    0,
  );
  for (const role of ["ADMIN", "MARKETING_VP", "B2C_VP"]) {
    const email = `${role.toLowerCase()}@example.com`;
    const registered = await register(email, { role, active: false });
    assert.equal(registered.body.user.active, true);
    assert.equal(
      (await request("/auth/me", { cookie: registered.cookie })).body.user.role,
      "MARKETING_MEMBER",
    );
    assert.equal((await login(email)).body.user.role, "MARKETING_MEMBER");
    assert.equal(
      (await request("/users", { cookie: registered.cookie })).status,
      403,
    );
    assert.match(registered.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(registered.headers.get("set-cookie"), /SameSite=Strict/i);
  }
  assert.equal(
    (
      await request("/auth/register", {
        method: "POST",
        body: {
          name: "Reserved",
          email: ` ${ADMIN_EMAIL.toUpperCase()} `,
          password: TEST_PASSWORD,
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await request("/auth/register", {
        method: "POST",
        body: {
          name: "Duplicate",
          email: " ADMIN@EXAMPLE.COM ",
          password: TEST_PASSWORD,
        },
      })
    ).status,
    409,
  );
  assert.equal(
    service.db
      .prepare("SELECT count(*) AS n FROM users WHERE role='ADMIN'")
      .get().n,
    1,
  );
});

test("registration works before bootstrap without claiming the reserved admin identity", async (t) => {
  const { request, register, service, dir } = await testApp(t, {
    bootstrap: false,
  });
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
  assert.equal(
    (
      await request("/auth/register", {
        method: "POST",
        body: { name: "Reserved", email: ADMIN_EMAIL, password: TEST_PASSWORD },
      })
    ).status,
    403,
  );
  await register("early@example.com");
  assert.equal(
    service.db
      .prepare("SELECT count(*) AS n FROM users WHERE role='ADMIN'")
      .get().n,
    0,
  );
  const bootstrapped = configuredApp({
    databasePath: path.join(dir, "test.sqlite"),
    uploadDir: path.join(dir, "uploads"),
  });
  try {
    assert.equal(
      bootstrapped.db.prepare("SELECT count(*) AS n FROM users").get().n,
      2,
    );
    assert.equal(
      bootstrapped.db
        .prepare("SELECT email FROM users WHERE role='ADMIN'")
        .get().email,
      ADMIN_EMAIL,
    );
  } finally {
    bootstrapped.close();
  }
});

test("registration validates inputs and rejects cross-origin requests", async (t) => {
  const { request, service } = await testApp(t, { bootstrap: false });
  const valid = {
    name: "Test OCVP",
    email: "valid@example.com",
    password: TEST_PASSWORD,
  };
  for (const body of [
    undefined,
    {},
    { ...valid, name: " " },
    { ...valid, name: "x".repeat(101) },
    { ...valid, email: "invalid" },
    { ...valid, password: "short" },
    { ...valid, password: "x".repeat(201) },
  ]) {
    assert.equal(
      (await request("/auth/register", { method: "POST", body })).status,
      400,
    );
  }
  assert.equal(
    (
      await request("/auth/register", {
        method: "POST",
        body: valid,
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
});

test("registration rate limit counts successes and failures by IP and expires", async (t) => {
  const { request, service } = await testApp(t, { bootstrap: false });
  // The default local server must not trust client-provided forwarding headers.
  service.app.set("trust proxy", false);
  const time = Date.now();
  t.mock.method(Date, "now", () => time);
  for (let i = 0; i < 10; i++) {
    const response = await request("/auth/register", {
      method: "POST",
      headers: { "X-Forwarded-For": `192.0.2.${i + 1}` },
      body: {
        name: "Test OCVP",
        email: `attempt-${i}@example.com`,
        password: i % 2 ? "short" : TEST_PASSWORD,
      },
    });
    assert.equal(response.status, i % 2 ? 400 : 201);
  }
  const body = {
    name: "Test OCVP",
    email: "after-limit@example.com",
    password: TEST_PASSWORD,
  };
  const limited = await request("/auth/register", { method: "POST", body });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "900");
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    5,
  );
  t.mock.method(Date, "now", () => time + 15 * 60000);
  assert.equal(
    (await request("/auth/register", { method: "POST", body })).status,
    201,
  );
});

test("local setup creates the reserved admin once using the supplied password", async (t) => {
  const { request, login, service } = await testApp(t, {
    bootstrap: false,
    environment: { DEMO_MODE: "true" },
  });
  assert.deepEqual((await request("/config")).body, {
    demoMode: false,
    registrationEnabled: true,
    setupRequired: true,
    adminEmail: ADMIN_EMAIL,
  });
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
  const password = "User-Chosen-Setup-Password!";
  const result = await request("/auth/setup", {
    method: "POST",
    body: {
      password,
      name: " Local Admin ",
      email: "ignored@example.com",
      role: "CREATOR",
    },
  });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.user.role, "ADMIN");
  assert.equal(result.body.user.email, ADMIN_EMAIL);
  assert.equal(result.body.user.name, "Local Admin");
  assert.equal(result.body.user.password_hash, undefined);
  assert.equal(
    (await request("/auth/me", { cookie: result.cookie })).body.user.id,
    result.body.user.id,
  );
  assert.equal(
    (await login(ADMIN_EMAIL, password)).body.user.id,
    result.body.user.id,
  );
  const stored = service.db.prepare("SELECT * FROM users").get();
  assert.match(stored.password_hash, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
  assert.notEqual(stored.password_hash, password);
  assert.equal((await request("/config")).body.setupRequired, false);
  assert.equal(
    (
      await request("/auth/setup", {
        method: "POST",
        body: { password: TEST_PASSWORD },
      })
    ).status,
    409,
  );
  assert.equal(
    service.db.prepare("SELECT password_hash FROM users").get().password_hash,
    stored.password_hash,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    1,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM submissions").get().n,
    0,
  );
  assert.equal(
    service.db.prepare("SELECT action FROM activity").get().action,
    "WORKSPACE_CREATED",
  );
  // An inactive administrator must not reopen public initialization.
  service.db.prepare("UPDATE users SET active=0 WHERE id=?").run(stored.id);
  assert.equal((await request("/config")).body.setupRequired, false);
  assert.equal(
    (await request("/auth/setup", { method: "POST", body: { password } }))
      .status,
    409,
  );
});

test("local setup works after creator signup and rejects competing setup requests", async (t) => {
  const { request, register, service } = await testApp(t, { bootstrap: false });
  await register("before-setup@example.com");
  assert.equal((await request("/config")).body.setupRequired, true);
  const results = await Promise.all(
    [1, 2].map(() =>
      request("/auth/setup", {
        method: "POST",
        body: { password: TEST_PASSWORD },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    results.find((r) => r.status === 201).body.user.name,
    "Administrator",
  );
  assert.equal(
    service.db
      .prepare("SELECT count(*) AS n FROM users WHERE role='ADMIN'")
      .get().n,
    1,
  );
  assert.equal(
    service.db
      .prepare("SELECT count(*) AS n FROM users WHERE role='MARKETING_MEMBER'")
      .get().n,
    1,
  );
});

test("local setup validates the password and name and preserves origin protection", async (t) => {
  const { request, service } = await testApp(t, { bootstrap: false });
  for (const body of [
    undefined,
    {},
    { password: "short" },
    { password: "x".repeat(201) },
    { password: TEST_PASSWORD, name: " " },
    { password: TEST_PASSWORD, name: "x".repeat(101) },
  ]) {
    assert.equal(
      (await request("/auth/setup", { method: "POST", body })).status,
      400,
    );
  }
  assert.equal(
    (
      await request("/auth/setup", {
        method: "POST",
        body: { password: TEST_PASSWORD },
        headers: { Origin: "https://untrusted.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
  assert.equal((await request("/config")).body.setupRequired, true);
});

test("setup checks the socket address regardless of trusted forwarding headers", async (t) => {
  const { request, service } = await testApp(t, {
    bootstrap: false,
    remoteAddress: "192.0.2.10",
  });
  service.app.set("trust proxy", true);
  const headers = {
    "X-Forwarded-For": "127.0.0.1",
    Forwarded: "for=127.0.0.1",
  };
  assert.equal(
    (await request("/config", { headers })).body.setupRequired,
    false,
  );
  assert.equal(
    (
      await request("/auth/setup", {
        method: "POST",
        headers,
        body: { password: TEST_PASSWORD },
      })
    ).status,
    403,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
});

test("setup accepts IPv6 and IPv4-mapped loopback sockets", async (t) => {
  for (const remoteAddress of ["::1", "::ffff:127.0.0.1"]) {
    await t.test(remoteAddress, async (t) => {
      const { request } = await testApp(t, { bootstrap: false, remoteAddress });
      assert.equal((await request("/config")).body.setupRequired, true);
      assert.equal(
        (
          await request("/auth/setup", {
            method: "POST",
            body: { password: TEST_PASSWORD },
          })
        ).status,
        201,
      );
    });
  }
});

test("production does not expose setup even to a loopback client with no admin", async (t) => {
  const { request, service } = await testApp(t, {
    bootstrap: false,
    environment: { NODE_ENV: "production", DEMO_MODE: "true" },
  });
  assert.equal((await request("/config")).body.setupRequired, false);
  assert.equal((await request("/config")).body.adminEmail, ADMIN_EMAIL);
  assert.equal(
    (
      await request("/auth/setup", {
        method: "POST",
        body: { password: TEST_PASSWORD },
      })
    ).status,
    404,
  );
  assert.equal(
    service.db.prepare("SELECT count(*) AS n FROM users").get().n,
    0,
  );
});

test("reviewers delete finalized creative files while retaining the submission and audit history", async (t) => {
  const { request, login, register, dir, service } = await testApp(t);
  const admin = await login(ADMIN_EMAIL),
    creator = await register("cleanup-creator@example.com");
  for (const [email, role] of [
    ["cleanup-mkt@example.com", "MARKETING_VP"],
    ["cleanup-b2c@example.com", "B2C_VP"],
  ])
    assert.equal(
      (
        await request("/users", {
          method: "POST",
          cookie: admin.cookie,
          body: { name: role, email, password: TEST_PASSWORD, role },
        })
      ).status,
      201,
    );
  const marketing = await login("cleanup-mkt@example.com"),
    b2c = await login("cleanup-b2c@example.com");
  const form = new FormData();
  for (const [key, value] of Object.entries({
    title: "Cleanup test",
    event: "Club",
    category: "MARKETING",
    contentType: "Social post",
    platform: "Instagram",
    caption: "Keep this caption",
    status: "PENDING",
  }))
    form.append(key, value);
  form.append("files", new Blob([png], { type: "image/png" }), "test.png");
  const created = await request("/submissions", {
    method: "POST",
    cookie: creator.cookie,
    body: form,
  });
  assert.equal(created.status, 201);
  const sid = created.body.submission.id;
  assert.equal(
    (await request("/storage", { cookie: creator.cookie })).status,
    403,
  );
  assert.equal(
    (
      await request(`/submissions/${sid}/creatives`, {
        method: "DELETE",
        cookie: marketing.cookie,
        body: { version: 1 },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/submissions/${sid}/review`, {
        method: "POST",
        cookie: marketing.cookie,
        body: { version: 1, decision: "APPROVED", comment: "" },
      })
    ).status,
    200,
  );
  assert.equal(
    (await request("/storage", { cookie: b2c.cookie })).body.submissions.length,
    0,
  );
  assert.equal(
    (
      await request(`/submissions/${sid}/creatives`, {
        method: "DELETE",
        cookie: b2c.cookie,
        body: { version: 2 },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/submissions/${sid}/creatives`, {
        method: "DELETE",
        cookie: marketing.cookie,
        body: { version: 1 },
      })
    ).status,
    409,
  );
  const removed = await request(`/submissions/${sid}/creatives`, {
    method: "DELETE",
    cookie: marketing.cookie,
    body: { version: 2 },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.filesDeleted, 1);
  assert.equal(removed.body.bytesFreed, png.length);
  assert.equal(readdirSync(path.join(dir, "uploads")).length, 0);
  const retained = (
    await request(`/submissions/${sid}`, { cookie: creator.cookie })
  ).body;
  assert.equal(retained.submission.caption, "Keep this caption");
  assert.equal(retained.files.length, 0);
  assert.ok(retained.history.some((h) => h.action === "CREATIVES_DELETED"));
  assert.equal(
    (
      await request(`/submissions/${sid}/review`, {
        method: "POST",
        cookie: admin.cookie,
        body: { version: 4, decision: "PENDING", comment: "Reopen" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/submissions/${sid}/creatives`, {
        method: "DELETE",
        cookie: admin.cookie,
        body: { version: 2 },
      })
    ).body.filesDeleted,
    0,
  );
  assert.equal(
    service.db
      .prepare("SELECT count(*) AS n FROM revisions WHERE submission_id=?")
      .get(sid).n,
    1,
  );
});

test("bootstrap uses only environment credentials and the fixed admin email, without fake content", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "approval-bootstrap-test-"));
  const options = {
    databasePath: path.join(dir, "real.sqlite"),
    uploadDir: path.join(dir, "uploads"),
  };
  let service;
  t.after(() => {
    service?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  service = configuredApp(options, null);
  for (const table of [
    "users",
    "sessions",
    "submissions",
    "files",
    "revisions",
    "history",
    "notifications",
    "activity",
  ]) {
    assert.equal(
      service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      0,
    );
  }
  service.close();
  service = configuredApp(options);
  let rows = service.db.prepare("SELECT * FROM users").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].role, "ADMIN");
  assert.equal(rows[0].email, ADMIN_EMAIL);
  assert.notEqual(rows[0].password_hash, TEST_PASSWORD);
  for (const table of [
    "sessions",
    "submissions",
    "files",
    "revisions",
    "history",
    "notifications",
  ]) {
    assert.equal(
      service.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
      0,
    );
  }
  const originalHash = rows[0].password_hash;
  service.close();
  service = configuredApp(options, "Different-Password123!", "Changed Name");
  rows = service.db.prepare("SELECT * FROM users").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Test Administrator");
  assert.equal(rows[0].password_hash, originalHash);
});
