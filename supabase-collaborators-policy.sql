drop policy if exists "workspace members can read active profiles" on public.profiles;

create policy "workspace members can read active profiles"
on public.profiles
for select
to authenticated
using (
  is_active = true
  and workspace_id = public.current_workspace_id()
);
