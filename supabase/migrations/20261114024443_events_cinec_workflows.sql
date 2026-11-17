-- Event-scoped observers and EXAMPLE_IG's IG -> LC approval sequence.
create table club.events (
 id uuid primary key default gen_random_uuid(), name text not null check(length(trim(name)) between 1 and 120),
 active boolean not null default true, created_at timestamptz not null default now()
);
create unique index events_name_unique on club.events(lower(name));
alter table club.events enable row level security;
revoke all on club.events from public,anon,authenticated;
grant all on club.events to service_role;
alter table club.profiles add column organization text not null default 'ENTITY' check(organization in ('ENTITY','EXAMPLE_IG'));
alter table club.profiles add column event_id uuid references club.events(id);
alter table club.profiles add column deleted_at timestamptz;
alter table club.profiles drop constraint profiles_role_check;
alter table club.profiles add constraint profiles_role_check check(role in ('ADMIN','MARKETING_VP','B2C_VP','CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER','IGVP_MARKETING','IGVP_OGV'));
-- Keep the audit identity after deleting Auth access.
alter table club.profiles drop constraint profiles_id_fkey;
drop index club.one_club_admin;
create function club.on_auth_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update club.profiles set active=false where id=old.id;
 delete from club.push_subscriptions where user_id=old.id;
 return old;
end $$;
create trigger club_auth_deleted after delete on auth.users for each row execute function club.on_auth_delete();
revoke all on function club.on_auth_delete() from public,anon,authenticated;
create or replace function club.me() returns club.profiles language plpgsql stable security definer set search_path='' as $$
declare u club.profiles;
begin
 select * into u from club.profiles p where p.id=auth.uid() and p.active and p.deleted_at is null and exists(select 1 from auth.users a where a.id=p.id);
 if u.id is null then raise exception 'Please sign in with an active account.' using errcode='42501'; end if;
 return u;
end $$;
create index profiles_event on club.profiles(event_id);
alter table club.submissions add column event_id uuid references club.events(id);
alter table club.submissions add column organization text not null default 'ENTITY' check(organization in ('ENTITY','EXAMPLE_IG'));
alter table club.submissions add column submitter_role text not null default 'CREATOR';
alter table club.submissions add column review_stage text not null default 'LC' check(review_stage in ('IG','LC'));
update club.submissions s set submitter_role=u.role from club.profiles u where u.id=s.creator_id;
create index submissions_event on club.submissions(event_id,status);
create index submissions_stage on club.submissions(organization,review_stage,category,status);

create or replace function club.profile_json(u club.profiles) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'active',u.active,'createdAt',u.created_at,
 'organization',u.organization,'eventId',u.event_id,'eventName',e.name,'eventActive',e.active)
 from (select 1) x left join club.events e on e.id=u.event_id
