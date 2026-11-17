-- Role-based routing: submitters no longer choose a category.
create or replace function club.on_signup() returns trigger language plpgsql security definer set search_path='' as $$
declare requested_role text := new.raw_user_meta_data->>'role';
begin
 insert into club.profiles(id,email,name,role)
 values(new.id,lower(new.email),left(coalesce(nullif(trim(new.raw_user_meta_data->>'name'),''),'Member'),100),
   case when requested_role in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER') then requested_role else 'CREATOR' end);
 return new;
end $$;

alter table club.profiles drop constraint if exists profiles_role_check;
alter table club.profiles add constraint profiles_role_check check(role in ('ADMIN','MARKETING_VP','B2C_VP','CREATOR','MARKETING_MEMBER','B2C_MEMBER'));

create or replace function club.visible(s club.submissions) returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and
 (u.id=s.creator_id or u.role='ADMIN' or (s.status<>'DRAFT' and
 ((u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')))))
$$;

create or replace function club.notify_reviewers(s club.submissions) returns void language sql set search_path='' as $$
 insert into club.notifications(user_id,submission_id,title,message)
 select id,s.id,'Ready for review',s.data->>'title' from club.profiles
 where active and id<>s.creator_id and (role='ADMIN' or role=case s.category when 'MARKETING' then 'MARKETING_VP' else 'B2C_VP' end)
$$;

create or replace function club.api_save(p_id uuid,p_data jsonb,p_files jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; old_revision int; f jsonb; field text; route_category text := case when u.role='B2C_MEMBER' then 'B2C' else 'MARKETING' end; limits jsonb := '{"title":160,"event":120,"caption":10000,"contentType":50,"platform":50,"notes":3000}'; clean jsonb := '{}';
begin
 if jsonb_typeof(p_data)<>'object' or jsonb_typeof(p_files)<>'array' or jsonb_array_length(p_files)>8 then raise exception 'Invalid submission.'; end if;
 for field in select jsonb_object_keys(limits) loop
  if length(coalesce(p_data->>field,''))>(limits->>field)::int or (field<>'notes' and length(trim(coalesce(p_data->>field,'')))=0) then raise exception 'Invalid or missing %.',field; end if;
  clean := clean || jsonb_build_object(field,trim(coalesce(p_data->>field,'')));
 end loop;
 if p_data->>'status' is null or p_data->>'status' not in ('DRAFT','PENDING') then raise exception 'Save a draft or submit for review.'; end if;
 clean := clean || jsonb_build_object('scheduledAt',nullif(p_data->>'scheduledAt','')::timestamptz);
 if p_id is not null then
  select * into s from club.submissions where id=p_id for update;
  if s.id is null or s.creator_id<>u.id then raise exception 'Only the creator can edit this submission.' using errcode='42501'; end if;
  if s.status not in ('DRAFT','CHANGES_REQUESTED') then raise exception 'Only drafts or posts needing changes can be edited.'; end if;
  if (p_data->>'version')::int is distinct from s.version then raise exception 'This post changed. Reload before saving.'; end if;
  old_revision := s.revision;
  update club.submissions set data=clean,category=route_category,status=p_data->>'status',revision=revision+1,version=version+1,updated_at=now() where id=p_id returning * into s;
 else
  insert into club.submissions(creator_id,data,category,status) values(u.id,clean,route_category,p_data->>'status') returning * into s;
 end if;
 for f in select value from jsonb_array_elements(p_files) loop
  if f->>'path' is null or split_part(f->>'path','/',1)<>u.id::text or length(f->>'name') not between 1 and 240 or not exists(select 1 from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path' and (o.metadata->>'size')::bigint between 1 and 52428800 and o.metadata->>'mimetype'=f->>'mime') or exists(select 1 from club.files cf where cf.path=f->>'path') then raise exception 'Invalid creative file.'; end if;
  insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,f->>'name',o.metadata->>'mimetype',(o.metadata->>'size')::bigint,o.name from storage.objects o where o.bucket_id='creatives' and o.name=f->>'path';
 end loop;
 if jsonb_array_length(p_files)=0 and old_revision is not null then insert into club.files(submission_id,revision,name,mime,size,path) select s.id,s.revision,name,mime,size,path from club.files where submission_id=s.id and revision=old_revision; end if;
 if s.status='PENDING' and not exists(select 1 from club.files where submission_id=s.id and revision=s.revision) then raise exception 'Attach a creative before submitting.'; end if;
 insert into club.revisions(submission_id,revision,snapshot) values(s.id,s.revision,club.serialize(s));
 perform club.record(s,case when s.status='DRAFT' then 'DRAFT_SAVED' when p_id is null then 'SUBMITTED' else 'RESUBMITTED' end);
 if s.status='PENDING' then perform club.notify_reviewers(s); end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;


create or replace function public.club_manage_profile(p_id uuid,p_name text,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role', true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 if p_role not in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','ADMIN') or p_role is null or p_active is null or length(trim(p_name)) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if exists(select 1 from club.profiles where id=p_id and role='ADMIN') and (p_role<>'ADMIN' or not p_active) then raise exception 'Keep the administrator active.'; end if;
 if p_role='ADMIN' and not exists(select 1 from auth.users where id=p_id and lower(email)='admin@your-entity.example' and email_confirmed_at is not null) then raise exception 'Only the verified club email can be administrator.'; end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active where id=p_id;
 if not found then raise exception 'Account not found.'; end if;
end $$;
