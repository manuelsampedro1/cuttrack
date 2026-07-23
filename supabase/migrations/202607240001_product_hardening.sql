begin;

create unique index if not exists integration_secrets_health_token_hash
  on public.integration_secrets(token_hash)
  where provider = 'health_auto_export' and token_hash is not null;

alter table public.food_entries
  add column if not exists image_paths text[] not null default '{}';

update public.food_entries
set image_paths = array[image_path]
where image_path is not null and cardinality(image_paths) = 0;

alter table public.food_entries
  drop constraint if exists food_entries_image_paths_limit;

alter table public.food_entries
  add constraint food_entries_image_paths_limit
  check (cardinality(image_paths) <= 2);

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
  v_calories numeric := (p_entry->>'calories')::numeric;
  v_image_paths text[] := case
    when jsonb_typeof(p_entry->'image_paths') = 'array'
      then coalesce(array(select jsonb_array_elements_text(p_entry->'image_paths')), '{}')
    when nullif(p_entry->>'image_path', '') is not null
      then array[p_entry->>'image_path']
    else '{}'
  end;
begin
  if v_user_id is null then raise exception 'authentication required'; end if;
  if cardinality(v_image_paths) > 2 then raise exception 'too many food images'; end if;

  select (consumed_at at time zone 'Europe/Madrid')::date
    into v_old_day
  from public.food_entries
  where id = v_id and user_id = v_user_id;

  insert into public.food_entries(
    id, user_id, consumed_at, meal, name, amount_description, calories, protein,
    carbohydrates, fat, confidence, source, input_text, image_path, image_paths,
    assumptions, items, calories_low, calories_high, reference_object,
    client_updated_at, deleted_at
  ) values (
    v_id,
    v_user_id,
    v_consumed_at,
    p_entry->>'meal',
    trim(p_entry->>'name'),
    coalesce(p_entry->>'amount_description', ''),
    v_calories,
    coalesce((p_entry->>'protein')::numeric, 0),
    coalesce((p_entry->>'carbohydrates')::numeric, 0),
    coalesce((p_entry->>'fat')::numeric, 0),
    nullif(p_entry->>'confidence', '')::numeric,
    p_entry->>'source',
    coalesce(p_entry->>'input_text', ''),
    coalesce(v_image_paths[1], nullif(p_entry->>'image_path', '')),
    v_image_paths,
    coalesce(array(select jsonb_array_elements_text(p_entry->'assumptions')), '{}'),
    case when jsonb_typeof(p_entry->'items') = 'array' then p_entry->'items' else '[]'::jsonb end,
    coalesce(nullif(p_entry->>'calories_low', '')::numeric, v_calories),
    coalesce(nullif(p_entry->>'calories_high', '')::numeric, v_calories),
    case when jsonb_typeof(p_entry->'reference_object') = 'object' then p_entry->'reference_object' else '{}'::jsonb end,
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
    image_paths = case
      when cardinality(excluded.image_paths) > 0 then excluded.image_paths
      else public.food_entries.image_paths
    end,
    assumptions = excluded.assumptions,
    items = excluded.items,
    calories_low = excluded.calories_low,
    calories_high = excluded.calories_high,
    reference_object = excluded.reference_object,
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

revoke all on function public.save_food_entry(jsonb) from public, anon;
grant execute on function public.save_food_entry(jsonb) to authenticated;

commit;
