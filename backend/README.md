# shortform backend — PHP 8.2 · MySQL 8.0 · Meta Graph API · NCP SENS 알림톡

The TypeScript engine in `src/` renders video. This layer owns what must survive a process
death: the **durable queue**, the **publish bookkeeping** and the **notification ledger**.
Same pipeline, split at the line where "fast and stateless" ends and "must not be lost" begins.

```
TypeScript (ffmpeg, script engine, studio)   ─┐
                                              ├─→  PHP 8.2 (queue worker, publish API)  ─→  MySQL 8.0
Instagram / YouTube webhooks  ────────────────┘         │
                                                        └─→  NCP SENS 알림톡 (Kakao)
```

## Quick start

```bash
docker compose up -d mysql            # MySQL 8.0.40 + schema + demo seed
cd backend
composer install
cp .env.example .env                  # DB_* only is enough; without SENS/IG keys those features stay off
php bin/migrate.php --fresh --seed --verify
php bin/worker.php --once             # claim → progress → complete → queue counts
php bin/coupon-worker.php --once      # claim → mint one-time token → send → dispatch_attempts
composer test                         # 151 unit tests (24 more with MySQL)
```

Measured locally (MySQL 8.0.40, PHP 8.2.32):

```
claimed job #1 (tenant 1, attempt 1/3, priority 7, 45.0s)
job #1 completed → /renders/demo-kitchen.mp4
queue: {"waiting":0,"delayed":0,"active":0,"completed":1,"failed":0,"dlq":0}

# retryable failure keeps the attempt counter and backs off:
job #2 failed (retryable) → queue applied backoff
queue: {"waiting":0,"delayed":1,"active":0,"completed":1,"failed":0,"dlq":0}
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | liveness + which integrations are configured |
| `GET` | `/webhooks/instagram` | Meta verification — returns the **raw** challenge string |
| `POST` | `/webhooks/instagram` | Meta events: `media` (publish) **and** `comments` (coupon), `X-Hub-Signature-256` verified over the raw body |
| `GET` | `/c/{token}` | one-time coupon link → `GRANTED` / `ALREADY_CLAIMED` / `EXPIRED` |
| `POST` | `/api/v1/coupons/claim` | same claim from an app/webview (`{"token":"…"}`) |
| `GET` | `/api/v1/tenants/{id}/queue` | queue counts per state |
| `GET` | `/api/v1/tenants/{id}/publish` | publish counts per status |
| `POST` | `/api/v1/projects/{id}/publish` | orchestrated publish: quota → container → poll → publish → notify |

```bash
curl "http://127.0.0.1:8081/webhooks/instagram?hub.mode=subscribe&hub.verify_token=$IG_VERIFY_TOKEN&hub.challenge=CH123"
# → CH123   (text/plain; JSON here would fail Meta's verification)

curl -X POST http://127.0.0.1:8081/api/v1/projects/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"video_url":"https://cdn.example.com/renders/demo-kitchen.mp4","recipient_phone":"010-1234-5678"}'
# → {"project_id":1,"outcome":{"status":"published","mediaId":"...","permalink":"https://www.instagram.com/reel/..."}}

# comment → coupon: signed comments event, then the worker, then the claim link
BODY='{"object":"instagram","entry":[{"id":"ig-account","time":1763690400,"changes":[{"field":"comments","value":{"id":"c1","text":"할인","from":{"id":"igsid-1"},"media":{"id":"reels_17894561234567890"}}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$IG_APP_SECRET" -r)"
curl -X POST http://127.0.0.1:8081/webhooks/instagram \
  -H 'Content-Type: application/json' -H "X-Hub-Signature-256: ${SIG%% *}" -d "$BODY"
