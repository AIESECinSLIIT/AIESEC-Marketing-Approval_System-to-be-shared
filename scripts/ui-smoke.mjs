// Isolated UI regression check: no production data, accounts or emails are used.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { createApp } from "../server/app.js";
const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const engine = process.env.UI_BROWSER || "chromium";
const temp = mkdtempSync(path.join(tmpdir(), "approval-ui-"));
const password = randomBytes(24).toString("base64url");
const oldPassword = process.env.ADMIN_PASSWORD;
process.env.ADMIN_PASSWORD = password;
const app = createApp({
  databasePath: path.join(temp, "test.sqlite"),
  uploadDir: path.join(temp, "uploads"),
});
if (oldPassword === undefined) delete process.env.ADMIN_PASSWORD;
else process.env.ADMIN_PASSWORD = oldPassword;
const api = app.app.listen(0, "127.0.0.1");
await new Promise((resolve) => api.once("listening", resolve));
const vite = await createServer({
  configFile: false,
  envDir: temp,
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 0,
    proxy: { "/api": `http://127.0.0.1:${api.address().port}` },
  },
});
await vite.listen();
const base = vite.resolvedUrls.local[0];
const browser = await playwright[engine].launch({
  headless: true,
  ...(engine === "chromium" ? { channel: "chrome" } : {}),
});
mkdirSync("test-results", { recursive: true });
const errors = [];
const roles = ["CREATOR", "MARKETING_MEMBER", "B2C_MEMBER"];
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
async function login(context, email) {
  const response = await context.request.post(base + "api/auth/login", {
    data: { email, password },
  });
  assert.equal(response.status(), 200, await response.text());
}
async function checkWidth(page) {
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
    "Horizontal overflow",
  );
}
async function checkFields(page) {
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector("input")).borderRadius === "8px",
  );
  const fields = page.locator(
    'input:not([type="file"]):not([type="checkbox"]):visible, select:visible, textarea:visible',
  );
  for (const field of await fields.all()) {
    if (await field.isDisabled()) continue;
    await field.focus();
    const style = await field.evaluate((el) => ({
      font: parseFloat(getComputedStyle(el).fontSize),
      outline: getComputedStyle(el).outlineStyle,
      tag: el.tagName,
      focused: el === document.activeElement,
      width: innerWidth,
      viewport: visualViewport.width,
      coarse: matchMedia("(pointer: coarse)").matches,
    }));
    assert.ok(
      style.font >= 16,
      `Field can trigger iPhone zoom: ${JSON.stringify(style)}`,
    );
    assert.equal(
      style.outline,
      "none",
      `Text field still has an outer focus ring: ${JSON.stringify(style)}`,
    );
  }
  await checkWidth(page);
}
// Simulate the visual viewport change from an onscreen keyboard. This verifies
// geometry/scrolling, not the physical iOS keyboard or its native zoom behavior.
async function keyboardViewport(page, height, offsetTop = 0) {
  await page.evaluate(
    ({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, get: () => height },
        offsetTop: { configurable: true, get: () => offsetTop },
      });
      window.visualViewport.dispatchEvent(new Event("resize"));
      window.visualViewport.dispatchEvent(new Event("scroll"));
    },
    { height, offsetTop },
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function checkDialog(page, height, offsetTop = 0) {
  await keyboardViewport(page, height, offsetTop);
  const geometry = await page.locator("dialog[open]").evaluate((el) => {
    const rect = (node) => {
      const r = node.getBoundingClientRect();
      return {
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
        height: r.height,
      };
    };
    return {
      dialog: rect(el),
      head: rect(el.querySelector(".modal-head")),
      body: rect(el.querySelector(".modal-body")),
      footer: rect(el.querySelector(".modal-footer")),
      field: rect(document.activeElement),
      scroll: el.querySelector(".modal-body").scrollTop,
    };
  });
  assert.ok(geometry.head.top >= offsetTop - 1, JSON.stringify(geometry));
  assert.ok(
    geometry.footer.bottom <= offsetTop + height + 1,
    JSON.stringify(geometry),
  );
  assert.ok(geometry.body.height >= 60, JSON.stringify(geometry));
  assert.ok(
    geometry.field.top >= geometry.body.top - 1,
    JSON.stringify(geometry),
  );
  assert.ok(
    geometry.field.top < geometry.body.bottom,
    JSON.stringify(geometry),
  );
  assert.ok(
    geometry.dialog.right <= page.viewportSize().width + 1,
    JSON.stringify(geometry),
  );
  assert.ok(geometry.dialog.left >= -1, JSON.stringify(geometry));
  await checkWidth(page);
}
try {
  for (const width of [320, 390, 430, 844, 1280]) {
    const ctx = await browser.newContext({
      viewport: { width, height: width === 844 ? 390 : 844 },
      isMobile: width < 1000,
      hasTouch: width < 1000,
    });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p.getByLabel("Email address").waitFor();
    if (width < 1000) await checkFields(p);
    await p.getByLabel("Email address").focus();
    await checkWidth(p);
    await p.screenshot({
      path: `test-results/${engine}-login-${width}.png`,
      fullPage: true,
    });
    await p
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    if (width < 1000) await checkFields(p);
    await checkWidth(p);
    await p.screenshot({
      path: `test-results/${engine}-signup-${width}.png`,
      fullPage: true,
    });
    await ctx.close();
  }
  const setup = await browser.newContext();
  await login(setup, "admin@your-entity.example");
  const eventResponse = await setup.request.post(base + "api/admin/events", {
    data: { name: "UI Test Event", active: true },
  });
  assert.equal(eventResponse.status(), 201, await eventResponse.text());
  const eventId = (await eventResponse.json()).event.id;
  for (const role of ["MARKETING_VP", "B2C_VP"]) {
    const r = await setup.request.post(base + "api/users", {
      data: { name: role, email: role + "@example.com", password, role },
    });
    assert.equal(r.status(), 201, await r.text());
  }
  const page = await setup.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page.getByRole("button", { name: "Accounts", exact: true }).click();
  await page.getByRole("button", { name: "Add person", exact: true }).click();
  await page.getByLabel("Role", { exact: true }).waitFor();
  const options = await page
    .getByLabel("Role", { exact: true })
    .locator("option")
    .evaluateAll((nodes) => nodes.map((n) => n.value));
  assert.ok(options.includes("CREATOR"));
  assert.ok(options.includes("ADMIN"));
  assert.ok(options.includes("OCP"));
  await setup.close();
  for (const role of roles) {
    const width = role === "CREATOR" ? 320 : role === "B2C_MEMBER" ? 430 : 390;
    const ctx = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await p.getByLabel("Your name").fill(role);
    await p.getByLabel("Team role").selectOption(role);
    if (role === "CREATOR")
      await p.getByLabel("Event", { exact: true }).selectOption(eventId);
    await p.getByLabel("Email address").fill(role + "@example.com");
    await p.getByLabel("Password", { exact: true }).fill(password);
    await p.getByLabel("Confirm password").fill(password);
    await checkWidth(p);
    await p
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await p.getByRole("heading", { name: "Welcome to Approval Hub" }).waitFor();
    await p.getByLabel("Password", { exact: true }).fill(password);
    await p.getByRole("button", { name: "Sign in", exact: true }).click();
    await p.getByRole("heading", { name: "Overview", exact: true }).waitFor();
    await p
      .getByRole("button", { name: "New submission", exact: true })
      .click();
    assert.equal(
      await p
        .locator("dialog h2")
        .evaluate((el) => el === document.activeElement),
      true,
      "Opening the dialog must not summon the keyboard",
    );
    await checkFields(p);
    for (const [height, offset] of [
      [340, 0],
      [340, 65],
      [250, 0],
      [844, 0],
    ]) {
      await p.locator('textarea[name="notes"]').focus();
      await checkDialog(p, height, offset);
    }
    await p.getByLabel("Submission title").focus();
    await checkDialog(p, 340);
    await p.screenshot({
      path: `test-results/${engine}-submission-keyboard-${width}.png`,
      clip: { x: 0, y: 0, width, height: 340 },
    });
    await keyboardViewport(p, 844);
    await p.screenshot({
      path: `test-results/${engine}-submission-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await p.getByText("Approval category", { exact: true }).count(),
      0,
    );
    await p.getByLabel("Submission title").fill("Mobile upload " + role);
    if (role !== "CREATOR")
      await p.getByLabel("Campaign / project (optional)").fill("UI check");
    await p.locator('textarea[name="caption"]').fill("Ready for review");
    await p.getByLabel("Upload creative files").setInputFiles({
      name: "creative.png",
      mimeType: "image/png",
      buffer: png,
    });
    await p
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await p
      .getByRole("heading", { name: "Mobile upload " + role, exact: true })
      .waitFor();
    await checkWidth(p);
    await ctx.close();
  }
  for (const width of [360, 390, 1280]) {
    for (const role of roles) {
      const creator = await browser.newContext();
      await login(creator, role + "@example.com");
      const response = await creator.request.post(base + "api/submissions", {
        multipart: {
          title: `Review ${role} ${width}`,
          event: "UI check",
          caption: "Test caption",
          contentType: "Social post",
          platform: "Instagram",
          status: "PENDING",
          category: role === "B2C_MEMBER" ? "MARKETING" : "B2C",
          files: { name: "creative.png", mimeType: "image/png", buffer: png },
        },
      });
      assert.equal(response.status(), 201, await response.text());
      const { submission } = await response.json();
      assert.equal(
        submission.category,
        role === "B2C_MEMBER" ? "B2C" : "MARKETING",
      );
      await creator.close();
      const reviewer = await browser.newContext({
        viewport: { width, height: 844 },
      });
      await login(
        reviewer,
        (role === "B2C_MEMBER" ? "B2C_VP" : "MARKETING_VP") + "@example.com",
      );
      const p = await reviewer.newPage();
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(base + "?submission=" + submission.id);
      await p
        .getByRole("heading", { name: submission.title, exact: true })
        .waitFor();
      await checkWidth(p);
      const button =
        width < 760
          ? p.getByRole("button", { name: "Approve", exact: true })
          : p.getByRole("button", { name: "Approve submission", exact: true });
      await button.waitFor({ state: "visible" });
      await p.screenshot({
        path: `test-results/review-${role}-${width}.png`,
        fullPage: true,
      });
      await button.click();
      if (width < 760) {
        await p.getByLabel("Comment (optional)").fill("Looks good");
        await checkDialog(p, 340);
        await p.screenshot({
          path: `test-results/${engine}-decision-keyboard-${width}.png`,
          clip: { x: 0, y: 0, width, height: 340 },
        });
      }
      await p
        .getByRole("button", { name: "Confirm decision", exact: true })
        .click();
      await p.locator(".review-receipt").waitFor();
      assert.match(await p.locator(".review-receipt").innerText(), /Approved/);
      await checkWidth(p);
      await reviewer.close();
    }
  }
  async function navigate(p, name) {
    if (p.viewportSize().width < 760)
      await p
        .getByRole("button", { name: "Open menu", exact: true })
        .first()
        .click();
    await p
      .locator(".sidebar")
      .getByRole("button", { name, exact: true })
      .click();
    await p.getByRole("heading", { name, exact: true }).waitFor();
    await checkWidth(p);
  }
  const adminContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  await login(adminContext, "admin@your-entity.example");
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (e) => errors.push(e.message));
  await adminPage.goto(base);
  await navigate(adminPage, "Events");
  await adminPage
    .getByRole("button", { name: "Add event", exact: true })
    .click();
  await adminPage.getByLabel("Event name").fill("Mobile event management");
  await adminPage
    .getByLabel("Committee", { exact: true })
    .selectOption("EXAMPLE_IG");
  await adminPage.getByLabel("Event name").focus();
  await checkDialog(adminPage, 340);
  await keyboardViewport(adminPage, 844);
  await adminPage
    .getByRole("button", { name: "Save event", exact: true })
    .click();
  await adminPage
    .getByRole("heading", { name: "Mobile event management", exact: true })
    .waitFor();
  await checkWidth(adminPage);
  const eventsResult = await adminContext.request.get(base + "api/events");
  const example_igEventId = (await eventsResult.json()).events.find(
    (e) => e.name === "Mobile event management",
  ).id;
  await navigate(adminPage, "Accounts");
  await adminPage
    .getByRole("button", { name: "Add person", exact: true })
    .click();
  await adminPage.getByLabel("Full name").fill("Event observer");
  await adminPage.getByLabel("Email address").fill("ocp@example.com");
  await adminPage.getByLabel("Role", { exact: true }).selectOption("OCP");
  await adminPage.getByLabel("Event", { exact: true }).selectOption(eventId);
  await adminPage
    .getByLabel("Initial password", { exact: false })
    .fill(password);
  await checkDialog(adminPage, 340);
  await keyboardViewport(adminPage, 844);
  await adminPage
    .getByRole("button", { name: "Save account", exact: true })
    .click();
  await adminPage.locator("dialog").waitFor({ state: "detached" });
  await adminPage.getByText("ocp@example.com", { exact: true }).waitFor();
  await adminPage.screenshot({
    path: `test-results/${engine}-accounts-390.png`,
    fullPage: true,
  });
  for (const name of ["Settings", "Notifications", "Storage cleanup"])
    await navigate(adminPage, name);
  for (const role of ["IGVP_MARKETING", "IGVP_OGV"]) {
    const r = await adminContext.request.post(base + "api/users", {
      data: { name: role, email: role + "@example.com", password, role },
    });
    assert.equal(r.status(), 201, await r.text());
  }
  await adminContext.close();
  for (const width of [390, 1280]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
    });
    await login(context, "ocp@example.com");
    const p = await context.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p
      .getByRole("heading", { name: "UI Test Event", exact: true })
      .waitFor();
    await checkWidth(p);
    assert.equal(
      await p
        .getByRole("button", { name: "New submission", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await p
        .locator(".sidebar")
        .getByRole("button", { name: "Approval queue", exact: true })
        .count(),
      0,
    );
    const result = await context.request.get(base + "api/submissions");
    const posts = (await result.json()).submissions;
    assert.ok(posts.length > 0);
    assert.ok(
      posts.every(
        (s) => s.eventId === eventId && s.submitterRole === "CREATOR",
      ),
    );
    await p.screenshot({
      path: `test-results/${engine}-ocp-${width}.png`,
      fullPage: true,
    });
    await p.goto(base + "?submission=" + posts[0].id);
    await p
      .getByRole("heading", { name: posts[0].title, exact: true })
      .waitFor();
    assert.equal(
      await p.getByRole("button", { name: /^Approve( submission)?$/ }).count(),
      0,
    );
    await checkWidth(p);
    await context.close();
  }
  const observerContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const observerPage = await observerContext.newPage();
  observerPage.on("pageerror", (e) => errors.push(e.message));
  await observerPage.goto(base);
  await observerPage
    .getByRole("button", { name: "Create an account", exact: true })
    .click();
  await observerPage.getByLabel("Your name").fill("EXAMPLE_IG OCP");
  await observerPage.getByLabel("Team role").selectOption("OCP");
  await observerPage.waitForFunction(
    (id) =>
      document.querySelector(`select[aria-label="Event"] option[value="${id}"]`)
        ?.disabled,
    eventId,
  );
  assert.ok(
    await observerPage
      .getByLabel("Event", { exact: true })
      .locator(`option[value="${eventId}"]`)
      .evaluate((el) => el.disabled),
  );
  await observerPage
    .getByLabel("Event", { exact: true })
    .selectOption(example_igEventId);
  await observerPage.getByLabel("Email address").fill("example_ig-ocp@example.com");
  await observerPage.getByLabel("Password", { exact: true }).fill(password);
  await observerPage.getByLabel("Confirm password").fill(password);
  await checkWidth(observerPage);
  await observerPage
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await observerPage
    .getByRole("heading", { name: "Welcome to Approval Hub" })
    .waitFor();
  await login(observerContext, "example_ig-ocp@example.com");
  await observerPage.reload();
  await observerPage
    .getByRole("heading", { name: "Mobile event management", exact: true })
    .waitFor();
  assert.equal(
    await observerPage
      .getByRole("button", { name: "New submission", exact: true })
      .count(),
    0,
  );
  await observerContext.close();
  for (const [role, ig, lc] of [
    ["CREATOR", "IGVP_MARKETING", "MARKETING_VP"],
    ["MARKETING_MEMBER", "IGVP_MARKETING", "MARKETING_VP"],
    ["B2C_MEMBER", "IGVP_OGV", "B2C_VP"],
  ]) {
    const member = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const p = await member.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(base);
    await p
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await p.getByLabel("Your name").fill("EXAMPLE_IG " + role);
    await p.getByLabel("Team role").selectOption(role);
    if (role === "CREATOR")
      await p.getByLabel("Event", { exact: true }).selectOption(example_igEventId);
    else
      await p
        .getByLabel("Local committee / initiative group")
        .selectOption("EXAMPLE_IG");
    await p.getByLabel("Email address").fill("example_ig-" + role + "@example.com");
    await p.getByLabel("Password", { exact: true }).fill(password);
    await p.getByLabel("Confirm password").fill(password);
    await p
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await p.getByRole("heading", { name: "Welcome to Approval Hub" }).waitFor();
    await login(member, "example_ig-" + role + "@example.com");
    await p.reload();
    await p
      .getByRole("button", { name: "New submission", exact: true })
      .click();
    await p.getByLabel("Submission title").fill("EXAMPLE_IG Drive " + role);
    await p.locator('textarea[name="caption"]').fill("Video for approval");
    await p
      .getByLabel("Google Drive video link (optional)")
      .fill("https://drive.google.com/file/d/ui-test-video/view");
    await p
      .getByRole("button", { name: "Submit for review", exact: true })
      .click();
    await p
      .getByRole("heading", { name: "EXAMPLE_IG Drive " + role, exact: true })
      .waitFor();
    const response = await member.request.get(base + "api/submissions");
    let s = (await response.json()).submissions[0];
    assert.equal(s.reviewStage, "IG");
    assert.equal(s.organization, "EXAMPLE_IG");
    await member.close();
    for (const [reviewRole, width] of [
      [ig, 390],
      [lc, 1280],
    ]) {
      const c = await browser.newContext({ viewport: { width, height: 844 } });
      await login(c, reviewRole + "@example.com");
      const r = await c.newPage();
      r.on("pageerror", (e) => errors.push(e.message));
      await r.goto(base + "?submission=" + s.id);
      await r.getByRole("heading", { name: s.title, exact: true }).waitFor();
      await checkWidth(r);
      assert.equal(
        await r.getByRole("link", { name: "Open video" }).count(),
        1,
      );
      await r.screenshot({
        path: `test-results/${engine}-${reviewRole}-${width}.png`,
        fullPage: true,
      });
      await r
        .getByRole("button", {
          name: width < 760 ? "Approve" : "Approve submission",
          exact: true,
        })
        .click();
      await r
        .getByRole("button", { name: "Confirm decision", exact: true })
        .click();
      await r.locator(".review-receipt").waitFor();
      const detail = await c.request.get(base + "api/submissions/" + s.id);
      s = (await detail.json()).submission;
      assert.equal(s.status, reviewRole === ig ? "PENDING" : "APPROVED");
      assert.equal(s.reviewStage, "LC");
      await c.close();
    }
  }
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log(
    `PASS (${engine}): mobile/desktop forms, keyboard geometry, all signup routes, event/account administration, read-only OCP dashboards, Drive video submissions and both EXAMPLE_IG approval stages; no runtime errors or horizontal overflow.`,
  );
} finally {
  if (errors.length) console.error("Browser errors:", errors);
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      console.log(
        "Final page:",
        (await page.locator("body").innerText()).slice(0, 1500),
      );
      await page.screenshot({
        path: `test-results/${engine}-last-screen.png`,
        fullPage: true,
      });
    }
  await browser.close();
  await vite.close();
  await new Promise((resolve) => api.close(resolve));
  app.close();
  rmSync(temp, { recursive: true, force: true });
}
