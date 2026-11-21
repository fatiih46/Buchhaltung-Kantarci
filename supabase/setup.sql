-- Haushaltsbuch Kantarci – Einrichtung der kostenlosen Cloud-Datenbank (Supabase)
-- Einmal komplett im Supabase-Dashboard unter „SQL Editor“ einfügen und auf „Run“ klicken.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden (z. B. nach einem Update).
--
-- Aufbau:
--   households  – ein Haushalt mit Einladungscode
--   members     – wer zu welchem Haushalt gehört (Name)
--   user_data   – die kompletten Daten einer Person (nur für sie selbst lesbar)
--   summaries   – Monatssummen einer Person, die der Haushalt sehen darf
--   Storage-Bucket „belege“ – Fotos/PDFs, jede Person nur im eigenen Ordner

create table if not exists public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 60),
  invite_code text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  created_at timestamptz not null default now()
);
create index if not exists members_household_idx on public.members (household_id);

create table if not exists public.user_data (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data text not null,                       -- SQLite-Datenbank der Person (Base64)
  version integer not null default 1,       -- schützt vor gleichzeitigem Überschreiben von zwei Geräten
  updated_at timestamptz not null default now()
);

create table if not exists public.summaries (
  user_id uuid primary key references public.members (user_id) on delete cascade,
  months jsonb not null default '{}'::jsonb, -- { "2026-11": { income, fixedTotal, ... }, ... }
  updated_at timestamptz not null default now()
);

alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.user_data enable row level security;
alter table public.summaries enable row level security;

-- Zugriffsrechte ausdrücklich vergeben (neuere Supabase-Projekte vergeben sie nicht mehr automatisch).
-- Welche Zeilen jemand sieht, regeln danach die Zugriffsregeln (Policies) weiter unten.
revoke all on public.households, public.members, public.user_data, public.summaries from anon;
grant select on public.households, public.members to authenticated;
grant select, insert, update, delete on public.user_data to authenticated;
grant select, insert, update on public.summaries to authenticated;

-- Haushalt der angemeldeten Person (security definer: umgeht RLS, liefert nur die eigene Zeile)
create or replace function public.my_household()
returns uuid language sql stable security definer set search_path = public as $$
  select household_id from public.members where user_id = auth.uid()
$$;

-- ---------- Zugriffsregeln ----------
drop policy if exists "households_select" on public.households;
create policy "households_select" on public.households
  for select to authenticated using (id = public.my_household());

drop policy if exists "members_select" on public.members;
create policy "members_select" on public.members
  for select to authenticated using (household_id = public.my_household());

-- Eigene Daten: nur die Person selbst
drop policy if exists "user_data_select" on public.user_data;
drop policy if exists "user_data_insert" on public.user_data;
drop policy if exists "user_data_update" on public.user_data;
drop policy if exists "user_data_delete" on public.user_data;
create policy "user_data_select" on public.user_data
  for select to authenticated using (user_id = auth.uid());
create policy "user_data_insert" on public.user_data
  for insert to authenticated with check (user_id = auth.uid());
create policy "user_data_update" on public.user_data
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "user_data_delete" on public.user_data
  for delete to authenticated using (user_id = auth.uid());

-- Monatssummen: der ganze Haushalt darf lesen, schreiben nur die Person selbst
drop policy if exists "summaries_select" on public.summaries;
drop policy if exists "summaries_insert" on public.summaries;
drop policy if exists "summaries_update" on public.summaries;
create policy "summaries_select" on public.summaries
  for select to authenticated using (
    user_id in (select m.user_id from public.members m where m.household_id = public.my_household()));
create policy "summaries_insert" on public.summaries
  for insert to authenticated with check (user_id = auth.uid());
create policy "summaries_update" on public.summaries
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- Haushalt anlegen / beitreten ----------
create or replace function public.new_invite_code()
returns text language plpgsql volatile set search_path = public as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea;
  code text;
begin
  loop
    bytes := decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    code := '';
    for i in 0..7 loop
      code := code || substr(alphabet, 1 + (get_byte(bytes, i) % 32), 1);
    end loop;
    exit when not exists (select 1 from public.households where invite_code = code);
  end loop;
  return code;
end $$;

create or replace function public.create_household(p_household_name text, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(trim(coalesce(p_name, '')), 60);
  v_household text := left(trim(coalesce(p_household_name, '')), 60);
  v_id uuid;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Bitte anmelden.'; end if;
  if v_name = '' then raise exception 'Name fehlt.'; end if;
  -- schon in einem Haushalt: nichts ändern
  select h.invite_code into v_code from public.households h
    join public.members m on m.household_id = h.id where m.user_id = auth.uid();
  if found then return v_code; end if;
  if v_household = '' then v_household := left('Haushalt ' || v_name, 60); end if;
  v_code := public.new_invite_code();
  insert into public.households (name, invite_code) values (v_household, v_code) returning id into v_id;
  insert into public.members (user_id, household_id, name) values (auth.uid(), v_id, v_name);
  return v_code;
end $$;

create or replace function public.join_household(p_code text, p_name text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_name text := left(trim(coalesce(p_name, '')), 60);
  v_id uuid;
  v_code text := upper(trim(coalesce(p_code, '')));
begin
  if auth.uid() is null then raise exception 'Bitte anmelden.'; end if;
  if v_name = '' then raise exception 'Name fehlt.'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then
    raise exception 'Du gehörst schon zu einem Haushalt.';
  end if;
  select id into v_id from public.households where invite_code = v_code;
  if not found then raise exception 'Einladungscode nicht gefunden.'; end if;
  insert into public.members (user_id, household_id, name) values (auth.uid(), v_id, v_name);
  return v_code;
end $$;

-- Vor der Registrierung prüfen, ob ein Einladungscode stimmt (ohne etwas über den Haushalt zu verraten)
create or replace function public.check_invite(p_code text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.households where invite_code = upper(trim(coalesce(p_code, ''))))
$$;

revoke all on function public.my_household() from public, anon;
revoke all on function public.new_invite_code() from public, anon, authenticated;
revoke all on function public.create_household(text, text) from public, anon;
revoke all on function public.join_household(text, text) from public, anon;
revoke all on function public.check_invite(text) from public;
grant execute on function public.my_household() to authenticated;
grant execute on function public.create_household(text, text) to authenticated;
grant execute on function public.join_household(text, text) to authenticated;
grant execute on function public.check_invite(text) to anon, authenticated;

-- ---------- Belege (Fotos & PDFs) ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('belege', 'belege', false, 8388608,
        array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'])
on conflict (id) do nothing;

drop policy if exists "belege_select_own" on storage.objects;
drop policy if exists "belege_insert_own" on storage.objects;
drop policy if exists "belege_delete_own" on storage.objects;
create policy "belege_select_own" on storage.objects
  for select to authenticated using (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "belege_insert_own" on storage.objects
  for insert to authenticated with check (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "belege_delete_own" on storage.objects
  for delete to authenticated using (bucket_id = 'belege' and (storage.foldername(name))[1] = auth.uid()::text);