# → …, "comments":{"processed":1,"enqueued":1,…,"status":"OK"}
php bin/coupon-worker.php --once    # → sent=1
curl http://127.0.0.1:8081/c/<token> # → {"outcome":"GRANTED",…} once, then ALREADY_CLAIMED
```

## Layout

```
backend/
├── public/index.php                          # DI + routes + error normalisation
├── public/router.php                         # php -S router (claim links contain a dot)
├── bin/
│   ├── migrate.php                           # schema + seed + structural verification
│   ├── worker.php                            # claim (SKIP LOCKED) → progress → complete/fail → notify
│   └── coupon-worker.php                     # claim → one-time token → send → attempt ledger
├── src/
│   ├── Controllers/
│   │   ├── PublishWebhookController.php       # media events: verify + event dedupe
│   │   ├── CommentsWebhookController.php      # comments → InteractiveCouponDispatcher
│   │   └── InstagramWebhookController.php     # one URL, signature verified once, both paths
│   ├── Bootstrap/CouponServices.php           # composition root shared by HTTP and worker
│   ├── Services/
│   │   ├── InstagramGraphApiService.php      # container → poll → publish, quota, token refresh
│   │   ├── PublishOrchestrator.php           # the publish sequence, with failure taxonomy
│   │   ├── InteractiveCouponDispatcher.php   # webhook → queue, worker → token/send, claim CAS
│   │   ├── Messaging/                        # dry-run / Instagram DM / SENS adapters + factory
│   │   ├── NaverCloudSensService.php         # SENS signature/transport, 100-message grouping
│   │   ├── ShortformAlertComposer.php        # alimtalk template variables (4 events)
│   │   └── ShortformAlertNotifier.php        # dedupe + failure isolation
│   ├── Repositories/
│   │   ├── ShortformRepository.php           # queue claim, publish lifecycle, webhook dedupe
│   │   ├── MySql/                            # 4 coupon stores + dispatch_attempts ledger
│   │   ├── JobQueueStore.php  PublishStore.php  NotificationStore.php   # narrow contracts
│   │   ├── CampaignCatalog.php  InteractionEventStore.php  DispatchQueueStore.php
│   │   └── ClaimTokenStore.php  DispatchAttemptStore.php  NotificationSender.php
│   ├── Domain/                               # Platform, JobState, PublishStatus + Interactive/
│   ├── Database/Connection.php               # PDO + deadlock retry
│   └── Support/                              # Env, Clock, Sleeper, HttpClient(Curl), DbTime
├── tests/                                    # 151 unit + 24 live MySQL (SHORTFORM_INTEGRATION=1)
└── examples/ (see database/seed_demo.sql)
```

## Design decisions

### 1. The queue is a table, and the row decides

`render_jobs` stores every state the TypeScript queue models: `waiting → delayed → active →
completed | failed → dlq`, plus `attempts`, `lease_expires_at`, `worker_id`, `last_error`.

- **Claiming**: `SELECT … ORDER BY priority DESC, available_at, id LIMIT 1 FOR UPDATE SKIP LOCKED`.
  Ten workers poll and each gets a different row; nobody waits on a locked one.
- **Lease**: a worker that dies leaves `state='active'` with an expired lease. The next worker
  reclaims it to `delayed` (or `dlq` if attempts are exhausted) — no human intervention.
- **Retry vs give up**: `retryable=false` (bad codec, revoked token) → `failed` immediately.
  `retryable=true` → `delayed` with `2^attempts` seconds backoff, then `dlq` at `max_attempts`.
  Retrying a permanently broken job 50 times only burns CPU and delays the rest of the queue.
- **Progress monotonic**: `progress = GREATEST(progress, ?)`. A late 30% event after 70% is dropped
  in SQL, not in the UI.

### 2. Instagram publishing: the middle step is mandatory

`POST /media` → poll `status_code` until `FINISHED` → `POST /media_publish`.

Publishing before FINISHED returns a generic error **and consumes one of the 25 daily API
publishes**. The poller backs off 2s → ×1.35 → 8s cap inside a timeout, and keeps the container id
in `publish_logs` so a crash after "container created" resumes instead of re-uploading (containers
live 24h).

Retry rules are explicit because the endpoint is quota-limited:

| Meta code | Meaning | Retried? |
| --- | --- | --- |
| 9007 | container still processing | yes |
| 4 / 17 / 32 / 613 | app/user rate limit | yes |
| 190 | token expired | no → refresh the long-lived token |
| 9004 | Meta could not download the video | no → fix the public HTTPS URL |
| 10 | missing `instagram_content_publish` | no → app review / scope |
| 9007 exhausted, 5xx | transient | yes, up to `maxRetries` |

### 3. Two long-lived token flows, because there are two token families

Facebook-Login tokens refresh through `GET /oauth/access_token?grant_type=fb_exchange_token`;
Instagram-Login tokens refresh through `graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token`.
Mixing them yields a token that works in a test call and fails at publish time. Both are implemented
behind `TokenFlow`, and `creator_accounts.refresh_lock_until` makes the refresh single-flight so 30
scheduled posts hitting an expired token cause **one** refresh, not 30.

### 4. Webhooks: signature over the raw body, and idempotent by event id

Verification lives in `Security/MetaWebhookSignatureVerifier` — one class, four rules:

| Situation | Result | Why it is a separate case |
| --- | --- | --- |
| valid `sha256=` + `HMAC-SHA256(rawBody, IG_APP_SECRET)` | pass | — |
| no secret configured (`IG_APP_SECRET=''`) | reject (`missing_app_secret`) | **fail closed**: an unset secret must never mean "accept anything" |
| `sha1=` header | reject (`legacy_sha1_signature`) | downgrade attempt, or an app still on the old config |
| missing / blank / malformed header | reject (`missing_header`, `malformed_header`) | a client bug, not a forgery — the reason tells them apart |
| digest differs | reject (`signature_mismatch`) | compared with `hash_equals` |

- `hash_equals` instead of `===`: byte-by-byte comparison returns at the first difference, which
  leaks how many leading bytes matched and enables forging a signature one byte at a time.
- The comparison is over the **raw body**. Parsing JSON first (or re-encoding the array) changes
  bytes and breaks the signature. Hex case and surrounding whitespace are normalised, so a valid
  signature is never rejected for formatting.
- PHP rewrites `hub.mode` to `hub_mode` in query strings. The verification reads **both** spellings —
  this single detail is the usual reason "the webhook cannot be verified".
- Meta re-delivers the same event for up to 24h. `applyWebhookEvent` guards the UPDATE with
  `last_event_id <> :event`, so a redelivery changes 0 rows. The API reports three distinct
  outcomes: `applied`, `duplicates`, `unknown_media` (a webhook for a post we never published).

### 5. Approval is a hash, not a flag

`shortform_projects.content_hash` is the sha256 of narration + caption + subtitle cues at approval
time. Publishing recomputes it and refuses if it moved: "approved" must not be able to ship a script
someone edited after review.

### 6. Notifications are a side effect, never a dependency

A render that finished is finished even if SENS is down. Every notification:
1. claims a `dedupe_key` (one `INSERT IGNORE`, so two workers cannot both send),
2. sends through SENS,
3. records `accepted`/`failed` — and the pipeline only ever gets a boolean back.

Templates must be reviewed by Kakao, so the body is the reviewed template with `#{vars}` filled
(see the four bodies at the top of `ShortformAlertComposer`). A free-form sentence would be rejected
with 3016 (NoMatchedTemplate).

