alter table public.nutrition_days
  add column if not exists manual_active_energy numeric(8,1) check (manual_active_energy between 0 and 20000),
  add column if not exists manual_basal_energy numeric(8,1) check (manual_basal_energy between 0 and 20000),
  add column if not exists manual_steps integer check (manual_steps between 0 and 200000),
  add column if not exists manual_sleep_hours numeric(4,2) check (manual_sleep_hours between 0 and 24);
