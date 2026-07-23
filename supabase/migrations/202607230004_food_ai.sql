begin;

create table if not exists public.food_entries (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  consumed_at timestamptz not null,
  meal text not null check (meal in ('breakfast', 'lunch', 'dinner', 'snack')),
  name text not null check (char_length(name) between 1 and 180),
  amount_description text not null default '' check (char_length(amount_description) <= 500),
  calories numeric(7,1) not null check (calories between 0 and 10000),
  protein numeric(6,1) not null default 0 check (protein between 0 and 1000),
  carbohydrates numeric(6,1) not null default 0 check (carbohydrates between 0 and 1000),
  fat numeric(6,1) not null default 0 check (fat between 0 and 1000),
  confidence numeric(4,3) check (confidence between 0 and 1),
  source text not null check (source in ('text_ai', 'photo_ai', 'manual')),
  input_text text not null default '' check (char_length(input_text) <= 1000),
  image_path text check (char_length(image_path) <= 500),
  assumptions text[] not null default '{}',
  client_updated_at timestamptz not null,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists food_entries_user_consumed_at
  on public.food_entries(user_id, consumed_at desc)
  where deleted_at is null;

alter table public.food_entries enable row level security;

revoke all on public.food_entries from public, anon, authenticated;
grant select on public.food_entries to authenticated;

drop policy if exists "food_entries_owner_select" on public.food_entries;
create policy "food_entries_owner_select" on public.food_entries
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop trigger if exists food_entries_touch_updated_at on public.food_entries;
create trigger food_entries_touch_updated_at before update on public.food_entries
  for each row execute function public.touch_updated_at();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'food-images',
  'food-images',
  false,
  8000000,
  array['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'image/webp']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "food_images_owner_select" on storage.objects;
drop policy if exists "food_images_owner_insert" on storage.objects;
drop policy if exists "food_images_owner_update" on storage.objects;
drop policy if exists "food_images_owner_delete" on storage.objects;

create policy "food_images_owner_select" on storage.objects
  for select to authenticated
  using (bucket_id = 'food-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "food_images_owner_insert" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'food-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "food_images_owner_update" on storage.objects
  for update to authenticated
  using (bucket_id = 'food-images' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'food-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy "food_images_owner_delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'food-images' and (storage.foldername(name))[1] = (select auth.uid())::text);

create or replace function public.recalculate_nutrition_day(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_calories numeric;
  v_protein numeric;
begin
  select sum(calories), sum(protein)
    into v_calories, v_protein
  from public.food_entries
  where user_id = p_user_id
    and deleted_at is null
    and (consumed_at at time zone 'Europe/Madrid')::date = p_day;

  insert into public.nutrition_days(
    user_id, day, calories, protein, client_updated_at, deleted_at
  ) values (
    p_user_id,
    p_day,
    case when v_calories is null then null else round(v_calories)::integer end,
    case when v_protein is null then null else round(v_protein, 1) end,
    now(),
    null
  )
  on conflict (user_id, day) do update set
    calories = excluded.calories,
    protein = excluded.protein,
    client_updated_at = excluded.client_updated_at,
    deleted_at = null,
    updated_at = now();
end;
$$;

create or replace function public.save_food_entry(p_entry jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_id uuid := (p_entry->>'id')::uuid;
  v_consumed_at timestamptz := (p_entry->>'consumed_at')::timestamptz;
  v_old_day date;
  v_new_day date := (v_consumed_at at time zone 'Europe/Madrid')::date;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;

  select (consumed_at at time zone 'Europe/Madrid')::date
    into v_old_day
  from public.food_entries
  where id = v_id and user_id = v_user_id;

  insert into public.food_entries(
    id, user_id, consumed_at, meal, name, amount_description, calories, protein,
    carbohydrates, fat, confidence, source, input_text, image_path, assumptions,
    client_updated_at, deleted_at
  ) values (
    v_id,
    v_user_id,
    v_consumed_at,
    p_entry->>'meal',
    trim(p_entry->>'name'),
    coalesce(p_entry->>'amount_description', ''),
    (p_entry->>'calories')::numeric,
    coalesce((p_entry->>'protein')::numeric, 0),
    coalesce((p_entry->>'carbohydrates')::numeric, 0),
    coalesce((p_entry->>'fat')::numeric, 0),
    nullif(p_entry->>'confidence', '')::numeric,
    p_entry->>'source',
    coalesce(p_entry->>'input_text', ''),
    nullif(p_entry->>'image_path', ''),
    coalesce(array(select jsonb_array_elements_text(p_entry->'assumptions')), '{}'),
    coalesce((p_entry->>'client_updated_at')::timestamptz, now()),
    null
  )
  on conflict (id) do update set
    consumed_at = excluded.consumed_at,
    meal = excluded.meal,
    name = excluded.name,
    amount_description = excluded.amount_description,
    calories = excluded.calories,
    protein = excluded.protein,
    carbohydrates = excluded.carbohydrates,
    fat = excluded.fat,
    confidence = excluded.confidence,
    source = excluded.source,
    input_text = excluded.input_text,
    image_path = coalesce(excluded.image_path, public.food_entries.image_path),
    assumptions = excluded.assumptions,
    client_updated_at = excluded.client_updated_at,
    deleted_at = null,
    updated_at = now()
  where public.food_entries.user_id = v_user_id;

  if not found then raise exception 'food entry belongs to another account'; end if;

  perform public.recalculate_nutrition_day(v_user_id, v_new_day);
  if v_old_day is not null and v_old_day <> v_new_day then
    perform public.recalculate_nutrition_day(v_user_id, v_old_day);
  end if;
  return v_id;
end;
$$;

create or replace function public.delete_food_entry(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_day date;
begin
  update public.food_entries
    set deleted_at = now(), client_updated_at = now(), updated_at = now()
    where id = p_id and user_id = v_user_id and deleted_at is null
    returning (consumed_at at time zone 'Europe/Madrid')::date into v_day;

  if v_day is not null then
    perform public.recalculate_nutrition_day(v_user_id, v_day);
  end if;
end;
$$;

revoke all on function public.recalculate_nutrition_day(uuid, date) from public, anon, authenticated;
revoke all on function public.save_food_entry(jsonb) from public, anon;
revoke all on function public.delete_food_entry(uuid) from public, anon;
grant execute on function public.save_food_entry(jsonb) to authenticated;
grant execute on function public.delete_food_entry(uuid) to authenticated;

commit;
