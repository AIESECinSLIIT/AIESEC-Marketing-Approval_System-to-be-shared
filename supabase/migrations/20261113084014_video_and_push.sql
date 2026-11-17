-- Larger phone videos, still within the free Storage plan.
update storage.buckets set file_size_limit=52428800,
 allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','application/pdf','video/mp4','video/quicktime','video/webm']
 where id='creatives';

create or replace function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; old_revision int; f jsonb; field text; limits jsonb := '{"title":160,"event":120,"caption":10000,"contentType":50,"platform":50,"notes":3000}'; clean jsonb := '{}';
begin
 if jsonb_typeof(p_data)<>'object' or jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)>8 then raise exception 'Invalid submission.'; end if;
 for field in select jsonb_object_keys(limits) loop
  if length(coalesce(p_data->>field,''))>(limits->>field)::int or (field<>'notes' and length(trim(coalesce(p_data->>field,'')))=0) then raise exception 'Invalid or missing %.',field; end if;
  clean := clean || jsonb_build_object(field,trim(coalesce(p_data->>field,'')));
 end loop;
 if p_data->>'category' is null or p_data->>'category' not in ('MARKETING','B2C') or p_data->>'status' is null or p_data->>'status' not in ('DRAFT','PENDING') then raise exception 'Choose a category and submit or save a draft.'; end if;
 clean := clean || jsonb_build_object('scheduledAt',nullif(p_data->>'scheduledAt','')::timestamptz);
 if p_id is not null then
  select * into s from club.submissions where id=p_id for update;
  if s.id is null or s.creator_id<>u.id then raise exception 'Only the creator can edit this submission.' using errcode='42501'; end if;
  if s.status not in ('DRAFT','CHANGES_REQUESTED') then raise exception 'Only drafts or posts needing changes can be edited.'; end if;
  if (p_data->>'version')::int is distinct from s.version then raise exception 'This post changed. Reload before saving.'; end if;
  old_revision := s.revision;
  update club.submissions set data=clean,category=p_data->>'category',status=p_data->>'status',revision=revision+1,version=version+1,updated_at=now() where id=p_id returning * into s;
 else
  insert into club.submissions(creator_id,data,category,status) values(u.id,clean,p_data->>'category',p_data->>'status') returning * into s;
 end if;
 for f in select value from jsonb_array_elements(p_files) loop
  if f->>'path' is null or split_part(f->>'path','/',1)<>u.id::text or length(f->>'name') not between 1 and 240 or not exists(
    select 1 from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path' and (o.metadata->>'size')::bigint between 1 and 52428800 and o.metadata->>'mimetype'=f->>'mime'
  ) or exists(select 1 from club.files cf where cf.path=f->>'path') then raise exception 'Invalid creative file.'; end if;
  insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,f->>'name',o.metadata->>'mimetype',(o.metadata->>'size')::bigint,o.name from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path';
 end loop;
 if jsonb_array_length(p_files)=0 and old_revision is not null then
  insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,name,mime,size,path from club.files where submission_id=s.id and revision=old_revision;
 end if;
 if s.status='PENDING' and not exists(select 1 from club.files where submission_id=s.id and revision=s.revision) then raise exception 'Attach a creative before submitting.'; end if;
 insert into club.revisions(submission_id,revision,snapshot) values(s.id,s.revision,club.serialize(s));
 perform club.record(s,case when s.status='DRAFT' then 'DRAFT_SAVED' when p_id is null then 'SUBMITTED' else 'RESUBMITTED' end);
 if s.status='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;

-- Private push settings and a durable delivery queue. Clients use scoped RPCs only.
create table club.push_settings (
 singleton boolean primary key default true check(singleton),
 public_key text not null, private_key text not null, dispatch_secret text not null,
 dispatch_url text not null
);
create table club.push_subscriptions (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references club.profiles(id) on delete cascade,
 endpoint text not null unique, p256dh text not null, auth text not null,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 tested_at timestamptz
);
create index push_subscriptions_user on club.push_subscriptions(user_id);
create table club.push_jobs (
 id uuid primary key default gen_random_uuid(),
 subscription_id uuid not null references club.push_subscriptions(id) on delete cascade,
 notification_id uuid not null references club.notifications(id) on delete cascade,
 attempts integer not null default 0, available_at timestamptz not null default now(),
 finished_at timestamptz, last_status integer,
 unique(subscription_id,notification_id)
);
create index push_jobs_notification on club.push_jobs(notification_id);
create index push_jobs_pending on club.push_jobs(available_at) where finished_at is null;
alter table club.push_settings enable row level security;
alter table club.push_subscriptions enable row level security;
alter table club.push_jobs enable row level security;
revoke all on club.push_settings,club.push_subscriptions,club.push_jobs from public,anon,authenticated;
grant all on club.push_settings,club.push_subscriptions,club.push_jobs to service_role;

