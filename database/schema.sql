-- =============================================================================
-- shortform-engine · B2B 숏폼 렌더 큐 & 멀티테넌트 발행 플랫폼 — MySQL 8.0 DDL
-- =============================================================================
-- 실행
--   docker compose up -d mysql          (리포지토리 루트)
--   php backend/bin/migrate.php --fresh --seed --verify
--
-- 이 스키마의 전제
--   1) 큐의 상태는 "메모리 변수"가 아니라 행이다. waiting → delayed → active →
--      completed | failed → dlq 전이가 행에 남아야 워커가 죽어도 작업이 살아난다.
--   2) 테넌트(대행사) 하나가 다른 테넌트의 예약을 밀어내지 않아야 한다. 그래서 모든
--      업무 테이블의 인덱스는 tenant_id로 시작하고, 작업 선점도 테넌트 스코프 안에서 한다.
--   3) 외부 API(Meta Graph)는 25건/일 쿼터와 "컨테이너 준비 대기"라는 두 가지 제약을 준다.
--      그 사실이 publish_logs(쿼터 사용량·컨테이너 상태)에 남아야 사후 분석이 된다.
--   4) 대본(4비트)과 텔레메트리는 형태가 자주 바뀌는 데이터다. JSON 컬럼으로 두고,
--      조회에 필요한 값(상태·기간·훅 유형)만 정규 컬럼으로 꺼낸다.
-- =============================================================================

SET NAMES utf8mb4;
SET time_zone = '+09:00';

CREATE DATABASE IF NOT EXISTS shortform
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE shortform;

