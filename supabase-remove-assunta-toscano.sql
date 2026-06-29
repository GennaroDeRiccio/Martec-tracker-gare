-- Disattiva l'account applicativo di Assunta Toscano.
-- Esegui questo script nel SQL Editor di Supabase con ruolo owner/postgres.
-- La disattivazione rimuove l'utente dai collaboratori attivi e blocca il bootstrap dell'app.

update public.profiles
set
  is_active = false,
  updated_at = timezone('utc', now())
where
  lower(coalesce(full_name, '')) = 'assunta toscano'
  or lower(coalesce(username::text, '')) in ('assunta', 'assuntatoscano', 'assunta.toscano')
  or lower(coalesce(email, '')) like '%assunta%toscano%';

-- Verifica: deve restituire il profilo con is_active = false.
select
  user_id,
  email,
  username,
  full_name,
  role,
  is_active,
  updated_at
from public.profiles
where
  lower(coalesce(full_name, '')) = 'assunta toscano'
  or lower(coalesce(username::text, '')) in ('assunta', 'assuntatoscano', 'assunta.toscano')
  or lower(coalesce(email, '')) like '%assunta%toscano%';
