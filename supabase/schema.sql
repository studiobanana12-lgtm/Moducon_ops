-- MODUCON OPS Full Schema — Step 2 (YouTube OAuth Delegation + Kill Switch + Audit Logs)
-- Idempotent: safe to re-run in Supabase SQL Editor without losing existing data.
-- Never insert admin accounts or service_role keys from the browser.

-- 1. Core Tables
create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.memberships (
  user_id uuid not null references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('admin', 'staff', 'client')),
  created_at timestamptz not null default now(),
  primary key (user_id, organization_id)
);

create table if not exists public.videos (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  status text not null default 'review' check (status in ('draft', 'review', 'revision', 'approved', 'scheduled', 'published')),
  storage_path text,
  feedback text default '',
  created_at timestamptz not null default now()
);

alter table public.videos add column if not exists storage_path text;
alter table public.videos add column if not exists feedback text default '';

create table if not exists public.publish_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  video_id uuid not null references public.videos(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram', 'tiktok', 'threads', 'x', 'naver')),
  scheduled_at timestamptz not null,
  status text not null default 'planned' check (status in ('planned', 'published', 'cancelled', 'failed')),
  created_at timestamptz not null default now()
);

-- 2. SNS Channels & OAuth Delegation Tables (Step 2)
create table if not exists public.social_channels (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null check (platform in ('youtube', 'instagram', 'tiktok', 'threads', 'x', 'naver')),
  handle text,
  channel_title text,
  avatar_url text,
  external_account_id text,
  status text not null default 'pending' check (status in ('pending', 'connected', 'expired', 'revoked')),
  permission_level text not null default 'viewer' check (permission_level in ('viewer', 'editor', 'publisher', 'full')),
  connected_by uuid references auth.users(id) on delete set null,
  connected_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_channels add column if not exists channel_title text;
alter table public.social_channels add column if not exists avatar_url text;
alter table public.social_channels add column if not exists external_account_id text;
alter table public.social_channels add column if not exists permission_level text not null default 'viewer';
alter table public.social_channels add column if not exists connected_by uuid references auth.users(id) on delete set null;
alter table public.social_channels add column if not exists connected_at timestamptz;
alter table public.social_channels add column if not exists expires_at timestamptz;
alter table public.social_channels add column if not exists revoked_at timestamptz;
alter table public.social_channels add column if not exists updated_at timestamptz not null default now();

create unique index if not exists social_channels_org_platform_uidx
  on public.social_channels (organization_id, platform);

-- Server-only encrypted OAuth token store (NO authenticated RLS policies = unreachable from browser)
create table if not exists public.social_channel_tokens (
  channel_id uuid primary key references public.social_channels(id) on delete cascade,
  access_token_enc text not null,
  refresh_token_enc text,
  scope text,
  token_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Server-only one-time OAuth state table for CSRF protection
create table if not exists public.oauth_states (
  state text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  platform text not null,
  permission_level text not null default 'viewer',
  access_expires_at timestamptz,
  return_url text not null,
  state_expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- Transparent security audit log visible to org members and staff
create table if not exists public.channel_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_id uuid references public.social_channels(id) on delete set null,
  actor_id uuid references auth.users(id) on delete set null,
  actor_role text not null default 'client',
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists channel_audit_logs_org_created_idx
  on public.channel_audit_logs (organization_id, created_at desc);

-- Step 3: Cached live channel statistics & recent video feed snapshots
create table if not exists public.social_channel_snapshots (
  channel_id uuid primary key references public.social_channels(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  subscriber_count bigint not null default 0,
  view_count bigint not null default 0,
  video_count integer not null default 0,
  recent_videos jsonb not null default '[]'::jsonb,
  synced_at timestamptz not null default now()
);

create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

-- 3. Enable Row Level Security (RLS)
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.videos enable row level security;
alter table public.publish_schedule enable row level security;
alter table public.social_channels enable row level security;
alter table public.social_channel_tokens enable row level security;
alter table public.oauth_states enable row level security;
alter table public.channel_audit_logs enable row level security;
alter table public.social_channel_snapshots enable row level security;
alter table public.app_settings enable row level security;

-- 4. Role Helper Functions
create or replace function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.role in ('admin', 'staff')
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists(
    select 1
    from public.memberships m
    where m.user_id = (select auth.uid())
      and m.role = 'admin'
  )
$$;

revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- 5. RLS Policies
drop policy if exists "memberships_self_or_staff" on public.memberships;
create policy "memberships_self_or_staff" on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_staff());

drop policy if exists "organizations_visible" on public.organizations;
create policy "organizations_visible" on public.organizations
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "videos_read" on public.videos;
create policy "videos_read" on public.videos
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = videos.organization_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "videos_staff_insert" on public.videos;
create policy "videos_staff_insert" on public.videos
  for insert to authenticated
  with check (public.is_staff());

drop policy if exists "videos_staff_update" on public.videos;
create policy "videos_staff_update" on public.videos
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

drop policy if exists "videos_staff_delete" on public.videos;
create policy "videos_staff_delete" on public.videos
  for delete to authenticated
  using (public.is_staff());

drop policy if exists "schedule_read" on public.publish_schedule;
create policy "schedule_read" on public.publish_schedule
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = publish_schedule.organization_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "schedule_staff_insert" on public.publish_schedule;
create policy "schedule_staff_insert" on public.publish_schedule
  for insert to authenticated
  with check (public.is_staff());

drop policy if exists "schedule_staff_update" on public.publish_schedule;
create policy "schedule_staff_update" on public.publish_schedule
  for update to authenticated
  using (public.is_staff())
  with check (public.is_staff());

drop policy if exists "channels_read" on public.social_channels;
create policy "channels_read" on public.social_channels
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = social_channels.organization_id and m.user_id = (select auth.uid())
    )
  );

-- NOTE: social_channel_tokens and oauth_states intentionally have NO authenticated policies.
-- Only Supabase Edge Functions using service_role can read/write them.

drop policy if exists "audit_logs_read" on public.channel_audit_logs;
create policy "audit_logs_read" on public.channel_audit_logs
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = channel_audit_logs.organization_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "snapshots_read" on public.social_channel_snapshots;
create policy "snapshots_read" on public.social_channel_snapshots
  for select to authenticated
  using (
    public.is_staff()
    or exists(
      select 1 from public.memberships m
      where m.organization_id = social_channel_snapshots.organization_id and m.user_id = (select auth.uid())
    )
  );

drop policy if exists "settings_read" on public.app_settings;
create policy "settings_read" on public.app_settings
  for select to authenticated
  using (true);

-- 6. RPC Functions
create or replace function public.create_customer_organization(customer_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_id uuid;
  trimmed text := trim(coalesce(customer_name, ''));
begin
  if not public.is_admin() then
    raise exception '관리자만 고객사를 등록할 수 있습니다.';
  end if;
  if char_length(trimmed) < 2 then
    raise exception '고객사 이름은 2자 이상이어야 합니다.';
  end if;
  insert into public.organizations(name) values (trimmed) returning id into new_id;
  return new_id;
end;
$$;

revoke all on function public.create_customer_organization(text) from public;
grant execute on function public.create_customer_organization(text) to authenticated;

create or replace function public.review_video(p_video_id uuid, p_status text, p_feedback text default '')
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  can_review boolean;
begin
  if p_status not in ('approved', 'revision') then
    raise exception '허용되지 않은 검수 상태입니다.';
  end if;

  select organization_id into v_org_id from public.videos where id = p_video_id;
  if v_org_id is null then
    raise exception '영상을 찾을 수 없습니다.';
  end if;

  can_review := public.is_staff() or exists(
    select 1 from public.memberships m
    where m.organization_id = v_org_id and m.user_id = (select auth.uid())
  );
  if not can_review then
    raise exception '이 영상을 검수할 권한이 없습니다.';
  end if;

  update public.videos
  set status = p_status,
      feedback = case when p_status = 'revision' then coalesce(p_feedback, '') else '' end
  where id = p_video_id;
end;
$$;

revoke all on function public.review_video(uuid, text, text) from public;
grant execute on function public.review_video(uuid, text, text) to authenticated;

create or replace function public.set_kakao_channel_url(p_url text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception '관리자만 상담 채널을 변경할 수 있습니다.';
  end if;
  insert into public.app_settings(key, value, updated_at)
  values ('kakao_channel_url', trim(coalesce(p_url, '')), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

revoke all on function public.set_kakao_channel_url(text) from public;
grant execute on function public.set_kakao_channel_url(text) to authenticated;

-- Client owner (or admin) updates delegated permission level / expiry on an active channel
create or replace function public.update_channel_permission(
  p_channel_id uuid,
  p_permission_level text,
  p_duration_days integer default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_platform text;
  v_status text;
  v_actor_role text;
  v_expires timestamptz;
begin
  if p_permission_level not in ('viewer', 'editor', 'publisher', 'full') then
    raise exception '허용되지 않은 권한 레벨입니다.';
  end if;

  select organization_id, platform, status
    into v_org_id, v_platform, v_status
  from public.social_channels
  where id = p_channel_id;

  if v_org_id is null then
    raise exception '연결된 채널을 찾을 수 없습니다.';
  end if;
  if v_status <> 'connected' then
    raise exception '연결 상태인 채널만 권한을 변경할 수 있습니다.';
  end if;

  -- Only the client belonging to this organization (never arbitrary staff) can change permissions
  if exists(
    select 1 from public.memberships m
    where m.organization_id = v_org_id
      and m.user_id = (select auth.uid())
      and m.role = 'client'
  ) then
    v_actor_role := 'client';
  elsif public.is_admin() then
    v_actor_role := 'admin';
  else
    raise exception '채널 소유자(고객사)만 권한을 변경할 수 있습니다.';
  end if;

  v_expires := case
    when p_duration_days is null or p_duration_days <= 0 then null
    else now() + make_interval(days => p_duration_days)
  end;

  update public.social_channels
  set permission_level = p_permission_level,
      expires_at = v_expires,
      updated_at = now()
  where id = p_channel_id;

  insert into public.channel_audit_logs(organization_id, channel_id, actor_id, actor_role, action, detail)
  values (
    v_org_id,
    p_channel_id,
    (select auth.uid()),
    v_actor_role,
    'permission_updated',
    jsonb_build_object(
      'platform', v_platform,
      'permission_level', p_permission_level,
      'duration_days', p_duration_days
    )
  );
end;
$$;

revoke all on function public.update_channel_permission(uuid, text, integer) from public;
grant execute on function public.update_channel_permission(uuid, text, integer) to authenticated;
