create extension if not exists citext;

do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'app_role'
  ) then
    create type public.app_role as enum ('admin', 'editor', 'viewer');
  end if;
end
$$;

create table if not exists public.app_workspaces (
  id text primary key,
  name text not null,
  created_at timestamptz not null default timezone('utc', now())
);

insert into public.app_workspaces (id, name)
values ('shared', 'Workspace condiviso Martec')
on conflict (id) do nothing;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id text not null references public.app_workspaces(id) on delete restrict default 'shared',
  email text not null,
  username citext not null unique,
  full_name text not null default '',
  role public.app_role not null default 'viewer',
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  constraint profiles_username_length check (char_length(username::text) >= 3)
);

create table if not exists public.app_state (
  workspace_id text primary key references public.app_workspaces(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default timezone('utc', now()),
  updated_by uuid references auth.users(id) on delete set null
);

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_state'
      and column_name = 'id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'app_state'
      and column_name = 'workspace_id'
  ) then
    alter table public.app_state rename column id to workspace_id;
  end if;
end
$$;

alter table public.app_state
  alter column workspace_id type text;

alter table public.app_state
  add column if not exists updated_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.app_state'::regclass
      and contype = 'p'
  ) then
    alter table public.app_state add primary key (workspace_id);
  end if;
exception
  when invalid_table_definition then
    null;
end
$$;

insert into public.app_state (workspace_id, payload)
values ('shared', '{}'::jsonb)
on conflict (workspace_id) do nothing;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute function public.set_updated_at();

drop trigger if exists app_state_set_updated_at on public.app_state;
create trigger app_state_set_updated_at
before update on public.app_state
for each row
execute function public.set_updated_at();

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
  v_role := case when exists (select 1 from public.profiles limit 1) then 'viewer'::public.app_role else 'admin'::public.app_role end;

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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row
execute function public.handle_new_user();

create or replace function public.current_workspace_id()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.workspace_id
  from public.profiles p
  where p.user_id = auth.uid()
    and p.is_active = true
  limit 1
$$;

create or replace function public.has_workspace_role(target_workspace_id text, allowed_roles public.app_role[])
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.user_id = auth.uid()
      and p.is_active = true
      and p.workspace_id = target_workspace_id
      and p.role = any(allowed_roles)
  )
$$;

create or replace function public.login_email_for_identifier(identifier text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select p.email
  from public.profiles p
  where p.is_active = true
    and (
      lower(p.username::text) = lower(identifier)
      or lower(p.email) = lower(identifier)
    )
  limit 1
$$;

revoke all on function public.current_workspace_id() from public;
revoke all on function public.has_workspace_role(text, public.app_role[]) from public;
revoke all on function public.login_email_for_identifier(text) from public;

grant execute on function public.current_workspace_id() to authenticated;
grant execute on function public.has_workspace_role(text, public.app_role[]) to authenticated;
grant execute on function public.login_email_for_identifier(text) to anon, authenticated;

alter table public.app_workspaces enable row level security;
alter table public.profiles enable row level security;
alter table public.app_state enable row level security;

drop policy if exists "workspace members can read workspace" on public.app_workspaces;
create policy "workspace members can read workspace"
on public.app_workspaces
for select
to authenticated
using (id = public.current_workspace_id());

drop policy if exists "users can read own profile" on public.profiles;
create policy "users can read own profile"
on public.profiles
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "admins can read workspace profiles" on public.profiles;
create policy "admins can read workspace profiles"
on public.profiles
for select
to authenticated
using (public.has_workspace_role(workspace_id, array['admin'::public.app_role]));

drop policy if exists "admins can update workspace profiles" on public.profiles;
create policy "admins can update workspace profiles"
on public.profiles
for update
to authenticated
using (public.has_workspace_role(workspace_id, array['admin'::public.app_role]))
with check (public.has_workspace_role(workspace_id, array['admin'::public.app_role]));

drop policy if exists "workspace can read state" on public.app_state;
create policy "workspace can read state"
on public.app_state
for select
to authenticated
using (workspace_id = public.current_workspace_id());

drop policy if exists "editors can insert state" on public.app_state;
create policy "editors can insert state"
on public.app_state
for insert
to authenticated
with check (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(workspace_id, array['admin'::public.app_role, 'editor'::public.app_role])
);

drop policy if exists "editors can update state" on public.app_state;
create policy "editors can update state"
on public.app_state
for update
to authenticated
using (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(workspace_id, array['admin'::public.app_role, 'editor'::public.app_role])
)
with check (
  workspace_id = public.current_workspace_id()
  and public.has_workspace_role(workspace_id, array['admin'::public.app_role, 'editor'::public.app_role])
);

grant select on public.app_workspaces to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update on public.app_state to authenticated;

do $$
begin
  begin
    alter publication supabase_realtime add table public.app_state;
  exception
    when duplicate_object then
      null;
  end;
end
$$;
