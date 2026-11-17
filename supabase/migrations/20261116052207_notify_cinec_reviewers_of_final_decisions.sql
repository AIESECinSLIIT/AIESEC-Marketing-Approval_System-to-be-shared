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
 where p.active and p.deleted_at is null and (p.id=s.creator_id or (p.role='OCP' and club.can_view(p,s)) or
  (s.organization='EXAMPLE_IG' and p.id<>u.id and p.role=case when s.category='B2C' then 'IGVP_OGV' else 'IGVP_MARKETING' end and club.can_view(p,s)
   and not(next_status='PENDING' and p.role=club.reviewer_role(s))));
 if next_status='PENDING' then
  -- The OCP already received the decision above. Only alert the next reviewers here.
  insert into club.notifications(user_id,submission_id,title,message)
  select p.id,s.id,'Ready for review',s.data->>'title' from club.profiles p
  where p.active and p.deleted_at is null and p.id<>s.creator_id and
   (p.role='ADMIN' or (p.role=club.reviewer_role(s) and club.can_view(p,s)));
 end if;
 return jsonb_build_object('submission',club.serialize(s));
end $$;
