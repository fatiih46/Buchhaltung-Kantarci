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

-- ---------- Nutzer-Übersicht für den Besitzer (ohne Inhalte) ----------
-- Wer darf die Übersicht sehen? Einmalig im SQL Editor eintragen (nicht über die App möglich):
--   select public.make_admin('deine@email.de');
alter table public.members add column if not exists last_seen_at timestamptz;

create table if not exists public.app_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table public.app_admins enable row level security; -- keine Policies: aus der App weder lesbar noch änderbar
revoke all on public.app_admins from anon, authenticated;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_admins where user_id = auth.uid())
$$;

-- „zuletzt aktiv“: die App meldet sich beim Öffnen kurz (nur Zeitpunkt, keine Inhalte)
create or replace function public.mark_active()
returns void language sql volatile security definer set search_path = public as $$
  update public.members set last_seen_at = now() where user_id = auth.uid()
$$;

-- Liste aller Konten – nur Name, E-Mail, Haushalt und Zeitpunkte, keine Einträge oder Beträge
-- (Rückgabe geändert -> alte Fassung erst entfernen, damit das Skript wiederholbar bleibt)
drop function if exists public.admin_overview();
create function public.admin_overview()
returns table (user_id uuid, name text, email text, household text, household_members integer, registered_at timestamptz,
               last_sign_in_at timestamptz, last_seen_at timestamptz, last_saved_at timestamptz, confirmed boolean,
               banned boolean, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Nur für den Besitzer.'; end if;
  return query
    select u.id, m.name, u.email::text, h.name,
           (select count(*)::integer from public.members m2 where m2.household_id = m.household_id),
           u.created_at, u.last_sign_in_at, m.last_seen_at, d.updated_at, (u.email_confirmed_at is not null),
           coalesce(u.banned_until > now(), false), u.id = auth.uid()
    from auth.users u
    left join public.members m on m.user_id = u.id
    left join public.households h on h.id = m.household_id
    left join public.user_data d on d.user_id = u.id
    order by coalesce(m.last_seen_at, d.updated_at, u.last_sign_in_at, u.created_at) desc;
end $$;

create or replace function public.make_admin(p_email text)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(trim(p_email));
  if not found then raise exception 'Kein Konto mit dieser E-Mail gefunden.'; end if;
  insert into public.app_admins (user_id) values (v_id) on conflict do nothing;
  return 'Fertig: ' || p_email || ' sieht jetzt die Nutzer-Übersicht.';
end $$;

-- Sperren / entsperren: gesperrte Konten können sich nicht mehr anmelden (Daten bleiben erhalten)
create or replace function public.admin_set_banned(p_user uuid, p_banned boolean)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Nur für den Besitzer.'; end if;
  if p_user = auth.uid() then raise exception 'Du kannst dich nicht selbst sperren.'; end if;
  update auth.users set banned_until = case when p_banned then 'infinity'::timestamptz else null end where id = p_user;
  if not found then raise exception 'Konto nicht gefunden.'; end if;
end $$;

-- Endgültig löschen: Konto samt Daten (Haushalt-Mitgliedschaft, gespeicherte Daten, Monatssummen);
-- ein Haushalt ohne Mitglieder wird mit entfernt. Belegfotos liegen im Storage-Ordner mit der Konto-ID.
create or replace function public.admin_delete_user(p_user uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare v_household uuid;
begin
  if not public.is_admin() then raise exception 'Nur für den Besitzer.'; end if;
  if p_user = auth.uid() then raise exception 'Du kannst dich nicht selbst löschen.'; end if;
  select household_id into v_household from public.members where user_id = p_user;
  delete from auth.users where id = p_user;
  if not found then raise exception 'Konto nicht gefunden.'; end if;
  if v_household is not null then
    delete from public.households h where h.id = v_household
      and not exists (select 1 from public.members m where m.household_id = h.id);
  end if;
  return p_user::text;
end $$;

revoke all on function public.admin_set_banned(uuid, boolean) from public, anon;
revoke all on function public.admin_delete_user(uuid) from public, anon;
grant execute on function public.admin_set_banned(uuid, boolean) to authenticated;
grant execute on function public.admin_delete_user(uuid) to authenticated;
revoke all on function public.is_admin() from public, anon;
revoke all on function public.mark_active() from public, anon;
revoke all on function public.admin_overview() from public, anon;
revoke all on function public.make_admin(text) from public, anon, authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.mark_active() to authenticated;
grant execute on function public.admin_overview() to authenticated;

-- ---------- Gemeinsame Kasse (Töpfe wie Tanken, Einkaufen, Lifestyle) ----------
-- Gehört dem Haushalt: alle Mitglieder sehen und pflegen sie gemeinsam. Private Daten bleiben getrennt.
-- plan: Liste von {from: "JJJJ-MM", amount, carryover} – Änderungen gelten ab dem Monat, frühere Monate bleiben richtig.
create table if not exists public.pots (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  icon text not null default '💰' check (char_length(icon) <= 8),
  categories jsonb not null default '[]'::jsonb,   -- passende Kategorien, damit ein Kassenbon automatisch zugeordnet wird
  plan jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists pots_household_idx on public.pots (household_id);

create table if not exists public.pot_entries (
  id uuid primary key default gen_random_uuid(),
  pot_id uuid not null references public.pots (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid references auth.users (id) on delete set null default auth.uid(),
  date date not null,
  amount numeric(12, 2) not null check (amount > 0 and amount < 1000000),
  shop text not null default '' check (char_length(shop) <= 60),
  note text not null default '' check (char_length(note) <= 200),
  file_path text,                                  -- Kassenbon im Storage-Ordner der Person, die ihn fotografiert hat
  file_type text,
  created_at timestamptz not null default now()
);
create index if not exists pot_entries_household_idx on public.pot_entries (household_id, date);

alter table public.pots enable row level security;
alter table public.pot_entries enable row level security;
revoke all on public.pots, public.pot_entries from anon;
grant select, insert, update, delete on public.pots, public.pot_entries to authenticated;

drop policy if exists "pots_all" on public.pots;
create policy "pots_all" on public.pots for all to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());

drop policy if exists "pot_entries_select" on public.pot_entries;
drop policy if exists "pot_entries_insert" on public.pot_entries;
drop policy if exists "pot_entries_update" on public.pot_entries;
drop policy if exists "pot_entries_delete" on public.pot_entries;
create policy "pot_entries_select" on public.pot_entries for select to authenticated
  using (household_id = public.my_household());
create policy "pot_entries_insert" on public.pot_entries for insert to authenticated
  with check (household_id = public.my_household() and user_id = auth.uid()
    and exists (select 1 from public.pots p where p.id = pot_id and p.household_id = public.my_household())
    and (file_path is null or (storage.foldername(file_path))[1] = auth.uid()::text));
create policy "pot_entries_update" on public.pot_entries for update to authenticated
  using (household_id = public.my_household()) with check (household_id = public.my_household());
create policy "pot_entries_delete" on public.pot_entries for delete to authenticated
  using (household_id = public.my_household());

-- Kassenbons der gemeinsamen Kasse darf der ganze Haushalt ansehen und mit der Ausgabe löschen
-- (nur diese – private Belege bleiben nur für die Person selbst)
drop policy if exists "belege_select_household_pot" on storage.objects;
drop policy if exists "belege_delete_household_pot" on storage.objects;
create policy "belege_select_household_pot" on storage.objects for select to authenticated using (
  bucket_id = 'belege' and exists (
    select 1 from public.pot_entries e where e.file_path = name and e.household_id = public.my_household()));
create policy "belege_delete_household_pot" on storage.objects for delete to authenticated using (
  bucket_id = 'belege' and exists (
    select 1 from public.pot_entries e where e.file_path = name and e.household_id = public.my_household()));

-- ---------- Gegenseitig ansehen (Freigabe pro Person, nur lesen) ----------
-- Jede Person entscheidet selbst unter ⚙, ob die anderen im Haushalt ALLE ihre Einträge und Belege sehen dürfen.
-- Ändern kann weiterhin nur jede Person ihre eigenen Daten.
alter table public.members add column if not exists share_all boolean not null default false;

create or replace function public.set_share_all(p_share boolean)
returns void language sql volatile security definer set search_path = public as $$
  update public.members set share_all = coalesce(p_share, false) where user_id = auth.uid()
$$;

-- hat p_user (als Text, z. B. Ordnername im Speicher) mir im selben Haushalt alles freigegeben?
create or replace function public.shares_with_me(p_user text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members m
    where m.user_id::text = p_user and m.share_all and m.user_id <> auth.uid()
      and m.household_id = public.my_household())
$$;

drop policy if exists "user_data_select_shared" on public.user_data;
create policy "user_data_select_shared" on public.user_data for select to authenticated
  using (public.shares_with_me(user_id::text));

drop policy if exists "belege_select_shared" on storage.objects;
create policy "belege_select_shared" on storage.objects for select to authenticated
  using (bucket_id = 'belege' and public.shares_with_me((storage.foldername(name))[1]));

revoke all on function public.set_share_all(boolean) from public, anon;
revoke all on function public.shares_with_me(text) from public, anon;
grant execute on function public.set_share_all(boolean) to authenticated;
grant execute on function public.shares_with_me(text) to authenticated;

-- ---------- Korrekturen an gemeinsamen Budgets (mit Grund, für alle nachvollziehbar) ----------
-- kind 'ausgabe': normale Ausgabe (Betrag > 0); kind 'korrektur': Geld hinzufügen (+) oder abziehen (−), Grund Pflicht
alter table public.pot_entries add column if not exists kind text not null default 'ausgabe';
alter table public.pot_entries drop constraint if exists pot_entries_amount_check;
alter table public.pot_entries drop constraint if exists pot_entries_kind_check;
alter table public.pot_entries drop constraint if exists pot_entries_korrektur_check;
alter table public.pot_entries add constraint pot_entries_amount_check
  check (amount <> 0 and abs(amount) < 1000000 and (kind = 'korrektur' or amount > 0));
alter table public.pot_entries add constraint pot_entries_kind_check check (kind in ('ausgabe', 'korrektur'));
alter table public.pot_entries add constraint pot_entries_korrektur_check
  check (kind <> 'korrektur' or char_length(trim(note)) > 0);
