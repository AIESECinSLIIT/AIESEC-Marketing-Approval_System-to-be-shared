-- Approval Hub: protected data and transactional workflow API.
create schema if not exists club;
revoke all on schema club from public, anon;
grant usage on schema club to authenticated, service_role;
create table club.profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 email text not null unique, name text not null check(length(name) between 1 and 100),
 role text not null default 'CREATOR' check(role in ('ADMIN','MARKETING_VP','B2C_VP','CREATOR')),
 active boolean not null default true, created_at timestamptz not null default now()
);
create unique index one_club_admin on club.profiles(role) where role='ADMIN';
create table club.submissions (
 id uuid primary key default gen_random_uuid(), creator_id uuid not null references club.profiles(id),
 category text not null check(category in ('MARKETING','B2C')),
 status text not null check(status in ('DRAFT','PENDING','APPROVED','CHANGES_REQUESTED','REJECTED')),
 revision integer not null default 1, version integer not null default 1,
 data jsonb not null, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index submissions_creator on club.submissions(creator_id);
create index submissions_queue on club.submissions(category,status,updated_at desc);
create table club.files (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null references club.submissions(id),
 revision integer not null, name text not null, mime text not null, size bigint not null, path text not null
);
create index files_submission on club.files(submission_id,revision);
create index files_path on club.files(path);
create table club.history (
 id uuid primary key default gen_random_uuid(), submission_id uuid not null references club.submissions(id),
 actor_id uuid not null references club.profiles(id), actor_name text not null, actor_role text not null,
 action text not null, comment text not null default '', revision integer not null, created_at timestamptz not null default now()
);
create index history_submission on club.history(submission_id,created_at);
create table club.revisions (
 submission_id uuid not null references club.submissions(id), revision integer not null,
 snapshot jsonb not null, created_at timestamptz not null default now(), primary key(submission_id,revision)
);
create table club.notifications (
 id uuid primary key default gen_random_uuid(), user_id uuid not null references club.profiles(id),
 submission_id uuid references club.submissions(id), title text not null, message text not null,
 created_at timestamptz not null default now(), read_at timestamptz
);
create index notifications_user on club.notifications(user_id,created_at desc);
alter table club.profiles enable row level security;
alter table club.submissions enable row level security;
alter table club.files enable row level security;
alter table club.history enable row level security;
alter table club.revisions enable row level security;
alter table club.notifications enable row level security;
grant all on all tables in schema club to service_role;

create function club.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into club.profiles(id,email,name) values(new.id,lower(new.email),left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Member'),100));
 return new;
end $$;
create trigger club_signup after insert on auth.users for each row execute function club.on_signup();

create function club.me() returns club.profiles language plpgsql stable security definer set search_path='' as $$
declare u club.profiles;
begin
 select * into u from club.profiles where id=auth.uid() and active;
 if u.id is null then raise exception 'Please sign in with an active account.' using errcode='42501'; end if;
 return u;
end $$;
create function club.visible(s club.submissions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and
 (u.id=s.creator_id or u.role='ADMIN' or (s.status<>'DRAFT' and
 ((u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')))))
$$;
create function club.serialize(s club.submissions) returns jsonb language sql stable set search_path='' as $$
 select s.data || jsonb_build_object('id',s.id,'creatorId',s.creator_id,'creatorName',u.name,
 'category',s.category,'status',s.status,'revision',s.revision,'version',s.version,
 'createdAt',s.created_at,'updatedAt',s.updated_at,
 'fileCount',(select count(*) from club.files f where f.submission_id=s.id and f.revision=s.revision),
 'thumbnailPath',(select f.path from club.files f where f.submission_id=s.id and f.revision=s.revision and f.mime like 'image/%' limit 1))
 from club.profiles u where u.id=s.creator_id
$$;
create function club.record(s club.submissions, action text, comment text default '') returns void language plpgsql set search_path='' as $$
declare u club.profiles := club.me();
begin
 insert into club.history(submission_id,actor_id,actor_name,actor_role,action,comment,revision)
 values(s.id,u.id,u.name,u.role,action,comment,s.revision);
end $$;
create function club.notify_reviewers(s club.submissions) returns void language sql set search_path='' as $$
 insert into club.notifications(user_id,submission_id,title,message)
 select id,s.id,'Ready for review',s.data->>'title' from club.profiles
 where active and id<>s.creator_id and (role='ADMIN' or role=case s.category when 'MARKETING' then 'MARKETING_VP' else 'B2C_VP' end)
$$;
create function club.profile_json(u club.profiles) returns jsonb language sql immutable set search_path='' as $$
 select jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'active',u.active,'createdAt',u.created_at)
$$;
create function club.api_me() returns jsonb language sql stable security definer set search_path='' as $$ select club.profile_json(club.me()) $$;
create function club.api_submissions() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 perform club.me();
 return jsonb_build_object('submissions',coalesce((select jsonb_agg(club.serialize(s) order by s.updated_at desc) from club.submissions s where club.visible(s)),'[]'::jsonb));
end $$;
create function club.api_detail(p_id uuid) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s club.submissions;
begin
 perform club.me(); select * into s from club.submissions where id=p_id;
 if s.id is null or not club.visible(s) then raise exception 'Submission not found.' using errcode='42501'; end if;
 return jsonb_build_object('submission',club.serialize(s),
 'files',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'revision',f.revision,'name',f.name,'mime',f.mime,'size',f.size,'storagePath',f.path) order by f.revision desc) from club.files f where f.submission_id=p_id),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'actorName',h.actor_name,'actorRole',h.actor_role,'action',h.action,'comment',h.comment,'revision',h.revision,'createdAt',h.created_at) order by h.created_at desc) from club.history h where h.submission_id=p_id),'[]'::jsonb),
 'revisions',coalesce((select jsonb_agg(jsonb_build_object('revision',r.revision,'snapshot',r.snapshot,'createdAt',r.created_at) order by r.revision desc) from club.revisions r where r.submission_id=p_id),'[]'::jsonb));
