-- Dynamic initiative groups, scoped management and event leadership.
create table club.initiative_groups (
 id text primary key default gen_random_uuid()::text,
 name text not null check(length(trim(name)) between 1 and 120),
 logo_path text not null, active boolean not null default true,
 deleted_at timestamptz, created_at timestamptz not null default now()
);
create unique index initiative_group_name on club.initiative_groups(lower(name)) where deleted_at is null;
alter table club.initiative_groups enable row level security;
revoke all on club.initiative_groups from public,anon,authenticated;
grant all on club.initiative_groups to service_role;
alter table club.profiles drop constraint profiles_organization_check;
alter table club.events drop constraint events_organization_check;
alter table club.submissions drop constraint submissions_organization_check;
alter table club.profiles drop constraint profiles_role_check;
alter table club.profiles add constraint profiles_role_check check(role in ('ADMIN','EM_VP','IGP','EVENT_MANAGER','MARKETING_VP','B2C_VP','CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER','IGVP_MARKETING','IGVP_OGV'));
drop index club.one_committee_vp;
create unique index one_committee_vp on club.profiles(role) where deleted_at is null and role in ('ADMIN','EM_VP','MARKETING_VP','B2C_VP');
create unique index one_ig_leader on club.profiles(organization,role) where deleted_at is null and role in ('IGP','IGVP_MARKETING','IGVP_OGV');
drop index club.events_name_unique;
create unique index events_name_unique on club.events(organization,lower(name));
create index profiles_organization_role on club.profiles(organization,role) where deleted_at is null;
-- No hardcoded initiative groups are seeded. Existing ENTITY work is unchanged.
create function club.is_super(u club.profiles) returns boolean language sql immutable set search_path='' as $$
 select u.role='ADMIN' and lower(u.email)='admin@your-entity.example' and u.active and u.deleted_at is null
$$;
create function club.group_open(org text) returns boolean language sql stable security definer set search_path='' as $$
 select org='ENTITY' or exists(select 1 from club.initiative_groups where id=org and active and deleted_at is null)
$$;
create function club.manages_org(u club.profiles,org text) returns boolean language sql stable set search_path='' as $$
 select u.active and u.deleted_at is null and (club.is_super(u) or (org<>'ENTITY' and (u.role='EM_VP' or (u.role='IGP' and u.organization=org))))
$$;
create function club.manages_role(u club.profiles,r text,org text) returns boolean language sql stable set search_path='' as $$
 select club.manages_org(u,org) and (club.is_super(u) or
 (u.role='EM_VP' and r in ('IGP','IGVP_MARKETING','IGVP_OGV','EVENT_MANAGER','OCP','CREATOR','MARKETING_MEMBER','B2C_MEMBER')) or
 (u.role='IGP' and r in ('IGVP_MARKETING','IGVP_OGV','EVENT_MANAGER')))
$$;
create or replace function club.event_profile_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.deleted_at is not null then return new; end if;
 if new.role in ('OCP','EVENT_MANAGER') and new.event_id is null then raise exception 'Select an event for this account.'; end if;
 if new.role in ('CREATOR','OCP','EVENT_MANAGER') and new.event_id is not null then
  -- Serializes concurrent registrations/appointments for the same event.
  perform pg_advisory_xact_lock(hashtextextended(new.event_id::text,0));
  select organization into new.organization from club.events where id=new.event_id;
  if new.role='EVENT_MANAGER' and (select count(*) from club.profiles where event_id=new.event_id and role='EVENT_MANAGER' and deleted_at is null and id<>new.id)>=3 then raise exception 'This event already has three Event Managers.'; end if;
 elsif new.role not in ('CREATOR','OCP','EVENT_MANAGER') then new.event_id:=null;
 end if;
 if new.role in ('ADMIN','EM_VP','MARKETING_VP','B2C_VP') then new.organization:='ENTITY'; end if;
 if new.role='ADMIN' and lower(new.email)<>'admin@your-entity.example' then raise exception 'Only the club administrator email can hold supreme access.'; end if;
 if new.role in ('IGP','IGVP_MARKETING','IGVP_OGV') and new.organization='ENTITY' then raise exception 'Choose an initiative group.'; end if;
 if new.organization<>'ENTITY' and not exists(select 1 from club.initiative_groups where id=new.organization and deleted_at is null) then raise exception 'Initiative group not found.'; end if;
 return new;