create function club.api_push_status(p_endpoint text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin
 return jsonb_build_object('publicKey',(select public_key from club.push_settings where singleton),
 'enabled',exists(select 1 from club.push_subscriptions where user_id=u.id and endpoint=p_endpoint));
end $$;

create function club.api_push_subscribe(p_subscription jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); ep text:=p_subscription->>'endpoint'; pk text:=p_subscription->'keys'->>'p256dh'; ak text:=p_subscription->'keys'->>'auth'; owner_id uuid;
begin
 if ep is null or length(ep)>2048 or ep !~ '^https://(fcm[.]googleapis[.]com|web[.]push[.]apple[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]#]+$'
 or pk is null or pk !~ '^[A-Za-z0-9_-]{87}$' or ak is null or ak !~ '^[A-Za-z0-9_-]{22}$' then
  raise exception 'This browser supplied an unsupported push subscription.';
 end if;
 if not exists(select 1 from club.push_settings) then raise exception 'Push notifications are not configured yet.'; end if;
 perform pg_advisory_xact_lock(hashtext(u.id::text));
 select user_id into owner_id from club.push_subscriptions where endpoint=ep;
 if owner_id is not null and owner_id<>u.id then raise exception 'Turn off notifications for the previous account on this device first.'; end if;
 if owner_id is null and (select count(*) from club.push_subscriptions where user_id=u.id)>=10 then raise exception 'You have reached the 10-device limit.'; end if;
 insert into club.push_subscriptions(user_id,endpoint,p256dh,auth) values(u.id,ep,pk,ak)
 on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,updated_at=now()
 where club.push_subscriptions.user_id=u.id;
 return jsonb_build_object('ok',true);
end $$;

create function club.api_push_unsubscribe(p_endpoint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin
 delete from club.push_subscriptions where endpoint=p_endpoint and user_id=u.id;
 return jsonb_build_object('ok',true);
end $$;

create function club.enqueue_push() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 insert into club.push_jobs(subscription_id,notification_id)
 select id,new.id from club.push_subscriptions where user_id=new.user_id;
 return new;
end $$;
create trigger club_enqueue_push after insert on club.notifications for each row execute function club.enqueue_push();

create function club.api_push_test(p_endpoint text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); sub club.push_subscriptions; nid uuid;
begin
 select * into sub from club.push_subscriptions where user_id=u.id and endpoint=p_endpoint for update;
 if sub.id is null then raise exception 'Enable notifications on this device first.'; end if;
 if sub.tested_at>now()-interval '1 minute' then raise exception 'Wait a minute before sending another test.'; end if;
 update club.push_subscriptions set tested_at=now() where id=sub.id;
 insert into club.notifications(user_id,title,message) values(u.id,'Notifications enabled','This is your test notification.') returning id into nid;
 -- A test targets only the current device.
 delete from club.push_jobs where notification_id=nid and subscription_id<>sub.id;
 return jsonb_build_object('ok',true);
end $$;

create function club.push_config() returns jsonb language sql stable security definer set search_path='' as $$
 select jsonb_build_object('publicKey',public_key,'privateKey',private_key,'secret',dispatch_secret) from club.push_settings where singleton
$$;
create function club.claim_push() returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
 delete from club.push_jobs where finished_at<now()-interval '1 day';
 -- Suppress stale/read notifications and notifications for revoked access.
 update club.push_jobs j set finished_at=now()
 where j.finished_at is null and ((j.attempts>=5 and j.available_at<=now()) or not exists(
 select 1 from club.push_subscriptions ps join club.profiles p on p.id=ps.user_id
 join club.notifications n on n.id=j.notification_id left join club.submissions s on s.id=n.submission_id
 where ps.id=j.subscription_id and p.active and p.id=n.user_id and n.read_at is null
 and n.created_at>now()-interval '1 day'
 and (s.id is null or s.creator_id=p.id or p.role='ADMIN' or
 (s.status<>'DRAFT' and ((p.role='MARKETING_VP' and s.category='MARKETING') or (p.role='B2C_VP' and s.category='B2C'))))));
 with batch as (
 select id from club.push_jobs where finished_at is null and available_at<=now()
 order by available_at limit 20 for update skip locked
 ), claimed as (
 update club.push_jobs j set attempts=attempts+1,available_at=now()+interval '2 minutes'
 from batch b where j.id=b.id returning j.*
 )
 select coalesce(jsonb_agg(jsonb_build_object('id',j.id,'attempt',j.attempts,
 'subscription',jsonb_build_object('endpoint',ps.endpoint,'keys',jsonb_build_object('p256dh',ps.p256dh,'auth',ps.auth)),
 'payload',jsonb_build_object('title','Approval Hub',
 'body',case when n.submission_id is null then 'Push notifications are working on this device.'
 when n.title='Ready for review' then 'A post is ready for your review.' else 'Your submission has an update.' end,
 'tag',n.id,'url',case when n.submission_id is null then '/?notifications=1' else '/?submission='||n.submission_id::text end))), '[]'::jsonb)
 into result from claimed j join club.push_subscriptions ps on ps.id=j.subscription_id join club.notifications n on n.id=j.notification_id;
 return result;
end $$;
create function club.finish_push(p_id uuid,p_attempt integer,p_status integer) returns void
language plpgsql security definer set search_path='' as $$
declare j club.push_jobs;
begin
 select * into j from club.push_jobs where id=p_id and attempts=p_attempt and finished_at is null for update;
 if j.id is null then return; end if;
 if p_status in (404,410) then
  delete from club.push_subscriptions where id=j.subscription_id;
 else
  update club.push_jobs set last_status=p_status,
  finished_at=case when p_status between 200 and 299 or p_status=400 or attempts>=5 then now() end,
  available_at=now()+make_interval(secs=>least(3600,60*(2^attempts)::int)) where id=p_id;
 end if;
end $$;

create function public.club_push_status(p_endpoint text default '') returns jsonb language sql set search_path='' as $$ select club.api_push_status(p_endpoint) $$;
create function public.club_push_subscribe(p_subscription jsonb) returns jsonb language sql set search_path='' as $$ select club.api_push_subscribe(p_subscription) $$;
create function public.club_push_unsubscribe(p_endpoint text) returns jsonb language sql set search_path='' as $$ select club.api_push_unsubscribe(p_endpoint) $$;
create function public.club_push_test(p_endpoint text) returns jsonb language sql set search_path='' as $$ select club.api_push_test(p_endpoint) $$;
create function public.club_push_config() returns jsonb language sql set search_path='' as $$ select club.push_config() $$;
create function public.club_claim_push() returns jsonb language sql set search_path='' as $$ select club.claim_push() $$;
create function public.club_finish_push(p_id uuid,p_attempt integer,p_status integer) returns void language sql set search_path='' as $$ select club.finish_push(p_id,p_attempt,p_status) $$;

revoke all on function club.api_push_status(text),club.api_push_subscribe(jsonb),club.api_push_unsubscribe(text),club.api_push_test(text),
 club.enqueue_push(),club.push_config(),club.claim_push(),club.finish_push(uuid,integer,integer) from public,anon,authenticated;
revoke all on function public.club_push_status(text),public.club_push_subscribe(jsonb),public.club_push_unsubscribe(text),public.club_push_test(text),
 public.club_push_config(),public.club_claim_push(),public.club_finish_push(uuid,integer,integer) from public,anon,authenticated;
grant execute on function club.api_push_status(text),club.api_push_subscribe(jsonb),club.api_push_unsubscribe(text),club.api_push_test(text),
 public.club_push_status(text),public.club_push_subscribe(jsonb),public.club_push_unsubscribe(text),public.club_push_test(text) to authenticated;
grant execute on function club.push_config(),club.claim_push(),club.finish_push(uuid,integer,integer),
 public.club_push_config(),public.club_claim_push(),public.club_finish_push(uuid,integer,integer) to service_role;

-- Hosted delivery transport. PGlite tests mock only these extension APIs.
create extension if not exists pg_net;
create extension if not exists pg_cron;
create function club.dispatch_push() returns void language plpgsql security definer set search_path='' as $$
declare settings club.push_settings;
begin
 if not exists(select 1 from club.push_jobs where finished_at is null and available_at<=now()) then return; end if;
 select * into settings from club.push_settings where singleton;
 if settings.singleton is null then return; end if;
 perform net.http_post(url:=settings.dispatch_url,body:='{}'::jsonb,
 headers:=jsonb_build_object('Content-Type','application/json','X-Push-Secret',settings.dispatch_secret),
 timeout_milliseconds:=10000);
exception when others then
 -- A network outage must not roll back an approval. Cron retries the durable queue.
 raise warning 'Push dispatch deferred';
end $$;
create function club.wake_push() returns trigger language plpgsql security definer set search_path='' as $$
begin perform club.dispatch_push(); return null; end $$;
create trigger club_wake_push after insert on club.push_jobs for each statement execute function club.wake_push();
revoke all on function club.dispatch_push(),club.wake_push() from public,anon,authenticated;
select cron.schedule('club-push-retry','*/5 * * * *','select club.dispatch_push()');

