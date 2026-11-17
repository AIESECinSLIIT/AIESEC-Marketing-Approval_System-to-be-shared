-- One Auth identity can hold multiple independently scoped club profiles.
alter table club.profiles add column auth_user_id uuid;
update club.profiles set auth_user_id=id;
alter table club.profiles alter column auth_user_id set not null;
alter table club.profiles drop constraint profiles_email_key;
create index profiles_auth_user on club.profiles(auth_user_id);
create unique index one_profile_assignment on club.profiles(auth_user_id,role,organization,coalesce(event_id,'00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
create or replace function club.me() returns club.profiles language plpgsql stable security definer set search_path='' as $$
declare u club.profiles; selected uuid;
begin
 selected:=nullif(substring(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-client-info' from 'approval-profile=([0-9a-f-]{36})'),'')::uuid;
 select * into u from club.profiles p where p.auth_user_id=auth.uid() and p.active and p.deleted_at is null
 and (selected is null or p.id=selected) and exists(select 1 from auth.users a where a.id=p.auth_user_id)
 order by (p.id=auth.uid()) desc,p.created_at,p.id limit 1;
 if u.id is null then raise exception 'Choose an active profile for this account.' using errcode='42501'; end if;
 return u;
end $$;
create or replace function club.visible(s club.submissions) returns boolean language sql stable security definer set search_path='' as $$select club.can_view(club.me(),s)$$;
CREATE OR REPLACE FUNCTION club.event_profile_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
 if new.auth_user_id is null then new.auth_user_id:=new.id; end if;
 if new.deleted_at is not null then return new; end if;
 if exists(select 1 from club.profiles where auth_user_id=new.auth_user_id and role='ADMIN' and deleted_at is null) and lower(new.email)='admin@your-entity.example' and new.role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV') then raise exception 'The shared administrator login cannot hold a submission profile.'; end if;
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
end $function$
;
CREATE OR REPLACE FUNCTION club.profile_json(u club.profiles)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select jsonb_build_object('id',u.id,'accountId',u.auth_user_id,'name',u.name,'email',u.email,'role',u.role,'active',u.active,'createdAt',u.created_at,
 'organization',u.organization,'organizationName',case when u.organization='ENTITY' then 'AIESEC in Your Entity' else g.name end,
 'logoPath',g.logo_path,'eventId',u.event_id,'eventName',e.name,'eventActive',e.active)
 from (select 1) x left join club.events e on e.id=u.event_id left join club.initiative_groups g on g.id=u.organization
$function$
;
CREATE OR REPLACE FUNCTION club.serialize(s club.submissions)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select s.data || jsonb_build_object('id',s.id,'creatorId',s.creator_id,'creatorAccountId',u.auth_user_id,'creatorName',u.name,
 'category',s.category,'status',s.status,'revision',s.revision,'version',s.version,
 'organizationLogoPath',(select logo_path from club.initiative_groups where id=s.organization),'organizationName',case when s.organization='ENTITY' then 'AIESEC in Your Entity' else (select name from club.initiative_groups where id=s.organization) end,'organization',s.organization,'eventId',s.event_id,'submitterRole',s.submitter_role,'reviewStage',s.review_stage,
 'createdAt',s.created_at,'updatedAt',s.updated_at,'cleanupRequestedAt',s.cleanup_requested_at,'creativesDeletedAt',s.creatives_deleted_at,
 'fileCount',case when s.cleanup_requested_at is null then (select count(*) from club.files f where f.submission_id=s.id and f.revision=s.revision) else 0 end,
 'thumbnailPath',case when s.cleanup_requested_at is null then (select f.path from club.files f where f.submission_id=s.id and f.revision=s.revision and f.mime like 'image/%' limit 1) end)
 from club.profiles u where u.id=s.creator_id
$function$
;
CREATE OR REPLACE FUNCTION club.api_save(p_id uuid, p_data jsonb, p_files jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  if f->>'path' is null or split_part(f->>'path','/',1)<>u.auth_user_id::text or length(f->>'name') not between 1 and 240 or not exists(select 1 from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path' and (o.metadata->>'size')::bigint between 1 and 52428800 and o.metadata->>'mimetype'=f->>'mime') or exists(select 1 from club.files cf where cf.path=f->>'path') then raise exception 'Invalid creative file.'; end if;
  insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,f->>'name',o.metadata->>'mimetype',(o.metadata->>'size')::bigint,o.name from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path';
 end loop;
 if jsonb_array_length(p_files)=0 and old_revision is not null then insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,name,mime,size,path from club.files where submission_id=s.id and revision=old_revision; end if;
 if s.status='PENDING' and drive='' and not exists(select 1 from club.files where submission_id=s.id and revision=s.revision) then raise exception 'Attach a creative or add a Google Drive video link before submitting.'; end if;
 insert into club.revisions(submission_id,revision,snapshot) values(s.id,s.revision,club.serialize(s));
 perform club.record(s,case when s.status='DRAFT' then 'DRAFT_SAVED' when p_id is null then 'SUBMITTED' else 'RESUBMITTED' end);
 if s.status='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $function$
;
CREATE OR REPLACE FUNCTION club.can_review(u club.profiles, s club.submissions)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
 select club.can_view(u,s) and u.auth_user_id is distinct from (select auth_user_id from club.profiles where id=s.creator_id) and (club.is_super(u) or club.ig_reviewable(u,s) or
 (u.role=club.reviewer_role(s) and s.status='PENDING'))
$function$
;

create or replace function club.on_auth_delete() returns trigger language plpgsql security definer set search_path='' as $$
begin
 update club.profiles set active=false where auth_user_id=old.id;
 delete from club.push_subscriptions where user_id=old.id;
 return old;
end $$;
create function club.sync_identity_email() returns trigger language plpgsql security definer set search_path='' as $$
begin update club.profiles set email=lower(new.email) where auth_user_id=new.id and deleted_at is null; return new; end $$;
create trigger club_identity_email after update of email on auth.users for each row execute function club.sync_identity_email();
create function club.api_profiles() returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if auth.uid() is null or not exists(select 1 from auth.users where id=auth.uid()) then raise exception 'Sign in first.' using errcode='42501'; end if;
 return jsonb_build_object('profiles',coalesce((select jsonb_agg(club.profile_json(p) order by p.created_at,p.id) from club.profiles p where p.auth_user_id=auth.uid() and p.active and p.deleted_at is null),'[]'::jsonb));
end $$;
create function club.api_add_profile(p_role text,p_organization text,p_event uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); p club.profiles; org text:=coalesce(p_organization,'ENTITY');
begin
 if p_role is null or p_role not in ('CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER') then raise exception 'This profile must be appointed by an administrator.' using errcode='42501'; end if;
 if p_role in ('CREATOR','OCP') then select organization into org from club.events where id=p_event and active for share; if org is null then raise exception 'Select an ongoing event.'; end if; else p_event:=null; end if;
 if not club.group_open(org) then raise exception 'Choose an active committee or group.'; end if;
 insert into club.profiles(id,auth_user_id,email,name,role,organization,event_id) values(gen_random_uuid(),u.auth_user_id,u.email,u.name,p_role,org,p_event) returning * into p;
 return jsonb_build_object('profile',club.profile_json(p));
exception when unique_violation then raise exception 'This profile already exists, or this event already has an OCP.';
end $$;
create function public.club_profiles() returns jsonb language sql security invoker set search_path='' as $$select club.api_profiles()$$;
create function public.club_add_profile(p_role text,p_organization text,p_event uuid) returns jsonb language sql security invoker set search_path='' as $$select club.api_add_profile(p_role,p_organization,p_event)$$;
create function public.club_find_account(p_actor uuid,p_email text) returns uuid language plpgsql security definer set search_path='' as $$
declare id uuid;
begin
 if current_setting('role',true) is distinct from 'service_role' or not exists(select 1 from club.profiles where profiles.id=p_actor and active and deleted_at is null and role in ('ADMIN','EM_VP','IGP')) then raise exception 'Management access required.' using errcode='42501'; end if;
 select a.id into id from auth.users a where lower(a.email)=lower(trim(p_email)); return id;
end $$;
create function public.club_add_managed_profile(p_actor uuid,p_account uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid) returns uuid language plpgsql security definer set search_path='' as $$
declare p club.profiles; email text; org text:=p_organization;
begin
 perform public.club_authorize_account(p_actor,null,p_role,p_organization,p_event);
 select a.email into email from auth.users a where a.id=p_account;
 if email is null then raise exception 'Account not found.'; end if;
 if p_role in ('CREATOR','OCP','EVENT_MANAGER') then select organization into org from club.events where id=p_event and active for share; if org is null then raise exception 'Select an ongoing event.'; end if; else p_event:=null; end if;
 if not club.group_open(org) then raise exception 'Choose an active committee or group.'; end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 100 or p_active is null then raise exception 'Enter a name and status.'; end if;
 insert into club.profiles(id,auth_user_id,email,name,role,active,organization,event_id) values(gen_random_uuid(),p_account,lower(email),trim(p_name),p_role,p_active,org,p_event) returning * into p;
 return p.id;
exception when unique_violation then raise exception 'This profile or leadership role already exists.';
end $$;
create function public.club_login_access(p_actor uuid,p_target uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare a club.profiles; t club.profiles;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 select * into a from club.profiles where id=p_actor and active and deleted_at is null;
 select * into t from club.profiles where id=p_target;
 if a.id is null or not club.manages_role(a,t.role,t.organization) then raise exception 'You cannot manage this profile.' using errcode='42501'; end if;
 return jsonb_build_object('accountId',t.auth_user_id,'active',exists(select 1 from club.profiles where auth_user_id=t.auth_user_id and active and deleted_at is null),
 'canManageLogin',not exists(select 1 from club.profiles p where p.auth_user_id=t.auth_user_id and p.deleted_at is null and not club.manages_role(a,p.role,p.organization)));
end $$;
CREATE OR REPLACE FUNCTION public.club_manage_account(p_id uuid, p_name text, p_role text, p_active boolean, p_organization text, p_event uuid, p_email text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
 if not exists(select 1 from club.profiles where auth_user_id=target.auth_user_id and active and deleted_at is null) then delete from club.push_subscriptions where user_id=target.auth_user_id; end if;
exception when unique_violation then
 get stacked diagnostics conflict_name=CONSTRAINT_NAME;
 if conflict_name in ('one_committee_vp','one_ocp_per_event','one_ig_leader','one_profile_assignment') then raise exception 'An account already holds this role. Edit or delete the existing account first.'; else raise; end if;
end $function$
;
CREATE OR REPLACE FUNCTION club.api_group(p_id text, p_name text, p_logo text, p_active boolean, p_delete boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me(); g club.initiative_groups;
begin
 if not (club.is_super(u) or u.role='EM_VP') then raise exception 'LCVP EM or supreme administrator required.' using errcode='42501'; end if;
 if p_id is not null then select * into g from club.initiative_groups where id=p_id and deleted_at is null for update; if g.id is null then raise exception 'Initiative group not found.'; end if; end if;
 if p_delete then
  -- Delete the active directory entry without deleting legitimate submission history.
  update club.initiative_groups set active=false,deleted_at=now() where id=p_id;
  update club.events set active=false where organization=p_id;
  update club.profiles set active=false where organization=p_id and deleted_at is null;
  delete from club.push_subscriptions ps where not exists(select 1 from club.profiles p where p.auth_user_id=ps.user_id and p.active and p.deleted_at is null);
  return jsonb_build_object('ok',true);
 end if;
 if length(trim(coalesce(p_name,''))) not between 1 and 120 or p_active is null then raise exception 'Enter a group name and status.'; end if;
 if p_logo is null or not exists(select 1 from storage.objects where bucket_id='ig-logos' and name=p_logo) or
 (p_logo is distinct from g.logo_path and not club.logo_access(p_logo)) then raise exception 'Upload an initiative group logo (PNG, JPG or WebP).'; end if;
 if p_id is null then insert into club.initiative_groups(name,logo_path,active) values(trim(p_name),p_logo,p_active) returning * into g;
 else update club.initiative_groups set name=trim(p_name),logo_path=p_logo,active=p_active where id=p_id returning * into g; end if;
 return jsonb_build_object('ok',true,'id',g.id);
end $function$
;

create or replace function public.club_delete_account(p_id uuid,p_finish boolean default false) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles; paths jsonb; last_profile boolean;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 lock table club.profiles in share row exclusive mode;
 select * into u from club.profiles where id=p_id;
 if u.id is null then raise exception 'Profile not found.'; end if;
 if u.role='ADMIN' and u.active then raise exception 'Keep the supreme administrator profile active.'; end if;
 last_profile:=not exists(select 1 from club.profiles where auth_user_id=u.auth_user_id and id<>u.id and deleted_at is null);
 update club.profiles set active=false where id=p_id;
 if not exists(select 1 from club.profiles where auth_user_id=u.auth_user_id and active and deleted_at is null) then delete from club.push_subscriptions where user_id=u.auth_user_id; end if;
 update club.submissions set cleanup_requested_at=coalesce(cleanup_requested_at,now()),version=version+1 where creator_id=p_id and cleanup_requested_at is null;
 select coalesce(jsonb_agg(o.name),'[]'::jsonb) into paths from storage.objects o where o.bucket_id='creatives' and
 ((last_profile and split_part(o.name,'/',1)=u.auth_user_id::text) or exists(select 1 from club.files f join club.submissions s on s.id=f.submission_id where f.path=o.name and s.creator_id=p_id));
 if p_finish then
  if jsonb_array_length(paths)>0 or (last_profile and exists(select 1 from auth.users where id=u.auth_user_id)) then raise exception 'Remove this profile’s files and, for its last profile, login access before finishing.'; end if;
  delete from club.files f using club.submissions s where f.submission_id=s.id and s.creator_id=p_id;
  update club.submissions set creatives_deleted_at=coalesce(creatives_deleted_at,now()) where creator_id=p_id;
  update club.profiles set deleted_at=now(),email=p_id::text||'@deleted.invalid' where id=p_id;
 end if;
 return jsonb_build_object('ok',true,'paths',paths,'accountId',u.auth_user_id,'deleteAuth',last_profile);
end $$;
create or replace function club.file_access(p_path text,p_delete boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.auth_user_id=auth.uid() and u.active and u.deleted_at is null and
 case when p_delete then u.role not in ('OCP','EVENT_MANAGER','IGP','EM_VP','ADMIN') and split_part(p_path,'/',1)=u.auth_user_id::text and not exists(select 1 from club.files f where f.path=p_path)
 else exists(select 1 from club.files f join club.submissions s on s.id=f.submission_id where f.path=p_path and club.can_view(u,s)) or
 (u.role not in ('OCP','EVENT_MANAGER','IGP','EM_VP','ADMIN') and split_part(p_path,'/',1)=u.auth_user_id::text and not exists(select 1 from club.files f where f.path=p_path)) end)
$$;
create or replace function club.logo_access(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.auth_user_id=auth.uid() and u.active and u.deleted_at is null and (club.is_super(u) or u.role='EM_VP') and split_part(p_path,'/',1)=u.auth_user_id::text)
$$;
create or replace function club.can_cleanup(s club.submissions) returns boolean language sql stable security definer set search_path='' as $$
 select u.active and (club.is_super(u) or (u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')) from club.me() u
$$;
create or replace function club.cleanup_file_access(p_path text) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.creative_cleanup j join club.submissions s on s.id=j.submission_id cross join club.profiles u
 where j.completed_at is null and s.status in ('APPROVED','REJECTED') and s.cleanup_requested_at is not null and p_path=any(j.paths)
 and u.auth_user_id=auth.uid() and u.active and u.deleted_at is null and (club.is_super(u) or (u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')))
$$;
create or replace function club.notify_workflow(s club.submissions,p_title text,p_message text,p_decision boolean) returns void language sql set search_path='' as $$
 insert into club.notifications(user_id,submission_id,title,message)
 select recipient.id,s.id,p_title,p_message from (
 select distinct on (u.auth_user_id) u.id,u.auth_user_id from club.profiles u where u.active and u.deleted_at is null and club.can_view(u,s) and
 ((p_decision and u.id=s.creator_id) or (u.auth_user_id is distinct from auth.uid() and u.id<>s.creator_id and
 (club.is_super(u) or u.role in ('OCP','EVENT_MANAGER','EM_VP','IGP','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV'))))
 order by u.auth_user_id,(u.id=s.creator_id) desc,(u.role=club.reviewer_role(s)) desc,(u.role in ('OCP','EVENT_MANAGER')) desc,u.created_at,u.id
 ) recipient
$$;
create or replace function club.api_notifications() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin
 return jsonb_build_object('notifications',coalesce((select jsonb_agg(jsonb_build_object('id',n.id,'submissionId',n.submission_id,'profileId',n.user_id,'profileLabel',n.profile_label,'title',n.title,'message',n.message,'createdAt',n.created_at,'readAt',n.read_at) order by n.created_at desc)
 from (select n.*,coalesce(e.name,g.name,'AIESEC in Your Entity') as profile_label from club.notifications n join club.profiles p on p.id=n.user_id left join club.submissions s on s.id=n.submission_id left join club.events e on e.id=p.event_id left join club.initiative_groups g on g.id=p.organization
 where p.auth_user_id=u.auth_user_id and p.active and p.deleted_at is null and (n.submission_id is null or club.can_view(p,s)) order by n.created_at desc limit 200) n),'[]'::jsonb));
end $$;
create or replace function club.api_read_notifications() returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me();
begin update club.notifications set read_at=now() where user_id in(select id from club.profiles where auth_user_id=u.auth_user_id) and read_at is null; return '{"ok":true}'; end $$;
create or replace function club.enqueue_push() returns trigger language plpgsql security definer set search_path='' as $$
begin
 insert into club.push_jobs(subscription_id,notification_id) select ps.id,new.id from club.push_subscriptions ps join club.profiles p on p.id=new.user_id where ps.user_id=p.auth_user_id;
 return new;
end $$;
CREATE OR REPLACE FUNCTION club.api_push_status(p_endpoint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me();
begin
 return jsonb_build_object('publicKey',(select public_key from club.push_settings where singleton),
 'enabled',exists(select 1 from club.push_subscriptions where user_id=u.auth_user_id and endpoint=p_endpoint));
end $function$
;
CREATE OR REPLACE FUNCTION club.api_push_subscribe(p_subscription jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me(); ep text:=p_subscription->>'endpoint'; pk text:=p_subscription->'keys'->>'p256dh'; ak text:=p_subscription->'keys'->>'auth'; owner_id uuid;
begin
 if ep is null or length(ep)>2048 or ep !~ '^https://(fcm[.]googleapis[.]com|web[.]push[.]apple[.]com|updates[.]push[.]services[.]mozilla[.]com|[a-z0-9-]+[.]notify[.]windows[.]com)/[^[:space:]#]+$'
 or pk is null or pk !~ '^[A-Za-z0-9_-]{87}$' or ak is null or ak !~ '^[A-Za-z0-9_-]{22}$' then
  raise exception 'This browser supplied an unsupported push subscription.';
 end if;
 if not exists(select 1 from club.push_settings) then raise exception 'Push notifications are not configured yet.'; end if;
 perform pg_advisory_xact_lock(hashtext(u.auth_user_id::text));
 select user_id into owner_id from club.push_subscriptions where endpoint=ep;
 if owner_id is not null and owner_id<>u.auth_user_id then raise exception 'Turn off notifications for the previous account on this device first.'; end if;
 if owner_id is null and (select count(*) from club.push_subscriptions where user_id=u.auth_user_id)>=10 then raise exception 'You have reached the 10-device limit.'; end if;
 insert into club.push_subscriptions(user_id,endpoint,p256dh,auth) values(u.auth_user_id,ep,pk,ak)
 on conflict(endpoint) do update set p256dh=excluded.p256dh,auth=excluded.auth,updated_at=now()
 where club.push_subscriptions.user_id=u.auth_user_id;
 return jsonb_build_object('ok',true);
end $function$
;
CREATE OR REPLACE FUNCTION club.api_push_unsubscribe(p_endpoint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me();
begin
 delete from club.push_subscriptions where endpoint=p_endpoint and user_id=u.auth_user_id;
 return jsonb_build_object('ok',true);
end $function$
;
CREATE OR REPLACE FUNCTION club.api_push_test(p_endpoint text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me(); sub club.push_subscriptions; nid uuid;
begin
 select * into sub from club.push_subscriptions where user_id=u.auth_user_id and endpoint=p_endpoint for update;
 if sub.id is null then raise exception 'Enable notifications on this device first.'; end if;
 if sub.tested_at>now()-interval '1 minute' then raise exception 'Wait a minute before sending another test.'; end if;
 update club.push_subscriptions set tested_at=now() where id=sub.id;
 insert into club.notifications(user_id,title,message) values(u.id,'Notifications enabled','This is your test notification.') returning id into nid;
 -- A test targets only the current device.
 delete from club.push_jobs where notification_id=nid and subscription_id<>sub.id;
 return jsonb_build_object('ok',true);
end $function$
;
CREATE OR REPLACE FUNCTION club.claim_push()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare result jsonb;
begin
 delete from club.push_jobs where finished_at<now()-interval '1 day';
 -- Suppress stale/read notifications and notifications for revoked access.
 update club.push_jobs j set finished_at=now()
 where j.finished_at is null and ((j.attempts>=5 and j.available_at<=now()) or not exists(
 select 1 from club.push_subscriptions ps join club.notifications n on n.id=j.notification_id join club.profiles p on p.id=n.user_id left join club.submissions s on s.id=n.submission_id
 where ps.id=j.subscription_id and p.active and p.deleted_at is null and p.auth_user_id=ps.user_id and n.read_at is null
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
 'tag',n.id,'url',case when n.submission_id is null then '/?notifications=1&profile='||n.user_id::text else '/?submission='||n.submission_id::text||'&profile='||n.user_id::text end))), '[]'::jsonb)
 into result from claimed j join club.push_subscriptions ps on ps.id=j.subscription_id join club.notifications n on n.id=j.notification_id;
 return result;
end $function$
;

revoke all on function club.sync_identity_email(),club.api_profiles(),club.api_add_profile(text,text,uuid),public.club_profiles(),public.club_add_profile(text,text,uuid),public.club_find_account(uuid,text),public.club_add_managed_profile(uuid,uuid,text,text,boolean,text,uuid),public.club_login_access(uuid,uuid) from public,anon,authenticated;
grant execute on function club.api_profiles(),club.api_add_profile(text,text,uuid),public.club_profiles(),public.club_add_profile(text,text,uuid) to authenticated;
grant execute on function public.club_find_account(uuid,text),public.club_add_managed_profile(uuid,uuid,text,text,boolean,text,uuid),public.club_login_access(uuid,uuid) to service_role;

CREATE OR REPLACE FUNCTION club.api_users()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u club.profiles:=club.me();
begin
 if u.role not in ('ADMIN','EM_VP','IGP') then raise exception 'Account management access required.' using errcode='42501'; end if;
 return jsonb_build_object('users',coalesce((select jsonb_agg(club.profile_json(p)||jsonb_build_object('manageable',club.manages_role(u,p.role,p.organization),'canManageLogin',not exists(select 1 from club.profiles other where other.auth_user_id=p.auth_user_id and other.deleted_at is null and not club.manages_role(u,other.role,other.organization))) order by p.created_at)
 from club.profiles p where p.deleted_at is null and club.manages_org(u,p.organization)),'[]'::jsonb));
end $function$
;
