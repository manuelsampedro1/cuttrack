create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.unschedule(jobid)
from cron.job
where jobname = 'cuttrack-hevy-sync';

select cron.schedule(
  'cuttrack-hevy-sync',
  '*/30 * * * *',
  $job$
  select net.http_post(
    url := 'https://shfpsrniibhbxmrjnhze.supabase.co/functions/v1/hevy-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'hevy_cron_secret'
        limit 1
      )
    ),
    body := '{"action":"cron"}'::jsonb
  );
  $job$
);