end $$;
drop trigger event_profile_scope on club.profiles;
create trigger event_profile_scope before insert or update of role,event_id,organization,email on club.profiles for each row execute function club.event_profile_scope();
create or replace function club.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
declare r text:=new.raw_user_meta_data->>'role'; org text:=coalesce(nullif(new.raw_user_meta_data->>'organization',''),'ENTITY'); eid uuid;
begin
 if r not in ('CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER') or r is null then r:='MARKETING_MEMBER'; end if;
 if r in ('CREATOR','OCP') then
  eid:=nullif(new.raw_user_meta_data->>'eventId','')::uuid;
  select organization into org from club.events where id=eid and active for share;
  if eid is null or org is null then raise exception 'Select an ongoing event.'; end if;
 end if;
 if not club.group_open(org) then raise exception 'Choose an active initiative group.'; end if;
 insert into club.profiles(id,email,name,role,organization,event_id)
 values(new.id,lower(new.email),left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Member'),100),r,org,eid);
 return new;
end $$;
create or replace function club.profile_json(u club.profiles) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',u.id,'name',u.name,'email',u.email,'role',u.role,'active',u.active,'createdAt',u.created_at,
 'organization',u.organization,'organizationName',case when u.organization='ENTITY' then 'AIESEC in Your Entity' else g.name end,
 'logoPath',g.logo_path,'eventId',u.event_id,'eventName',e.name,'eventActive',e.active)
 from (select 1) x left join club.events e on e.id=u.event_id left join club.initiative_groups g on g.id=u.organization
$$;
create or replace function club.can_view(u club.profiles,s club.submissions) returns boolean language sql stable set search_path='' as $$
 select coalesce(u.active and u.deleted_at is null and case
 when u.role in ('OCP','EVENT_MANAGER') then u.event_id is not null and u.event_id=s.event_id and u.organization=s.organization and s.submitter_role='CREATOR' and s.status<>'DRAFT'
 else u.id=s.creator_id or club.is_super(u) or (s.status<>'DRAFT' and
 ((u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C') or
 (s.organization<>'ENTITY' and (u.role='EM_VP' or (u.organization=s.organization and
 (u.role='IGP' or (u.role='IGVP_MARKETING' and s.category='MARKETING') or (u.role='IGVP_OGV' and s.category='B2C'))))))) end,false)
$$;
create function club.ig_reviewable(u club.profiles,s club.submissions) returns boolean language sql stable set search_path='' as $$
 select s.organization<>'ENTITY' and (u.role='EM_VP' or (u.role='IGP' and u.organization=s.organization)) and
 (s.review_stage='IG' or (s.review_stage='LC' and s.status='PENDING' and s.submitter_role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER')))
$$;
create function club.can_review(u club.profiles,s club.submissions) returns boolean language sql stable set search_path='' as $$
 select club.can_view(u,s) and u.id<>s.creator_id and (club.is_super(u) or club.ig_reviewable(u,s) or
 (u.role=club.reviewer_role(s) and s.status='PENDING'))
$$;
create or replace function club.api_users() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin
 if u.role not in ('ADMIN','EM_VP','IGP') then raise exception 'Account management access required.' using errcode='42501'; end if;
 return jsonb_build_object('users',coalesce((select jsonb_agg(club.profile_json(p)||jsonb_build_object('manageable',club.manages_role(u,p.role,p.organization)) order by p.created_at)
 from club.profiles p where p.deleted_at is null and club.manages_org(u,p.organization)),'[]'::jsonb));
end $$;
create or replace function club.api_events(p_all boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles;
begin
 if p_all then u:=club.me(); if u.role not in ('ADMIN','EM_VP','IGP') then raise exception 'Event management access required.' using errcode='42501'; end if; end if;
 return jsonb_build_object('events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'active',e.active,'organization',e.organization,
 'organizationName',case when e.organization='ENTITY' then 'AIESEC in Your Entity' else g.name end,
 'ocpAssigned',exists(select 1 from club.profiles p where p.event_id=e.id and p.role='OCP' and p.deleted_at is null),
 'managerCount',(select count(*) from club.profiles p where p.event_id=e.id and p.role='EVENT_MANAGER' and p.deleted_at is null)) order by e.name)
 from club.events e left join club.initiative_groups g on g.id=e.organization
 where (p_all and club.manages_org(u,e.organization)) or (not p_all and e.active and club.group_open(e.organization))),'[]'::jsonb));
