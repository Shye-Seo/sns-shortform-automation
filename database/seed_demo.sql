-- =============================================================================
-- shortform-engine demo seed (optional)
--   php backend/bin/migrate.php --fresh --seed
-- One tenant, one Instagram account, one project with a render job in the queue.
-- =============================================================================

USE shortform;

INSERT INTO tenants (id, code, name, plan, monthly_render_quota, status) VALUES
  (1, 'agency-a', '숭구리 스튜디오', 'agency', 300, 'active')
AS new
ON DUPLICATE KEY UPDATE name = new.name;

INSERT INTO creator_accounts
  (id, tenant_id, platform, handle, external_account_id, token_expires_at, scopes, status)
VALUES
  (1, 1, 'instagram-reels', '@ddung_guri', '17841400000000000', DATE_ADD(NOW(), INTERVAL 45 DAY),
   JSON_ARRAY('instagram_content_publish', 'instagram_basic', 'pages_read_engagement'), 'active')
AS new
ON DUPLICATE KEY UPDATE handle = new.handle;

INSERT INTO shortform_projects
  (id, tenant_id, creator_account_id, platform, idempotency_key, title, topic, language, target_duration_sec,
   hook_type, cta_goal, script, caption, hashtags, status, status_events)
VALUES
  (1, 1, 1, 'instagram-reels', 'demo-2026-11-01', '부산 신혼집 3평 주방 수납 정리법', '신혼집 주방 수납', 'ko', 45,
   'numbers', 'save',
   JSON_OBJECT(
     'schemaVersion', '1.0',
     'beats', JSON_ARRAY('hook', 'problem', 'solution', 'cta'),
     'scenes', JSON_ARRAY(
        JSON_OBJECT('id', 's1', 'beat', 'hook', 'index', 0, 'narration', '3평 주방, 이 세 가지만 바꾸세요.', 'startSec', 0, 'durationSec', 2.9),
        JSON_OBJECT('id', 's2', 'beat', 'problem', 'index', 1, 'narration', '수납장 문을 열 때마다 뭘 꺼낼지 몰라 헤매죠.', 'startSec', 2.9, 'durationSec', 8.1),
        JSON_OBJECT('id', 's3', 'beat', 'solution', 'index', 2, 'narration', '세로 칸막이와 회전 트레이, 그리고 문 안쪽 걸이입니다.', 'startSec', 11.0, 'durationSec', 26.0),
        JSON_OBJECT('id', 's4', 'beat', 'cta', 'index', 3, 'narration', '저장해 두고 주말에 하나씩 바꿔 보세요.', 'startSec', 37.0, 'durationSec', 8.0)
     ),
     'metrics', JSON_OBJECT('totalDurationSec', 45.0, 'hookDurationSec', 2.9)
   ),
   '3평 주방 수납, 이 세 가지만 바꾸면 끝납니다. 세로 칸막이 · 회전 트레이 · 문 안쪽 걸이.',
   JSON_ARRAY('#부산신혼집', '#주방수납', '#자취템', '#살림꿀팁'),
   'scripted',
   JSON_ARRAY(JSON_OBJECT('from', NULL, 'to', 'scripted', 'at', '2026-11-01T09:00:00+09:00', 'reason', 'seed')))
AS new
ON DUPLICATE KEY UPDATE title = new.title;

INSERT INTO render_jobs (id, tenant_id, project_id, platform, state, priority, payload, available_at, dedupe_key)
VALUES
  (1, 1, 1, 'instagram-reels', 'waiting', 7,
   JSON_OBJECT('projectId', 1, 'platform', 'instagram-reels', 'durationSec', 45, 'chunkCount', 4,
               'outputPath', '/renders/demo-kitchen.mp4', 'projectTitle', '부산 신혼집 3평 주방 수납 정리법',
               'tenantName', '숭구리 스튜디오'),
   NOW(), 'demo-kitchen-45s')
AS new
ON DUPLICATE KEY UPDATE priority = new.priority;

