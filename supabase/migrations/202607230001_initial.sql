begin;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  calorie_target integer not null default 1900 check (calorie_target between 800 and 6000),
  protein_target integer not null default 180 check (protein_target between 20 and 500),
  tdee_estimate integer not null default 2600 check (tdee_estimate between 1000 and 7000),
  main_body_fat_target numeric(4,1) not null default 15 check (main_body_fat_target between 5 and 50),
  starting_weight numeric(5,2) check (starting_weight between 30 and 300),
  starting_body_fat numeric(4,1) check (starting_body_fat between 3 and 70),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.nutrition_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  calories integer check (calories between 0 and 10000),
  protein numeric(6,1) check (protein between 0 and 1000),
  manual_weight numeric(5,2) check (manual_weight between 30 and 300),
  manual_body_fat numeric(4,1) check (manual_body_fat between 3 and 70),
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.health_days (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  weight numeric(5,2) check (weight between 30 and 300),
  body_fat numeric(4,1) check (body_fat between 3 and 70),
  active_energy numeric(8,1) check (active_energy between 0 and 20000),
  basal_energy numeric(8,1) check (basal_energy between 0 and 20000),
  steps integer check (steps between 0 and 200000),
  sleep_hours numeric(4,2) check (sleep_hours between 0 and 24),
  resting_heart_rate numeric(5,1) check (resting_heart_rate between 20 and 250),
  health_updated_at timestamptz not null,
  source_device text,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create table if not exists public.workouts (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('hevy', 'manual')),
  source_id text not null,
  title text not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  payload jsonb not null default '{}'::jsonb,
  client_updated_at timestamptz not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, source_id)
);

create table if not exists public.sync_status (
  user_id uuid not null references auth.users(id) on delete cascade,
  source text not null check (source in ('healthkit', 'hevy', 'web')),
  device_id text not null,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (user_id, source, device_id)
);

alter table public.profiles enable row level security;
alter table public.nutrition_days enable row level security;
alter table public.health_days enable row level security;
alter table public.workouts enable row level security;
alter table public.sync_status enable row level security;

revoke all on public.profiles, public.nutrition_days, public.health_days, public.workouts, public.sync_status from anon;
grant select, insert, update, delete on public.profiles, public.nutrition_days, public.health_days, public.workouts, public.sync_status to authenticated;

create policy "profiles_owner_all" on public.profiles
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "nutrition_owner_all" on public.nutrition_days
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "health_owner_all" on public.health_days
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "workouts_owner_all" on public.workouts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "sync_status_owner_all" on public.sync_status
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch_updated_at before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger nutrition_touch_updated_at before update on public.nutrition_days
  for each row execute function public.touch_updated_at();
create trigger health_touch_updated_at before update on public.health_days
  for each row execute function public.touch_updated_at();
create trigger workouts_touch_updated_at before update on public.workouts
  for each row execute function public.touch_updated_at();
create trigger sync_status_touch_updated_at before update on public.sync_status
  for each row execute function public.touch_updated_at();

commit;
