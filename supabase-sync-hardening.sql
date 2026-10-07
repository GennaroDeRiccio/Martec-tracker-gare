-- Applied to production on 2026-10-07. Does not modify workspace data.
begin;
alter role authenticated set statement_timeout = '30s';
alter table public.app_state enable row level security;
drop policy if exists anon_insert_app_state on public.app_state;
drop policy if exists anon_read_app_state on public.app_state;
drop policy if exists anon_update_app_state on public.app_state;
revoke all on table public.app_state from anon;
alter function public.set_updated_at() set search_path = pg_catalog;
alter function public.set_app_state_updated_at() set search_path = pg_catalog;
revoke execute on function public.current_workspace_id() from public, anon;
revoke execute on function public.has_workspace_role(text, public.app_role[]) from public, anon;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
grant execute on function public.current_workspace_id() to authenticated;
grant execute on function public.has_workspace_role(text, public.app_role[]) to authenticated;
revoke execute on function public.login_email_for_identifier(text) from public;
grant execute on function public.login_email_for_identifier(text) to anon, authenticated;
commit;
notify pgrst, 'reload config';
notify pgrst, 'reload schema';

select rolname, rolconfig from pg_roles where rolname = 'authenticated';
select policyname, roles, cmd from pg_policies
where schemaname = 'public' and tablename = 'app_state';

-- Dashboard: Authentication > Sign In / Providers > Allow new users to sign up = OFF.
-- Existing users keep access; new users must be invited by an administrator.