INSERT INTO hook_experiments (id, tenant_id, project_id, hypothesis, variants, metric, window_hours, alpha, status)
VALUES
  (1, 1, 1, '숫자형 훅이 질문형보다 3초 시청률이 높다',
   JSON_ARRAY(
     JSON_OBJECT('id', 'A', 'angle', 'question', 'text', '부산 신혼집, 왜 또 원래대로일까요?', 'hookSeconds', 2.95),
     JSON_OBJECT('id', 'B', 'angle', 'numbers', 'text', '3평 주방, 이 세 가지만 바꾸세요', 'hookSeconds', 2.59),
     JSON_OBJECT('id', 'C', 'angle', 'contrarian', 'text', '3평 주방, 더 하면 안 됩니다', 'hookSeconds', 3.25)
   ),
   'viewRate3s', 24, 0.05, 'running')
AS new
ON DUPLICATE KEY UPDATE hypothesis = new.hypothesis;


-- =============================================================================
-- 2부 · 숏폼 인터랙티브 응모 & 즉시 쿠폰 디스패치 데모 데이터
-- =============================================================================
-- 시나리오: 테넌트 1(숭구리 스튜디오)이 인스타 릴스 1편과 유튜브 쇼츠 1편에
-- "댓글에 '할인' 남기면 3,000원 쿠폰" 캠페인을 돌리고 있다.
--   · 캠페인 2개(인스타 진행 중, 유튜브 종료)
--   · 웹훅 이벤트 60건 — 48건 매칭, 6건 키워드 불일치(IGNORED), 1건 서명 불일치(REJECTED), 1건 중복(DUPLICATE)
--   · 발송 큐 40건 — DISPATCHED 28 / PENDING 6 / RETRY 3 / DEAD_LETTER 3
--   · 1회용 토큰 28건 — 사용 12 / 미사용 13 / 만료 3
--   · 전환 로그 — VIDEO_VIEW → COMMENT → LINK_CLICK → CLAIM → PURCHASE 단계별
-- UUID는 MD5 기반으로 결정적으로 만든다(재적재해도 같은 값, 시드 재현성).
-- =============================================================================

INSERT INTO interactive_campaigns
  (id, tenant_id, project_id, code, name, platform, content_ref, trigger_keywords, reward_label,
   reward_amount, total_reward_budget, claim_limit, max_claims_per_user, token_ttl_minutes,
   starts_at, ends_at, status)
VALUES
  (1, 1, 1, 'reels-drop-2026-11', '릴스 댓글 3,000원 쿠폰 드롭', 'instagram', 'reels_17894561234567890',
   JSON_ARRAY('할인', '선착순', '쿠폰'), '3,000원 즉시 할인', 3000, 3000000, 1000, 1, 15,
   '2026-11-10 10:00:00', '2026-11-24 23:59:59', 'live'),
  (2, 1, 1, 'shorts-drop-2026-10', '쇼츠 댓글 웰컴 쿠폰', 'youtube', 'yt_shorts_9f2c1a',
   JSON_ARRAY('쿠폰', '이벤트'), '2,000원 웰컴 쿠폰', 2000, 1000000, 500, 1, 15,
   '2026-10-20 18:00:00', '2026-10-31 23:59:59', 'ended')
AS new
ON DUPLICATE KEY UPDATE name = new.name, status = new.status;

-- 웹훅 이벤트 60건(캠페인1) — 댓글 52건 매칭, 8건 키워드 불일치, 2건 서명 실패 포함
INSERT INTO webhook_interaction_events
  (campaign_id, tenant_id, platform, external_event_id, event_type, content_ref,
   author_platform_id, author_handle, message_text, matched_keyword,
   signature_verified, processing_status, rejection_reason, raw_payload, received_at, processed_at)
