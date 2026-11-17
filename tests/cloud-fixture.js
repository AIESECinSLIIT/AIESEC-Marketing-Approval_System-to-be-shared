import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
export async function cloudDatabase() {
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

  return db;
}
