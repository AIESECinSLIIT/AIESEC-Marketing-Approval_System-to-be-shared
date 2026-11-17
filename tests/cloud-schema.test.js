import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("cloud workflow enforces ownership, categories, feedback, versions and disabled accounts", async () => {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
 create schema auth; create schema storage; create schema net; create schema cron;
 create function net.http_post(url text,body jsonb,headers jsonb,timeout_milliseconds integer) returns bigint language sql as $$select 1::bigint$$;
 create function cron.schedule(job_name text,schedule text,command text) returns bigint language sql as $$select 1::bigint$$;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb,email_confirmed_at timestamptz);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,metadata jsonb);`);
  const migrations = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(migrations))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    // PGlite cannot run networking/cron extensions; only their transport APIs are mocked above.
    await db.exec(
      (await readFile(new URL(file, migrations), "utf8")).replace(
        /^(?:create extension if not exists (?:pg_net|pg_cron)|drop extension pg_net|create extension pg_net with schema extensions);$/gm,
        "",
      ),
    );
  const eventId='10000000-0000-0000-0000-000000000001';
  await db.query('insert into club.events(id,name) values($1,$2)',[eventId,'Test event']);
  const ids = [
    "00000000-0000-0000-0000-000000000001",
    "00000000-0000-0000-0000-000000000002",
    "00000000-0000-0000-0000-000000000003",
    "00000000-0000-0000-0000-000000000004",
  ];
  for (let i = 0; i < 4; i++)
    await db.query(
      `insert into auth.users values($1,$2,'{"name":"Member"}',now())`,
      [ids[i], i === 0 ? "admin@your-entity.example" : `user${i}@example.test`],
    );
  await db.exec('set role service_role');
  await db.query(`select public.club_manage_profile($1,'Admin','ADMIN',true)`, [
    ids[0],
  ]);
  await db.query(
    `select public.club_manage_profile($1,'Marketing','MARKETING_VP',true)`,
    [ids[2]],
  );
  await db.query(`select public.club_manage_profile($1,'B2C','B2C_VP',true)`, [
    ids[3],
  ]);
  await db.exec('reset role');
  await db.exec(
    `insert into club.push_settings values(true,'public-test-key','private-test-key','${"a".repeat(64)}','https://example.test/push')`,
  );
  const as = async (id) => {
    await db.exec("reset role");
    await db.query(`select set_config('request.jwt.claim.sub',$1,false)`, [id]);
    await db.exec("set role authenticated");
  };
  const rpc = async (sql, args = []) =>
    (await db.query(sql, args)).rows[0]?.result;
  const post = {
    title: "Test",
    event: "Club",
    category: "MARKETING",
    contentType: "Social post",
    platform: "Instagram",
    caption: "Caption",
    notes: "",
    status: "DRAFT",
  };
  await as(ids[1]);
  const subscription = {
    endpoint: "https://fcm.googleapis.com/fcm/send/creator-test",
    keys: { p256dh: "B".repeat(87), auth: "A".repeat(22) },
  };
  await db.query("select public.club_push_subscribe($1)", [subscription]);
  assert.equal(
    (
      await rpc("select public.club_push_status($1) as result", [
        subscription.endpoint,
      ])
    ).enabled,
    true,
  );
  await assert.rejects(
    db.query("select public.club_push_subscribe($1)", [
      { ...subscription, endpoint: "https://127.0.0.1/internal" },
    ]),
  );
  await assert.rejects(db.query("select public.club_push_config()"));
  await assert.rejects(db.query("select public.club_claim_push()"));
  await assert.rejects(db.query("select * from club.push_settings"));
  await as(ids[2]);
  await assert.rejects(
    db.query("select public.club_push_subscribe($1)", [subscription]),
  );
  await db.query("select public.club_push_unsubscribe($1)", [
    subscription.endpoint,
  ]);
  assert.equal(
    (
      await rpc("select public.club_push_status($1) as result", [
        subscription.endpoint,
      ])
    ).enabled,
    false,
  );
  await as(ids[1]);
  assert.equal(
    (
      await rpc("select public.club_push_status($1) as result", [
        subscription.endpoint,
      ])
    ).enabled,
    true,
  );
  await db.query("select public.club_push_test($1)", [subscription.endpoint]);
  await assert.rejects(
    db.query("select public.club_push_test($1)", [subscription.endpoint]),
  );
  const saved = await rpc(`select public.club_save(null,$1,'[]') as result`, [
    post,
  ]);
  const sid = saved.submission.id;
  assert.equal(saved.submission.status, "DRAFT");
  await assert.rejects(
    db.query(`select public.club_review($1,'APPROVED','',1)`, [sid]),
  );
  await assert.rejects(db.query(`select public.club_users()`));
  await assert.rejects(
    db.query(`select public.club_manage_profile($1,'Impostor','ADMIN',true)`, [
      ids[1],
    ]),
  );
  await assert.rejects(db.query(`select * from club.profiles`));
  await as(ids[2]);
  assert.equal(
    (await rpc("select public.club_submissions() as result")).submissions
      .length,
    0,
  );
  await db.exec("reset role");
  await db.query(
    `insert into storage.objects values('creatives',$1,'{"size":128,"mimetype":"image/png"}')`,
    [ids[1] + "/file/test.png"],
  );
  await as(ids[1]);
  const submitted = await rpc(`select public.club_save($1,$2,$3) as result`, [
    sid,
    { ...post, status: "PENDING", version: 1 },
    [{ path: ids[1] + "/file/test.png", name: "test.png", mime: "image/png" }],
  ]);
  assert.equal(submitted.submission.version, 2);
  await as(ids[3]);
  assert.equal(
    (await rpc("select public.club_submissions() as result")).submissions
      .length,
    0,
  );
  await assert.rejects(
    db.query(`select public.club_review($1,'APPROVED','',2)`, [sid]),
  );
  await as(ids[2]);
  await assert.rejects(
    db.query(`select public.club_review($1,'REJECTED','',2)`, [sid]),
  );
  await assert.rejects(
    db.query(`select public.club_review($1,'APPROVED','',1)`, [sid]),
  );
  const changes = await rpc(
    `select public.club_review($1,'CHANGES_REQUESTED','Fix logo',2) as result`,
    [sid],
  );
  assert.equal(changes.submission.status, "CHANGES_REQUESTED");
  await as(ids[1]);
  const resubmitted = await rpc(
    `select public.club_save($1,$2,'[]') as result`,
    [sid, { ...post, status: "PENDING", version: 3 }],
  );
  assert.equal(resubmitted.submission.fileCount, 1);
  await as(ids[2]);
  await db.query(`select public.club_review($1,'APPROVED','',4)`, [sid]);
  await as(ids[0]);
  await assert.rejects(db.query(`select public.club_review($1,'REJECTED','Admin override',5)`,[sid]),/password/);
  await db.exec('reset role; set role service_role');
  const proof=(await db.query("select public.club_authorize_override($1,$2,5,'REJECTED') as proof",[ids[0],sid])).rows[0].proof;
  await as(ids[0]);
  await db.query("select public.club_review_verified($1,'REJECTED','Admin override',5,$2)",[sid,proof]);
  const detail = await rpc(`select public.club_detail($1) as result`, [sid]);
  assert.equal(detail.submission.status, "REJECTED");
  assert.equal(detail.revisions.length, 3);
  // Large MOV metadata is accepted, while >50 MB is rejected by the workflow as well as Storage.
  await db.exec("reset role");
  await db.query(
    `insert into storage.objects values('creatives',$1,'{"size":40000000,"mimetype":"video/quicktime"}'),('creatives',$2,'{"size":52428801,"mimetype":"video/mp4"}')`,
    [ids[1] + "/large/test.mov", ids[1] + "/oversize/test.mp4"],
  );
  await as(ids[1]);
  const video = await rpc(`select public.club_save(null,$1,$2) as result`, [
    { ...post, status: "PENDING" },
    [
      {
        path: ids[1] + "/large/test.mov",
        name: "test.mov",
        mime: "video/quicktime",
      },
    ],
  ]);
  assert.equal(video.submission.fileCount, 1);
  await assert.rejects(
    db.query(`select public.club_save(null,$1,$2)`, [
      { ...post, status: "PENDING" },
      [
        {
          path: ids[1] + "/oversize/test.mp4",
          name: "test.mp4",
          mime: "video/mp4",
        },
      ],
    ]),
  );
  await db.exec("reset role; set role service_role");
  const jobs = await rpc("select public.club_claim_push() as result");
  assert.ok(jobs.length >= 4);
  assert.ok(
    jobs.every((j) => j.subscription.endpoint === subscription.endpoint),
  );
  assert.ok(jobs.some((j) => j.payload.body.includes("Fix logo")));
  assert.equal(
    (await rpc("select public.club_claim_push() as result")).length,
    0,
  );
  await db.query("select public.club_finish_push($1,$2,201)", [
    jobs[0].id,
    jobs[0].attempt,
  ]);
  await db.query("select public.club_finish_push($1,$2,503)", [
    jobs[1].id,
    jobs[1].attempt,
  ]);
  await db.query("select public.club_finish_push($1,$2,410)", [
    jobs[2].id,
    jobs[2].attempt,
  ]);
  await as(ids[1]);
  assert.equal(
    (
      await rpc("select public.club_push_status($1) as result", [
        subscription.endpoint,
      ])
    ).enabled,
    false,
  );
  // Cleanup is limited to finalized posts in the reviewer's category.
  await assert.rejects(db.query("select public.club_storage()"));
  await assert.rejects(
    db.query("select public.club_begin_cleanup($1,6)", [sid]),
  );
  await as(ids[3]);
  assert.equal(
    (await rpc("select public.club_storage() as result")).submissions.length,
    0,
  );
  await assert.rejects(
    db.query("select public.club_begin_cleanup($1,6)", [sid]),
  );
  await as(ids[2]);
  const eligible = (await rpc("select public.club_storage() as result"))
    .submissions;
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].fileCount, 1); // One physical file reused by two revisions.
  assert.equal(eligible[0].bytes, 128);
  const path = ids[1] + "/file/test.png";
  assert.equal(
    await rpc("select club.cleanup_file_access($1) as result", [path]),
    false,
  );
  await assert.rejects(
    db.query("select public.club_begin_cleanup($1,1)", [video.submission.id]),
  );
  await assert.rejects(
    db.query("select public.club_begin_cleanup($1,5)", [sid]),
  );
  const cleanup = await rpc(
    "select public.club_begin_cleanup($1,6) as result",
    [sid],
  );
  assert.equal(cleanup.paths.length, 1);
  assert.equal(
    await rpc("select club.cleanup_file_access($1) as result", [path]),
    true,
  );
  assert.equal(
    await rpc("select club.cleanup_file_access($1) as result", [
      ids[1] + "/large/test.mov",
    ]),
    false,
  );
  assert.equal(
    (await rpc("select public.club_begin_cleanup($1,6) as result", [sid]))
      .jobId,
    cleanup.jobId,
  );
  await assert.rejects(
    db.query("select public.club_finish_cleanup($1)", [cleanup.jobId]),
  );
  await as(ids[3]);
  assert.equal(
    await rpc("select club.cleanup_file_access($1) as result", [path]),
    false,
  );
  await assert.rejects(
    db.query("select public.club_finish_cleanup($1)", [cleanup.jobId]),
  );
  await as(ids[0]);
  await assert.rejects(
    db.query("select public.club_review($1,'PENDING','Reopen',7)", [sid]),
  );
  // Simulate the external Storage API removing the object before finalization.
  await db.exec("reset role");
  await db.query("delete from storage.objects where name=$1", [path]);
  await as(ids[2]);
  const cleaned = await rpc("select public.club_finish_cleanup($1) as result", [
    cleanup.jobId,
  ]);
  assert.equal(cleaned.bytesFreed, 128);
  assert.equal(cleaned.filesDeleted, 1);
  assert.equal(
    (
      await rpc("select public.club_finish_cleanup($1) as result", [
        cleanup.jobId,
      ])
    ).filesDeleted,
    0,
  );
  const retained = await rpc("select public.club_detail($1) as result", [sid]);
  assert.equal(retained.files.length, 0);
  assert.equal(retained.revisions.length, 3);
  assert.equal(retained.submission.caption, post.caption);
  assert.ok(retained.submission.creativesDeletedAt);
  assert.ok(retained.history.some((h) => h.action === "CREATIVES_DELETED"));
  assert.equal(
    (await rpc("select public.club_storage() as result")).submissions.length,
    0,
  );
  // Admin can clean an approved post as well.
  await as(ids[0]);
  await db.query("select public.club_review($1,'APPROVED','',1)", [
    video.submission.id,
  ]);
  const approvedCleanup = await rpc(
    "select public.club_begin_cleanup($1,2) as result",
    [video.submission.id],
  );
  assert.equal(approvedCleanup.bytes, 40000000);
  // All self-service roles route from the stored profile, never request category
  // or mutable auth metadata. Reviewers see only their own approval queue.
  for (const [role, category, reviewer, other] of [
    ['CREATOR', 'MARKETING', ids[2], ids[3]],
    ['MARKETING_MEMBER', 'MARKETING', ids[2], ids[3]],
    ['B2C_MEMBER', 'B2C', ids[3], ids[2]],
  ]) {
    await db.exec('reset role');
    const member = (await db.query("select gen_random_uuid() as id")).rows[0].id;
    await db.query('insert into auth.users values($1,$2,$3,now())',
      [member, `${role}@example.test`, {name: role, role,eventId}]);
    await as(member);
    assert.equal((await rpc('select public.club_me() as result')).role, role);
    await assert.rejects(db.query('select public.club_users()'));
    const memberPath = `${member}/file.png`;
    await db.exec('reset role');
    await db.query("insert into storage.objects values('creatives',$1,$2)",
      [memberPath, {size: 128, mimetype: 'image/png'}]);
    await db.query("update auth.users set raw_user_meta_data='{"+'"role":"ADMIN"'+"}' where id=$1", [member]);
    await as(member);
    const created = (await rpc('select public.club_save(null,$1,$2) as result',
      [{...post, category: category === 'B2C' ? 'MARKETING' : 'B2C', status: 'PENDING'},
        [{path: memberPath, name: 'file.png', mime: 'image/png'}]])).submission;
    assert.equal(created.category, category);
    assert.equal((await rpc('select public.club_me() as result')).role, role);
    await assert.rejects(db.query("select public.club_review($1,'APPROVED','',1)", [created.id]));
    await as(other);
    await assert.rejects(db.query('select public.club_detail($1)', [created.id]));
    await assert.rejects(db.query("select public.club_review($1,'APPROVED','',1)", [created.id]));
    await as(reviewer);
    assert.ok((await rpc('select public.club_notifications() as result')).notifications.some(n => n.submissionId === created.id));
    await assert.rejects(db.query("select public.club_review($1,'REJECTED','',1)", [created.id]));
    await db.query("select public.club_review($1,'CHANGES_REQUESTED','Update the logo',1)", [created.id]);
    await as(member);
    const {category: ignored, ...noCategory} = post;
    await db.query('select public.club_save($1,$2,$3)',
      [created.id, {...noCategory, status: 'PENDING', version: 2}, []]);
    await as(reviewer);
    await db.query("select public.club_review($1,'APPROVED','',3)", [created.id]);
    await assert.rejects(db.query("select public.club_review($1,'REJECTED','Stale',3)", [created.id]));
    await as(member);
    assert.equal((await rpc('select public.club_detail($1) as result', [created.id])).submission.status, 'APPROVED');
    assert.ok((await rpc('select public.club_notifications() as result')).notifications.some(n => n.title === 'Final approval received'));
  }
  for (const role of ['ADMIN','MARKETING_VP','B2C_VP']) {
    await db.exec('reset role');
    const member = (await db.query('select gen_random_uuid() as id')).rows[0].id;
    await db.query('insert into auth.users values($1,$2,$3,now())',
      [member, `${role}-signup@example.test`, {name: 'No privilege escalation', role}]);
    await as(member);
    assert.equal((await rpc('select public.club_me() as result')).role, 'MARKETING_MEMBER');
  }
  await db.exec("reset role; set role service_role");
  await db.query(
    `select public.club_manage_profile($1,'Member','MARKETING_MEMBER',false)`,
    [ids[1]],
  );
  await as(ids[1]);
  await assert.rejects(db.query(`select public.club_submissions()`));
  await assert.rejects(
    db.query("select public.club_push_subscribe($1)", [subscription]),
  );
  await db.exec("reset role; set role anon");
  await assert.rejects(db.query(`select public.club_submissions()`));
  await db.close();
});