-- -----------------------------------------------------------------------------
-- 1. tenants — 대행사(테넌트)
-- -----------------------------------------------------------------------------
-- 렌더 쿼터는 "테넌트 플랜"에 붙는다(대행사 요금제). 한 테넌트의 폭주가 다른 테넌트의
-- 잡을 지연시키지 않도록, 큐 조회·워커 배정은 항상 tenant_id 범위에서 이뤄진다.
-- -----------------------------------------------------------------------------
CREATE TABLE tenants (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '테넌트 PK',
  code                VARCHAR(32)     NOT NULL                COMMENT '테넌트 코드(agency-a 등). API 키 이름과 1:1',
  name                VARCHAR(120)    NOT NULL                COMMENT '대행사명',
  plan                ENUM('starter','growth','agency') NOT NULL DEFAULT 'starter' COMMENT '요금제. 렌더 동시성·월 쿼터의 근거',
  monthly_render_quota INT UNSIGNED   NOT NULL DEFAULT 30     COMMENT '월 렌더 상한(편). 0이면 무제한 아님 — 플랜 값으로 채운다',
  api_key_hash        CHAR(64)        NULL                    COMMENT 'API 키의 SHA-256. 원문은 저장하지 않는다',
  status              ENUM('active','suspended','archived') NOT NULL DEFAULT 'active',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tenants_code (code),
  UNIQUE KEY uq_tenants_api_key (api_key_hash) COMMENT 'NULL은 중복 허용(아직 키를 안 만든 테넌트)',
  KEY idx_tenants_status_plan (status, plan),
  CONSTRAINT chk_tenants_quota CHECK (monthly_render_quota <= 100000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='대행사(테넌트). 큐·쿼터·레이트리밋의 격리 단위';

-- -----------------------------------------------------------------------------
-- 2. creator_accounts — 발행 대상 계정(Instagram Business / YouTube 채널)
-- -----------------------------------------------------------------------------
-- 토큰은 암호문만 저장한다(token_ciphertext). 왜 JSON 한 컬럼이 아니라 별 컬럼인가:
-- 만료·갱신 상태를 조건으로 조회해야 하기 때문이다("만료 24시간 이내 + active" 스캔).
-- refresh_lock_until은 OAuth single-flight용 짧은 lease다. 30개 예약이 동시에 만료 토큰을
-- 만나도 갱신은 1회만 일어나야 한다(동시 갱신은 이전 토큰을 무효화해 전부 실패시킨다).
-- -----------------------------------------------------------------------------
CREATE TABLE creator_accounts (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '계정 PK',
  tenant_id             BIGINT UNSIGNED NOT NULL                COMMENT '소유 대행사',
  platform              ENUM('instagram-reels','youtube-shorts') NOT NULL COMMENT '발행 플랫폼',
  handle                VARCHAR(80)     NOT NULL                COMMENT '표시용 핸들(@seo.busan)',
  external_account_id   VARCHAR(64)     NOT NULL                COMMENT 'IG Business User ID 또는 YouTube channel ID',
  token_ciphertext      VARBINARY(1024) NULL                    COMMENT '장기 액세스 토큰 암호문(AES-256-GCM). 평문 저장 금지',
  token_expires_at      DATETIME(3)     NULL                    COMMENT '토큰 만료 시각(장기 토큰은 60일)',
  token_refreshed_at    DATETIME(3)     NULL                    COMMENT '마지막 갱신 성공 시각',
  refresh_lock_until    DATETIME(3)     NULL                    COMMENT '갱신 single-flight lease. 이 시각 전에는 다른 워커가 갱신하지 않는다',
  scopes                JSON            NULL                    COMMENT '부여된 스코프(instagram_content_publish 등)',
  status                ENUM('active','expired','revoked') NOT NULL DEFAULT 'active' COMMENT 'expired=갱신 필요, revoked=사용자 철회',
  created_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at            DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_creator_account (tenant_id, platform, external_account_id) COMMENT '같은 테넌트에 같은 외부 계정 중복 연결 방지',
  KEY idx_creator_expiring (status, token_expires_at) COMMENT '만료 임박 스캔(갱신 워커)',
  KEY idx_creator_tenant (tenant_id, platform),
  CONSTRAINT fk_creator_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='발행 대상 계정과 토큰 상태(암호문)';

-- -----------------------------------------------------------------------------
-- 3. shortform_projects — 프로젝트(대본·캡션·승인)
-- -----------------------------------------------------------------------------
-- 대본은 4비트(hook → problem → solution* → cta) 구조다. 비트 순서·3초 훅 제한은
-- 애플리케이션이 검증하지만, "무엇을 만들었는지"는 JSON으로 통째로 남긴다.
--   · script JSON: scenes[](beat, narration, startSec, durationSec …), metrics, compression
--   · hook 3안은 hook_experiments에 따로 남긴다(실험이 도는 동안 바뀌지 않아야 한다)
--
-- 승인(approval)은 사람이 검토한 지문이다. content_hash(대본+캡션+자막의 sha256)를 저장해
-- 두고, 승인 후 대본이 한 글자라도 바뀌면 발행 직전 해시 비교에서 막는다.
-- (승인 없는 발행, 승인 후 내용 변경 발행 — 둘 다 실제로 사고가 나는 지점이다)
-- -----------------------------------------------------------------------------
CREATE TABLE shortform_projects (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '프로젝트 PK',
  tenant_id          BIGINT UNSIGNED NOT NULL                COMMENT '소유 대행사',
  creator_account_id BIGINT UNSIGNED NOT NULL                COMMENT '발행 대상 계정',
  platform           ENUM('instagram-reels','youtube-shorts') NOT NULL COMMENT '발행 플랫폼(계정과 일치해야 하지만 렌더 규격 선택에 필요)',
  idempotency_key    VARCHAR(80)     NOT NULL                COMMENT '외부 요청 중복 생성 방지(테넌트 내 유니크)',
  title              VARCHAR(100)    NOT NULL                COMMENT '영상 제목',
  topic              VARCHAR(300)    NOT NULL                COMMENT '주제/프롬프트',
  language           ENUM('ko','en') NOT NULL DEFAULT 'ko',
  target_duration_sec SMALLINT UNSIGNED NOT NULL DEFAULT 60  COMMENT '목표 길이(초). 플랫폼 상한은 60',
  hook_type          ENUM('question','numbers','shock','howto','contrarian') NOT NULL DEFAULT 'question',
  cta_goal           ENUM('follow','save','comment','link') NOT NULL DEFAULT 'save',
  script             JSON            NOT NULL                COMMENT '4비트 대본 + 타임라인 + 압축 리포트',
  caption            VARCHAR(2200)   NOT NULL                COMMENT '최종 캡션(해시태그 포함 가능)',
  hashtags           JSON            NOT NULL                COMMENT '해시태그 배열(최대 30)',
  approval           JSON            NULL                    COMMENT 'approved, approvedAt, approvedBy, contentHash, notes',
  content_hash       CHAR(64)        NULL                    COMMENT '승인 시점의 대본+캡션+자막 sha256. 발행 직전 재검증',
  status             ENUM('draft','scripted','rendering','rendered','publishing','published','failed')
                     NOT NULL DEFAULT 'draft' COMMENT '상태머신의 현재 위치. 전이는 status_events에 남는다',
  status_events      JSON            NOT NULL                COMMENT '전이 이력 [{from,to,at,reason}] — 행 1개로 이력 전체 보존',
  failure_reason     VARCHAR(500)    NULL                    COMMENT '실패 사유(상태=failed일 때)',
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  published_at       DATETIME(3)     NULL                    COMMENT '첫 발행 성공 시각',
  PRIMARY KEY (id),
  UNIQUE KEY uq_project_idempotency (tenant_id, idempotency_key) COMMENT '재시도 요청이 영상을 두 번 만들지 않는다',
  KEY idx_project_tenant_status (tenant_id, status, created_at) COMMENT '대시보드: 테넌트별 상태 목록',
  KEY idx_project_creator (creator_account_id, created_at),
  CONSTRAINT fk_project_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_project_creator FOREIGN KEY (creator_account_id) REFERENCES creator_accounts (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_project_duration CHECK (target_duration_sec BETWEEN 10 AND 60),
  CONSTRAINT chk_project_script CHECK (JSON_VALID(script)),
  CONSTRAINT chk_project_hashtags CHECK (JSON_VALID(hashtags))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='숏폼 프로젝트(대본·캡션·승인·상태 이력)';

-- -----------------------------------------------------------------------------
-- 4. render_jobs — 분산 렌더 큐(durable state machine)
-- -----------------------------------------------------------------------------
-- 큐를 Redis가 아니라 MySQL에 두는 이유: 이 시스템의 단위 작업은 "8분짜리 4K 인코딩"이다.
-- 초당 수만 건을 처리하는 큐가 아니라, 실패하면 사람이 원인을 확인해야 하는 큐다.
-- 그래서 (1) 작업 상태와 전이 이력이 트랜잭션으로 남고, (2) 재시작해도 그대로 살아 있으며,
-- (3) SQL로 "이 테넌트가 왜 밀렸나"를 바로 물어볼 수 있는 편이 낫다.
--
-- 선점은 MySQL 8.0의 `SELECT … FOR UPDATE SKIP LOCKED`로 한다. 잠긴 행을 건너뛰므로
-- 워커 N개가 같은 작업을 두 번 집어가지 않고, 서로를 기다리지도 않는다.
-- lease_expires_at이 지난 active 작업은 "죽은 워커의 작업"으로 보고 회수한다(stalled).
--
-- 인덱스
--   · idx_jobs_queue (state, priority DESC, available_at, id)
--       스케줄러의 유일한 핫 패스: "지금 실행 가능한 작업을 우선순위 높은 순, 같은 우선순위면
--       먼저 들어온 순". PRIORITY를 DESC로 저장해 filesort를 없앤다. tenant_id를 선두에
--       넣지 않은 이유: 전역 스케줄링(공정 분배)이 테넌트 경계를 넘어야 하기 때문이며,
--       대신 테넌트 단위 조회는 idx_jobs_tenant_state가 담당한다.
--   · uq_jobs_dedupe (tenant_id, dedupe_key) — 같은 영상의 중복 렌더 차단. NULL 허용이라
--       dedupe_key가 없는 잡은 여러 개 있어도 된다(MySQL 유니크 인덱스는 NULL 중복 허용).
-- -----------------------------------------------------------------------------
CREATE TABLE render_jobs (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '잡 PK',
  tenant_id         BIGINT UNSIGNED NOT NULL                COMMENT '소유 테넌트(격리 단위)',
  project_id        BIGINT UNSIGNED NOT NULL                COMMENT '대상 프로젝트',
  platform          ENUM('instagram-reels','youtube-shorts') NOT NULL COMMENT '렌더 규격(9:16 공통, 길이·비트레이트 상이)',
  state             ENUM('waiting','delayed','active','completed','failed','dlq') NOT NULL DEFAULT 'waiting'
                    COMMENT 'waiting=대기, delayed=재시도/예약, active=실행중, failed=비재시도 실패, dlq=격리',
  priority          TINYINT UNSIGNED NOT NULL DEFAULT 5     COMMENT '0=백필, 9=유료 테넌트 예약. 높을수록 먼저',
  attempts          TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '시작된 횟수(max_attempts로 제한)',
  max_attempts      TINYINT UNSIGNED NOT NULL DEFAULT 3,
  progress          DECIMAL(5,2)    NOT NULL DEFAULT 0.00   COMMENT '0~100. 단조 증가(뒤로 가는 이벤트는 버린다)',
  payload           JSON            NOT NULL                COMMENT '렌더 입력(대본 요약, 길이, 청크 수, 출력 경로)',
  result            JSON            NULL                    COMMENT '완료 결과(출력 경로, 청크, 인코딩 초, probe)',
  available_at      DATETIME(3)     NOT NULL                COMMENT '스케줄러가 실행해도 되는 가장 이른 시각',
  started_at        DATETIME(3)     NULL,
  finished_at       DATETIME(3)     NULL,
  lease_expires_at  DATETIME(3)     NULL                    COMMENT 'active 작업의 소유권 만료. 지나면 stalled로 회수',
  worker_id         VARCHAR(64)     NULL                    COMMENT '작업을 잡은 워커',
  dedupe_key        VARCHAR(120)    NULL                    COMMENT '멱등 키(같은 영상 중복 렌더 방지)',
  last_error        VARCHAR(2000)   NULL                    COMMENT '마지막 실패 메시지(재시도 판단 근거)',
  created_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at        DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_jobs_queue (state, priority DESC, available_at, id) COMMENT '스케줄러 핫 패스(우선순위→도래 시각→id)',
  KEY idx_jobs_tenant_state (tenant_id, state, created_at) COMMENT '테넌트별 큐 현황',
  KEY idx_jobs_project (project_id, platform) COMMENT '프로젝트의 렌더 잡 조회',
  KEY idx_jobs_lease (state, lease_expires_at) COMMENT 'stalled 회수 스캔',
  UNIQUE KEY uq_jobs_dedupe (tenant_id, dedupe_key) COMMENT '중복 렌더 차단(NULL 허용)',
  CONSTRAINT fk_jobs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_jobs_project FOREIGN KEY (project_id) REFERENCES shortform_projects (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_jobs_progress CHECK (progress >= 0 AND progress <= 100),
  CONSTRAINT chk_jobs_attempts CHECK (attempts <= max_attempts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='내구성 렌더 큐. 상태·이력·lease가 모두 행에 있다';

-- -----------------------------------------------------------------------------
-- 5. publish_logs — 발행 시도와 결과(Meta Graph API)
-- -----------------------------------------------------------------------------
-- Instagram Content Publishing은 3단계다: 컨테이너 생성 → status_code=FINISHED 대기 →
-- media_publish. 중간에 죽으면 컨테이너만 남고 발행은 안 된 상태가 된다. 그래서 컨테이너 ID와
-- 각 단계 시각을 남겨 "어디까지 갔는지"를 복구할 수 있게 한다(컨테이너는 24시간 유효).
--
-- 쿼터: Instagram은 24시간에 API 발행 25건이다. 발행 전 content_publishing_limit을 조회해
-- 남은 양을 확인하고, 사용량을 이 행에 남긴다(쿼터 소진은 재시도로 풀리지 않는 실패다).
--
-- 웹훅 멱등성: Meta는 24시간 동안 같은 이벤트를 재전송한다. last_event_id가 같은 이벤트면
-- UPDATE가 0행이 되도록 조건을 걸어 중복 집계를 막는다.
-- -----------------------------------------------------------------------------
CREATE TABLE publish_logs (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '발행 시도 PK',
  tenant_id          BIGINT UNSIGNED NOT NULL                COMMENT '소유 테넌트',
  project_id         BIGINT UNSIGNED NOT NULL                COMMENT '대상 프로젝트',
  creator_account_id BIGINT UNSIGNED NOT NULL                COMMENT '발행 계정',
  platform           ENUM('instagram-reels','youtube-shorts') NOT NULL,
  status             ENUM('container_created','in_progress','published','failed','expired')
                     NOT NULL DEFAULT 'container_created' COMMENT '컨테이너 생성 → 처리중 → 발행/실패/만료',
  container_id       VARCHAR(64)     NULL                    COMMENT 'IG 미디어 컨테이너 ID(24시간 유효)',
  media_id           VARCHAR(64)     NULL                    COMMENT '발행된 미디어 ID(웹훅 매칭 키)',
  permalink          VARCHAR(255)    NULL                    COMMENT '발행 URL',
  attempts           TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '발행 시도 횟수',
  quota_used         SMALLINT UNSIGNED NULL                  COMMENT '발행 시점의 24시간 쿼터 사용량',
  quota_total        SMALLINT UNSIGNED NULL                  COMMENT '쿼터 상한(기본 25)',
  caption_hash       CHAR(64)        NOT NULL                COMMENT '발행한 캡션의 sha256. 승인 지문과 대조',
  request_payload    JSON            NULL                    COMMENT 'Graph API 요청(토큰 제외)',
  response_payload   JSON            NULL                    COMMENT 'Graph API 응답 원문',
  last_event_id      VARCHAR(120)    NULL                    COMMENT '마지막으로 반영한 웹훅 이벤트 id(중복 수신 차단)',
  error_code         INT             NULL                    COMMENT 'Meta 오류 코드(9007 등)',
  error_message      VARCHAR(500)    NULL                    COMMENT 'Meta 오류 메시지 + 사람이 읽는 힌트',
  published_at       DATETIME(3)     NULL,
  last_polled_at     DATETIME(3)     NULL                    COMMENT '컨테이너 상태 마지막 조회 시각',
  created_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_publish_project_platform (project_id, platform) COMMENT '프로젝트당 플랫폼별 발행 기록 1건',
  UNIQUE KEY uq_publish_container (container_id) COMMENT '컨테이너 중복 매칭 방지',
  KEY idx_publish_media (media_id) COMMENT '웹훅이 media_id로 찾는다',
  KEY idx_publish_tenant_status (tenant_id, status, created_at) COMMENT '테넌트별 발행 현황',
  CONSTRAINT fk_publish_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_publish_project FOREIGN KEY (project_id) REFERENCES shortform_projects (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_publish_creator FOREIGN KEY (creator_account_id) REFERENCES creator_accounts (id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT chk_publish_quota CHECK (quota_used IS NULL OR quota_total IS NULL OR quota_used <= quota_total)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='발행 시도·컨테이너·쿼터·웹훅 멱등 키';

-- -----------------------------------------------------------------------------
-- 6. hook_experiments — 훅 A/B 실험과 성과 집계
-- -----------------------------------------------------------------------------
-- 첫 3초(훅)가 시청 지속을 결정한다는 것이 이 제품의 가설이다. 대본을 만들 때 훅 3안을
-- 생성해 나눠 발행하고, 플랫폼 웹훅으로 들어오는 지표(3초 시청률, 완주율)로 판정한다.
--
-- variants JSON: [{id:'A', angle:'question', text:'…', hookSeconds:2.95}, …] (2~4안)
-- results JSON : {metric:'viewRate3s', window:'24h', computedAt, variants:[{id, successes,
--                trials, lower, upper, lift, pValue}], status:'winner'|'inconclusive'}
-- 지표를 별 테이블로 정규화하지 않은 이유: 실험 단위 통계(신뢰구간·p값)는 실험이 끝날 때
-- 한 번 계산되는 값이고, 원자료(웹훅 샘플)는 플랫폼 쪽에 있다. 여기서는 "판정 결과"만 남긴다.
-- -----------------------------------------------------------------------------
CREATE TABLE hook_experiments (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '실험 PK',
  tenant_id      BIGINT UNSIGNED NOT NULL                COMMENT '소유 테넌트',
  project_id     BIGINT UNSIGNED NOT NULL                COMMENT '대상 프로젝트',
  hypothesis     VARCHAR(200)    NOT NULL                COMMENT '가설(예: 숫자형 훅이 질문형보다 3초 시청률이 높다)',
  variants       JSON            NOT NULL                COMMENT '훅 후보 2~4안(angle·text·hookSeconds)',
  metric         ENUM('viewRate3s','retention','commentRate') NOT NULL DEFAULT 'viewRate3s' COMMENT '판정 지표',
  window_hours   SMALLINT UNSIGNED NOT NULL DEFAULT 24   COMMENT '지표 수집 창(24h/168h=7d)',
  alpha          DECIMAL(4,3)    NOT NULL DEFAULT 0.050  COMMENT '유의수준(기본 0.05)',
  required_sample SMALLINT UNSIGNED NOT NULL DEFAULT 200 COMMENT '판정에 필요한 최소 표본(안별)',
  status         ENUM('running','concluded') NOT NULL DEFAULT 'running',
  winner_variant CHAR(8)         NULL                    COMMENT '우승 안 id(A/B/C)',
  results        JSON            NULL                    COMMENT '판정 결과(신뢰구간·p값·lift)',
  started_at     DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  concluded_at   DATETIME(3)     NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_experiment_project (project_id) COMMENT '프로젝트당 실험 1개',
  KEY idx_experiment_tenant_status (tenant_id, status, started_at) COMMENT '진행 중 실험 목록',
  CONSTRAINT fk_experiment_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_experiment_project FOREIGN KEY (project_id) REFERENCES shortform_projects (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_experiment_variants CHECK (JSON_LENGTH(variants) BETWEEN 2 AND 4)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='훅 A/B 실험 정의와 판정 결과';

-- -----------------------------------------------------------------------------
-- 7. alimtalk_notifications — SENS 알림톡(렌더 완료·발행 완료·실패)
-- -----------------------------------------------------------------------------
-- 언제 알리나: (1) 렌더 완료 → 크리에이터가 검수, (2) 발행 성공 → URL 전달,
-- (3) 실패/쿼터 소진 → 운영자. 알림은 부가 효과이지 파이프라인의 일부가 아니다.
-- 발송 실패가 렌더나 발행을 실패시키면 안 되므로, 실패는 status='failed'로 남기고 재시도한다.
--
-- dedupe_key UNIQUE: 같은 프로젝트·같은 이벤트는 한 번만. 워커가 재시도해도 문자가 두 번 가지 않는다.
-- -----------------------------------------------------------------------------
CREATE TABLE alimtalk_notifications (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '알림 PK',
  tenant_id           BIGINT UNSIGNED NOT NULL                COMMENT '수신 테넌트',
  project_id          BIGINT UNSIGNED NULL                    COMMENT '관련 프로젝트(운영 공지는 NULL)',
  event               ENUM('render_completed','publish_completed','publish_failed','quota_exhausted')
                      NOT NULL                                COMMENT '알림 계기(템플릿 선택 기준)',
  template_code       VARCHAR(40)     NOT NULL                COMMENT 'SENS에 검수된 템플릿 코드',
  plus_friend_id      VARCHAR(40)     NOT NULL                COMMENT '카카오 채널 ID(@…)',
  recipient_phone     VARCHAR(20)     NOT NULL                COMMENT '수신 번호(숫자만, 마스킹 저장)',
  recipient_role      ENUM('creator','operator') NOT NULL DEFAULT 'creator' COMMENT '수신자 역할',
  dedupe_key          VARCHAR(120)    NOT NULL                COMMENT '중복 발송 차단 키. UNIQUE',
  status              ENUM('queued','accepted','sent','delivered','failed','fallback_sent')
                      NOT NULL DEFAULT 'queued'               COMMENT 'queued=적재, accepted=202, delivered=0000',
  request_id          VARCHAR(80)     NULL                    COMMENT 'SENS 요청 id',
  message_id          VARCHAR(80)     NULL                    COMMENT 'SENS 메시지 id(결과 조회 키)',
  message_status_code VARCHAR(8)      NULL                    COMMENT 'SENS 수신 코드(0000 정상)',
  attempts            TINYINT UNSIGNED NOT NULL DEFAULT 0,
  request_payload     JSON            NULL                    COMMENT '실제 전송 본문(CS 추적)',
  response_payload    JSON            NULL                    COMMENT 'SENS 응답 원문',
  error_message       VARCHAR(500)    NULL,
  sent_at             DATETIME(3)     NULL,
  delivered_at        DATETIME(3)     NULL,
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_notification_dedupe (dedupe_key) COMMENT '같은 이벤트는 한 번만',
  KEY idx_notification_tenant_created (tenant_id, created_at) COMMENT '테넌트별 알림 이력',
  KEY idx_notification_status (status, created_at) COMMENT '재시도 워커',
  CONSTRAINT fk_notification_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_notification_project FOREIGN KEY (project_id) REFERENCES shortform_projects (id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='SENS 알림톡 발송·도달 이력(멱등 키)';

-- =============================================================================
-- 2부 · 숏폼 인터랙티브 실시간 응모 & 토스형 즉시 할인쿠폰 디스패치
-- =============================================================================
-- 왜 이 계층이 필요한가
--   1부는 "영상 1편을 만들어 예약 발행하는 일"을 자동화한다. 그 다음 문제는
--   **발행한 영상이 만든 트래픽을 돈으로 바꾸는 일**이다. 인스타 릴스 댓글에
--   '할인'이라고 쓴 사람에게 5초 안에 1회용 쿠폰 딥링크를 보내고, 그 링크가
--   실제 결제로 이어졌는지(ROAS)까지 세는 것이 이 파트의 목표다.
--
-- 이 파트가 지키는 네 가지
--   1) 웹훅은 **재전송된다**. Meta는 응답이 늦으면 같은 이벤트를 다시 보낸다.
--      external_event_id UNIQUE가 같은 댓글로 두 번 쿠폰을 보내지 않게 막는다.
--   2) 발송은 **5초 SLA**다. 큐에 인큐만 하고 응답하면 사용자는 댓글을 쓴 뒤
--      30초를 기다린다. 그래서 dispatch_deadline_at을 행에 박고, 지연분은
--      DEAD_LETTER로 분리해 원인을 센다.
--   3) 딥링크 토큰은 **1회용·15분 TTL**이다. token_hash(UNIQUE)로만 검증하고
--      원문 토큰은 저장하지 않는다. 링크가 단톡방에 뿌려져도 두 번 쓸 수 없다.
--   4) 전환은 **단계별로 남긴다**(노출→클릭→수령→구매). 마지막 값만 저장하면
--      "어디서 새는지"를 알 수 없고, ROAS를 계산할 근거도 사라진다.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 8. interactive_campaigns — 숏폼 연계 프로모션
-- -----------------------------------------------------------------------------
-- 트리거 키워드는 JSON 배열이다('할인', '선착순', '쿠폰' …). 별 테이블로 정규화하지
-- 않은 이유: 키워드는 캠페인과 함께 읽고 함께 바뀌는 값이고(부분 갱신 없음),
-- 조회는 항상 "이 캠페인의 키워드 집합" 단위다. 대신 키워드 매칭 결과는
-- webhook_interaction_events.matched_keyword에 남겨 집계가 가능하게 한다.
--
-- total_reward_budget은 "이 캠페인에서 나갈 수 있는 총 할인액"이다. 장수(claim_limit)와
-- 따로 두는 이유는 1부와 같다 — 쿠폰 종류가 섞이면 장수만으로 예산을 통제할 수 없다.
-- -----------------------------------------------------------------------------
CREATE TABLE interactive_campaigns (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '캠페인 PK',
  tenant_id           BIGINT UNSIGNED NOT NULL                COMMENT '소유 테넌트(대행사)',
  project_id          BIGINT UNSIGNED NULL                    COMMENT '연결된 숏폼 프로젝트(shortform_projects)',
  code                VARCHAR(40)     NOT NULL                COMMENT '캠페인 코드(reels-drop-2026-11)',
  name                VARCHAR(120)    NOT NULL                COMMENT '캠페인명(운영 콘솔 표기)',
  platform            ENUM('instagram','youtube') NOT NULL    COMMENT '트리거가 발생하는 플랫폼',
  content_ref         VARCHAR(80)     NOT NULL                COMMENT '대상 콘텐츠 ID(릴스 media_id / 쇼츠 video_id)',
  trigger_keywords    JSON            NOT NULL                COMMENT '트리거 키워드 배열(["할인","선착순"])',
  reward_label        VARCHAR(80)     NOT NULL                COMMENT '리워드 표기(3,000원 즉시 할인)',
  reward_amount       INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '1인당 리워드 금액(원). 예산 계산 기준',
  total_reward_budget INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '총 리워드 예산(원). 0이면 무제한(비권장)',
  claim_limit         INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '발급 가능 총 장수. 0이면 무제한',
  max_claims_per_user TINYINT UNSIGNED NOT NULL DEFAULT 1     COMMENT '1인당 발급 가능 수(다계정 어뷰징 기준)',
  token_ttl_minutes   SMALLINT UNSIGNED NOT NULL DEFAULT 15   COMMENT '딥링크 토큰 유효 시간(분)',
  starts_at           DATETIME(3)     NOT NULL                COMMENT '시작 시각(KST)',
  ends_at             DATETIME(3)     NOT NULL                COMMENT '종료 시각(KST)',
  status              ENUM('draft','scheduled','live','paused','ended') NOT NULL DEFAULT 'draft'
                      COMMENT 'draft=작성, scheduled=대기, live=진행, paused=일시정지, ended=종료',
  created_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at          DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_interactive_campaigns_code (tenant_id, code) COMMENT '테넌트 내 캠페인 코드 유일',
  KEY idx_interactive_campaigns_live (status, starts_at, ends_at) COMMENT '스케줄러: 지금 살아있는 캠페인',
  KEY idx_interactive_campaigns_content (platform, content_ref) COMMENT '웹훅 수신 시 콘텐츠로 캠페인 역조회',
  CONSTRAINT fk_interactive_campaigns_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_interactive_campaigns_project FOREIGN KEY (project_id) REFERENCES shortform_projects (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_interactive_campaigns_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_interactive_campaigns_ttl CHECK (token_ttl_minutes BETWEEN 1 AND 1440),
  CONSTRAINT chk_interactive_campaigns_budget CHECK (max_claims_per_user >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='숏폼 연계 인터랙티브 프로모션(트리거 키워드·예산·1회용 토큰 TTL)';

-- -----------------------------------------------------------------------------
-- 9. webhook_interaction_events — 웹훅 이벤트 스트림 원본 + 파싱 로그
-- -----------------------------------------------------------------------------
-- Meta Graph 웹훅은 **서명 검증 → 파싱 → 멱등 확인 → 큐 적재**의 순서로 처리한다.
-- 이 테이블은 그 네 단계의 결과를 모두 남긴다.
--   · signature_verified — 서명이 틀렸는데 처리했는지 사후에 알 수 있어야 한다
--   · processing_status — 어느 단계에서 멈췄는지(파싱 실패·키워드 불일치·중복)
--   · raw_payload JSON — 원본을 남긴다. Meta 포맷은 예고 없이 바뀌고, 파서 버그를
--     재현하려면 원본이 있어야 한다(개인정보는 해시·최소 필드만).
--
-- external_event_id UNIQUE가 재전송 방어선이다. Meta는 200을 못 받으면 같은
-- 댓글 이벤트를 최대 수 시간 재전송하므로, 애플리케이션 if문만으로는 부족하다.
-- author_platform_id는 HMAC으로 저장한다(원문 ID를 남기면 개인 식별자가 된다).
-- -----------------------------------------------------------------------------
CREATE TABLE webhook_interaction_events (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '이벤트 PK',
  campaign_id         BIGINT UNSIGNED NULL                    COMMENT '매칭된 캠페인(키워드 불일치면 NULL)',
  tenant_id           BIGINT UNSIGNED NOT NULL                COMMENT '테넌트(라우팅 결과)',
  platform            ENUM('instagram','youtube') NOT NULL    COMMENT '이벤트 발생 플랫폼',
  external_event_id   VARCHAR(120)    NOT NULL                COMMENT '플랫폼 이벤트 ID(댓글 ID). UNIQUE — 재전송 방어',
  event_type          ENUM('comment','dm','mention') NOT NULL DEFAULT 'comment' COMMENT '이벤트 종류',
  content_ref         VARCHAR(80)     NOT NULL                COMMENT '대상 콘텐츠 ID(media_id/video_id)',
  author_platform_id  CHAR(64)        NOT NULL                COMMENT '작성자 플랫폼 ID의 HMAC-SHA256(원문 저장 금지)',
  author_handle       CHAR(64)        NULL                    COMMENT '작성자 핸들 HMAC. 표시가 필요하면 별도 마스킹',
  message_text        VARCHAR(500)    NOT NULL DEFAULT ''     COMMENT '댓글 본문(최대 500자). 키워드 매칭에만 쓴다',
  matched_keyword     VARCHAR(40)     NULL                    COMMENT '매칭된 트리거 키워드',
  signature_verified  TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '1=Meta X-Hub-Signature-256 검증 통과',
  processing_status   ENUM('RECEIVED','PARSED','QUEUED','DISPATCHED','IGNORED','REJECTED','DUPLICATE')
                      NOT NULL DEFAULT 'RECEIVED'             COMMENT '처리 단계. IGNORED=키워드 불일치, REJECTED=서명/어뷰징',
  rejection_reason    VARCHAR(120)    NULL                    COMMENT '거절 사유(BAD_SIGNATURE, NO_KEYWORD, ABUSE…)',
  raw_payload         JSON            NULL                    COMMENT '원본 페이로드(파서 재현용)',
  received_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '수신 시각',
  processed_at        DATETIME(3)     NULL                    COMMENT '처리 완료 시각',
  PRIMARY KEY (id),
  UNIQUE KEY uq_webhook_external_event (external_event_id) COMMENT '재전송 방어: 같은 댓글은 한 행',
  KEY idx_webhook_campaign_status (campaign_id, processing_status, received_at) COMMENT '캠페인별 처리 현황·지연',
  KEY idx_webhook_author (author_platform_id, received_at) COMMENT '다계정/도배 탐지',
  KEY idx_webhook_status_received (processing_status, received_at) COMMENT '재처리 워커(Failed/Received)',
  CONSTRAINT fk_webhook_campaign FOREIGN KEY (campaign_id) REFERENCES interactive_campaigns (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_webhook_tenant FOREIGN KEY (tenant_id) REFERENCES tenants (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_webhook_text_length CHECK (CHAR_LENGTH(message_text) <= 500)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='숏폼 댓글/멘션 웹훅 원본과 파싱·멱등·서명 검증 로그';

-- -----------------------------------------------------------------------------
-- 10. dispatch_queue — 알림톡/DM 5초 내 즉시 발송 큐
-- -----------------------------------------------------------------------------
-- 5초 SLA를 지키려면 "큐에 넣고 응답"이 아니라 "큐에 넣고 **데드라인을 박은 뒤**
-- 워커가 즉시 집어가는 구조"여야 한다. 그래서 행에 dispatch_deadline_at이 있다.
--
-- 상태 전이: PENDING → DISPATCHED | FAILED → RETRY → DEAD_LETTER
--   · PENDING에서 available_at이 지나야 워커가 집는다(즉시 재시도 폭주 방지)
--   · RETRY는 지수 백오프(1s, 2s, 4s …) 후 다시 PENDING처럼 동작한다
--   · 데드라인을 넘긴 실패는 DEAD_LETTER로 분리한다. 여기 남은 건은 사람이 봐야 한다
--
-- idempotency_key UNIQUE가 핵심이다. "이 이벤트 → 이 채널 → 이 수신자"는 한 번만
-- 발송된다. 워커가 죽어서 재시작해도 같은 키로는 두 번 나가지 않는다.
-- -----------------------------------------------------------------------------
CREATE TABLE dispatch_queue (
  id                   BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '발송 큐 PK',
  campaign_id          BIGINT UNSIGNED NOT NULL                COMMENT '대상 캠페인',
  interaction_event_id BIGINT UNSIGNED NOT NULL                COMMENT '계기가 된 웹훅 이벤트',
  claim_token_id       BIGINT UNSIGNED NULL                    COMMENT '발급한 1회용 토큰(생성 후 연결)',
  channel              ENUM('ALIMTALK','INSTAGRAM_DM') NOT NULL COMMENT '발송 채널',
  recipient_ref        VARCHAR(120)    NOT NULL                COMMENT '수신자 참조(해시된 플랫폼 ID 또는 마스킹 번호)',
  idempotency_key      VARCHAR(120)    NOT NULL                COMMENT '중복 발송 차단 키. UNIQUE',
  status               ENUM('PENDING','DISPATCHED','FAILED','RETRY','DEAD_LETTER') NOT NULL DEFAULT 'PENDING'
                       COMMENT 'PENDING=대기, DISPATCHED=발송, FAILED=실패, RETRY=재시도 대기, DEAD_LETTER=포기',
  attempts             TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '발송 시도 횟수',
  available_at         DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '다음 시도 가능 시각(백오프)',
  dispatch_deadline_at DATETIME(3)     NOT NULL                COMMENT '5초 SLA 데드라인. 넘기면 DEAD_LETTER',
  dispatched_at        DATETIME(3)     NULL                    COMMENT '실제 발송 시각',
  dead_letter_at       DATETIME(3)     NULL                    COMMENT '포기 처리 시각',
  last_error           VARCHAR(300)    NULL                    COMMENT '마지막 실패 사유(플랫폼 오류 코드 포함)',
  payload              JSON            NULL                    COMMENT '발송 본문(딥링크 URL·템플릿 인자)',
  created_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at           DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_dispatch_idempotency (idempotency_key) COMMENT '이벤트×채널×수신자 1회 발송',
  KEY idx_dispatch_ready (status, available_at) COMMENT '워커: PENDING/RETRY 중 시도 가능한 행',
  KEY idx_dispatch_campaign (campaign_id, status) COMMENT '캠페인별 발송 현황',
  KEY idx_dispatch_deadline (status, dispatch_deadline_at) COMMENT 'SLA 초과 스캔',
  CONSTRAINT fk_dispatch_campaign FOREIGN KEY (campaign_id) REFERENCES interactive_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_dispatch_event FOREIGN KEY (interaction_event_id) REFERENCES webhook_interaction_events (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT chk_dispatch_attempts CHECK (attempts <= 10),
  CONSTRAINT chk_dispatch_deadline CHECK (dispatch_deadline_at >= created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='숏폼 댓글 → 즉시 쿠폰 발송 큐(5초 SLA·백오프·DLQ)';

-- -----------------------------------------------------------------------------
-- 11. instant_claim_tokens — HMAC-SHA256 서명된 1회용 딥링크 토큰
-- -----------------------------------------------------------------------------
-- 딥링크는 문자/카톡으로 나가고, 받은 사람은 캡처해서 단톡방에 뿌린다. 그래서
-- 토큰은 반드시 **1회용 + 짧은 TTL**이어야 한다.
--
-- 저장 원칙
--   · token_uuid — 링크에 들어가는 공개 식별자(조회 키). UNIQUE
--   · token_hash — 토큰 원문의 SHA-256. 검증은 이 값으로만 한다
--   · hmac_signature — `uuid.expiresAt`에 대한 HMAC-SHA256. 서버가 서명한 것임을 증명
--   · 원문 토큰은 저장하지 않는다(발급 응답 1회 노출). DB 덤프로 링크를 위조할 수 없다
--
-- claim_count / is_claimed를 둘 다 두는 이유: 동시 클릭 2건에서 "둘 다 성공"하는 것을
-- 막아야 한다. 갱신은 `UPDATE ... WHERE claim_count = 0`(compare-and-set)으로 한다.
-- -----------------------------------------------------------------------------
CREATE TABLE instant_claim_tokens (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '토큰 PK',
  campaign_id      BIGINT UNSIGNED NOT NULL                COMMENT '대상 캠페인',
  dispatch_queue_id BIGINT UNSIGNED NULL                   COMMENT '발송 큐 행(어떤 메시지로 나갔는지)',
  token_uuid       CHAR(36)        NOT NULL                COMMENT '링크에 노출되는 공개 UUID. UNIQUE',
  token_hash       CHAR(64)        NOT NULL                COMMENT '토큰 원문 SHA-256. 검증 키. UNIQUE',
  hmac_signature   VARCHAR(64)     NOT NULL                COMMENT 'uuid.expires_at에 대한 HMAC-SHA256(hex)',
  reward_amount    INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '확정 리워드 금액(원)',
  is_claimed       TINYINT(1)      NOT NULL DEFAULT 0      COMMENT '1=사용됨(1회용)',
  claim_count      TINYINT UNSIGNED NOT NULL DEFAULT 0     COMMENT '사용 시도 성공 횟수. 0→1만 허용',
  claimed_at       DATETIME(3)     NULL                    COMMENT '사용 시각',
  claimed_ip       VARBINARY(16)   NULL                    COMMENT '사용 IP(INET6_ATON). 분쟁·어뷰징 추적',
  expires_at       DATETIME(3)     NOT NULL                COMMENT '만료 시각(발급 + TTL, 기본 15분)',
  created_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_claim_token_uuid (token_uuid) COMMENT '링크 조회 키',
  UNIQUE KEY uq_claim_token_hash (token_hash) COMMENT '원문 위조 방지 — 해시로만 검증',
  KEY idx_claim_expiry (expires_at, is_claimed) COMMENT '만료 스윕',
  CONSTRAINT fk_claim_campaign FOREIGN KEY (campaign_id) REFERENCES interactive_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_claim_dispatch FOREIGN KEY (dispatch_queue_id) REFERENCES dispatch_queue (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_claim_count CHECK (claim_count <= 1),
  CONSTRAINT chk_claim_consistency CHECK (is_claimed = 0 OR claimed_at IS NOT NULL)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='1회용 딥링크 클레임 토큰(HMAC 서명·15분 TTL·compare-and-set 사용)';

-- -----------------------------------------------------------------------------
-- 12. shortform_conversion_attributions — 풀 퍼널 전환 로그(ROAS)
-- -----------------------------------------------------------------------------
-- 숏폼 마케팅의 질문은 "몇 명이 쿠폰을 받았나"가 아니라 **"그 쿠폰이 얼마를 벌었나"** 다.
-- 그래서 퍼널을 단계별 행으로 남긴다: VIDEO_VIEW → COMMENT → LINK_CLICK → CLAIM → PURCHASE.
--
-- 한 토큰이 단계마다 한 행을 갖고(UNIQUE (claim_token_id, stage)), 같은 단계가 두 번
-- 기록되면 무시된다(웹훅/리다이렉트 재전송). 구매 단계에는 주문 금액과 할인액을 남겨
--   ROAS = 구매 매출 / 리워드 원가
-- 를 캠페인 단위로 계산할 수 있게 한다.
-- -----------------------------------------------------------------------------
CREATE TABLE shortform_conversion_attributions (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '전환 로그 PK',
  campaign_id       BIGINT UNSIGNED NOT NULL                COMMENT '대상 캠페인',
  content_ref       VARCHAR(80)     NOT NULL                COMMENT '콘텐츠 ID(릴스/쇼츠)',
  interaction_event_id BIGINT UNSIGNED NULL                 COMMENT '원천 댓글 이벤트',
  claim_token_id    BIGINT UNSIGNED NULL                    COMMENT '연결된 1회용 토큰',
  stage             ENUM('VIDEO_VIEW','COMMENT','LINK_CLICK','CLAIM','PURCHASE') NOT NULL
                    COMMENT '퍼널 단계',
  order_id          VARCHAR(64)     NULL                    COMMENT '쇼핑몰 주문번호(구매 단계)',
  order_amount      INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '주문 금액(원). 구매 단계만',
  discount_amount   INT UNSIGNED    NOT NULL DEFAULT 0      COMMENT '쿠폰 할인액(원). 구매 단계만',
  utm_source        VARCHAR(40)     NULL                    COMMENT '유입 소스(instagram, youtube)',
  occurred_at       DATETIME(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '단계 발생 시각',
  PRIMARY KEY (id),
  UNIQUE KEY uq_attribution_stage (claim_token_id, stage) COMMENT '같은 토큰·같은 단계는 한 번만(재전송 멱등)',
  KEY idx_attribution_campaign_stage (campaign_id, stage, occurred_at) COMMENT '퍼널 집계·ROAS',
  KEY idx_attribution_content (content_ref, stage) COMMENT '콘텐츠별 성과 비교',
  CONSTRAINT fk_attribution_campaign FOREIGN KEY (campaign_id) REFERENCES interactive_campaigns (id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_attribution_event FOREIGN KEY (interaction_event_id) REFERENCES webhook_interaction_events (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_attribution_token FOREIGN KEY (claim_token_id) REFERENCES instant_claim_tokens (id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT chk_attribution_purchase CHECK (stage <> 'PURCHASE' OR order_amount > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
  COMMENT='숏폼 → 댓글 → 링크 → 수령 → 구매 전환 퍼널(ROAS 근거)';

