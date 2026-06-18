drop policy if exists "editors can insert state" on public.app_state;
create policy "editors can insert state"
on public.app_state
for insert
to authenticated
with check (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(
    workspace_id,
    array[
      'admin'::public.app_role,
      'editor'::public.app_role,
      'viewer'::public.app_role
    ]
  )
);

drop policy if exists "editors can update state" on public.app_state;
create policy "editors can update state"
on public.app_state
for update
to authenticated
using (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(
    workspace_id,
    array[
      'admin'::public.app_role,
      'editor'::public.app_role,
      'viewer'::public.app_role
    ]
  )
)
with check (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(
    workspace_id,
    array[
      'admin'::public.app_role,
      'editor'::public.app_role,
      'viewer'::public.app_role
    ]
  )
);
