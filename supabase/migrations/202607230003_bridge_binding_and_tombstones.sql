begin;

alter table public.nutrition_days
  add column if not exists deleted_at timestamptz;

create table if not exists public.devices (
  device_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  health_bridge_enabled boolean not null default true,
  consent_version integer not null,
  bound_at timestamptz not null default now(),
  revoked_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists one_active_health_bridge_per_user
  on public.devices(user_id)
  where health_bridge_enabled = true and revoked_at is null;

create table if not exists public.consents (
  user_id uuid not null references auth.users(id) on delete cascade,
  purpose text not null,
  consent_version integer not null,
  data_types text[] not null,
  accepted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (user_id, purpose, consent_version)
);

alter table public.health_days add column if not exists device_id uuid references public.devices(device_id);
alter table public.workouts add column if not exists device_id uuid references public.devices(device_id);
alter table public.health_days drop column if exists source_device;

alter table public.devices enable row level security;
alter table public.consents enable row level security;

drop policy if exists "profiles_owner_all" on public.profiles;
drop policy if exists "nutrition_owner_all" on public.nutrition_days;
drop policy if exists "health_owner_all" on public.health_days;
drop policy if exists "workouts_owner_all" on public.workouts;
drop policy if exists "sync_status_owner_all" on public.sync_status;
drop policy if exists "profiles_owner_select" on public.profiles;
drop policy if exists "profiles_owner_insert" on public.profiles;
drop policy if exists "profiles_owner_update" on public.profiles;
drop policy if exists "nutrition_owner_select" on public.nutrition_days;
drop policy if exists "nutrition_owner_insert" on public.nutrition_days;
drop policy if exists "nutrition_owner_update" on public.nutrition_days;
drop policy if exists "health_owner_select" on public.health_days;
drop policy if exists "workouts_owner_select" on public.workouts;
drop policy if exists "sync_status_owner_select" on public.sync_status;
drop policy if exists "devices_owner_select" on public.devices;
drop policy if exists "consents_owner_select" on public.consents;

create policy "profiles_owner_select" on public.profiles for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "profiles_owner_insert" on public.profiles for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "profiles_owner_update" on public.profiles for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "nutrition_owner_select" on public.nutrition_days for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "nutrition_owner_insert" on public.nutrition_days for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "nutrition_owner_update" on public.nutrition_days for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "health_owner_select" on public.health_days for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "workouts_owner_select" on public.workouts for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "sync_status_owner_select" on public.sync_status for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "devices_owner_select" on public.devices for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "consents_owner_select" on public.consents for select to authenticated
  using ((select auth.uid()) = user_id);

revoke all on public.profiles, public.nutrition_days, public.health_days, public.workouts,
  public.sync_status, public.devices, public.consents from anon, authenticated;
grant select, insert, update on public.profiles, public.nutrition_days to authenticated;
grant select on public.health_days, public.workouts, public.sync_status, public.devices, public.consents to authenticated;

create or replace function public.bind_health_bridge(p_device_id uuid, p_consent_version integer default 1)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if exists (
    select 1 from public.devices
    where device_id = p_device_id and user_id <> v_user_id and revoked_at is null
  ) then
    raise exception 'device is bound to another account';
  end if;

  update public.devices
    set revoked_at = now(), health_bridge_enabled = false, updated_at = now()
    where user_id = v_user_id and revoked_at is null and device_id <> p_device_id;

  insert into public.devices(device_id, user_id, health_bridge_enabled, consent_version, bound_at, revoked_at)
  values (p_device_id, v_user_id, true, p_consent_version, now(), null)
  on conflict (device_id) do update set
    user_id = excluded.user_id,
    health_bridge_enabled = true,
    consent_version = excluded.consent_version,
    bound_at = now(),
    revoked_at = null,
    updated_at = now();

  insert into public.consents(user_id, purpose, consent_version, data_types, accepted_at, revoked_at)
  values (
    v_user_id,
    'health_cloud_sync',
    p_consent_version,
    array['weight','body_fat','steps','sleep','active_energy','basal_energy','resting_heart_rate'],
    now(),
    null
  )
  on conflict (user_id, purpose, consent_version) do update set accepted_at = now(), revoked_at = null;
end;
$$;

create or replace function public.unbind_health_bridge(p_device_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  update public.devices set revoked_at = now(), health_bridge_enabled = false, updated_at = now()
    where device_id = p_device_id and user_id = v_user_id;
  update public.consents set revoked_at = now()
    where user_id = v_user_id and purpose = 'health_cloud_sync' and revoked_at is null;
end;
$$;

create or replace function public.upsert_health_days(p_device_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if not exists (
    select 1 from public.devices
    where device_id = p_device_id and user_id = v_user_id
      and health_bridge_enabled = true and revoked_at is null
  ) then
    raise exception 'active health bridge required';
  end if;

  insert into public.health_days(
    user_id, day, weight, body_fat, active_energy, basal_energy, steps, sleep_hours,
    resting_heart_rate, health_updated_at, device_id
  )
  select
    v_user_id, x.day, x.weight, x.body_fat, x.active_energy, x.basal_energy, x.steps,
    x.sleep_hours, x.resting_heart_rate, x.health_updated_at, p_device_id
  from jsonb_to_recordset(p_rows) as x(
    day date, weight numeric, body_fat numeric, active_energy numeric, basal_energy numeric,
    steps integer, sleep_hours numeric, resting_heart_rate numeric, health_updated_at timestamptz
  )
  on conflict (user_id, day) do update set
    weight = excluded.weight,
    body_fat = excluded.body_fat,
    active_energy = excluded.active_energy,
    basal_energy = excluded.basal_energy,
    steps = excluded.steps,
    sleep_hours = excluded.sleep_hours,
    resting_heart_rate = excluded.resting_heart_rate,
    health_updated_at = excluded.health_updated_at,
    device_id = excluded.device_id,
    updated_at = now();
end;
$$;

create or replace function public.upsert_hevy_workouts(p_device_id uuid, p_rows jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
begin
  if not exists (
    select 1 from public.devices
    where device_id = p_device_id and user_id = v_user_id
      and health_bridge_enabled = true and revoked_at is null
  ) then
    raise exception 'active bridge required';
  end if;

  insert into public.workouts(
    user_id, source, source_id, title, started_at, ended_at, payload,
    client_updated_at, device_id
  )
  select
    v_user_id, 'hevy', x.source_id, x.title, x.started_at, x.ended_at,
    x.payload, x.client_updated_at, p_device_id
  from jsonb_to_recordset(p_rows) as x(
    source_id text, title text, started_at timestamptz, ended_at timestamptz,
    payload jsonb, client_updated_at timestamptz
  )
  on conflict (user_id, source, source_id) do update set
    title = excluded.title,
    started_at = excluded.started_at,
    ended_at = excluded.ended_at,
    payload = excluded.payload,
    client_updated_at = excluded.client_updated_at,
    device_id = excluded.device_id,
    updated_at = now();
end;
$$;

revoke all on function public.bind_health_bridge(uuid, integer) from public, anon;
revoke all on function public.unbind_health_bridge(uuid) from public, anon;
revoke all on function public.upsert_health_days(uuid, jsonb) from public, anon;
revoke all on function public.upsert_hevy_workouts(uuid, jsonb) from public, anon;
grant execute on function public.bind_health_bridge(uuid, integer) to authenticated;
grant execute on function public.unbind_health_bridge(uuid) to authenticated;
grant execute on function public.upsert_health_days(uuid, jsonb) to authenticated;
grant execute on function public.upsert_hevy_workouts(uuid, jsonb) to authenticated;

commit;
