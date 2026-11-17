import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloudDatabase } from "./cloud-fixture.js";
import {
  normalizeDriveLink,
  canReview,
  canView,
  initialStage,
} from "../src/workflow.js";

test("event privacy, OCP monitoring, EXAMPLE_IG review stages and account administration", async (t) => {
  const db = await cloudDatabase();
  t.after(() => db.close());
  await db.exec("insert into club.initiative_groups(id,name,logo_path) values('EXAMPLE_IG','AIESEC in EXAMPLE_IG','fixture.png')");
  await db.query("insert into club.push_settings values(true,$1,$2,$3,$4)", [
    "public-test-key",
    "private-test-key",
    "a".repeat(64),
    "https://example.test/push",
  ]);
  const query = async (sql, args = []) =>
    (await db.query(sql, args)).rows[0]?.result;
  const as = async (id, role = "authenticated") => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      id || "",
    ]);
    await db.exec(`set role ${role}`);
  };
  const service = () => db.exec("reset role; set role service_role");
  async function user(role, organization = "ENTITY", eventId = null) {
    const id = randomUUID();
    await db.exec("reset role");
    await db.query("insert into auth.users values($1,$2,$3,now())", [
      id,
      (role === "ADMIN" ? "admin@your-entity.example" : id + "@test.invalid"),
      { name: role, role: "MARKETING_MEMBER" },
    ]);
    await service();
    await db.query(
      "select public.club_manage_account($1,$2,$2,true,$3,$4,$5)",
      [id, role, organization, eventId, role === "ADMIN" ? "admin@your-entity.example" : id + "@test.invalid"],
    );
    return id;
  }
  const admin = await user("ADMIN");
  await as(admin);
  const e1 = (
    await query("select public.club_event(null,$1,true,false) as result", [
      "Catalyst 7.0",
    ])
  ).event.id;
  const e2 = (
    await query("select public.club_event(null,$1,true,false) as result", [
      "Legacy'26",
    ])
  ).event.id;
  const ocvp = await user("CREATOR", "ENTITY", e1),
    otherCreator = await user("CREATOR", "ENTITY", e2);
  const ocp = await user("OCP", "ENTITY", e1),
    otherOcp = await user("OCP", "ENTITY", e2);
  const mkt = await user("MARKETING_VP"),
    b2c = await user("B2C_VP");
  const igMkt = await user("IGVP_MARKETING", "EXAMPLE_IG"),
    igOgv = await user("IGVP_OGV", "EXAMPLE_IG");
  const example_igMkt = await user("MARKETING_MEMBER", "EXAMPLE_IG"),
    example_igB2c = await user("B2C_MEMBER", "EXAMPLE_IG");
  const entityMkt = await user("MARKETING_MEMBER"),
    entityB2c = await user("B2C_MEMBER");
  for (const [observer, suffix] of [
    [ocp, "catalyst"],
    [otherOcp, "legacy"],
  ]) {
    await as(observer);
    await db.query("select public.club_push_subscribe($1)", [
      {
        endpoint: "https://fcm.googleapis.com/fcm/send/" + suffix,
        keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
      },
    ]);
  }
  const base = {
    title: "Creative",
    event: "Forged event",
    caption: "Caption",
    contentType: "Video",
    platform: "Instagram",
    notes: "",
    status: "PENDING",
    externalUrl: "https://drive.google.com/file/d/test-video-123/view",
  };
  const save = async (id, data = {}, sid = null) => {
    await as(id);
    return (
      await query("select public.club_save($1,$2,$3) as result", [
        sid,
        { ...base, ...data },
        [],
      ])
    ).submission;
  };
  const review = async (id, s, decision = "APPROVED", comment = "") => {
    await as(id);
    return (
      await query("select public.club_review($1,$2,$3,$4) as result", [
        s.id,
        decision,
        comment,
        s.version,
      ])
    ).submission;
  };
  const detail = async (id, s) => {
    await as(id);
    return query("select public.club_detail($1) as result", [s.id]);
  };
  let eventPost;
  await t.test(
    "events are admin-managed; signup only exposes active event names",
    async () => {
      await as(null, "anon");
      assert.equal(
        (await query("select public.club_events() as result")).events.length,
        2,
      );
      await assert.rejects(query("select public.club_events(true)"));
      await assert.rejects(db.query("select * from club.events"));
      await as(ocvp);
      await assert.rejects(
        query("select public.club_event(null,$1,true,false)", [
          "Injected event",
        ]),
      );
      await db.exec("reset role");
      for (const role of ["ADMIN", "IGVP_MARKETING", "IGVP_OGV"]) {
        const id = randomUUID();
        await db.exec("reset role");
        await db.query("insert into auth.users values($1,$2,$3,now())", [
          id,
          id + "@test.invalid",
          { name: "Attacker", role, eventId: e1 },
        ]);
        await as(id);
        assert.equal(
          (await query("select public.club_me() as result")).role,
          "MARKETING_MEMBER",
        );
      }
      await db.exec("reset role");
      await assert.rejects(
        db.query("insert into auth.users values($1,$2,$3,now())", [
          randomUUID(),
          "no-event@test.invalid",
          { role: "CREATOR" },
        ]),
      );
    },
  );
  await t.test(
    "OCVP event comes from the profile; OCP sees only their event and cannot write",
    async () => {
      eventPost = await save(ocvp, { eventId: e2, category: "B2C" });
      assert.equal(eventPost.eventId, e1);
      assert.equal(eventPost.event, "Catalyst 7.0");
      assert.equal(eventPost.category, "MARKETING");
      await service();
      const jobs = await query("select public.club_claim_push() as result");
      assert.equal(jobs.length, 1);
      assert.match(jobs[0].subscription.endpoint, /catalyst$/);
      await db.exec("reset role");
      const filePath = ocvp + "/image.png";
      await db.query("insert into storage.objects values('creatives',$1,$2)", [
        filePath,
        { size: 128, mimetype: "image/png" },
      ]);
      await db.query(
        "insert into club.files(submission_id,revision,name,mime,size,path) values($1,1,'image.png','image/png',128,$2)",
        [eventPost.id, filePath],
      );
      await as(ocp);
      assert.equal(
        await query("select club.file_access($1,false) as result", [filePath]),
        true,
      );
      assert.equal(
        await query("select club.file_access($1,true) as result", [
          ocp + "/new.png",
        ]),
        false,
      );
      await as(otherOcp);
      assert.equal(
        await query("select club.file_access($1,false) as result", [filePath]),
        false,
      );
      assert.equal((await detail(ocp, eventPost)).submission.id, eventPost.id);
      for (const denied of [otherOcp, otherCreator, igMkt, b2c])
        await assert.rejects(detail(denied, eventPost));
      await assert.rejects(save(ocp));
      await assert.rejects(review(ocp, eventPost));
      await as(ocp);
      await assert.rejects(query("select public.club_storage()"));
      await assert.rejects(query("select public.club_users()"));
      const draft = await save(ocvp, { status: "DRAFT" });
      await assert.rejects(detail(ocp, draft));
      const notes = await query("select public.club_notifications() as result");
      assert.ok(
        notes.notifications.some((n) => n.submissionId === eventPost.id),
      );
      await as(otherOcp);
      assert.equal(
        (await query("select public.club_notifications() as result"))
          .notifications.length,
        0,
      );
      eventPost = await review(
        mkt,
        eventPost,
        "CHANGES_REQUESTED",
        "Update the date",
      );
      await as(ocp);
      assert.ok(
        (
          await query("select public.club_notifications() as result")
        ).notifications.some((n) => n.title === "Changes requested"),
      );
      eventPost = await save(
        ocvp,
        { version: eventPost.version },
        eventPost.id,
      );
      eventPost = await review(mkt, eventPost);
      assert.equal(eventPost.status, "APPROVED");
    },
  );
  await t.test(
    "member posts do not leak to event observers; ENTITY routing stays direct",
    async () => {
      for (const [creator, reviewer, category] of [
        [entityMkt, mkt, "MARKETING"],
        [entityB2c, b2c, "B2C"],
      ]) {
        const s = await save(creator, { event: "Catalyst 7.0", eventId: e1 });
        assert.equal(s.eventId, null);
        assert.equal(s.category, category);
        assert.equal(s.reviewStage, "LC");
        await assert.rejects(detail(ocp, s));
        assert.equal((await review(reviewer, s)).status, "APPROVED");
      }
    },
  );
  await t.test(
    "EXAMPLE_IG needs IG then LC; no cross-category, stale, self or skipped decisions",
    async () => {
      for (const [creator, ig, lc, wrongIg] of [
        [example_igMkt, igMkt, mkt, igOgv],
        [example_igB2c, igOgv, b2c, igMkt],
      ]) {
        let s = await save(creator, {
          reviewStage: "LC",
          organization: "ENTITY",
        });
        assert.equal(s.reviewStage, "IG");
        assert.equal(s.organization, "EXAMPLE_IG");
        await assert.rejects(review(lc, s));
        await assert.rejects(review(wrongIg, s));
        await assert.rejects(review(creator, s));
        await as(ig);
        assert.ok(
          (
            await query("select public.club_notifications() as result")
          ).notifications.some((n) => n.submissionId === s.id),
        );
        await as(lc);
        assert.ok(
          (
            await query("select public.club_notifications() as result")
          ).notifications.some((n) => n.submissionId === s.id),
        );
        const old = s;
        s = await review(ig, s);
        assert.equal(s.reviewStage, "LC");
        assert.equal(s.status, "PENDING");
        await assert.rejects(review(ig, s));
        await assert.rejects(review(lc, old));
        await assert.rejects(review(lc, s, "REJECTED", ""));
        s = await review(lc, s, "CHANGES_REQUESTED", "Fix the caption");
        s = await save(
          creator,
          { version: s.version, caption: "Revised caption" },
          s.id,
        );
        assert.equal(s.reviewStage, "IG");
        await assert.rejects(review(lc, s));
        s = await review(ig, s);
        s = await review(lc, s);
        assert.equal(s.status, "APPROVED");
        const d = await detail(creator, s);
        assert.equal(
          d.history.filter((h) => h.action === "IG_APPROVED").length,
          2,
        );
        await assert.rejects(save(creator, { version: s.version }, s.id));
      }
    },
  );
  await t.test(
    "IGVP own posts go directly to the matching ENTITY LCVP",
    async () => {
      for (const [ig, lc, category] of [
        [igMkt, mkt, "MARKETING"],
        [igOgv, b2c, "B2C"],
      ]) {
        const s = await save(ig);
        assert.equal(s.reviewStage, "LC");
        assert.equal(s.category, category);
        await assert.rejects(review(ig, s));
        assert.equal((await review(lc, s)).status, "APPROVED");
      }
    },
  );
  await t.test(
    "archiving an event blocks new signup/submission while preserving its history",
    async () => {
      await as(admin);
      await query("select public.club_event($1,$2,false,false)", [
        e1,
        "Catalyst 7.0",
      ]);
      await assert.rejects(save(ocvp));
      await assert.rejects(save(ocvp, { status: "DRAFT" }));
      assert.equal((await detail(ocp, eventPost)).submission.id, eventPost.id);
      await as(null, "anon");
      assert.equal(
        (await query("select public.club_events() as result")).events.length,
        1,
      );
      await db.exec("reset role");
      await assert.rejects(
        db.query("insert into auth.users values($1,$2,$3,now())", [
          randomUUID(),
          "archived@test.invalid",
          { role: "CREATOR", eventId: e1 },
        ]),
      );
      await as(admin);
      await assert.rejects(
        query("select public.club_event($1,$2,true,true)", [
          e1,
          "Catalyst 7.0",
        ]),
      );
    },
  );
  await t.test(
    "scope changes revoke observer notifications and file access",
    async () => {
      await db.exec("reset role");
      await db.query(
        "update auth.users set raw_user_meta_data=$1 where id=$2",
        [{ role: "ADMIN", eventId: e2 }, ocp],
      );
      await as(ocp);
      assert.equal(
        (await query("select public.club_me() as result")).eventId,
        e1,
      );
      await service();
      await assert.rejects(
        query(
          "select public.club_manage_account($1,'OCP','OCP',true,'ENTITY',$2,$3)",
          [ocp, e2, ocp + "@test.invalid"],
        ),
      );
      await query(
        "select public.club_manage_account($1,'Former OCP','MARKETING_MEMBER',true,'ENTITY',null,$2)",
        [otherOcp, otherOcp + "@test.invalid"],
      );
      await query("select public.club_manage_account($1,$2,$3,true,$4,$5,$6)", [
        ocp,
        "OCP",
        "OCP",
        "ENTITY",
        e2,
        ocp + "@test.invalid",
      ]);
      await assert.rejects(detail(ocp, eventPost));
      await as(ocp);
      assert.equal(
        (await query("select public.club_notifications() as result"))
          .notifications.length,
        0,
      );
    },
  );
  await t.test(
    "deletion is service-only, protects the last admin, and retains submission history",
    async () => {
      await as(ocvp);
      await assert.rejects(
        query("select public.club_delete_account($1,false)", [admin]),
      );
      await service();
      await assert.rejects(
        query("select public.club_delete_account($1,false)", [admin]),
      );
      const paths = await query(
        "select public.club_delete_account($1,false) as result",
        [ocvp],
      );
      assert.deepEqual(paths.paths, [ocvp + "/image.png"]);
      await assert.rejects(
        query("select public.club_delete_account($1,true)", [ocvp]),
      );
      await as(ocvp);
      await assert.rejects(query("select public.club_me()"));
      await db.exec("reset role");
      await db.query("delete from storage.objects where name=$1", [
        ocvp + "/image.png",
      ]);
      await db.query("delete from auth.users where id=$1", [ocvp]);
      await service();
      await query("select public.club_delete_account($1,true)", [ocvp]);
      await as(admin);
      assert.ok(
        !(await query("select public.club_users() as result")).users.some(
          (u) => u.id === ocvp,
        ),
      );
      assert.equal(
        (await detail(admin, eventPost)).submission.status,
        "APPROVED",
      );
      await assert.rejects(user("ADMIN"), /duplicate|already holds/);
    },
  );
  await t.test(
    "Drive links are accepted without uploads and unsafe URLs are rejected",
    async () => {
      for (const externalUrl of [
        "javascript:alert(1)",
        "https://drive.google.com.evil.test/file/d/abc/view",
        "https://evil.test/video",
        "https://drive.google.com@evil.test/file/d/abc/view",
      ])
        await assert.rejects(save(entityMkt, { externalUrl }));
      const s = await save(entityMkt);
      assert.equal(s.fileCount, 0);
      assert.equal(s.externalUrl, base.externalUrl);
      await assert.rejects(save(entityMkt, { externalUrl: "" }));
    },
  );
});

test("frontend role gates agree with the approval workflow and safe Drive links", () => {
  const post = {
    status: "PENDING",
    creatorId: "c",
    category: "B2C",
    organization: "EXAMPLE_IG",
    reviewStage: "IG",
    status: "PENDING",
  };
  assert.equal(canReview({ id: "a", role: "B2C_VP" }, post), false);
  assert.equal(
    canReview({ id: "b", active:true, role: "IGVP_OGV", organization: "EXAMPLE_IG" }, post),
    true,
  );
  assert.equal(initialStage({ role: "IGVP_OGV", organization: "EXAMPLE_IG" }), "LC");
  assert.equal(
    canView(
      { id: "o", active: true, role: "OCP", eventId: "e" },
      { ...post, eventId: "e", submitterRole: "B2C_MEMBER" },
    ),
    false,
  );
  assert.equal(
    normalizeDriveLink("https://drive.google.com/open?id=file_123"),
    "https://drive.google.com/open?id=file_123",
  );
  for (const url of [
    "http://drive.google.com/file/d/123",
    "https://user@drive.google.com/file/d/123",
    "https://drive.google.com:444/file/d/123",
    "javascript:alert(1)",
  ])
    assert.throws(() => normalizeDriveLink(url));
});
