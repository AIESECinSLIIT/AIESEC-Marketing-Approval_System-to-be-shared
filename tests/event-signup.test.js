import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cloudDatabase } from "./cloud-fixture.js";

test("event signup, EXAMPLE_IG event approvals and unique leadership slots", async (t) => {
  const db = await cloudDatabase();
  t.after(() => db.close());
  await db.exec("insert into club.initiative_groups(id,name,logo_path) values('EXAMPLE_IG','AIESEC in EXAMPLE_IG','fixture.png')");
  const q = async (sql, args = []) =>
    (await db.query(sql, args)).rows[0]?.result;
  const as = async (id) => {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec("set role authenticated");
  };
  const signup = async (role, eventId = null, organization = "ENTITY") => {
    await db.exec("reset role");
    const id = randomUUID();
    await db.query("insert into auth.users values($1,$2,$3,now())", [
      id,
      id + "@test.invalid",
      { name: role, role, eventId, organization },
    ]);
    return id;
  };
  const assign = async (id, role, event = null, active = true) => {
    await db.exec("reset role; set role service_role");
    return q("select public.club_manage_account($1,$2,$2,$3,$4,$5,$6)", [
      id,
      role,
      active,
      ["IGVP_MARKETING","IGVP_OGV"].includes(role) ? "EXAMPLE_IG" : "ENTITY",
      event,
      role === "ADMIN" ? "admin@your-entity.example" : id + "@test.invalid",
    ]);
  };
  const admin = await signup("MARKETING_MEMBER");
  await assign(admin, "ADMIN");
  await as(admin);
  const event = async (name, organization) =>
    (
      await q("select public.club_event(null,$1,true,false,$2) as result", [
        name,
        organization,
      ])
    ).event.id;
  const entity = await event("ENTITY Event", "ENTITY"),
    example_ig = await event("EXAMPLE_IG Event", "EXAMPLE_IG");
  const ocp = await signup("OCP", example_ig, "ENTITY"),
    ocvp = await signup("CREATOR", example_ig, "ENTITY");
  const otherOcp = await signup("OCP", entity, "EXAMPLE_IG");
  const leaders = {};
  for (const role of ["MARKETING_VP", "B2C_VP", "IGVP_MARKETING", "IGVP_OGV"]) {
    leaders[role] = await signup("MARKETING_MEMBER");
    await assign(leaders[role], role);
  }
  let post;
  const save = async (version) => {
    await as(ocvp);
    return (
      await q("select public.club_save($1,$2,$3) as result", [
        post?.id || null,
        {
          title: "EXAMPLE_IG event creative",
          caption: "Caption",
          contentType: "Video",
          platform: "Instagram",
          status: "PENDING",
          event: "Forged ENTITY event",
          organization: "ENTITY",
          reviewStage: "LC",
          version,
          externalUrl: "https://drive.google.com/file/d/test-video/view",
        },
        [],
      ])
    ).submission;
  };
  const review = async (id, decision = "APPROVED", comment = "") => {
    let proof;
    if (id===admin && post.status!=="PENDING") {
      await db.exec('reset role; set role service_role');
      proof=await q('select public.club_authorize_override($1,$2,$3,$4) as result',[admin,post.id,post.version,decision]);
    }
    await as(id);
    if(proof)return(await q('select public.club_review_verified($1,$2,$3,$4,$5) as result',[post.id,decision,comment,post.version,proof])).submission;
    return (
      await q("select public.club_review($1,$2,$3,$4) as result", [
        post.id,
        decision,
        comment,
        post.version,
      ])
    ).submission;
  };
  await t.test(
    "self-signup derives event and committee; OCP stays read-only",
    async () => {
      for (const id of [ocp, ocvp]) {
        await as(id);
        const me = await q("select public.club_me() as result");
        assert.equal(me.organization, "EXAMPLE_IG");
        assert.equal(me.eventId, example_ig);
      }
      await as(otherOcp);
      assert.equal(
        (await q("select public.club_me() as result")).organization,
        "ENTITY",
      );
      await assert.rejects(signup("OCP", null));
      await assert.rejects(signup("OCP", example_ig));
      await as(ocp);
      const events = (await q("select public.club_events() as result")).events;
      assert.equal(events.find((e) => e.id === example_ig).ocpAssigned, true);
      assert.equal(events.find((e) => e.id === example_ig).organization, "EXAMPLE_IG");
      await assert.rejects(
        q("select public.club_save(null,$1,$2)", [
          { title: "Observer write" },
          [],
        ]),
      );
    },
  );
  await t.test(
    "EXAMPLE_IG OCVP requires IG then LC and notifies only its own OCP",
    async () => {
      post = await save();
      assert.equal(post.reviewStage, "IG");
      assert.equal(post.organization, "EXAMPLE_IG");
      assert.equal(post.eventId, example_ig);
      assert.equal(post.event, "EXAMPLE_IG Event");
      await as(ocp);
      assert.equal(
        (await q("select public.club_notifications() as result")).notifications
          .length,
        1,
      );
      await as(otherOcp);
      assert.equal(
        (await q("select public.club_notifications() as result")).notifications
          .length,
        0,
      );
      await assert.rejects(q("select public.club_detail($1)", [post.id]));
      await assert.rejects(review(ocp));
      await assert.rejects(review(leaders.MARKETING_VP));
      await assert.rejects(review(leaders.IGVP_OGV));
      post = await review(leaders.IGVP_MARKETING);
      assert.equal(post.status, "PENDING");
      assert.equal(post.reviewStage, "LC");
      await as(ocp);
      assert.equal(
        (await q("select public.club_notifications() as result")).notifications
          .length,
        2,
      );
      assert.ok(
        (
          await q("select public.club_notifications() as result")
        ).notifications.some(
          (n) => n.title === "IG approved · awaiting ENTITY approval",
        ),
      );
      post = await review(leaders.MARKETING_VP);
      assert.equal(post.status, "APPROVED");
      await as(ocp);
      assert.equal(
        (await q("select public.club_notifications() as result")).notifications
          .length,
        3,
      );
      assert.ok(
        (
          await q("select public.club_notifications() as result")
        ).notifications.some((n) => n.title === "Final approval received"),
      );
      post = await review(admin, "PENDING", "Reopen for a change");
      assert.equal(post.reviewStage, "IG");
      post = await review(
        leaders.IGVP_MARKETING,
        "CHANGES_REQUESTED",
        "Fix the caption",
      );
      post = await save(post.version);
      assert.equal(post.reviewStage, "IG");
    },
  );
  await t.test(
    "each VP role is unique, including disabled accounts; indexes reject bypass attempts",
    async () => {
      const candidate = await signup("MARKETING_MEMBER");
      for (const [role, id] of Object.entries(leaders)) {
        await assert.rejects(assign(candidate, role), /already holds/);
        await assign(id, role, null, false);
        await assert.rejects(assign(candidate, role), /already holds/);
        await db.exec("reset role");
        await assert.rejects(
          db.query("update club.profiles set role=$1,organization=$3 where id=$2", [
            role,
            candidate,
            ["IGVP_MARKETING","IGVP_OGV"].includes(role)?"EXAMPLE_IG":"ENTITY",
          ]),
          (e) => e.code === "23505",
        );
        await assign(id, role, null, true);
      }
    },
  );
  await t.test(
    "OCP admin edits cannot take another event slot; deletion frees it",
    async () => {
      await assert.rejects(assign(otherOcp, "OCP", example_ig), /already holds/);
      await assign(ocp, "OCP", example_ig, false);
      await assert.rejects(signup("OCP", example_ig));
      await db.exec("reset role; set role service_role");
      await q("select public.club_delete_account($1,false)", [ocp]);
      await db.exec("reset role");
      await db.query("delete from auth.users where id=$1", [ocp]);
      await db.exec("set role service_role");
      await q("select public.club_delete_account($1,true)", [ocp]);
      const replacement = await signup("OCP", example_ig);
      await as(replacement);
      assert.equal(
        (await q("select public.club_me() as result")).eventId,
        example_ig,
      );
    },
  );
  await t.test(
    "only admin creates events; event committee is immutable and archived signup closes",
    async () => {
      await as(ocvp);
      await assert.rejects(event("Injected", "EXAMPLE_IG"));
      await as(admin);
      await assert.rejects(
        q("select public.club_event($1,$2,true,false,$3)", [
          example_ig,
          "Renamed",
          "ENTITY",
        ]),
        /change its committee/,
      );
      await q("select public.club_event($1,$2,false,false,$3)", [
        example_ig,
        "EXAMPLE_IG Event",
        "EXAMPLE_IG",
      ]);
      await assert.rejects(signup("CREATOR", example_ig));
      await assert.rejects(save(post.version));
    },
  );
});
