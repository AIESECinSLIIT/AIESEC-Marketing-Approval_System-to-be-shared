// Isolated browser UI fixtures: no production accounts or notifications.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
const pw = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.UI_BROWSER || "chromium";
const browser = await pw[engine].launch({
  headless: true,
  ...(engine === "chromium" ? { channel: "chrome" } : {}),
});
const base = process.env.UI_URL || "http://127.0.0.1:5178";
mkdirSync("test-results", { recursive: true });
try {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
  ]) {
    const context = await browser.newContext({
        viewport,
        isMobile: viewport.width < 760,
        hasTouch: viewport.width < 760,
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let selected = "profile-lc";
    const profiles = [
      {
        id: "profile-lc",
        accountId: "person",
        name: "Multi-role Member",
        email: "member@example.test",
        role: "CREATOR",
        organization: "ENTITY",
        organizationName: "AIESEC in Your Entity",
        eventId: "event-lc",
        eventName: "Catalyst 7.0",
        eventActive: true,
        active: true,
      },
      {
        id: "profile-ig",
        accountId: "person",
        name: "Multi-role Member",
        email: "member@example.test",
        role: "IGP",
        organization: "ig-1",
        organizationName: "AIESEC in EXAMPLE_IG",
        logoUrl: "/test-ig-logo.png",
        active: true,
      },
    ];
    const groups = [{ id: "ig-1", name: "AIESEC in EXAMPLE_IG", active: true }];
    const events = [
      {
        id: "event-lc",
        name: "Catalyst 7.0",
        organization: "ENTITY",
        active: true,
        ocpAssigned: false,
      },
      {
        id: "event-ig",
        name: "IG Conference",
        organization: "ig-1",
        active: true,
        ocpAssigned: false,
      },
    ];
    await page.route("**/test-ig-logo.png", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120"><rect width="400" height="120" fill="white"/><text x="12" y="80" fill="#1565a4" font-size="55">EXAMPLE_IG logo</text></svg>',
      }),
    );
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname.slice(4);
      let result = { ok: true };
      if (path === "/profiles/switch")
        selected = route.request().postDataJSON().id;
      if (path === "/profiles" && route.request().method() === "POST") {
        const b = route.request().postDataJSON();
        profiles.push({
          ...profiles[0],
          id: "profile-new",
          role: b.role,
          organization: b.organization,
          eventId: b.eventId,
        });
        selected = "profile-new";
      }
      if (
        path === "/auth/me" ||
        path === "/profiles/switch" ||
        path === "/profiles"
      )
        result = {
          user: { ...profiles.find((p) => p.id === selected), profiles },
        };
      else if (path === "/submissions") result = { submissions: [] };
      else if (path === "/notifications")
        result = {
          notifications: [
            {
              id: "notification",
              profileId: "profile-ig",
              profileLabel: "AIESEC in EXAMPLE_IG",
              submissionId: "post-ig",
              title: "IG approved · awaiting ENTITY approval",
              message: "Campaign video — IGVP Marketing",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      else if (path === "/submissions/post-ig")
        result = {
          submission: {
            id: "post-ig",
            creatorId: "someone",
            creatorAccountId: "another-login",
            creatorName: "Creative member",
            title: "IG campaign",
            organization: "ig-1",
            organizationName: "AIESEC in EXAMPLE_IG",
            category: "MARKETING",
            reviewStage: "LC",
            status: "APPROVED",
            submitterRole: "MARKETING_MEMBER",
            revision: 1,
            version: 2,
            createdAt: new Date().toISOString(),
          },
          files: [],
          history: [],
          revisions: [],
        };
      else if (path.includes("groups")) result = { groups };
      else if (path.includes("events")) result = { events };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(result),
      });
    });
    const width = async () =>
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      );
    await page.goto(base);
    await page.locator(".app-shell").waitFor();
    await page
      .getByRole("button", { name: "Switch profile", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: /Initiative Group President/ })
      .click();
    await page.waitForFunction(
      () =>
        document.querySelector(".brand img")?.getAttribute("src") ===
        "/test-ig-logo.png",
    );
    assert.equal(
      await page.locator('img[src="/entity-logo.svg"]').count(),
      0,
    );
    await width();
    if (viewport.width < 760)
      await page
        .getByRole("button", { name: "Open navigation", exact: true })
        .click();
    await page.screenshot({
      path: `test-results/ig-brand-${viewport.width}.png`,
      fullPage: true,
    });
    if (viewport.width < 760)
      await page
        .getByRole("button", { name: "Close navigation", exact: true })
        .click();
    await page
      .getByRole("button", { name: "Switch profile", exact: true })
      .last()
      .click();
    await page.getByRole("button", { name: /OCVP Marketing/ }).click();
    await page
      .getByRole("button", { name: "View notifications", exact: true })
      .click();
    await page.getByRole("button", { name: /IG approved/ }).click();
    await page
      .getByRole("heading", { name: "IG campaign", exact: true })
      .waitFor();
    assert.equal(selected, "profile-ig");
    await width();
    await page
      .getByRole("button", { name: "Switch profile", exact: true })
      .last()
      .click();
    await page
      .getByRole("button", { name: "Add a profile", exact: true })
      .click();
    await page
      .getByLabel("Role", { exact: true })
      .selectOption("MARKETING_MEMBER");
    await page
      .getByLabel("Committee / initiative group", { exact: true })
      .selectOption("ig-1");
    await width();
    await page.screenshot({
      path: `test-results/profile-add-${viewport.width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Add profile", exact: true })
      .click();
    await page
      .getByRole("heading", { name: "Add a profile", exact: true })
      .waitFor({ state: "hidden" });
    assert.equal(selected, "profile-new");
    assert.deepEqual(errors, []);
    await context.close();
  }
  console.log(
    "Profile switching, IG-only branding, notification links, self-add and mobile/desktop overflow checks passed.",
  );
} finally {
  await browser.close();
}