end $$;
create or replace function club.api_event_scoped(p_id uuid,p_name text,p_active boolean,p_delete boolean,p_organization text) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); e club.events;
begin
 if p_id is not null then select * into e from club.events where id=p_id for update; if e.id is null then raise exception 'Event not found.'; end if; end if;
 p_organization:=coalesce(p_organization,e.organization,'ENTITY');
 if not club.manages_org(u,p_organization) or (p_id is not null and not club.manages_org(u,e.organization)) then raise exception 'You cannot manage this event.' using errcode='42501'; end if;
 if p_id is not null and p_organization<>e.organization then raise exception 'Create a separate event to change its committee.'; end if;
 if p_delete then
  if exists(select 1 from club.profiles where event_id=p_id and deleted_at is null) or exists(select 1 from club.submissions where event_id=p_id) then raise exception 'This event has accounts or submissions. Archive it to preserve their history.'; end if;
  update club.profiles set event_id=null where event_id=p_id and deleted_at is not null;
  delete from club.events where id=p_id;
 elsif not club.group_open(p_organization) then raise exception 'Choose an active initiative group.';
 elsif length(trim(coalesce(p_name,''))) not between 1 and 120 or p_active is null then raise exception 'Enter an event name and status.';
 elsif p_id is null then insert into club.events(name,active,organization) values(trim(p_name),p_active,p_organization) returning * into e;
 else update club.events set name=trim(p_name),active=p_active where id=p_id returning * into e;
 end if;
 return jsonb_build_object('ok',true,'event',to_jsonb(e));
end $$;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('ig-logos','ig-logos',true,2097152,array['image/png','image/jpeg','image/webp']) on conflict(id) do nothing;
create function club.logo_access(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and u.deleted_at is null and (club.is_super(u) or u.role='EM_VP') and split_part(p_path,'/',1)=u.id::text)
$$;
create policy ig_logo_insert on storage.objects for insert to authenticated with check(bucket_id='ig-logos' and club.logo_access(name));
create policy ig_logo_delete on storage.objects for delete to authenticated using(bucket_id='ig-logos' and club.logo_access(name) and not exists(select 1 from club.initiative_groups where logo_path=name));
-- Logo deletion is exposed through a guarded helper, keeping private tables inaccessible.
drop policy ig_logo_delete on storage.objects;
create function club.logo_unused(p_path text) returns boolean language sql stable security definer set search_path='' as $$select club.logo_access(p_path) and not exists(select 1 from club.initiative_groups where logo_path=p_path)$$;
create policy ig_logo_delete on storage.objects for delete to authenticated using(bucket_id='ig-logos' and club.logo_unused(name));
create function public.club_groups(p_all boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles;
begin
 if p_all then u:=club.me(); if u.role not in ('ADMIN','EM_VP','IGP') then raise exception 'Management access required.' using errcode='42501'; end if; end if;
 return jsonb_build_object('groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'logoPath',g.logo_path,'active',g.active) order by g.name)
 from club.initiative_groups g where g.deleted_at is null and ((not p_all and g.active) or (p_all and club.manages_org(u,g.id)))),'[]'::jsonb));
