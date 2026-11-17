-- Keep elevated implementations private, matching the rest of the RPC boundary.
alter function public.club_groups(boolean) set schema club;
alter function club.club_groups(boolean) rename to api_groups;
alter function public.club_group(text,text,text,boolean,boolean) set schema club;
alter function club.club_group(text,text,text,boolean,boolean) rename to api_group;
create function public.club_groups(p_all boolean default false) returns jsonb language sql security invoker set search_path='' as $$select club.api_groups(p_all)$$;
create function public.club_group(p_id text,p_name text,p_logo text,p_active boolean,p_delete boolean default false) returns jsonb language sql security invoker set search_path='' as $$select club.api_group(p_id,p_name,p_logo,p_active,p_delete)$$;
revoke all on function public.club_groups(boolean),public.club_group(text,text,text,boolean,boolean) from public,anon,authenticated;
grant execute on function public.club_groups(boolean) to anon,authenticated;
grant execute on function public.club_group(text,text,text,boolean,boolean) to authenticated;
