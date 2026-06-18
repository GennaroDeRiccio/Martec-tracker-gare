alter table public.profiles
  alter column role set default 'editor'::public.app_role;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_username text;
  v_full_name text;
  v_workspace_id text;
  v_role public.app_role;
begin
  v_username := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));
  v_full_name := coalesce(new.raw_user_meta_data->>'full_name', '');
  v_workspace_id := coalesce(new.raw_user_meta_data->>'workspace_id', 'shared');
  v_role := case when exists (select 1 from public.profiles limit 1) then 'editor'::public.app_role else 'admin'::public.app_role end;

  insert into public.profiles (
    user_id,
    workspace_id,
    email,
    username,
    full_name,
    role,
    is_active
  ) values (
    new.id,
    v_workspace_id,
    lower(new.email),
    v_username,
    v_full_name,
    v_role,
    true
  )
  on conflict (user_id) do update
  set email = excluded.email,
      username = excluded.username,
      full_name = excluded.full_name,
      workspace_id = excluded.workspace_id;

  insert into public.app_state (workspace_id, payload)
  values (v_workspace_id, '{}'::jsonb)
  on conflict (workspace_id) do nothing;

  return new;
end;
$$;

update public.profiles
set role = 'editor'::public.app_role
where role = 'viewer'::public.app_role;