end $$;
create function public.club_group(p_id text,p_name text,p_logo text,p_active boolean,p_delete boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); g club.initiative_groups;
begin
 if not (club.is_super(u) or u.role='EM_VP') then raise exception 'LCVP EM or supreme administrator required.' using errcode='42501'; end if;
 if p_id is not null then select * into g from club.initiative_groups where id=p_id and deleted_at is null for update; if g.id is null then raise exception 'Initiative group not found.'; end if; end if;
 if p_delete then
  -- Delete the active directory entry without deleting legitimate submission history.
  update club.initiative_groups set active=false,deleted_at=now() where id=p_id;
  update club.events set active=false where organization=p_id;
  update club.profiles set active=false where organization=p_id and deleted_at is null;
  delete from club.push_subscriptions where user_id in(select id from club.profiles where organization=p_id);
  return jsonb_build_object('ok',true);
 end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 120 or p_active is null then raise exception 'Enter a group name and status.'; end if;
 if p_logo is null or not exists(select 1 from storage.objects where bucket_id='ig-logos' and name=p_logo) or
 (p_logo is distinct from g.logo_path and not club.logo_access(p_logo)) then raise exception 'Upload an initiative group logo (PNG, JPG or WebP).'; end if;
 if p_id is null then insert into club.initiative_groups(name,logo_path,active) values(trim(p_name),p_logo,p_active) returning * into g;
 else update club.initiative_groups set name=trim(p_name),logo_path=p_logo,active=p_active where id=p_id returning * into g; end if;
 return jsonb_build_object('ok',true,'id',g.id);
end $$;
create or replace function club.serialize(s club.submissions) returns jsonb language sql stable set search_path='' as $$
 select s.data || jsonb_build_object('id',s.id,'creatorId',s.creator_id,'creatorName',u.name,
 'category',s.category,'status',s.status,'revision',s.revision,'version',s.version,
 'organizationName',case when s.organization='ENTITY' then 'AIESEC in Your Entity' else (select name from club.initiative_groups where id=s.organization) end,'organization',s.organization,'eventId',s.event_id,'submitterRole',s.submitter_role,'reviewStage',s.review_stage,
 'createdAt',s.created_at,'updatedAt',s.updated_at,'cleanupRequestedAt',s.cleanup_requested_at,'creativesDeletedAt',s.creatives_deleted_at,
 'fileCount',case when s.cleanup_requested_at is null then (select count(*) from club.files f where f.submission_id=s.id and f.revision=s.revision) else 0 end,
 'thumbnailPath',case when s.cleanup_requested_at is null then (select f.path from club.files f where f.submission_id=s.id and f.revision=s.revision and f.mime like 'image/%' limit 1) end)
 from club.profiles u where u.id=s.creator_id
$$;
create or replace function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; old_revision int; f jsonb; field text; route_category text := case when u.role in ('B2C_MEMBER','B2C_VP','IGVP_OGV') then 'B2C' else 'MARKETING' end; limits jsonb := '{"title":160,"event":120,"caption":10000,"contentType":50,"platform":50,"notes":3000}'; clean jsonb := '{}'; eid uuid; org text:=u.organization; stage text; event_name text; drive text:=trim(coalesce(p_data->>'externalUrl',''));
begin
 if u.role in ('ADMIN','OCP','EVENT_MANAGER','EM_VP','IGP') then raise exception 'This account cannot submit creatives.' using errcode='42501'; end if;
 if not club.group_open(org) then raise exception 'This initiative group is inactive.'; end if;
 if u.role='CREATOR' then
  select id,name,organization into eid,event_name,org from club.events where id=u.event_id and active for share;
  if eid is null then raise exception 'Ask the admin to assign an ongoing event to your account.'; end if;
  p_data:=p_data||jsonb_build_object('event',event_name);
 end if;
 stage:=case when org<>'ENTITY' and u.role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
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

