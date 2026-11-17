-- Preserve the cleanup review guard and enforce the database caller role.
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

create or replace function public.club_manage_profile(p_id uuid,p_name text,p_role text,p_active boolean) returns void language plpgsql security definer set search_path='' as $$
begin
 if current_setting('role', true) is distinct from 'service_role' then raise exception 'Service role required.' using errcode='42501'; end if;
 if p_role not in ('CREATOR','MARKETING_MEMBER','B2C_MEMBER','MARKETING_VP','B2C_VP','ADMIN') or p_role is null or p_active is null or length(trim(p_name)) not between 1 and 100 then raise exception 'Invalid account details.'; end if;
 if exists(select 1 from club.profiles where id=p_id and role='ADMIN') and (p_role<>'ADMIN' or not p_active) then raise exception 'Keep the administrator active.'; end if;
 if p_role='ADMIN' and not exists(select 1 from auth.users where id=p_id and lower(email)='admin@your-entity.example' and email_confirmed_at is not null) then raise exception 'Only the verified club email can be administrator.'; end if;
 update club.profiles set name=trim(p_name),role=p_role,active=p_active where id=p_id;
 if not found then raise exception 'Account not found.'; end if;
end $$;
