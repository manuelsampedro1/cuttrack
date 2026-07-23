begin;

alter table public.food_entries
  add column if not exists items jsonb not null default '[]'::jsonb,
  add column if not exists calories_low numeric(7,1),
  add column if not exists calories_high numeric(7,1),
  add column if not exists reference_object jsonb not null default '{}'::jsonb;

alter table public.food_entries
  drop constraint if exists food_entries_items_array,
  drop constraint if exists food_entries_calorie_range;

alter table public.food_entries
  add constraint food_entries_items_array check (jsonb_typeof(items) = 'array'),
  add constraint food_entries_calorie_range check (
    (calories_low is null or calories_low between 0 and 10000)
    and (calories_high is null or calories_high between 0 and 10000)
    and (calories_low is null or calories_high is null or calories_low <= calories_high)
  );

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
begin
  if v_user_id is null then raise exception 'authentication required'; end if;

  select (consumed_at at time zone 'Europe/Madrid')::date
    into v_old_day
  from public.food_entries
  where id = v_id and user_id = v_user_id;

  insert into public.food_entries(
    id, user_id, consumed_at, meal, name, amount_description, calories, protein,
    carbohydrates, fat, confidence, source, input_text, image_path, assumptions,
    items, calories_low, calories_high, reference_object, client_updated_at, deleted_at
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
    nullif(p_entry->>'image_path', ''),
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
