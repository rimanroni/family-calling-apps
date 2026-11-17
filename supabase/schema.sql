-- addbuz family app: schema, RLS, 5-hour auto-delete and storage guard
-- Run once in Supabase Dashboard > SQL Editor.
--
-- IMPORTANT: neither the 5-hour cleanup nor the storage guard ever deletes a
-- row from public.profiles (or auth.users). Messages, photos, notices, room
-- membership and activity are disposable; family accounts are not.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  name text not null,
  phone text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  host_id uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.room_members (
  room_id uuid not null references public.rooms (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  muted boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table if not exists public.room_events (
  id bigserial primary key,
  room_id uuid references public.rooms (id) on delete cascade,
  user_id uuid references public.profiles (id) on delete set null,
  kind text not null,
  created_at timestamptz not null default now()
);

-- Chat text, images and join/leave notices all live here. Images are inline
-- base64, so deleting a row deletes the image too - no Storage bucket to fill.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  room_slug text not null,
  user_id uuid references auth.users (id) on delete cascade,
  name text not null,
  text text not null default '',
  image_data text,
  kind text not null default 'text',
  created_at timestamptz not null default now()
);

-- Activity history is metadata only (who did what, when): a message was sent,
-- a photo was shared, someone joined, a call started, the mic was muted, etc.
-- It is kept for 30 minutes (VITE_ACTIVITY_TTL_MINUTES), then deleted.
create table if not exists public.activity_log (
  id uuid primary key default gen_random_uuid(),
  room_slug text not null,
  actor text not null,
  action text not null,
  detail text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists activity_created_at_idx on public.activity_log (created_at);
create index if not exists activity_room_idx on public.activity_log (room_slug, created_at);
create index if not exists messages_created_at_idx on public.messages (created_at);
create index if not exists messages_room_idx on public.messages (room_slug, created_at);
create index if not exists room_events_created_at_idx on public.room_events (created_at);
create index if not exists room_members_joined_at_idx on public.room_members (joined_at);

insert into public.rooms (slug, name)
values ('addbuz', 'addbuz · Family room')
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.room_events enable row level security;
alter table public.messages enable row level security;
alter table public.activity_log enable row level security;

drop policy if exists "profiles readable" on public.profiles;
create policy "profiles readable" on public.profiles for select to authenticated using (true);
drop policy if exists "own profile insert" on public.profiles;
create policy "own profile insert" on public.profiles for insert to authenticated with check (auth.uid() = id);
drop policy if exists "own profile update" on public.profiles;
create policy "own profile update" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "rooms readable" on public.rooms;
create policy "rooms readable" on public.rooms for select to authenticated using (true);

drop policy if exists "members readable" on public.room_members;
create policy "members readable" on public.room_members for select to authenticated using (true);
drop policy if exists "join room" on public.room_members;
create policy "join room" on public.room_members for insert to authenticated with check (auth.uid() = user_id);
drop policy if exists "leave room" on public.room_members;
create policy "leave room" on public.room_members for delete to authenticated using (auth.uid() = user_id);
drop policy if exists "own mute state" on public.room_members;
create policy "own mute state" on public.room_members for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "events readable" on public.room_events;
create policy "events readable" on public.room_events for select to authenticated using (true);
drop policy if exists "events insert" on public.room_events;
create policy "events insert" on public.room_events for insert to authenticated with check (auth.uid() = user_id);

drop policy if exists "messages readable" on public.messages;
create policy "messages readable" on public.messages for select to authenticated using (true);
drop policy if exists "messages insert" on public.messages;
create policy "messages insert" on public.messages for insert to authenticated with check (auth.uid() = user_id);
-- Family app: anyone in the family can purge old data when storage is tight.
drop policy if exists "messages deletable" on public.messages;
create policy "messages deletable" on public.messages for delete to authenticated using (true);

drop policy if exists "activity readable" on public.activity_log;
create policy "activity readable" on public.activity_log for select to authenticated using (true);
drop policy if exists "activity insert" on public.activity_log;
create policy "activity insert" on public.activity_log for insert to authenticated with check (true);

-- Realtime: clients listen for INSERT events on these tables.
do $$
begin
  alter publication supabase_realtime add table public.messages;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.activity_log;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- Retention: content 5 hours, activity 30 minutes
-- ---------------------------------------------------------------------------

create or replace function public.cleanup_old_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Content only. public.profiles is intentionally never touched here.
  delete from public.messages
   where created_at < now() - make_interval(hours => 5);

  delete from public.activity_log
   where created_at < now() - make_interval(mins => 30);

  delete from public.room_events
   where created_at < now() - make_interval(hours => 5);

  delete from public.room_members
   where joined_at < now() - make_interval(hours => 5);

  delete from public.rooms
   where created_at < now() - make_interval(hours => 5)
     and not exists (select 1 from public.room_members m where m.room_id = public.rooms.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage guard: if the free 500 MB database is nearly full, wipe old data,
-- end every call (clients get this system message over Realtime and hang up),
-- and leave one short notice explaining what happened.
-- ---------------------------------------------------------------------------

create or replace function public.guard_storage()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  used_bytes bigint;
  limit_bytes bigint := 350 * 1024 * 1024; -- 350 MB, safely under 500 MB free cap
begin
  select
    pg_total_relation_size('public.messages'::regclass) +
    pg_total_relation_size('public.activity_log'::regclass) +
    pg_total_relation_size('public.room_events'::regclass) +
    pg_total_relation_size('public.room_members'::regclass) +
    pg_total_relation_size('public.profiles'::regclass)
  into used_bytes;

  if used_bytes > limit_bytes then
    -- Content only. Family accounts (public.profiles / auth.users) stay, so
    -- nobody has to create an account again after a storage wipe.
    delete from public.messages;
    delete from public.activity_log;
    delete from public.room_events;
    delete from public.room_members;

    -- Realtime INSERT -> every client receives this and force-ends the call.
    insert into public.messages (room_slug, user_id, name, text, kind)
    values ('addbuz', null, 'system',
            'Storage limit reached — call ended and all messages, photos and notices were cleared. Database is free again.',
            'system');
  end if;
end;
$$;

create or replace function public.addbuz_housekeeping()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.cleanup_old_data();
  perform public.guard_storage();
end;
$$;

do $$
begin
  begin perform cron.unschedule('addbuz-cleanup'); exception when others then null; end;
  begin perform cron.unschedule('addbuz-housekeeping'); exception when others then null; end;
  perform cron.schedule(
    'addbuz-housekeeping',
    '* * * * *',
    'select public.addbuz_housekeeping()'
  );
end;
$$;

-- Manual test:
-- select public.addbuz_housekeeping();
-- select jobid, schedule, command from cron.job;
