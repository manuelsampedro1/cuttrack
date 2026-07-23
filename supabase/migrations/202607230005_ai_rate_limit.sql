begin;

create table if not exists public.ai_usage (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);

create index if not exists ai_usage_recent_by_user
  on public.ai_usage(user_id, requested_at desc);

alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from public, anon, authenticated;

create or replace function public.consume_ai_request(p_daily_limit integer default 60)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_count integer;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if p_daily_limit < 1 or p_daily_limit > 200 then raise exception 'invalid limit'; end if;

  perform pg_advisory_xact_lock(hashtext(v_user_id::text));
  delete from public.ai_usage
    where user_id = v_user_id and requested_at < now() - interval '7 days';
  select count(*) into v_count
    from public.ai_usage
    where user_id = v_user_id and requested_at >= now() - interval '24 hours';
  if v_count >= p_daily_limit then return false; end if;

  insert into public.ai_usage(user_id) values (v_user_id);
  return true;
end;
$$;

revoke all on function public.consume_ai_request(integer) from public, anon;
grant execute on function public.consume_ai_request(integer) to authenticated;

commit;