create or replace function public.club_manage_account(p_id uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
declare target club.profiles; conflict_name text;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 lock table club.profiles in share row exclusive mode;
 select * into target from club.profiles where id=p_id and deleted_at is null;
 if target.id is null then raise exception 'Account not found.'; end if;
 if p_role is null or p_role not in ('ADMIN','EM_VP','IGP','EVENT_MANAGER','CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV') or p_active is null or length(trim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if target.role='ADMIN' and lower(p_email)<>lower(target.email) then raise exception 'The supreme administrator email cannot be changed here.'; end if;
 if target.role='ADMIN' and target.active and (p_role<>'ADMIN' or not p_active) and (select count(*) from club.profiles where role='ADMIN' and active and deleted_at is null)<=1 then raise exception 'Keep at least one active administrator.'; end if;
 if p_role in ('CREATOR','OCP','EVENT_MANAGER') then
  if not (not p_active and p_event is null) and (p_event is null or not exists(select 1 from club.events where id=p_event and (active or target.event_id=p_event))) then raise exception 'Select an ongoing event.'; end if;
  if p_event is not null then select organization into p_organization from club.events where id=p_event; end if;
 else p_event:=null; end if;

 if p_role in ('ADMIN','EM_VP','MARKETING_VP','B2C_VP') then p_organization:='ENTITY'; end if;
 if p_organization is null or not club.group_open(p_organization) then raise exception 'Choose an active committee or initiative group.'; end if;
 if p_email is null or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Enter a valid email.'; end if;
 if exists(select 1 from club.profiles p where p.id<>p_id and p.deleted_at is null and p.role=p_role and
 (p_role in ('ADMIN','EM_VP','MARKETING_VP','B2C_VP') or (p_role in ('IGP','IGVP_MARKETING','IGVP_OGV') and p.organization=p_organization) or (p_role='OCP' and p.event_id=p_event))) then
  raise exception 'An account already holds this role. Edit or delete the existing account first.';
 end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active,organization=p_organization,event_id=p_event,email=lower(trim(p_email)) where id=p_id;
 if not p_active or target.role<>p_role or target.event_id is distinct from p_event or target.organization<>p_organization then
  delete from club.push_subscriptions where user_id=p_id;
 end if;
exception when unique_violation then
 get stacked diagnostics conflict_name=CONSTRAINT_NAME;
 if conflict_name in ('one_committee_vp','one_ocp_per_event','one_ig_leader') then raise exception 'An account already holds this role. Edit or delete the existing account first.'; else raise; end if;
end $$;


create function public.club_authorize_account(p_actor uuid,p_target uuid,p_role text,p_organization text,p_event uuid) returns boolean language plpgsql security definer set search_path='' as $$
declare a club.profiles; t club.profiles; org text:=p_organization;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 select * into a from club.profiles where id=p_actor and active and deleted_at is null;
 if a.id is null then raise exception 'Management access required.' using errcode='42501'; end if;
 if p_target is not null then select * into t from club.profiles where id=p_target and deleted_at is null; if t.id is null or not club.manages_role(a,t.role,t.organization) then raise exception 'You cannot manage this account.' using errcode='42501'; end if; end if;
 if p_event is not null then select organization into org from club.events where id=p_event; end if;
 if not club.manages_role(a,p_role,org) then raise exception 'You cannot assign this role or committee.' using errcode='42501'; end if;
 return true;
end $$;
create function public.club_administer_account(p_actor uuid,p_id uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.club_authorize_account(p_actor,p_id,p_role,p_organization,p_event);
 perform public.club_manage_account(p_id,p_name,p_role,p_active,p_organization,p_event,p_email);
end $$;
create function public.club_remove_account(p_actor uuid,p_id uuid,p_finish boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare t club.profiles;
begin
 select * into t from club.profiles where id=p_id;
 perform public.club_authorize_account(p_actor,p_id,t.role,t.organization,t.event_id);
 return public.club_delete_account(p_id,p_finish);
end $$;
-- One notification per recipient per action; device jobs are generated by the existing trigger.
create function club.notify_workflow(s club.submissions,p_title text,p_message text,p_decision boolean) returns void language sql set search_path='' as $$
 insert into club.notifications(user_id,submission_id,title,message)
 select u.id,s.id,p_title,p_message from club.profiles u where u.active and u.deleted_at is null and club.can_view(u,s) and
 ((p_decision and u.id=s.creator_id) or (u.id<>auth.uid() and u.id<>s.creator_id and
 (club.is_super(u) or u.role in ('OCP','EVENT_MANAGER','EM_VP','IGP','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV'))))
$$;
create or replace function club.notify_reviewers(s club.submissions) returns void language sql set search_path='' as $$
 select club.notify_workflow(s,case when s.review_stage='IG' then 'Submitted · awaiting IG approval' else 'Submitted · awaiting ENTITY approval' end,
 (s.data->>'title')||' — '||coalesce((select name from club.profiles where id=s.creator_id),'Member'),false)
$$;
create table club.override_authorizations (
 id uuid primary key default gen_random_uuid(),actor_id uuid not null,submission_id uuid not null,
 version int not null,decision text not null,expires_at timestamptz not null default now()+interval '60 seconds'
);
alter table club.override_authorizations enable row level security;
revoke all on club.override_authorizations from public,anon,authenticated;
grant all on club.override_authorizations to service_role;
create function public.club_authorize_override(p_actor uuid,p_id uuid,p_version int,p_decision text) returns uuid language plpgsql security definer set search_path='' as $$
declare proof uuid;
begin
 if current_setting('role',true) is distinct from 'service_role' or not exists(select 1 from club.profiles where id=p_actor and club.is_super(profiles)) then raise exception 'Supreme administrator required.' using errcode='42501'; end if;
 delete from club.override_authorizations where expires_at<now();
 insert into club.override_authorizations(actor_id,submission_id,version,decision) values(p_actor,p_id,p_version,p_decision) returning id into proof;
 return proof;
end $$;
create function club.review_scoped(p_id uuid,p_decision text,p_comment text,p_version int,p_proof uuid default null) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); s club.submissions; action text; next_status text; next_stage text; title text; proof uuid; ig_override boolean;
begin
 select * into s from club.submissions where id=p_id for update;
 if s.id is null or not club.can_review(u,s) then raise exception 'You cannot review this stage of the submission.' using errcode='42501'; end if;
 if s.cleanup_requested_at is not null then raise exception 'Creative files have been removed.'; end if;
 if s.status='DRAFT' or p_version is distinct from s.version then raise exception 'This post changed. Reload before reviewing.'; end if;
 if p_decision is null or p_decision not in ('APPROVED','CHANGES_REQUESTED','REJECTED','PENDING') or p_decision=s.status or (p_decision='PENDING' and not club.is_super(u)) then raise exception 'Invalid decision.'; end if;
 if club.is_super(u) and s.status<>'PENDING' then
  delete from club.override_authorizations where id=p_proof and actor_id=u.id and submission_id=s.id and version=s.version and decision=p_decision and expires_at>now() returning id into proof;
  if proof is null then raise exception 'Confirm your administrator password to override this decision.' using errcode='42501'; end if;
 end if;
 p_comment:=trim(coalesce(p_comment,''));
 ig_override:=club.ig_reviewable(u,s);
 if length(p_comment)>5000 or ((p_decision<>'APPROVED' or s.status<>'PENDING' or (ig_override and s.review_stage='LC')) and length(p_comment)=0) then raise exception 'Please provide feedback for this decision.'; end if;
 next_status:=p_decision; next_stage:=s.review_stage;
 action:=case when s.status='PENDING' then p_decision else 'OVERRIDE_'||p_decision end;
 if p_decision='APPROVED' and (s.review_stage='IG' or ig_override) then
  next_status:='PENDING'; next_stage:='LC'; action:='IG_APPROVED';
 elsif ig_override then next_stage:='IG'; action:='IG_OVERRIDE_'||p_decision;
 elsif p_decision='PENDING' then next_stage:=case when s.organization<>'ENTITY' and s.submitter_role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
 end if;
 update club.submissions set status=next_status,review_stage=next_stage,version=version+1,updated_at=now() where id=p_id returning * into s;
 perform club.record(s,action,p_comment);
 title:=case when action='IG_APPROVED' then 'IG approved · awaiting ENTITY approval' when p_decision='CHANGES_REQUESTED' then 'Changes requested' when p_decision='APPROVED' then 'Final approval received' when p_decision='REJECTED' then 'Submission rejected' else 'Submission reopened' end;
 perform club.notify_workflow(s,title,(s.data->>'title')||' — '||u.name||case when p_comment='' then '' else ': '||p_comment end,true);
 return jsonb_build_object('submission',club.serialize(s));
end $$;
create or replace function club.api_review(p_id uuid,p_decision text,p_comment text,p_version int) returns jsonb language sql security invoker set search_path='' as $$select club.review_scoped(p_id,p_decision,p_comment,p_version,null)$$;
create function public.club_review_verified(p_id uuid,p_decision text,p_comment text,p_version int,p_proof uuid) returns jsonb language sql security invoker set search_path='' as $$select club.review_scoped(p_id,p_decision,p_comment,p_version,p_proof)$$;
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
 'payload',jsonb_build_object('title',left(n.title,100),
 'body',left(n.message,240),
 'tag',n.id,'url',case when n.submission_id is null then '/?notifications=1' else '/?submission='||n.submission_id::text end))), '[]'::jsonb)
 into result from claimed j join club.push_subscriptions ps on ps.id=j.subscription_id join club.notifications n on n.id=j.notification_id;
 return result;