WITH RECURSIVE seq AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM seq WHERE n < 60)
SELECT
  CASE WHEN n <= 50 THEN 1 ELSE NULL END,
  1,
  'instagram',
  CONCAT('ig_comment_', LPAD(n, 6, '0')),
  'comment',
  'reels_17894561234567890',
  SHA2(CONCAT('ig-user-', n), 256),
  SHA2(CONCAT('@shye_', n), 256),
  CASE
    WHEN n <= 42 THEN CONCAT('할인 받고 싶어요 ', n)
    WHEN n BETWEEN 43 AND 48 THEN CONCAT('선착순 쿠폰 주세요 ', n)
    WHEN n BETWEEN 49 AND 52 THEN CONCAT('쿠폰 기대할게요 ', n)
    ELSE CONCAT('영상 잘 보고 갑니다 ', n)
  END,
  CASE WHEN n <= 42 THEN '할인' WHEN n BETWEEN 43 AND 48 THEN '선착순' WHEN n BETWEEN 49 AND 52 THEN '쿠폰' ELSE NULL END,
  CASE WHEN n = 59 THEN 0 ELSE 1 END,
  CASE
    WHEN n = 59 THEN 'REJECTED'
    WHEN n = 60 THEN 'DUPLICATE'
    WHEN n > 52 THEN 'IGNORED'
    WHEN n <= 48 THEN 'DISPATCHED'
    ELSE 'QUEUED'
  END,
  CASE WHEN n = 59 THEN 'BAD_SIGNATURE' WHEN n = 60 THEN 'DUPLICATE_EVENT' WHEN n > 52 THEN 'NO_KEYWORD' ELSE NULL END,
  JSON_OBJECT('object', 'instagram', 'entry', JSON_ARRAY(JSON_OBJECT('id', CONCAT('ig_comment_', n)))),
  TIMESTAMPADD(SECOND, n * 7, TIMESTAMP('2026-11-10 10:00:00')),
  TIMESTAMPADD(SECOND, n * 7 + 1, TIMESTAMP('2026-11-10 10:00:00'))
FROM seq
ON DUPLICATE KEY UPDATE processing_status = VALUES(processing_status);

-- 발송 큐 40건 — 48건 매칭 중 40건만 큐에 들어갔다(8건은 예산/중복으로 미발송).
INSERT INTO dispatch_queue
  (campaign_id, interaction_event_id, channel, recipient_ref, idempotency_key, status, attempts,
   available_at, dispatch_deadline_at, dispatched_at, dead_letter_at, last_error, payload, created_at)
WITH target AS (
  SELECT e.id AS event_id, e.author_platform_id, e.received_at,
         ROW_NUMBER() OVER (ORDER BY e.id) AS rn
    FROM webhook_interaction_events e
   WHERE e.campaign_id = 1 AND e.processing_status IN ('DISPATCHED','QUEUED')
   ORDER BY e.id
   LIMIT 40
)
SELECT
  1, event_id, 'INSTAGRAM_DM', author_platform_id,
  CONCAT('dispatch-1-', event_id),
  CASE
    WHEN rn <= 28 THEN 'DISPATCHED'
    WHEN rn <= 34 THEN 'PENDING'
    WHEN rn <= 37 THEN 'RETRY'
    ELSE 'DEAD_LETTER'
  END,
  CASE WHEN rn <= 28 THEN 1 WHEN rn <= 37 THEN 2 ELSE 9 END,
  TIMESTAMPADD(SECOND, 1, received_at),
  TIMESTAMPADD(SECOND, 5, received_at),
  CASE WHEN rn <= 28 THEN TIMESTAMPADD(MICROSECOND, 900000, received_at) ELSE NULL END,
  CASE WHEN rn > 37 THEN TIMESTAMPADD(MICROSECOND, 5200000, received_at) ELSE NULL END,
  CASE WHEN rn > 37 THEN 'Meta rate limit (code 4) after 9 attempts' WHEN rn BETWEEN 35 AND 37 THEN 'Timeout after 2s' ELSE NULL END,
  JSON_OBJECT('deepLink', CONCAT('https://coupon.shye.kr/c/', CONCAT('token-', event_id)), 'templateCode', 'shortform_claim_v1'),
  received_at