end $$;
create function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
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
    select 1 from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path' and (o.metadata->>'size')::bigint between 1 and 26214400 and o.metadata->>'mimetype'=f->>'mime'
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
create function club.api_review(p_id uuid,p_decision text,p_comment text,p_version int) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; action text;
begin
 select * into s from club.submissions where id=p_id for update;
 if s.id is null or not club.visible(s) or s.creator_id=u.id or not(u.role='ADMIN' or (u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')) then raise exception 'You cannot review this submission.' using errcode='42501'; end if;
 if s.status='DRAFT' or (u.role<>'ADMIN' and s.status<>'PENDING') or p_version is distinct from s.version then raise exception 'This post changed. Reload before reviewing.'; end if;
 if p_decision is null or p_decision not in ('APPROVED','CHANGES_REQUESTED','REJECTED','PENDING') or p_decision=s.status or (p_decision='PENDING' and u.role<>'ADMIN') then raise exception 'Invalid decision.'; end if;
 p_comment := trim(coalesce(p_comment,''));
 if length(p_comment)>5000 or ((p_decision<>'APPROVED' or s.status<>'PENDING') and length(p_comment)=0) then raise exception 'Please provide feedback for this decision.'; end if;
 action := case when s.status='PENDING' then p_decision else 'OVERRIDE_'||p_decision end;
 update club.submissions set status=p_decision,version=version+1,updated_at=now() where id=p_id returning * into s;
 perform club.record(s,action,p_comment);
 insert into club.notifications(user_id,submission_id,title,message) values(s.creator_id,s.id,case p_decision when 'CHANGES_REQUESTED' then 'Changes requested' when 'APPROVED' then 'Submission approved' when 'REJECTED' then 'Submission rejected' else 'Submission reopened' end,(s.data->>'title')||case when p_comment='' then '' else ': '||p_comment end);
 if p_decision='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;
create function club.api_notifications() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles := club.me();
begin
 return jsonb_build_object('notifications',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'submissionId',n.submission_id,'title',n.title,'message',n.message,'createdAt',n.created_at,'readAt',n.read_at) order by n.created_at desc) from (select * from club.notifications where user_id=u.id order by created_at desc limit 200) n),'[]'::jsonb));
