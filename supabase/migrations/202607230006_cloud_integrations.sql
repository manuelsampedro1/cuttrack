begin;

create table if not exists public.integration_secrets (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('health_auto_export', 'hevy')),
  token_hash text,
  encrypted_secret text,
  secret_iv text,
  status text not null default 'connected' check (status in ('connected', 'error', 'revoked')),
  last_sync_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider),
  check (
    (provider = 'health_auto_export' and token_hash is not null)
    or (provider = 'hevy' and encrypted_secret is not null and secret_iv is not null)
  )
);

alter table public.integration_secrets enable row level security;
revoke all on public.integration_secrets from public, anon, authenticated;
grant select, insert, update, delete on public.integration_secrets to service_role;
grant select, insert, update on public.health_days, public.workouts to service_role;

drop trigger if exists integration_secrets_touch_updated_at on public.integration_secrets;
create trigger integration_secrets_touch_updated_at
  before update on public.integration_secrets
  for each row execute function public.touch_updated_at();

alter table public.health_days
  add column if not exists source text not null default 'healthkit';

alter table public.health_days
  drop constraint if exists health_days_source_check;
alter table public.health_days
  add constraint health_days_source_check
  check (source in ('healthkit', 'health_auto_export', 'garmin'));

alter table public.workouts
  drop constraint if exists workouts_source_check;
alter table public.workouts
  add constraint workouts_source_check
  check (source in ('hevy', 'manual', 'health_auto_export', 'garmin'));

commit;