FROM target
ON DUPLICATE KEY UPDATE status = VALUES(status);

-- 1회용 토큰 28건 — DISPATCHED 28건에 1:1로 발급됐다.
INSERT INTO instant_claim_tokens
  (campaign_id, dispatch_queue_id, token_uuid, token_hash, hmac_signature, reward_amount,
   is_claimed, claim_count, claimed_at, claimed_ip, expires_at, created_at)
WITH dispatched AS (
  SELECT d.id AS dispatch_id, d.created_at,
         ROW_NUMBER() OVER (ORDER BY d.id) AS rn
    FROM dispatch_queue d
   WHERE d.campaign_id = 1 AND d.status = 'DISPATCHED'
   ORDER BY d.id
)
SELECT
  1, dispatch_id,
  CONCAT(
    SUBSTR(MD5(CONCAT('tok-', dispatch_id)), 1, 8), '-',
    SUBSTR(MD5(CONCAT('tok-', dispatch_id)), 9, 4), '-4',
    SUBSTR(MD5(CONCAT('tok-', dispatch_id)), 14, 3), '-a',
    SUBSTR(MD5(CONCAT('tok-', dispatch_id)), 18, 3), '-',
    SUBSTR(MD5(CONCAT('tok-', dispatch_id)), 21, 12)
  ),
  SHA2(CONCAT('tok-', dispatch_id), 256),
  SHA2(CONCAT('sig-', dispatch_id, ':2026-11-10T10:15:00+09:00'), 256),
  3000,
  CASE WHEN rn <= 12 THEN 1 ELSE 0 END,
  CASE WHEN rn <= 12 THEN 1 ELSE 0 END,
  CASE WHEN rn <= 12 THEN TIMESTAMPADD(SECOND, 40, created_at) ELSE NULL END,
  CASE WHEN rn <= 12 THEN INET6_ATON(CONCAT('211.234.10.', rn)) ELSE NULL END,
  TIMESTAMPADD(MINUTE, 15, created_at),
  created_at
FROM dispatched
ON DUPLICATE KEY UPDATE is_claimed = VALUES(is_claimed);

-- 전환 퍼널 — 토큰이 있는 28건에 대해 단계별 로그(사용 12건은 PURCHASE까지)
INSERT INTO shortform_conversion_attributions
  (campaign_id, content_ref, interaction_event_id, claim_token_id, stage, order_id, order_amount, discount_amount, utm_source, occurred_at)
WITH tok AS (
  SELECT t.id AS token_id, t.dispatch_queue_id, t.created_at, t.is_claimed,
         ROW_NUMBER() OVER (ORDER BY t.id) AS rn
    FROM instant_claim_tokens t
   WHERE t.campaign_id = 1
), stages AS (
  SELECT 1 AS stage_no, 'VIDEO_VIEW' AS stage UNION ALL
  SELECT 2, 'COMMENT' UNION ALL
  SELECT 3, 'LINK_CLICK' UNION ALL
  SELECT 4, 'CLAIM' UNION ALL
  SELECT 5, 'PURCHASE'
)
SELECT
  1, 'reels_17894561234567890',
  (SELECT d.interaction_event_id FROM dispatch_queue d WHERE d.id = tok.dispatch_queue_id),
  tok.token_id,
  stages.stage,
  CASE WHEN stages.stage = 'PURCHASE' THEN CONCAT('20261110-', LPAD(tok.rn, 7, '0')) ELSE NULL END,
  CASE WHEN stages.stage = 'PURCHASE' THEN 32000 + tok.rn * 500 ELSE 0 END,
  CASE WHEN stages.stage = 'PURCHASE' THEN 3000 ELSE 0 END,
  'instagram',
  TIMESTAMPADD(SECOND, stages.stage_no * 20, tok.created_at)
FROM tok
CROSS JOIN stages
WHERE stages.stage_no <= CASE WHEN tok.is_claimed = 1 THEN 5 ELSE 3 END
ON DUPLICATE KEY UPDATE stage = VALUES(stage);
