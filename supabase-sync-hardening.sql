-- Applied to production on 2026-10-07. Does not modify workspace data.
begin;
alter role authenticated set statement_timeout = '30s';
alter table public.app_state enable row level security;
drop policy if exists anon_insert_app_state on public.app_state;
drop policy if exists anon_read_app_state on public.app_state;
drop policy if exists anon_update_app_state on public.app_state;
revoke all on table public.app_state from anon;
commit;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

select rolname, rolconfig from pg_roles where rolname = 'authenticated';
select policyname, roles, cmd from pg_policies
where schemaname = 'public' and tablename = 'app_state';