$$;
create or replace function club.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
declare r text:=new.raw_user_meta_data->>'role'; org text:='ENTITY'; eid uuid;
begin
 -- Metadata only selects a low-privilege role at signup. Subsequent metadata
 -- changes never modify authorization stored in club.profiles.
 if r not in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') or r is null then r:='MARKETING_MEMBER'; end if;
 if r='CREATOR' then
  eid:=nullif(new.raw_user_meta_data->>'eventId','')::uuid;
  if eid is null or not exists(select 1 from club.events where id=eid and active) then raise exception 'Select an ongoing event created by the admin.'; end if;
 elsif new.raw_user_meta_data->>'organization'='EXAMPLE_IG' then org:='EXAMPLE_IG'; end if;
 insert into club.profiles(id,email,name,role,organization,event_id)
 values(new.id,lower(new.email),left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Member'),100),r,org,eid);
 return new;
end $$;
create function club.api_events(p_all boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_all and (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('events',coalesce((select jsonb_agg(jsonb_build_object('id',id,'name',name,'active',active) order by name) from club.events where active or p_all),'[]'::jsonb));
end $$;
create function club.api_event(p_id uuid,p_name text,p_active boolean,p_delete boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare e club.events;
begin
 if (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if p_delete then
  if exists(select 1 from club.profiles where event_id=p_id) or exists(select 1 from club.submissions where event_id=p_id) then raise exception 'This event has members or submissions. Archive it to keep their history.'; end if;
  delete from club.events where id=p_id;
 elsif length(trim(coalesce(p_name,''))) not between 1 and 120 or p_active is null then raise exception 'Enter an event name and status.';
 elsif p_id is null then insert into club.events(name,active) values(trim(p_name),p_active) returning * into e;
 else
  update club.events set name=trim(p_name),active=p_active where id=p_id returning * into e;
  if e.id is null then raise exception 'Event not found.'; end if;
 end if;
 return jsonb_build_object('ok',true,'event',to_jsonb(e));
end $$;
create function club.can_view(u club.profiles,s club.submissions) returns boolean language sql stable set search_path='' as $$
 select u.active and u.deleted_at is null and case when u.role='OCP' then
  u.event_id is not null and u.event_id=s.event_id and s.submitter_role='CREATOR' and s.status<>'DRAFT'
 else u.id=s.creator_id or u.role='ADMIN' or (s.status<>'DRAFT' and
  ((u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C') or
   (u.organization='EXAMPLE_IG' and s.organization='EXAMPLE_IG' and ((u.role='IGVP_MARKETING' and s.category='MARKETING') or (u.role='IGVP_OGV' and s.category='B2C'))))) end
$$;
create or replace function club.visible(s club.submissions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and club.can_view(u,s))
$$;
create function club.reviewer_role(s club.submissions) returns text language sql immutable set search_path='' as $$
 select case when s.review_stage='IG' then case when s.category='B2C' then 'IGVP_OGV' else 'IGVP_MARKETING' end
 else case when s.category='B2C' then 'B2C_VP' else 'MARKETING_VP' end end
$$;
create or replace function club.serialize(s club.submissions) returns jsonb language sql stable set search_path='' as $$
 select s.data || jsonb_build_object('id',s.id,'creatorId',s.creator_id,'creatorName',u.name,
 'category',s.category,'status',s.status,'revision',s.revision,'version',s.version,
 'organization',s.organization,'eventId',s.event_id,'submitterRole',s.submitter_role,'reviewStage',s.review_stage,
 'createdAt',s.created_at,'updatedAt',s.updated_at,'cleanupRequestedAt',s.cleanup_requested_at,'creativesDeletedAt',s.creatives_deleted_at,
 'fileCount',case when s.cleanup_requested_at is null then (select count(*) from club.files f where f.submission_id=s.id and f.revision=s.revision) else 0 end,
 'thumbnailPath',case when s.cleanup_requested_at is null then (select f.path from club.files f where f.submission_id=s.id and f.revision=s.revision and f.mime like 'image/%' limit 1) end)
 from club.profiles u where u.id=s.creator_id
$$;
create or replace function club.notify_reviewers(s club.submissions) returns void language sql set search_path='' as $$
 insert into club.notifications(user_id,submission_id,title,message)
 select u.id,s.id,case when u.role='OCP' then 'Event submission update' else 'Ready for review' end,s.data->>'title'
 from club.profiles u where u.active and u.deleted_at is null and u.id<>s.creator_id and
 (u.role='ADMIN' or (u.role=club.reviewer_role(s) and club.can_view(u,s)) or
 (u.role='OCP' and club.can_view(u,s)))
$$;
create or replace function club.api_review(p_id uuid,p_decision text,p_comment text,p_version int) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); s club.submissions; action text; next_status text; next_stage text; title text;
begin
 select * into s from club.submissions where id=p_id for update;
 if s.id is null or not club.visible(s) or s.creator_id=u.id or not(u.role='ADMIN' or u.role=club.reviewer_role(s)) then raise exception 'You cannot review this stage of the submission.' using errcode='42501'; end if;
 if s.cleanup_requested_at is not null then raise exception 'Creative files are being deleted or have been removed. Create a new submission.'; end if;
 if s.status='DRAFT' or (u.role<>'ADMIN' and s.status<>'PENDING') or p_version is distinct from s.version then raise exception 'This post changed. Reload before reviewing.'; end if;
 if p_decision is null or p_decision not in ('APPROVED','CHANGES_REQUESTED','REJECTED','PENDING') or p_decision=s.status or (p_decision='PENDING' and u.role<>'ADMIN') then raise exception 'Invalid decision.'; end if;
 p_comment:=trim(coalesce(p_comment,''));
 if length(p_comment)>5000 or ((p_decision<>'APPROVED' or s.status<>'PENDING') and length(p_comment)=0) then raise exception 'Please provide feedback for this decision.'; end if;
 next_status:=p_decision; next_stage:=s.review_stage;
 action:=case when s.status='PENDING' then p_decision else 'OVERRIDE_'||p_decision end;
 if p_decision='APPROVED' and s.review_stage='IG' then
  next_status:='PENDING'; next_stage:='LC'; action:='IG_APPROVED';
 elsif p_decision='PENDING' then
  next_stage:=case when s.organization='EXAMPLE_IG' and s.submitter_role in ('MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
 end if;
 update club.submissions set status=next_status,review_stage=next_stage,version=version+1,updated_at=now() where id=p_id returning * into s;
 perform club.record(s,action,p_comment);
 title:=case when action='IG_APPROVED' then 'IG approved · awaiting ENTITY review' when p_decision='CHANGES_REQUESTED' then 'Changes requested' when p_decision='APPROVED' then 'Submission approved' when p_decision='REJECTED' then 'Submission rejected' else 'Submission reopened' end;
 insert into club.notifications(user_id,submission_id,title,message)
 select p.id,s.id,title,(s.data->>'title')||case when p_comment='' then '' else ': '||p_comment end from club.profiles p
 where p.active and p.deleted_at is null and (p.id=s.creator_id or (p.role='OCP' and club.can_view(p,s)));
 if next_status='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;
create or replace function club.api_notifications() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin
 return jsonb_build_object('notifications',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'submissionId',n.submission_id,'title',n.title,'message',n.message,'createdAt',n.created_at,'readAt',n.read_at) order by n.created_at desc)
 from (select n.* from club.notifications n left join club.submissions s on s.id=n.submission_id where n.user_id=u.id and (n.submission_id is null or club.can_view(u,s)) order by n.created_at desc limit 200) n),'[]'::jsonb));
end $$;
create or replace function club.file_access(p_path text,p_delete boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and u.deleted_at is null and
 case when p_delete then u.role<>'OCP' and split_part(p_path,'/',1)=u.id::text and not exists(select 1 from club.files f where f.path=p_path)
 else exists(select 1 from club.files f join club.submissions s on s.id=f.submission_id where f.path=p_path and club.can_view(u,s)) or
 (u.role<>'OCP' and split_part(p_path,'/',1)=u.id::text and not exists(select 1 from club.files f where f.path=p_path)) end)
$$;
create or replace function club.api_users() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('users',coalesce((select jsonb_agg(club.profile_json(u) order by u.created_at) from club.profiles u where u.deleted_at is null),'[]'::jsonb));
end $$;

-- Internal profile changes are available only to the server's admin handler.
create function public.club_manage_account(p_id uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
declare target club.profiles;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 lock table club.profiles in share row exclusive mode;
 select * into target from club.profiles where id=p_id and deleted_at is null;
 if target.id is null then raise exception 'Account not found.'; end if;
 if p_role is null or p_role not in ('ADMIN','CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV') or p_active is null or length(trim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if target.role='ADMIN' and target.active and (p_role<>'ADMIN' or not p_active) and (select count(*) from club.profiles where role='ADMIN' and active and deleted_at is null)<=1 then raise exception 'Keep at least one active administrator.'; end if;
 if p_role in ('CREATOR','OCP') then
  if not (not p_active and p_event is null) and (p_event is null or not exists(select 1 from club.events where id=p_event and (active or target.event_id=p_event))) then raise exception 'Select an ongoing event.'; end if;
  p_organization:='ENTITY';
 else p_event:=null; end if;
 if p_role in ('IGVP_MARKETING','IGVP_OGV') then p_organization:='EXAMPLE_IG'; end if;
 if p_role in ('ADMIN','MARKETING_VP','B2C_VP') then p_organization:='ENTITY'; end if;
 if p_organization is null or p_organization not in ('ENTITY','EXAMPLE_IG') then raise exception 'Choose ENTITY or EXAMPLE_IG.'; end if;
 if p_email is null or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Enter a valid email.'; end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active,organization=p_organization,event_id=p_event,email=lower(trim(p_email)) where id=p_id;
 if not p_active or target.role<>p_role or target.event_id is distinct from p_event or target.organization<>p_organization then
  delete from club.push_subscriptions where user_id=p_id;
 end if;
end $$;
-- Retain the old service signature for already deployed clients, but do not
-- permit it to clear event/org assignments or bypass new validation.
create or replace function public.club_manage_profile(p_id uuid,p_name text,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
declare u club.profiles;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 select * into u from club.profiles where id=p_id;
 perform public.club_manage_account(p_id,p_name,p_role,p_active,u.organization,u.event_id,u.email);
end $$;
create function public.club_delete_account(p_id uuid,p_finish boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles; paths jsonb;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 lock table club.profiles in share row exclusive mode;
 select * into u from club.profiles where id=p_id;
 if u.id is null then raise exception 'Account not found.'; end if;
 if u.role='ADMIN' and u.active and (select count(*) from club.profiles where role='ADMIN' and active and deleted_at is null)<=1 then raise exception 'Keep at least one active administrator.'; end if;
 update club.profiles set active=false where id=p_id;
 delete from club.push_subscriptions where user_id=p_id;
 update club.submissions set cleanup_requested_at=coalesce(cleanup_requested_at,now()),version=version+1 where creator_id=p_id and cleanup_requested_at is null;
 select coalesce(jsonb_agg(name),'[]'::jsonb) into paths from storage.objects where bucket_id='creatives' and split_part(name,'/',1)=p_id::text;
 if p_finish then
  if jsonb_array_length(paths)>0 or exists(select 1 from auth.users where id=p_id) then raise exception 'Delete uploaded files and Auth access before finishing.'; end if;
  delete from club.files f using club.submissions s where f.submission_id=s.id and s.creator_id=p_id;
  update club.submissions set creatives_deleted_at=coalesce(creatives_deleted_at,now()) where creator_id=p_id;
  update club.profiles set deleted_at=now(),email=p_id::text||'@deleted.invalid' where id=p_id;
 end if;
 return jsonb_build_object('ok',true,'paths',paths);
end $$;
create function public.club_events(p_all boolean default false) returns jsonb language sql set search_path='' as $$select club.api_events(p_all)$$;
create function public.club_event(p_id uuid,p_name text,p_active boolean,p_delete boolean default false) returns jsonb language sql set search_path='' as $$select club.api_event(p_id,p_name,p_active,p_delete)$$;
revoke all on function club.can_view(club.profiles,club.submissions),club.reviewer_role(club.submissions),club.api_events(boolean),club.api_event(uuid,text,boolean,boolean),public.club_events(boolean),public.club_event(uuid,text,boolean,boolean),public.club_manage_account(uuid,text,text,boolean,text,uuid,text),public.club_delete_account(uuid,boolean) from public,anon,authenticated;
grant execute on function club.api_events(boolean),public.club_events(boolean) to anon,authenticated;
grant usage on schema club to anon;
grant execute on function club.api_event(uuid,text,boolean,boolean),public.club_event(uuid,text,boolean,boolean) to authenticated;
grant execute on function public.club_manage_account(uuid,text,text,boolean,text,uuid,text),public.club_delete_account(uuid,boolean) to service_role;

create or replace function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; old_revision int; f jsonb; field text; route_category text := case when u.role in ('B2C_MEMBER','B2C_VP','IGVP_OGV') then 'B2C' else 'MARKETING' end; limits jsonb := '{"title":160,"event":120,"caption":10000,"contentType":50,"platform":50,"notes":3000}'; clean jsonb := '{}'; eid uuid; org text:=u.organization; stage text; event_name text; drive text:=trim(coalesce(p_data->>'externalUrl',''));
begin
 if u.role='OCP' then raise exception 'OCP accounts can only observe their event.' using errcode='42501'; end if;
 if u.role='CREATOR' then
  select id,name into eid,event_name from club.events where id=u.event_id and active;
  if eid is null then raise exception 'Ask the admin to assign an ongoing event to your account.'; end if;
  p_data:=p_data||jsonb_build_object('event',event_name);
 end if;
 stage:=case when org='EXAMPLE_IG' and u.role in ('MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
 if length(drive)>2000 or (drive<>'' and drive !~ '^https://drive[.]google[.]com/(file/d/|open[?]id=)[A-Za-z0-9_-]+[^[:space:]]*$') then raise exception 'Use a Google Drive file link.'; end if;
 clean:=jsonb_build_object('externalUrl',drive);
 if jsonb_typeof(p_data)<>'object' or jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)>8 then raise exception 'Invalid submission.'; end if;
 for field in select jsonb_object_keys(limits) loop
  if length(coalesce(p_data->>field,''))>(limits->>field)::int or (field not in ('notes','event') and length(trim(coalesce(p_data->>field,'')))=0) then raise exception 'Invalid or missing %.',field; end if;
  clean := clean || jsonb_build_object(field,trim(coalesce(p_data->>field,'')));
 end loop;
 if p_data->>'status' is null or p_data->>'status' not in ('DRAFT','PENDING') then raise exception 'Save a draft or submit for review.'; end if;
 clean := clean || jsonb_build_object('scheduledAt',nullif(p_data->>'scheduledAt','')::timestamptz);
 if p_id is not null then
  select * into s from club.submissions where id=p_id for update;
  if s.id is null or s.creator_id<>u.id then raise exception 'Only the creator can edit this submission.' using errcode='42501'; end if;
  if s.status not in ('DRAFT','CHANGES_REQUESTED') then raise exception 'Only drafts or posts needing changes can be edited.'; end if;
  if (p_data->>'version')::int is distinct from s.version then raise exception 'This post changed. Reload before saving.'; end if;
  if s.cleanup_requested_at is not null then raise exception 'Creative files were removed. Create a new submission.'; end if;
  if s.organization<>org or s.submitter_role<>u.role or (s.event_id is not null and s.event_id is distinct from eid) then raise exception 'Your account assignment changed. Create a new submission.'; end if;
  old_revision := s.revision;
  update club.submissions set data=clean,category=route_category,event_id=eid,organization=org,submitter_role=u.role,review_stage=stage,status=p_data->>'status',revision=revision+1,version=version+1,updated_at=now() where id=p_id returning * into s;
 else
  insert into club.submissions(creator_id,data,category,status,event_id,organization,submitter_role,review_stage) values(u.id,clean,route_category,p_data->>'status',eid,org,u.role,stage) returning * into s;
 end if;
 for f in select value from jsonb_array_elements(p_files) loop
  if f->>'path' is null or split_part(f->>'path','/',1)<>u.id::text or length(f->>'name') not between 1 and 240 or not exists(select 1 from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path' and (o.metadata->>'size')::bigint between 1 and 52428800 and o.metadata->>'mimetype'=f->>'mime') or exists(select 1 from club.files cf where cf.path=f->>'path') then raise exception 'Invalid creative file.'; end if;
  insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,f->>'name',o.metadata->>'mimetype',(o.metadata->>'size')::bigint,o.name from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path';
 end loop;
 if jsonb_array_length(p_files)=0 and old_revision is not null then insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,name,mime,size,path from club.files where submission_id=s.id and revision=old_revision; end if;
 if s.status='PENDING' and drive='' and not exists(select 1 from club.files where submission_id=s.id and revision=s.revision) then raise exception 'Attach a creative or add a Google Drive video link before submitting.'; end if;
 insert into club.revisions(submission_id,revision,snapshot) values(s.id,s.revision,club.serialize(s));
 perform club.record(s,case when s.status='DRAFT' then 'DRAFT_SAVED' when p_id is null then 'SUBMITTED' else 'RESUBMITTED' end);
 if s.status='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;



create or replace function club.claim_push() returns jsonb language plpgsql security definer set search_path='' as $$
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
 and (s.id is null or club.can_view(p,s))));
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
 when n.title='Ready for review' then 'A post is ready for your review.' else 'A submission you follow has an update.' end,
 'tag',n.id,'url',case when n.submission_id is null then '/?notifications=1' else '/?submission='||n.submission_id::text end))), '[]'::jsonb)
 into result from claimed j join club.push_subscriptions ps on ps.id=j.subscription_id join club.notifications n on n.id=j.notification_id;
 return result;
end $$;