### 7. SENS signature — the three classic 401s

```
POST + " " + /alimtalk/v2/services/{serviceId}/messages + "\n" + timestamp(ms) + "\n" + accessKey
→ base64(HMAC-SHA256(secretKey, message))
```

1. The query string is part of the signed URI.
2. The timestamp used to sign must be the exact string in `x-ncp-apigw-timestamp`.
3. The service id contains colons (`ncp:kkobizmsg:kr:…:sens`) — percent-encoding it changes the path
   and invalidates the signature.

The test pins an **independently computed** signature vector (Python `hmac`/`base64`), so a change in
this logic fails the build instead of production.

### 8. PDO and placeholders

`ERRMODE_EXCEPTION`, `EMULATE_PREPARES=false` (server-side prepares, keeps integer types), session
`time_zone`, and a MySQL 8.0.19+ check at connect. One practical consequence of native prepares:
**a named placeholder cannot be reused** in a statement, so timestamps that appear twice get distinct
names (`:now_created`, `:now_updated`). This is enforced by the integration tests, which is how the
duplicate-placeholder bugs were caught here.

## Tests

```bash
composer test                            # 151 unit tests; integration skipped without MySQL
SHORTFORM_INTEGRATION=1 composer test    # + 24 live MySQL tests
```

| File | What it pins |
| --- | --- |
| `Services/InstagramGraphApiServiceTest` | poll backoff (2s→2.7s), ERROR/terminal, 9007 retry, 190 no-retry, both token flows, quota parse |
| `Services/PublishOrchestratorTest` | stage order, quota gate (no container created), stale approval, retryable taxonomy |
| `Services/NaverCloudSensServiceTest` | signature vectors, header consistency, 100-message grouping, delivery 0000 vs 3005 |
| `Services/ShortformAlertNotifierTest` | dedupe, template per event, SENS failure contained |
| `Controllers/PublishWebhookControllerTest` | challenge echo, dotted params, raw-body signature, duplicate vs unknown media |
| `Security/MetaWebhookSignatureVerifierTest` | valid/forged/tampered body, empty or wrong secret, SHA-1 downgrade, malformed and uppercase headers, UTF-8 body, actionable rejection messages |
| `Integration/DatabaseIntegrationTest` | SKIP LOCKED (one worker wins), progress monotonic, delayed→dlq, stalled reclaim, one publish row with attempts++, webhook redelivery, notification dedupe, CHECK on experiment variants |
| `Controllers/InstagramWebhookControllerTest` | comments enqueue, unsigned rejected with no rows, media still applied, mixed body once, redelivery dedupe |
| `Services/InstagramMessagingSenderTest` | private reply uses `comment_id`, Bearer token, 429/code4 retry, 190/100 permanent, network retry, 1,000-char cap |
| `Services/SensCouponSenderTest` | reviewed template code, digit-normalised recipient, 202 accepted, 429 retry, 4xx permanent |
| `Services/CouponSenderFactoryTest` | dry-run default, live fails without credentials, per-channel routing, deterministic dry-run ids |
| `Services/CouponDispatchLedgerTest` | attempt per send, token attached to the queue row, SENT row stops a second send after a crash |
| `Integration/CouponPipelineIntegrationTest` | webhook → DB → worker → attempt → claim, CLAIMED lease reclaim, SLA late → DEAD_LETTER, 3 retries → DLQ, token CAS, fraud counters, claim limit (campaign-scoped, so a seeded demo DB is fine) |

