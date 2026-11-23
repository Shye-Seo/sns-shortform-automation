-- sns-shortform-automation · 기획 루프 스키마 (Supabase / PostgreSQL)
--
-- 실행: Supabase 대시보드 → SQL Editor → 이 파일 전체를 붙여넣고 Run.
-- 다시 실행해도 안전하다(create ... if not exists).
--
-- 이 앱은 데이터를 서버 함수(Vercel)에서만 읽고 씁니다. 브라우저는 Supabase에
-- 직접 붙지 않고, 서비스 롤 키는 서버 환경변수에만 있습니다. 그래서 모든 표에
-- RLS를 켜 두고, anon 키로는 아무 행도 보이지 않도록 정책을 만들지 않습니다.
-- (서비스 롤 키는 RLS를 우회합니다.)

create extension if not exists pgcrypto;

-- 1) 채널 정체성 — 계정마다 하나. 말투·타깃·고정 강점·금지 표현.
create table if not exists public.channel_identities (
  id          text primary key,
  name        text not null,
  handle      text not null default '',
  posture     text not null default '',
  audience    text not null default '',
  voice       text not null default '',
  strengths   jsonb not null default '[]'::jsonb,
  banned      jsonb not null default '[]'::jsonb,
  signature   jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now()
);

create index if not exists channel_identities_updated_at_idx
  on public.channel_identities (updated_at desc);

-- 2) 트렌드 보관함 — 참고 영상과 배수, 그리고 그 영상이 쓴 구조.
create table if not exists public.trend_vault_items (
  id            text primary key,
  url           text not null default '',
  title         text not null,
  author        text not null default '',
  transcript    text not null default '',
  views         bigint not null default 0 check (views >= 0),
  median_views  bigint not null default 0 check (median_views >= 0),
  multiplier    numeric(10, 2),
  level         text not null default 'unknown'
                check (level in ('viral', 'above', 'near', 'below', 'unknown')),
  structure     jsonb not null,
  note          text not null default '',
  saved_at      timestamptz not null default now()
);

create index if not exists trend_vault_items_saved_at_idx
  on public.trend_vault_items (saved_at desc);
create index if not exists trend_vault_items_multiplier_idx
  on public.trend_vault_items (multiplier desc nulls last);
create index if not exists trend_vault_items_level_idx
  on public.trend_vault_items (level);

-- 3) 합체 기획안 — 핵심 열은 목록·정렬용, 본문은 plan jsonb에 통째로.
create table if not exists public.content_plans (
  id             text primary key,
  topic          text not null,
  identity_id    text references public.channel_identities (id) on delete set null,
  identity_name  text not null default '',
  trend_id       text references public.trend_vault_items (id) on delete set null,
  trend_title    text not null default '',
  goal           text not null default 'save' check (goal in ('save', 'comment', 'follow', 'link')),
  chosen_hook    text not null default 'A' check (chosen_hook in ('A', 'B', 'C')),
  source         text not null default 'rules' check (source in ('rules', 'openai', 'anthropic')),
  total_sec      numeric(5, 2) not null default 0,
  plan           jsonb not null,
  created_at     timestamptz not null default now()
);

create index if not exists content_plans_created_at_idx
  on public.content_plans (created_at desc);
create index if not exists content_plans_topic_idx
  on public.content_plans (topic);
create index if not exists content_plans_identity_idx
  on public.content_plans (identity_id, created_at desc);

-- 4) 성과 로그 — 올린 영상의 숫자. 배수는 기록 시점의 중간값으로 계산해 남긴다.
create table if not exists public.performance_logs (
  id            text primary key,
  plan_id       text references public.content_plans (id) on delete set null,
  title         text not null,
  hook_pattern  text not null default 'story'
                check (hook_pattern in ('question', 'numbers', 'howto', 'contrarian', 'story')),
  posted_at     date not null default current_date,
  views         bigint not null default 0 check (views >= 0),
  saves         bigint not null default 0 check (saves >= 0),
  shares        bigint not null default 0 check (shares >= 0),
  follows       bigint not null default 0 check (follows >= 0),
  median_views  bigint not null default 0 check (median_views >= 0),
  multiplier    numeric(10, 2),
  created_at    timestamptz not null default now()
);

create index if not exists performance_logs_posted_at_idx
  on public.performance_logs (posted_at desc);
create index if not exists performance_logs_hook_pattern_idx
  on public.performance_logs (hook_pattern);
create index if not exists performance_logs_plan_idx
  on public.performance_logs (plan_id);

-- 5) RLS — 서버(서비스 롤)에서만 접근한다.
alter table public.channel_identities enable row level security;
alter table public.trend_vault_items  enable row level security;
alter table public.content_plans      enable row level security;
alter table public.performance_logs   enable row level security;

-- anon/authenticated 역할에는 정책을 주지 않는다 → 기본이 전부 거부다.
-- 나중에 앱 로그인을 붙여 사용자별로 나누고 싶다면, 각 표에 owner_key uuid를
-- 추가하고 아래처럼 정책을 만든다(주석을 풀어 쓰세요).
--
-- alter table public.content_plans add column if not exists owner_key uuid default auth.uid();
-- create policy "owner reads own plans" on public.content_plans
--   for select using (owner_key = auth.uid());
-- create policy "owner writes own plans" on public.content_plans
--   for insert with check (owner_key = auth.uid());

-- 6) 확인 — 네 표가 보이면 끝났습니다.
select table_name
from information_schema.tables
where table_schema = 'public'
  and table_name in ('channel_identities', 'trend_vault_items', 'content_plans', 'performance_logs')
order by table_name;
