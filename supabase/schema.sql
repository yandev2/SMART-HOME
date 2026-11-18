-- Smart Home AI Assistant - Supabase Schema
-- Jalankan SQL ini di Supabase Dashboard -> SQL Editor

-- Ekstensi UUID & random bytes
create extension if not exists pgcrypto;

-- 1. Tabel Ruangan / Tempat (dinamis oleh user)
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

-- 2. Tabel Unit Hardware NodeMCU (1 NodeMCU bisa untuk 1 atau banyak relay)
create table if not exists public.controllers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  api_token text not null unique default encode(gen_random_bytes(24), 'hex'),
  last_seen timestamptz,
  created_at timestamptz not null default now()
);

-- 3. Tabel Perangkat / Relay (terhubung ke Ruangan & NodeMCU)
create table if not exists public.devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  room_id uuid references public.rooms(id) on delete set null,
  controller_id uuid references public.controllers(id) on delete set null,
  name text not null,
  aliases text not null default '',
  gpio_pin integer not null default 5, -- Contoh: 5 = D1 pada NodeMCU ESP8266
  active_low boolean not null default true, -- Mayoritas modul relay menggunakan Active LOW
  is_on boolean not null default false,
  updated_at timestamptz not null default now()
);

-- 4. Tabel Sesi Chat (menyimpan last_interaction_id dari Gemini Interactions API)
create table if not exists public.chat_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  last_interaction_id text,
  updated_at timestamptz not null default now()
);

-- 5. Tabel Riwayat Pesan Chat
create table if not exists public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  actions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

-- 6. Tabel Pengaturan User (menyimpan Gemini API Key terenkripsi & profil asisten per user)
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_gemini_api_key text,
  key_hint text,
  assistant_name text not null default 'Surya',
  assistant_gender text not null default 'laki-laki' check (assistant_gender in ('laki-laki', 'perempuan')),
  assistant_styles text[] not null default array['santai', 'ceria', 'suka bercanda']::text[],
  assistant_description text not null default '',
  updated_at timestamptz not null default now()
);

-- Migrasi aman jika tabel user_settings sudah dibuat sebelumnya
alter table public.user_settings
  add column if not exists assistant_name text not null default 'Surya',
  add column if not exists assistant_gender text not null default 'laki-laki',
  add column if not exists assistant_styles text[] not null default array['santai', 'ceria', 'suka bercanda']::text[],
  add column if not exists assistant_description text not null default '';

do $$
begin
  alter table public.user_settings
    add constraint chk_user_settings_gender
    check (assistant_gender in ('laki-laki', 'perempuan'));
exception when duplicate_object then null;
end $$;

-- Index untuk performa query
create index if not exists idx_rooms_user_id on public.rooms(user_id);
create index if not exists idx_controllers_user_id on public.controllers(user_id);
create index if not exists idx_controllers_token on public.controllers(api_token);
create index if not exists idx_devices_user_id on public.devices(user_id);
create index if not exists idx_devices_controller_id on public.devices(controller_id);
create index if not exists idx_chat_messages_user_id on public.chat_messages(user_id, created_at);

-- Trigger otomatis update kolom updated_at
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_devices_updated_at on public.devices;
create trigger trg_devices_updated_at
  before update on public.devices
  for each row execute function public.set_updated_at();

drop trigger if exists trg_chat_sessions_updated_at on public.chat_sessions;
create trigger trg_chat_sessions_updated_at
  before update on public.chat_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_user_settings_updated_at on public.user_settings;
create trigger trg_user_settings_updated_at
  before update on public.user_settings
  for each row execute function public.set_updated_at();

-- Aktifkan Row Level Security (RLS)
alter table public.rooms enable row level security;
alter table public.controllers enable row level security;
alter table public.devices enable row level security;
alter table public.chat_sessions enable row level security;
alter table public.chat_messages enable row level security;
alter table public.user_settings enable row level security;

-- Policies: User hanya bisa mengakses data miliknya sendiri
drop policy if exists "rooms_own_all" on public.rooms;
create policy "rooms_own_all" on public.rooms
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "controllers_own_all" on public.controllers;
create policy "controllers_own_all" on public.controllers
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "devices_own_all" on public.devices;
create policy "devices_own_all" on public.devices
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "chat_sessions_own_all" on public.chat_sessions;
create policy "chat_sessions_own_all" on public.chat_sessions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "chat_messages_own_all" on public.chat_messages;
create policy "chat_messages_own_all" on public.chat_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "user_settings_own_all" on public.user_settings;
create policy "user_settings_own_all" on public.user_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Aktifkan Supabase Realtime agar perubahan status perangkat langsung muncul di Web UI
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.controllers;
exception when duplicate_object then null;
end $$;

do $$
begin
  alter publication supabase_realtime add table public.devices;
exception when duplicate_object then null;
end $$;