## Operations

| Task | How |
| --- | --- |
| Worker | `php bin/worker.php --jobs=10 --tenant=1` in a loop (systemd/NCP Container) |
| Coupon worker | `php bin/coupon-worker.php --loop --sleep-ms=200` (sender set by `COUPON_SENDER`) |
| Coupon DLQ | `dispatch_queue.status = 'DEAD_LETTER'` — each row's `last_error` and `dispatch_attempts` say why |
| Stalled recovery | every worker start runs `reclaimStalled(50)`; a cron for quiet queues is fine too |
| Notification retry | `alimtalk_notifications.status IN ('queued','failed') AND attempts < 3` |
| Quota guard | `GET /api/v1/tenants/{id}/publish` shows published/failed counts; the orchestrator refuses at 25/25 |
| Webhook health | `unknown_media` climbing means posts are being created outside the platform |

## Known limits

- The encoder in `bin/worker.php` is **simulated**; production encoding is the TypeScript pipeline,
  which claims the same rows with the same SQL. The queue is the contract between the two runtimes.
- `POST /projects/{id}/publish` does not check the approval hash because that hash is produced by the
  script engine (narration + caption + cues). The worker that owns the full script enforces it.
- YouTube publishing is modelled (platform enum, per-day limit) but only Instagram is orchestrated here.
- The coupon worker's default sender is **dry-run**: it writes the attempt ledger with `provider=dry_run`
  and never calls Meta or SENS. Real sends need `COUPON_SENDER=live` plus credentials, and the
  `dispatch_queue.recipient_ref` is the platform id Meta requires for delivery (the event ledger keeps
  only an HMAC of it).
- Instagram private replies require the `instagram_manage_messages` permission and app review; the
  adapter is written against `POST /{ig-user-id}/messages` but the call itself is unverified here.
