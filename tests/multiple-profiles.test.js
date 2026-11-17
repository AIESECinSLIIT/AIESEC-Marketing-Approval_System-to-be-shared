import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloudDatabase } from "./cloud-fixture.js";
test("multiple profiles keep role scopes, self-review protection, files and notifications correct", async (t) => {
  const db = await cloudDatabase();
  t.after(() => db.close());
  const q = async (s, a = []) => (await db.query(s, a)).rows[0]?.result;
  const root = () => db.exec("reset role");
  const as = async (account, profile = account, role = "authenticated") => {
    await root();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      account || "",
    ]);
    await db.query("select set_config('request.headers',$1,false)", [
      JSON.stringify(
        profile
          ? { "x-client-info": "approval-hub approval-profile=" + profile }
          : {},
      ),
    ]);
    await db.exec("set role " + role);
  };
  const service = () => as(null, null, "service_role");
  async function identity(name, email) {
    await root();
    let id = randomUUID();
    await db.query("insert into auth.users values($1,$2,$3,now())", [
      id,
      email || id + "@test.invalid",
      { name, role: "MARKETING_MEMBER" },
    ]);
    return id;
  }
  const admin = await identity("Admin", "admin@your-entity.example");
  await service();
  await q(
    "select public.club_manage_account($1,'Admin','ADMIN',true,'ENTITY',null,'admin@your-entity.example')",
    [admin],
  );
  const alice = await identity("Alice"),
    bob = await identity("Bob"),
    carol = await identity("Carol");
  const assign = async (
    account,
    role,
    org = "ENTITY",
    event = null,
    actor = admin,
  ) => {
    await service();
    return q(
      "select public.club_add_managed_profile($1,$2,$3,$4,true,$5,$6) as result",
      [actor, account, "Assigned " + role, role, org, event],
    );
  };
  const event = async (name, org = "ENTITY") => {
    await as(admin);
    return (
      await q("select public.club_event(null,$1,true,false,$2) as result", [
        name,
        org,
      ])
    ).event.id;
  };
  const e1 = await event("Catalyst"),
    e2 = await event("Halloween");
  const own = async (
    account,
    role,
    event = null,
    org = "ENTITY",
    profile = account,
  ) => {
    await as(account, profile);
    return (
      await q("select public.club_add_profile($1,$2,$3) as result", [
        role,
        org,
        event,
      ])
    ).profile.id;
  };
  const aCreator = await own(alice, "CREATOR", e1),
    aHalloween = await own(alice, "CREATOR", e2),
    aMkt = await assign(alice, "MARKETING_VP");
  let post1, post2;
  const save = async (account, profile, title, path) => {
    await as(account, profile);
    return (
      await q("select public.club_save(null,$1,$2) as result", [
        {
          title,
          caption: "Caption",
          contentType: "Image",
          platform: "Instagram",
          status: "PENDING",
          externalUrl: path ? "" : "https://drive.google.com/file/d/test/view",
        },
        path ? [{ path, name: "creative.png", mime: "image/png" }] : [],
      ])
    ).submission;
  };
  const review = async (account, profile, s, decision = "APPROVED") => {
    await as(account, profile);
    return q("select public.club_review($1,$2,$3,$4) as result", [
      s.id,
      decision,
      decision === "APPROVED" ? "" : "Feedback",
      s.version,
    ]);
  };
  await t.test(
    "profiles share login, not permissions, and cannot select another account’s profile",
    async () => {
      await as(alice, aCreator);
      let me = await q("select public.club_me() as result");
      assert.equal(me.accountId, alice);
      assert.equal(me.id, aCreator);
      assert.equal(me.eventId, e1);
      const list = (await q("select public.club_profiles() as result"))
        .profiles;
      assert.equal(list.length, 4);
      assert(list.every((p) => p.accountId === alice));
      await as(alice, aHalloween);
      assert.equal((await q("select public.club_me() as result")).eventId, e2);
      await as(bob, aCreator);
      await assert.rejects(q("select public.club_me()"), /active profile/);
      await as(alice, aCreator);
      await assert.rejects(
        q("select public.club_add_profile('ADMIN','ENTITY',null)"),
        /appointed/,
      );
      await assert.rejects(own(alice, "CREATOR", e1), /already exists/);
    },
  );
  await t.test(
    "each submission belongs to its active profile and file ownership remains the login identity",
    async () => {
      await root();
      const p1 = alice + "/one/image.png",
        p2 = alice + "/two/image.png";
      for (const path of [p1, p2])
        await db.query(
          "insert into storage.objects values('creatives',$1,$2)",
          [path, { size: 100, mimetype: "image/png" }],
        );
      post1 = await save(alice, aCreator, "Catalyst creative", p1);
      post2 = await save(alice, aHalloween, "Halloween creative", p2);
      assert.equal(post1.creatorId, aCreator);
      assert.equal(post1.creatorAccountId, alice);
      assert.equal(post2.eventId, e2);
      await as(alice, aCreator);
      assert.equal(
        (await q("select public.club_submissions() as result")).submissions
          .length,
        1,
      );
      await assert.rejects(q("select public.club_detail($1)", [post2.id]));
      await as(alice, aHalloween);
      assert.equal(
        (await q("select public.club_submissions() as result")).submissions[0]
          .id,
        post2.id,
      );
      await as(bob);
      assert.equal(
        await q("select club.file_access($1,false) as result", [p1]),
        false,
      );
    },
  );
  await t.test(
    "switching to an LCVP profile cannot approve any of the same person’s submissions",
    async () => {
      await assert.rejects(review(alice, aMkt, post1), /cannot review/);
      await assert.rejects(review(alice, aMkt, post2), /cannot review/);
      const other = await save(bob, bob, "Another person");
      assert.equal(
        (await review(alice, aMkt, other)).submission.status,
        "APPROVED",
      );
    },
  );
  const cOcp = await assign(carol, "OCP", "ENTITY", e1),
    cManager = await assign(carol, "EVENT_MANAGER", "ENTITY", e1);
  await root();
  await db.query(
    "insert into club.push_settings values(true,'public','private',$1,'https://example.test/push')",
    ["a".repeat(64)],
  );
  const endpoint = "https://fcm.googleapis.com/carol-device";
  await as(carol, cOcp);
  await q("select public.club_push_subscribe($1)", [
    { endpoint, keys: { p256dh: "A".repeat(87), auth: "A".repeat(22) } },
  ]);
  await t.test(
    "one device subscription covers all profiles with one notification per action",
    async () => {
      await root();
      await db.exec("delete from club.notifications");
      const s = await save(alice, aCreator, "Deduplicate this update");
      await root();
      assert.equal(
        await q(
          "select count(*)::int as result from club.notifications n join club.profiles p on p.id=n.user_id where p.auth_user_id=$1 and n.submission_id=$2",
          [carol, s.id],
        ),
        1,
      );
      await as(carol, carol);
      const notices = (await q("select public.club_notifications() as result"))
        .notifications;
      assert.equal(notices.length, 1);
      assert([cOcp, cManager].includes(notices[0].profileId));
      assert.equal(
        (await q("select public.club_push_status($1) as result", [endpoint]))
          .enabled,
        true,
      );
      await service();
      const jobs = await q("select public.club_claim_push() as result");
      assert.equal(jobs.length, 1);
      assert(jobs[0].payload.url.includes("&profile=" + notices[0].profileId));
      assert(jobs[0].payload.body.includes("Deduplicate this update"));
    },
  );
  await t.test(
    "disabling or deleting one profile keeps the login, other profiles, files and device access",
    async () => {
      await service();
      const target = await q(
        "select public.club_remove_account($1,$2,false) as result",
        [admin, aHalloween],
      );
      assert.equal(target.deleteAuth, false);
      assert.deepEqual(target.paths, [alice + "/two/image.png"]);
      await root();
      await db.query("delete from storage.objects where name=$1", [
        target.paths[0],
      ]);
      await service();
      await q("select public.club_remove_account($1,$2,true)", [
        admin,
        aHalloween,
      ]);
      await as(alice, aCreator);
      assert.equal(
        (await q("select public.club_detail($1) as result", [post1.id])).files
          .length,
        1,
      );
      await root();
      assert.equal(
        await q("select count(*)::int as result from auth.users where id=$1", [
          alice,
        ]),
        1,
      );
      await service();
      const carolBase = await q(
        "select public.club_remove_account($1,$2,false) as result",
        [admin, carol],
      );
      assert.equal(carolBase.deleteAuth, false);
      await q("select public.club_remove_account($1,$2,true)", [admin, carol]);
      await as(carol, cManager);
      assert.equal(
        (await q("select public.club_push_status($1) as result", [endpoint]))
          .enabled,
        true,
      );
      assert.equal((await q("select public.club_me() as result")).id, cManager);
    },
  );
  await t.test(
    "shared-login credential changes require authority over all its profiles",
    async () => {
      const emAccount = await identity("EM"),
        em = await assign(emAccount, "EM_VP");
      await root();
      await db.query(
        "insert into club.initiative_groups(id,name,logo_path) values('ig-test','IG Test','test.png')",
      );
      const aIg = await assign(alice, "IGVP_MARKETING", "ig-test", null, em);
      await service();
      const limited = await q(
        "select public.club_login_access($1,$2) as result",
        [em, aIg],
      );
      assert.equal(limited.accountId, alice);
      assert.equal(limited.canManageLogin, false);
      const supreme = await q(
        "select public.club_login_access($1,$2) as result",
        [admin, aIg],
      );
      assert.equal(supreme.canManageLogin, true);
      await as(alice, aIg);
      assert.equal(
        (await q("select public.club_me() as result")).logoPath,
        "test.png",
      );
    },
  );
});
