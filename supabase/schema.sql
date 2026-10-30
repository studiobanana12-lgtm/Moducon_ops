-- Run in Supabase SQL Editor. Do not insert admin accounts from the browser.
create table if not exists public.organizations (
 id uuid primary key default gen_random_uuid(), name text not null, created_at timestamptz not null default now()
);
create table if not exists public.memberships (
 user_id uuid not null references auth.users(id) on delete cascade,
 organization_id uuid not null references public.organizations(id) on delete cascade,
 role text not null check (role in ('admin','staff','client')),
 primary key (user_id,organization_id)
);
create table if not exists public.videos (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id) on delete cascade,
 title text not null,
 status text not null default 'review' check (status in ('draft','review','revision','approved','scheduled','published')),
 created_at timestamptz not null default now()
);
alter table public.organizations enable row level security;
alter table public.memberships enable row level security;
alter table public.videos enable row level security;
create or replace function public.is_staff() returns boolean language sql stable security definer set search_path = '' as $$
 select exists(select 1 from public.memberships m where m.user_id = (select auth.uid()) and m.role in ('admin','staff'))
$$;
revoke all on function public.is_staff() from public;
grant execute on function public.is_staff() to authenticated;
create policy "memberships_self_or_staff" on public.memberships for select to authenticated using (user_id = (select auth.uid()) or public.is_staff());
create policy "organizations_visible" on public.organizations for select to authenticated using (
 public.is_staff() or exists(select 1 from public.memberships m where m.organization_id=id and m.user_id=(select auth.uid()))
);
create policy "videos_read" on public.videos for select to authenticated using (
 public.is_staff() or exists(select 1 from public.memberships m where m.organization_id=videos.organization_id and m.user_id=(select auth.uid()))
);
create policy "videos_staff_insert" on public.videos for insert to authenticated with check (public.is_staff());
create policy "videos_staff_update" on public.videos for update to authenticated using (public.is_staff()) with check (public.is_staff());
-- Create accounts in Supabase Authentication > Users; assign memberships using SQL editor (trusted administrator only).
-- Client users must have membership role client and only their own organization_id.
