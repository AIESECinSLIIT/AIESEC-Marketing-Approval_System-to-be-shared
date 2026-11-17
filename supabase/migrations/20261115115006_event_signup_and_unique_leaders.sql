-- Events own committee identity; role slots are enforced even under concurrent signup.
alter table club.events add column organization text not null default 'ENTITY' check(organization in ('ENTITY','EXAMPLE_IG'));
create unique index one_committee_vp on club.profiles(role) where deleted_at is null and role in ('MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV');
create unique index one_ocp_per_event on club.profiles(event_id) where deleted_at is null and role='OCP';

create function club.event_profile_scope() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.role='OCP' and new.event_id is null and new.deleted_at is null then raise exception 'Choose an event for the OCP account.'; end if;
 if new.role in ('CREATOR','OCP') and new.event_id is not null then
  select organization into new.organization from club.events where id=new.event_id;
 end if;
 return new;
end $$;
create trigger event_profile_scope before insert or update of role,event_id,organization on club.profiles for each row execute function club.event_profile_scope();
revoke all on function club.event_profile_scope() from public,anon,authenticated;

create or replace function club.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
declare r text:=new.raw_user_meta_data->>'role'; org text:='ENTITY'; eid uuid;
begin
 -- Metadata only selects a low-privilege role at signup. Subsequent metadata
 -- changes never modify authorization stored in club.profiles.
 if r not in ('CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER') or r is null then r:='MARKETING_MEMBER'; end if;
 if r in ('CREATOR','OCP') then
  eid:=nullif(new.raw_user_meta_data->>'eventId','')::uuid;
  select organization into org from club.events where id=eid and active for share;
  if eid is null or org is null then raise exception 'Select an ongoing event created by the admin.'; end if;
 elsif new.raw_user_meta_data->>'organization'='EXAMPLE_IG' then org:='EXAMPLE_IG'; end if;
 insert into club.profiles(id,email,name,role,organization,event_id)
 values(new.id,lower(new.email),left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Member'),100),r,org,eid);
 return new;
end $$;

create or replace function club.api_events(p_all boolean default false) returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if p_all and (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 return jsonb_build_object('events',coalesce((select jsonb_agg(jsonb_build_object('id',e.id,'name',e.name,'active',e.active,'organization',e.organization,
 'ocpAssigned',exists(select 1 from club.profiles p where p.event_id=e.id and p.role='OCP' and p.deleted_at is null)) order by e.name)
 from club.events e where e.active or p_all),'[]'::jsonb));
end $$;
create function club.api_event_scoped(p_id uuid,p_name text,p_active boolean,p_delete boolean,p_organization text) returns jsonb language plpgsql security definer set search_path='' as $$
declare e club.events;
begin
 if (club.me()).role<>'ADMIN' then raise exception 'Administrator access required.' using errcode='42501'; end if;
 if p_id is not null then
  select * into e from club.events where id=p_id for update;
  if e.id is null then raise exception 'Event not found.'; end if;
 end if;
 p_organization:=coalesce(p_organization,e.organization,'ENTITY');
 if p_organization not in ('ENTITY','EXAMPLE_IG') then raise exception 'Choose ENTITY or EXAMPLE_IG.'; end if;
 if p_id is not null and p_organization<>e.organization then raise exception 'An event committee cannot be changed. Create a separate event instead.'; end if;
 if p_delete then
  if exists(select 1 from club.profiles where event_id=p_id) or exists(select 1 from club.submissions where event_id=p_id) then raise exception 'This event has members or submissions. Archive it to keep their history.'; end if;
  delete from club.events where id=p_id;
 elsif length(trim(coalesce(p_name,''))) not between 1 and 120 or p_active is null then raise exception 'Enter an event name and status.';
 elsif p_id is null then insert into club.events(name,active,organization) values(trim(p_name),p_active,p_organization) returning * into e;
 else update club.events set name=trim(p_name),active=p_active where id=p_id returning * into e;
 end if;
 return jsonb_build_object('ok',true,'event',to_jsonb(e));
end $$;
-- Keep the previous four-argument API available to already-open clients.
create or replace function club.api_event(p_id uuid,p_name text,p_active boolean,p_delete boolean default false) returns jsonb language sql security invoker set search_path='' as $$select club.api_event_scoped(p_id,p_name,p_active,p_delete,null)$$;
create function public.club_event(p_id uuid,p_name text,p_active boolean,p_delete boolean,p_organization text) returns jsonb language sql security invoker set search_path='' as $$select club.api_event_scoped(p_id,p_name,p_active,p_delete,p_organization)$$;
revoke all on function club.api_event_scoped(uuid,text,boolean,boolean,text),public.club_event(uuid,text,boolean,boolean,text) from public,anon,authenticated;
grant execute on function club.api_event_scoped(uuid,text,boolean,boolean,text),public.club_event(uuid,text,boolean,boolean,text) to authenticated;


create or replace function public.club_manage_account(p_id uuid,p_name text,p_role text,p_active boolean,p_organization text,p_event uuid,p_email text) returns void language plpgsql security definer set search_path='' as $$
declare target club.profiles; conflict_name text;
begin
 if current_setting('role',true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 lock table club.profiles in share row exclusive mode;
 select * into target from club.profiles where id=p_id and deleted_at is null;
 if target.id is null then raise exception 'Account not found.'; end if;
 if p_role is null or p_role not in ('ADMIN','CREATOR','OCP','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV') or p_active is null or length(trim(coalesce(p_name,''))) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if target.role='ADMIN' and target.active and (p_role<>'ADMIN' or not p_active) and (select count(*) from club.profiles where role='ADMIN' and active and deleted_at is null)<=1 then raise exception 'Keep at least one active administrator.'; end if;
 if p_role in ('CREATOR','OCP') then
  if not (not p_active and p_event is null) and (p_event is null or not exists(select 1 from club.events where id=p_event and (active or target.event_id=p_event))) then raise exception 'Select an ongoing event.'; end if;
  if p_event is not null then select organization into p_organization from club.events where id=p_event; end if;
 else p_event:=null; end if;
 if p_role in ('IGVP_MARKETING','IGVP_OGV') then p_organization:='EXAMPLE_IG'; end if;
 if p_role in ('ADMIN','MARKETING_VP','B2C_VP') then p_organization:='ENTITY'; end if;
 if p_organization is null or p_organization not in ('ENTITY','EXAMPLE_IG') then raise exception 'Choose ENTITY or EXAMPLE_IG.'; end if;
 if p_email is null or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Enter a valid email.'; end if;
 if exists(select 1 from club.profiles p where p.id<>p_id and p.deleted_at is null and p.role=p_role and
 (p_role in ('MARKETING_VP','B2C_VP','IGVP_MARKETING','IGVP_OGV') or (p_role='OCP' and p.event_id=p_event))) then
  raise exception 'An account already holds this role. Edit or delete the existing account first.';
 end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active,organization=p_organization,event_id=p_event,email=lower(trim(p_email)) where id=p_id;
 if not p_active or target.role<>p_role or target.event_id is distinct from p_event or target.organization<>p_organization then
  delete from club.push_subscriptions where user_id=p_id;
 end if;
exception when unique_violation then
 get stacked diagnostics conflict_name=CONSTRAINT_NAME;
 if conflict_name in ('one_committee_vp','one_ocp_per_event') then raise exception 'An account already holds this role. Edit or delete the existing account first.'; else raise; end if;
end $$;

create or replace function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; old_revision int; f jsonb; field text; route_category text := case when u.role in ('B2C_MEMBER','B2C_VP','IGVP_OGV') then 'B2C' else 'MARKETING' end; limits jsonb := '{"title":160,"event":120,"caption":10000,"contentType":50,"platform":50,"notes":3000}'; clean jsonb := '{}'; eid uuid; org text:=u.organization; stage text; event_name text; drive text:=trim(coalesce(p_data->>'externalUrl',''));
begin
 if u.role='OCP' then raise exception 'OCP accounts can only observe their event.' using errcode='42501'; end if;
 if u.role='CREATOR' then
  select id,name,organization into eid,event_name,org from club.events where id=u.event_id and active for share;
  if eid is null then raise exception 'Ask the admin to assign an ongoing event to your account.'; end if;
  p_data:=p_data||jsonb_build_object('event',event_name);
 end if;
 stage:=case when org='EXAMPLE_IG' and u.role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
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
  next_stage:=case when s.organization='EXAMPLE_IG' and s.submitter_role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') then 'IG' else 'LC' end;
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
