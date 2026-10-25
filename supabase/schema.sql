create table if not exists public.administrators (
  id integer primary key check (id = 1),
  email text not null unique check (email = lower(email)),
  password_salt text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.properties (
  id text primary key,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity (
  id bigint generated always as identity primary key,
  message text not null,
  time timestamptz not null default now()
);

create table if not exists public.settings (
  key text primary key,
  value text not null
);

alter table public.administrators enable row level security;
alter table public.properties enable row level security;
alter table public.activity enable row level security;
alter table public.settings enable row level security;

grant all on table public.administrators, public.properties, public.activity, public.settings to service_role;
grant usage, select on all sequences in schema public to service_role;

create or replace function public.import_initial_site_data(
  p_properties jsonb,
  p_administrator jsonb,
  p_activity jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (select 1 from public.properties)
    or exists (select 1 from public.administrators)
    or exists (select 1 from public.activity)
    or exists (select 1 from public.settings where key = 'initial-site-data-import-v1') then
    raise exception 'Initial data import requires empty application tables.';
  end if;

  insert into public.properties (id, data, updated_at)
  select p.id, p.data, p.updated_at
  from jsonb_to_recordset(p_properties) as p(id text, data jsonb, updated_at timestamptz);

  if p_administrator is not null then
    insert into public.administrators (id, email, password_salt, password_hash, created_at)
    select a.id, a.email, a.password_salt, a.password_hash, a.created_at
    from jsonb_to_record(p_administrator) as a(
      id integer,
      email text,
      password_salt text,
      password_hash text,
      created_at timestamptz
    );
  end if;

  insert into public.activity (message, time)
  select a.message, a.time
  from jsonb_to_recordset(p_activity) as a(message text, time timestamptz);

  insert into public.settings (key, value) values ('initial-site-data-import-v1', 'true');
end;
$$;

revoke all on function public.import_initial_site_data(jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.import_initial_site_data(jsonb, jsonb, jsonb) to service_role;
notify pgrst, 'reload schema';

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('property-photos', 'property-photos', true, 1500000, array['image/jpeg'])
on conflict (id) do update
set public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
