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