end $$;
create or replace function club.file_access(p_path text,p_delete boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and u.deleted_at is null and
 case when p_delete then u.role not in ('OCP','EVENT_MANAGER','IGP','EM_VP','ADMIN') and split_part(p_path,'/',1)=u.id::text and not exists(select 1 from club.files f where f.path=p_path)
 else exists(select 1 from club.files f join club.submissions s on s.id=f.submission_id where f.path=p_path and club.can_view(u,s)) or
 (u.role not in ('OCP','EVENT_MANAGER','IGP','EM_VP','ADMIN') and split_part(p_path,'/',1)=u.id::text and not exists(select 1 from club.files f where f.path=p_path)) end)
$$;

-- Default deny for every newly introduced function.
revoke all on function club.is_super(club.profiles),club.group_open(text),club.manages_org(club.profiles,text),club.manages_role(club.profiles,text,text),club.ig_reviewable(club.profiles,club.submissions),club.can_review(club.profiles,club.submissions),club.logo_access(text),club.logo_unused(text),club.notify_workflow(club.submissions,text,text,boolean),club.review_scoped(uuid,text,text,int,uuid),public.club_groups(boolean),public.club_group(text,text,text,boolean,boolean),public.club_authorize_account(uuid,uuid,text,text,uuid),public.club_administer_account(uuid,uuid,text,text,boolean,text,uuid,text),public.club_remove_account(uuid,uuid,boolean),public.club_authorize_override(uuid,uuid,int,text),public.club_review_verified(uuid,text,text,int,uuid) from public,anon,authenticated;
grant execute on function public.club_groups(boolean) to anon,authenticated;
grant execute on function club.logo_access(text),club.logo_unused(text),club.review_scoped(uuid,text,text,int,uuid),public.club_review_verified(uuid,text,text,int,uuid),public.club_group(text,text,text,boolean,boolean) to authenticated;
grant execute on function public.club_authorize_account(uuid,uuid,text,text,uuid),public.club_administer_account(uuid,uuid,text,text,boolean,text,uuid,text),public.club_remove_account(uuid,uuid,boolean),public.club_authorize_override(uuid,uuid,int,text) to service_role;

create function public.club_appoint_account(p_actor uuid,p_id uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.club_authorize_account(p_actor,null,p_role,p_organization,p_event);
 if not exists(select 1 from club.profiles where id=p_id and role='MARKETING_MEMBER' and created_at>now()-interval '2 minutes' and organization=p_organization) then raise exception 'Invalid new account.'; end if;
 perform public.club_manage_account(p_id,p_name,p_role,p_active,p_organization,p_event,p_email);
end $$;
revoke all on function public.club_appoint_account(uuid,uuid,text,text,boolean,text,uuid,text) from public,anon,authenticated;
grant execute on function public.club_appoint_account(uuid,uuid,text,text,boolean,text,uuid,text) to service_role;
