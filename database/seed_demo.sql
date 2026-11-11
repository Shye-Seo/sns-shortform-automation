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
