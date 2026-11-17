// Component-level UI checks with isolated API fixtures; never creates production records.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
const { chromium, webkit } = await import(
  process.env.PLAYWRIGHT_MODULE || "playwright"
);
const engine = process.env.UI_BROWSER === "webkit" ? webkit : chromium;
const browser = await engine.launch({
  headless: true,
  ...(engine === chromium ? { channel: "chrome" } : {}),
});
const base = process.env.UI_URL || "http://127.0.0.1:5178";
mkdirSync("test-results", { recursive: true });
const groups = [
  {
    id: "ig-1",
    name: "AIESEC in EXAMPLE_IG",
    active: true,
    logoUrl: "/entity-logo.svg",
  },
];
const events = [
  {
    id: "event-1",
    name: "Catalyst 7.0",
    organization: "ENTITY",
    organizationName: "AIESEC in Your Entity",
    active: true,
    ocpAssigned: false,
    managerCount: 0,
  },
  {
    id: "event-2",
    name: "IG Conference",
    organization: "ig-1",
    organizationName: "AIESEC in EXAMPLE_IG",
    active: true,
    ocpAssigned: false,
    managerCount: 1,
  },
];
const errors = [];
const width = async (page) =>
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    "Horizontal overflow",
  );
async function setup(role, viewport) {
  const context = await browser.newContext({
    viewport,
    isMobile: viewport.width < 760,
    hasTouch: viewport.width < 760,
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  const user = {
    id: "test-user",
    name: "Test " + (role || ""),
    email: role === "ADMIN" ? "admin@your-entity.example" : "test@example.test",
    role,
    organization: ["IGP", "IGVP_MARKETING"].includes(role) ? "ig-1" : "ENTITY",
    organizationName: "AIESEC in EXAMPLE_IG",
    active: true,
    eventId: "event-1",
    eventName: "Catalyst 7.0",
    eventActive: true,
  };
  const post = {
    id: "post-1",
    title: "A longer campaign title that needs to wrap safely on a phone",
    creatorId: "member-1",
    creatorName: "Campaign team",
    organization: ["IGP", "EM_VP"].includes(role) ? "ig-1" : "ENTITY",
    organizationName: "AIESEC in EXAMPLE_IG",
    eventId: "event-1",
    submitterRole: "CREATOR",
    status: "PENDING",
    reviewStage: ["IGP", "EM_VP"].includes(role) ? "IG" : "LC",
    category: "MARKETING",
    revision: 1,
    version: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname.slice(4);
    const data =
      path === "/auth/me"
        ? { user }
        : path === "/config"
          ? { registrationEnabled: true }
          : path === "/submissions"
            ? { submissions: [post] }
            : path === "/notifications"
              ? { notifications: [] }
              : path.includes("/groups")
                ? { groups }
                : path.includes("/events")
                  ? { events }
                  : path === "/users"
                    ? { users: [user] }
                    : { ok: true };
    return route.fulfill({
      status: path === "/auth/me" && !role ? 401 : 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto(base);
  await page.waitForSelector(role ? ".app-shell" : ".login-form");
  if (role)
    await page
      .getByRole("heading", { name: post.title, exact: true })
      .waitFor();
  return { page, context };
}
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    const { page, context } = await setup(null, viewport);
    await width(page);
    await page
      .getByRole("button", { name: /Create.*account|Sign up/i })
      .first()
      .click();
    await page.getByRole("combobox").first().selectOption("OCP");
    await page
      .getByLabel("Committee / initiative group", { exact: true })
      .selectOption("ig-1");
    await page.getByLabel("Event", { exact: true }).selectOption("event-2");
    for (const field of await page
      .locator("input:visible,select:visible")
      .all()) {
      await field.focus();
      assert(
        await field.evaluate(
          (e) => parseFloat(getComputedStyle(e).fontSize) >= 16,
        ),
      );
      await width(page);
    }
    assert(
      !(await page.locator("body").innerText())
        .toLowerCase()
        .includes("observer"),
    );
    await page.screenshot({
      path: `test-results/signup-${viewport.width}.png`,
      fullPage: true,
    });
    await context.close();
  }
  for (const role of ["ADMIN", "EM_VP", "IGP", "EVENT_MANAGER"]) {
    const { page, context } = await setup(role, { width: 390, height: 844 });
    await width(page);
    assert.equal(
      await page
        .getByRole("button", { name: "New submission", exact: true })
        .count(),
      0,
    );
    await page.getByRole("button", { name: /Open navigation/ }).click();
    if (role === "EVENT_MANAGER") {
      assert.equal(
        await page
          .getByRole("button", { name: "Accounts", exact: true })
          .count(),
        0,
      );
      await context.close();
      continue;
    }
    await page.getByRole("button", { name: "Accounts", exact: true }).click();
    await page.getByRole("button", { name: "Add profile", exact: true }).click();
    await page
      .getByLabel("Role", { exact: true })
      .selectOption(
        role === "ADMIN" ? "EM_VP" : role === "EM_VP" ? "IGP" : "EVENT_MANAGER",
      );
    if (role === "EM_VP")
      await page
        .getByLabel("Committee / initiative group", { exact: true })
        .selectOption("ig-1");
    if (role === "IGP")
      await page.getByLabel("Event", { exact: true }).selectOption("event-2");
    await width(page);
    await page.screenshot({
      path: `test-results/account-${role}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    if (role !== "IGP") {
      await page.getByRole("button", { name: /Open navigation/ }).click();
      await page
        .getByRole("button", { name: "Initiative groups", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Add initiative group", exact: true })
        .click();
      await page
        .getByLabel("Initiative group name", { exact: true })
        .fill("AIESEC in Test");
      await width(page);
      await page.screenshot({
        path: `test-results/group-${role}.png`,
        fullPage: true,
      });
    }
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Mobile/desktop signup, scoped account forms, IG management and read-only navigation passed.",
  );
} finally {
  await browser.close();
}