end $$;
create function club.api_read_notifications() returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me();
begin update club.notifications set read_at=now() where user_id=u.id and read_at is null; return '{"ok":true}'; end $$;
create function club.api_users() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('users',coalesce((select jsonb_agg(club.profile_json(u) order by u.created_at) from club.profiles u),'[]'::jsonb));
end $$;
-- Service-only mutation for the authenticated admin Edge Function.
create function public.club_manage_profile(p_id uuid,p_name text,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if p_role not in ('CREATOR','MARKETING_VP','B2C_VP','ADMIN') or p_role is null or p_active is null or length(trim(p_name)) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if exists(select 1 from club.profiles where id=p_id and role='ADMIN') and (p_role<>'ADMIN' or not p_active) then raise exception 'Keep the administrator active.'; end if;
 if p_role='ADMIN' and not exists(select 1 from auth.users where id=p_id and lower(email)='admin@your-entity.example' and email_confirmed_at is not null) then raise exception 'Only the verified club email can be administrator.'; end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active where id=p_id;
 if not found then raise exception 'Account not found.'; end if;
end $$;
revoke all on function public.club_manage_profile(uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.club_manage_profile(uuid,text,text,boolean) to service_role;
-- Exposed wrappers use invoker security; internal functions enforce identity and authorization.
create function public.club_me() returns jsonb language sql set search_path='' as $$ select club.api_me() $$;
create function public.club_submissions() returns jsonb language sql set search_path='' as $$ select club.api_submissions() $$;
create function public.club_detail(p_id uuid) returns jsonb language sql set search_path='' as $$ select club.api_detail(p_id) $$;
create function public.club_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language sql set search_path='' as $$ select club.api_save(p_id,p_data,p_files) $$;
create function public.club_review(p_id uuid,p_decision text,p_comment text,p_version int) returns jsonb language sql set search_path='' as $$ select club.api_review(p_id,p_decision,p_comment,p_version) $$;
create function public.club_notifications() returns jsonb language sql set search_path='' as $$ select club.api_notifications() $$;
create function public.club_read_notifications() returns jsonb language sql set search_path='' as $$ select club.api_read_notifications() $$;
create function public.club_users() returns jsonb language sql set search_path='' as $$ select club.api_users() $$;
revoke all on all functions in schema club from public,anon,authenticated;
grant execute on function club.api_me(),club.api_submissions(),club.api_detail(uuid),club.api_save(uuid,jsonb,jsonb),club.api_review(uuid,text,text,int),club.api_notifications(),club.api_read_notifications(),club.api_users() to authenticated;
revoke all on function public.club_me(),public.club_submissions(),public.club_detail(uuid),public.club_save(uuid,jsonb,jsonb),public.club_review(uuid,text,text,int),public.club_notifications(),public.club_read_notifications(),public.club_users() from public,anon;
grant execute on function public.club_me(),public.club_submissions(),public.club_detail(uuid),public.club_save(uuid,jsonb,jsonb),public.club_review(uuid,text,text,int),public.club_notifications(),public.club_read_notifications(),public.club_users() to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('creatives','creatives',false,26214400,array['image/jpeg','image/png','image/webp','image/gif','application/pdf','video/mp4']);
create function club.file_access(p_path text,p_delete boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active) and
 case when p_delete then split_part(p_path,'/',1)=auth.uid()::text and not exists(select 1 from club.files f where f.path=p_path)
 else split_part(p_path,'/',1)=auth.uid()::text or exists(select 1 from club.files f join club.submissions s on s.id=f.submission_id where f.path=p_path and club.visible(s)) end
$$;
revoke all on function club.file_access(text,boolean) from public,anon;
grant execute on function club.file_access(text,boolean) to authenticated;
create policy creatives_insert on storage.objects for insert to authenticated with check(bucket_id='creatives' and split_part(name,'/',1)=(select auth.uid())::text and club.file_access(name,true));
create policy creatives_read on storage.objects for select to authenticated using(bucket_id='creatives' and club.file_access(name,false));
create policy creatives_cleanup on storage.objects for delete to authenticated using(bucket_id='creatives' and club.file_access(name,true));
