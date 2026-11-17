import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloudDatabase } from "./cloud-fixture.js";
import {
  canSubmit,
  canReview,
  canView,
  initialStage,
} from "../src/workflow.js";

test("initiative group management, privacy, staged approvals and notification coverage", async (t) => {
  const db = await cloudDatabase();
  t.after(() => db.close());
  const q = async (sql, args = []) =>
    (await db.query(sql, args)).rows[0]?.result;
  const owner = () => db.exec("reset role");
  const as = async (id, role = "authenticated") => {
    await owner();
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [
      id || "",
    ]);
    await db.exec("set role " + role);
  };
  const service = () => as(null, "service_role");
  async function user(role, org = "ENTITY", event = null) {
    await owner();
    const id = randomUUID(),
      email =
        role === "ADMIN" ? "admin@your-entity.example" : id + "@test.invalid";
    await db.query("insert into auth.users values($1,$2,$3,now())", [
      id,
      email,
      { name: role, role: "MARKETING_MEMBER", organization: org },
    ]);
    await service();
    await q("select public.club_manage_account($1,$2,$2,true,$3,$4,$5)", [
      id,
      role,
      org,
      event,
      email,
    ]);
    return id;
  }
  const admin = await user("ADMIN"),
    em = await user("EM_VP"),
    mkt = await user("MARKETING_VP"),
    b2c = await user("B2C_VP");
  async function group(actor, name) {
    await owner();
    const logo = actor + "/" + randomUUID() + ".png";
    await db.query("insert into storage.objects values('ig-logos',$1,'{}')", [
      logo,
    ]);
    await as(actor);
    return (
      await q("select public.club_group(null,$1,$2,true,false) as result", [
        name,
        logo,
      ])
    ).id;
  }
  const g1 = await group(em, "AIESEC in EXAMPLE_IG"),
    g2 = await group(admin, "Another IG");
  const igp = await user("IGP", g1),
    igp2 = await user("IGP", g2),
    igMkt = await user("IGVP_MARKETING", g1),
    igB2c = await user("IGVP_OGV", g1),
    igMkt2 = await user("IGVP_MARKETING", g2);
  async function event(actor, org, name) {
    await as(actor);
    return (
      await q("select public.club_event(null,$1,true,false,$2) as result", [
        name,
        org,
      ])
    ).event.id;
  }
  const lcEvent = await event(admin, "ENTITY", "Catalyst"),
    igEvent = await event(igp, g1, "IG conference"),
    otherEvent = await event(igp2, g2, "Other conference");
  const ocp = await user("OCP", g1, igEvent),
    ocvp = await user("CREATOR", g1, igEvent),
    manager = await user("EVENT_MANAGER", g1, igEvent),
    lcOcp = await user("OCP", "ENTITY", lcEvent),
    lcCreator = await user("CREATOR", "ENTITY", lcEvent),
    lcManager = await user("EVENT_MANAGER", "ENTITY", lcEvent),
    otherOcp = await user("OCP", g2, otherEvent),
    member = await user("MARKETING_MEMBER", g1),
    b2cMember = await user("B2C_MEMBER", g1);
  const everyone = [
    admin,
    em,
    mkt,
    b2c,
    igp,
    igp2,
    igMkt,
    igB2c,
    igMkt2,
    ocp,
    ocvp,
    manager,
    lcOcp,
    lcCreator,
    lcManager,
    otherOcp,
    member,
    b2cMember,
  ];
  await owner();
  await db.query(
    "insert into club.push_settings values(true,'public','private',$1,'https://example.test/push')",
    ["a".repeat(64)],
  );
  for (const id of everyone) {
    await db.query(
      "insert into club.push_subscriptions(user_id,endpoint,p256dh,auth) values($1,$2,$3,$4)",
      [id, "https://fcm.googleapis.com/" + id, "A".repeat(87), "A".repeat(22)],
    );
  }
  const create = async (id, title = "Test creative") => {
    await as(id);
    return (
      await q("select public.club_save(null,$1,$2) as result", [
        {
          title,
          caption: "A caption",
          contentType: "Video",
          platform: "Instagram",
          status: "PENDING",
          externalUrl: "https://drive.google.com/file/d/test-file/view",
        },
        [],
      ])
    ).submission;
  };
  const review = async (id, s, decision = "APPROVED", comment = "") => {
    await as(id);
    return (
      await q("select public.club_review($1,$2,$3,$4) as result", [
        s.id,
        decision,
        comment,
        s.version,
      ])
    ).submission;
  };
  const notifications = async (s) => {
    await owner();
    return (
      await db.query(
        "select user_id,title,message from club.notifications where submission_id=$1",
        [s.id],
      )
    ).rows;
  };
  const clearNotices = async () => {
    await owner();
    await db.exec("delete from club.notifications");
  };
  let post;
  await t.test(
    "public directory is dynamic; privileged roles cannot be self-selected",
    async () => {
      await as(null, "anon");
      const groups = await q("select public.club_groups() as result");
      assert.deepEqual(groups.groups.map((g) => g.id).sort(), [g1, g2].sort());
      await assert.rejects(q("select public.club_groups(true)"));
      await owner();
      const id = randomUUID();
      await db.query("insert into auth.users values($1,$2,$3,now())", [
        id,
        id + "@test.invalid",
        { role: "EM_VP", organization: g1 },
      ]);
      await as(id);
      assert.equal(
        (await q("select public.club_me() as result")).role,
        "MARKETING_MEMBER",
      );
    },
  );
  await t.test(
    "IGP/EM cannot manage LC or another IG; only supreme admin appoints EM/LC managers",
    async () => {
      for (const actor of [em, igp]) {
        await as(actor);
        await assert.rejects(
          q("select public.club_event(null,'Forbidden',true,false,'ENTITY')"),
        );
      }
      await as(igp);
      await assert.rejects(
        q("select public.club_event(null,$1,true,false,$2)", [
          "Forbidden IG",
          g2,
        ]),
      );
      await assert.rejects(group(igp, "Forbidden group"));
      await service();
      for (const actor of [em, igp]) {
        await assert.rejects(
          q("select public.club_authorize_account($1,null,$2,$3,$4)", [
            actor,
            "EVENT_MANAGER",
            "ENTITY",
            lcEvent,
          ]),
        );
        await assert.rejects(
          q("select public.club_authorize_account($1,null,$2,$3,null)", [
            actor,
            "EM_VP",
            "ENTITY",
          ]),
        );
      }
      assert.equal(
        await q(
          "select public.club_authorize_account($1,null,$2,$3,$4) as result",
          [igp, "EVENT_MANAGER", g1, igEvent],
        ),
        true,
      );
      await assert.rejects(
        q("select public.club_authorize_account($1,$2,$3,$4,null)", [
          igp,
          igMkt2,
          "IGVP_MARKETING",
          g2,
        ]),
      );
      await as(igp);
      const users = (await q("select public.club_users() as result")).users;
      assert(users.every((u) => u.organization === g1));
      assert.equal(users.find((u) => u.id === igp).manageable, false);
    },
  );
  await t.test(
    "one leader per group, one OCP per event and at most three managers including disabled accounts",
    async () => {
      await assert.rejects(user("IGVP_MARKETING", g1), /already holds/);
      await assert.rejects(user("IGP", g1), /already holds/);
      await assert.rejects(user("OCP", g1, igEvent), /already holds/);
      await user("EVENT_MANAGER", g1, igEvent);
      const third = await user("EVENT_MANAGER", g1, igEvent);
      await owner();
      await db.query("update club.profiles set active=false where id=$1", [
        third,
      ]);
      await assert.rejects(
        user("EVENT_MANAGER", g1, igEvent),
        /three Event Managers/,
      );
    },
  );
  await t.test(
    "read-only and management roles cannot submit or upload creatives",
    async () => {
      for (const id of [admin, em, igp, ocp, manager]) {
        await assert.rejects(create(id), /cannot submit/);
        await as(id);
        assert.equal(
          await q("select club.file_access($1,true) as result", [
            id + "/file.png",
          ]),
          false,
        );
      }
    },
  );
  await t.test(
    "IG event submission notifies the exact relevant roles, including LC VP before final stage",
    async () => {
      await clearNotices();
      post = await create(ocvp);
      assert.equal(post.reviewStage, "IG");
      assert.equal(post.organization, g1);
      const ns = await notifications(post);
      const ids = ns.map((n) => n.user_id);
      const expected = [admin, em, mkt, igp, igMkt, ocp, manager];
      // A second active appointed manager is also a recipient.
      assert(expected.every((id) => ids.includes(id)));
      assert.equal(new Set(ids).size, ids.length);
      for (const id of [
        b2c,
        igp2,
        igB2c,
        igMkt2,
        lcOcp,
        lcManager,
        otherOcp,
        member,
      ])
        assert(!ids.includes(id));
      for (const id of [lcOcp, otherOcp, igp2, igMkt2, b2c]) {
        await as(id);
        await assert.rejects(q("select public.club_detail($1)", [post.id]));
      }
      for (const id of [em, igp, ocp, manager, mkt]) {
        await as(id);
        assert.equal(
          (await q("select public.club_detail($1) as result", [post.id]))
            .submission.id,
          post.id,
        );
      }
    },
  );
  await t.test(
    "IG approval never becomes final; IG and LC steps notify submitter and scoped leadership once each",
    async () => {
      await assert.rejects(review(mkt, post), /cannot review/);
      await assert.rejects(review(ocp, post), /cannot review/);
      await assert.rejects(review(manager, post), /cannot review/);
      await clearNotices();
      post = await review(igMkt, post);
      assert.equal(post.status, "PENDING");
      assert.equal(post.reviewStage, "LC");
      let ns = await notifications(post);
      for (const id of [ocvp, ocp, manager, igp, em, mkt])
        assert(ns.some((n) => n.user_id === id));
      assert.equal(new Set(ns.map((n) => n.user_id)).size, ns.length);
      await clearNotices();
      post = await review(mkt, post);
      assert.equal(post.status, "APPROVED");
      ns = await notifications(post);
      for (const id of [ocvp, ocp, manager, igp, em, igMkt])
        assert(ns.some((n) => n.user_id === id));
      await assert.rejects(review(em, post, "REJECTED", "No"), /cannot review/);
      await assert.rejects(
        review(igp, post, "REJECTED", "No"),
        /cannot review/,
      );
    },
  );
  await t.test(
    "EM/IGP may override IG decisions while LC final approval is still mandatory",
    async () => {
      let s = await create(member);
      s = await review(igMkt, s, "REJECTED", "Please revise");
      s = await review(igp, s, "APPROVED", "Fallback approval");
      assert.equal(s.status, "PENDING");
      assert.equal(s.reviewStage, "LC");
      s = await review(em, s, "CHANGES_REQUESTED", "IG needs changes");
      assert.equal(s.reviewStage, "IG");
      assert.equal(s.status, "CHANGES_REQUESTED");
      s = await review(em, s, "APPROVED", "Reviewed update");
      assert.equal(s.status, "PENDING");
      s = await review(mkt, s);
      assert.equal(s.status, "APPROVED");
    },
  );
  await t.test(
    "B2C stages and IGVP own submissions route to the matching LC VP",
    async () => {
      await clearNotices();
      let s = await create(b2cMember);
      assert.equal(s.category, "B2C");
      let ns = await notifications(s);
      for (const id of [b2c, igB2c, igp, em])
        assert(ns.some((n) => n.user_id === id));
      for (const id of [mkt, igMkt, ocp, manager])
        assert(!ns.some((n) => n.user_id === id));
      await assert.rejects(review(igMkt, s), /cannot review/);
      s = await review(igB2c, s);
      s = await review(b2c, s);
      assert.equal(s.status, "APPROVED");
      for (const [actor, lc, cat] of [
        [igMkt, mkt, "MARKETING"],
        [igB2c, b2c, "B2C"],
      ]) {
        s = await create(actor);
        assert.equal(s.reviewStage, "LC");
        assert.equal(s.category, cat);
        await assert.rejects(review(actor, s));
        await assert.rejects(review(em, s));
        s = await review(lc, s);
        assert.equal(s.status, "APPROVED");
      }
    },
  );
  await t.test(
    "ENTITY event routes directly and does not notify IG managers",
    async () => {
      await clearNotices();
      let s = await create(lcCreator);
      assert.equal(s.reviewStage, "LC");
      const ns = await notifications(s);
      for (const id of [mkt, lcOcp, lcManager])
        assert(ns.some((n) => n.user_id === id));
      for (const id of [em, igp, igMkt, ocp, manager])
        assert(!ns.some((n) => n.user_id === id));
      s = await review(mkt, s);
      assert.equal(s.status, "APPROVED");
    },
  );
  await t.test(
    "admin overrides require one-use, version-bound proof from the password verification server",
    async () => {
      await assert.rejects(
        review(admin, post, "REJECTED", "Override"),
        /password/,
      );
      await as(admin);
      await assert.rejects(
        q("select public.club_authorize_override($1,$2,$3,$4)", [
          admin,
          post.id,
          post.version,
          "REJECTED",
        ]),
      );
      await service();
      const proof = await q(
        "select public.club_authorize_override($1,$2,$3,$4) as result",
        [admin, post.id, post.version, "REJECTED"],
      );
      await as(admin);
      post = (
        await q(
          "select public.club_review_verified($1,$2,$3,$4,$5) as result",
          [post.id, "REJECTED", "Verified override", post.version, proof],
        )
      ).submission;
      assert.equal(post.status, "REJECTED");
      await assert.rejects(
        q("select public.club_review_verified($1,$2,$3,$4,$5)", [
          post.id,
          "APPROVED",
          "Replay",
          post.version,
          proof,
        ]),
        /password/,
      );
    },
  );
  await t.test(
    "push payloads carry the actual message and obsolete access is excluded",
    async () => {
      await clearNotices();
      await create(ocvp, "Notification title check");
      await service();
      const jobs = await q("select public.club_claim_push() as result");
      assert(jobs.length > 0);
      assert(jobs.every((j) => j.payload.title.includes("awaiting IG")));
      assert(
        jobs.every((j) => j.payload.body.includes("Notification title check")),
      );
    },
  );
  await t.test(
    "group deletion disables its accounts and events while retaining submission history",
    async () => {
      await as(em);
      await q("select public.club_group($1,null,null,false,true)", [g2]);
      await as(igp2);
      await assert.rejects(q("select public.club_me()"), /active profile/);
      await as(null, "anon");
      assert(
        !(await q("select public.club_groups() as result")).groups.some(
          (g) => g.id === g2,
        ),
      );
      await owner();
      assert.equal(
        await q(
          "select count(*)::int as result from club.submissions where id=$1",
          [post.id],
        ),
        1,
      );
    },
  );
});

test("UI role gates match read-only access and staged approval rules", () => {
  for (const role of ["ADMIN", "EM_VP", "IGP", "EVENT_MANAGER", "OCP"])
    assert.equal(canSubmit({ role }), false);
  const post = {
    id: "p",
    creatorId: "creator",
    organization: "ig-one",
    submitterRole: "CREATOR",
    eventId: "event",
    status: "PENDING",
    reviewStage: "IG",
    category: "MARKETING",
  };
  const own = { id: "p1", active: true, role: "IGP", organization: "ig-one" };
  assert(canReview(own, post));
  assert(!canReview({ ...own, organization: "ig-two" }, post));
  assert(!canView({ ...own, role: "EVENT_MANAGER", eventId: "other" }, post));
  assert.equal(initialStage({ role: "CREATOR", organization: "ig-one" }), "IG");
  assert.equal(
    initialStage({ role: "IGVP_MARKETING", organization: "ig-one" }),
    "LC",
  );
});
