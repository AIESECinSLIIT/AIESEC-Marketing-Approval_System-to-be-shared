-- Finalized submissions can release file storage without losing their record.
alter table club.submissions add column cleanup_requested_at timestamptz;
alter table club.submissions add column creatives_deleted_at timestamptz;
create table club.creative_cleanup (
 id uuid primary key default gen_random_uuid(),
 submission_id uuid not null unique references club.submissions(id),
 requested_by uuid not null references club.profiles(id),
 paths text[] not null, file_count integer not null, bytes bigint not null,
 requested_at timestamptz not null default now(), completed_at timestamptz
);
create index creative_cleanup_requester on club.creative_cleanup(requested_by);
alter table club.creative_cleanup enable row level security;
revoke all on club.creative_cleanup from public,anon,authenticated;
grant all on club.creative_cleanup to service_role;

create function club.can_cleanup(s club.submissions) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.profiles u where u.id=auth.uid() and u.active and
 (u.role='ADMIN' or (u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')))
$$;

create or replace function club.serialize(s club.submissions) returns jsonb language sql stable set search_path='' as $$
 select s.data || jsonb_build_object('id',s.id,'creatorId',s.creator_id,'creatorName',u.name,
 'category',s.category,'status',s.status,'revision',s.revision,'version',s.version,
 'createdAt',s.created_at,'updatedAt',s.updated_at,
 'cleanupRequestedAt',s.cleanup_requested_at,'creativesDeletedAt',s.creatives_deleted_at,
 'fileCount',case when s.cleanup_requested_at is null then (select count(*) from club.files f where f.submission_id=s.id and f.revision=s.revision) else 0 end,
 'thumbnailPath',case when s.cleanup_requested_at is null then (select f.path from club.files f where f.submission_id=s.id and f.revision=s.revision and f.mime like 'image/%' limit 1) end)
 from club.profiles u where u.id=s.creator_id
$$;

create or replace function club.api_review(p_id uuid,p_decision text,p_comment text,p_version int) returns jsonb language plpgsql security definer set search_path='' as $$
declare u club.profiles := club.me(); s club.submissions; action text;
begin
 select * into s from club.submissions where id=p_id for update;
 if s.id is null or not club.visible(s) or s.creator_id=u.id or not(u.role='ADMIN' or (u.role='MARKETING_VP' and s.category='MARKETING') or (u.role='B2C_VP' and s.category='B2C')) then raise exception 'You cannot review this submission.' using errcode='42501'; end if;
 if s.cleanup_requested_at is not null then raise exception 'Creative files are being deleted or have been removed. Create a new submission to review new files.'; end if;
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


create function club.api_storage() returns jsonb language plpgsql stable security definer set search_path='' as $$
declare u club.profiles:=club.me(); rows jsonb;
begin
 if u.role not in ('ADMIN','MARKETING_VP','B2C_VP') then raise exception 'Reviewer access required.' using errcode='42501'; end if;
 select coalesce(jsonb_agg(club.serialize(s)||jsonb_build_object('fileCount',f.count,'bytes',f.bytes) order by s.updated_at),'[]'::jsonb)
 into rows from club.submissions s
 cross join lateral (select count(*) as count,coalesce(sum(size),0) as bytes from (select path,max(size) as size from club.files where submission_id=s.id group by path) distinct_files) f
 where s.status in ('APPROVED','REJECTED') and s.creatives_deleted_at is null and club.can_cleanup(s) and f.count>0;
 return jsonb_build_object('submissions',rows,'usedBytes',coalesce((select sum(coalesce(nullif(metadata->>'size',''),'0')::bigint) from storage.objects where bucket_id='creatives'),0));
end $$;

create function club.api_begin_cleanup(p_id uuid,p_version integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); s club.submissions; j club.creative_cleanup;
begin
 select * into s from club.submissions where id=p_id for update;
 if s.id is null or not club.can_cleanup(s) then raise exception 'You cannot delete files for this submission.' using errcode='42501'; end if;
 if s.status not in ('APPROVED','REJECTED') then raise exception 'Only approved or rejected submissions can be cleaned up.'; end if;
 select * into j from club.creative_cleanup where submission_id=p_id;
 if j.id is null then
  if p_version is distinct from s.version then raise exception 'This submission changed. Refresh before deleting files.'; end if;
  insert into club.creative_cleanup(submission_id,requested_by,paths,file_count,bytes)
  select s.id,u.id,array_agg(path order by path),count(*),sum(size)
  from (select path,max(size) as size from club.files where submission_id=s.id group by path) f
  having count(*)>0 returning * into j;
  if j.id is null then raise exception 'There are no creative files to delete.'; end if;
  update club.submissions set cleanup_requested_at=now(),version=version+1 where id=s.id;
  perform club.record(s,'FILES_DELETION_REQUESTED','Delete all creative versions; retain captions, decisions and history.');
 end if;
 return jsonb_build_object('jobId',j.id,'paths',j.paths,'fileCount',j.file_count,'bytes',j.bytes,'completedAt',j.completed_at);
end $$;

-- The Storage API performs the physical deletion under this narrowly scoped policy.
create function club.cleanup_file_access(p_path text) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from club.creative_cleanup j join club.submissions s on s.id=j.submission_id
 where j.completed_at is null and s.status in ('APPROVED','REJECTED') and s.cleanup_requested_at is not null
 and p_path=any(j.paths) and club.can_cleanup(s))
$$;
create policy creatives_reviewed_cleanup on storage.objects for delete to authenticated
 using(bucket_id='creatives' and club.cleanup_file_access(name));

create function club.api_finish_cleanup(p_job uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare u club.profiles:=club.me(); s club.submissions; j club.creative_cleanup;
begin
 select * into j from club.creative_cleanup where id=p_job;
 select * into s from club.submissions where id=j.submission_id for update;
 if s.id is null or not club.can_cleanup(s) then raise exception 'You cannot finish this cleanup.' using errcode='42501'; end if;
 select * into j from club.creative_cleanup where id=p_job for update;
 if j.completed_at is not null then return jsonb_build_object('ok',true,'alreadyDeleted',true,'bytesFreed',0,'filesDeleted',0); end if;
 if s.status not in ('APPROVED','REJECTED') or s.cleanup_requested_at is null then raise exception 'This submission cannot be cleaned up.'; end if;
 if exists(select 1 from storage.objects where bucket_id='creatives' and name=any(j.paths)) then
  raise exception 'Some files remain in storage. Retry cleanup to finish.';
 end if;
 delete from club.files where submission_id=s.id;
 update club.creative_cleanup set completed_at=now() where id=j.id;
 update club.submissions set creatives_deleted_at=now(),version=version+1 where id=s.id;
 perform club.record(s,'CREATIVES_DELETED',j.file_count||' files deleted across all versions. Captions, decisions and history retained.');
 return jsonb_build_object('ok',true,'bytesFreed',j.bytes,'filesDeleted',j.file_count);
end $$;

create function public.club_storage() returns jsonb language sql set search_path='' as $$ select club.api_storage() $$;
create function public.club_begin_cleanup(p_id uuid,p_version integer) returns jsonb language sql set search_path='' as $$ select club.api_begin_cleanup(p_id,p_version) $$;
create function public.club_finish_cleanup(p_job uuid) returns jsonb language sql set search_path='' as $$ select club.api_finish_cleanup(p_job) $$;
revoke all on function club.can_cleanup(club.submissions),club.api_storage(),club.api_begin_cleanup(uuid,integer),
 club.cleanup_file_access(text),club.api_finish_cleanup(uuid),public.club_storage(),public.club_begin_cleanup(uuid,integer),public.club_finish_cleanup(uuid)
 from public,anon,authenticated;
grant execute on function club.can_cleanup(club.submissions),club.api_storage(),club.api_begin_cleanup(uuid,integer),
 club.cleanup_file_access(text),club.api_finish_cleanup(uuid),public.club_storage(),public.club_begin_cleanup(uuid,integer),public.club_finish_cleanup(uuid)
 to authenticated;

