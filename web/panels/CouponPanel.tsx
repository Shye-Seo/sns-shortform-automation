import { useEffect, useMemo, useState } from 'react';
import type { ClaimOutcome, StormReport } from '../../src/core/interactiveCouponDispatcher';
import { Button, Card, Kpi, Meter, Pill, Toggle, hhmmss, num, pct, won } from '../ui';
import {
  DEFAULT_RULE,
  POSTS,
  REWARD_PRESETS,
  CouponDesk,
  rewardLabelOf,
  type CouponRule,
  type PostItem,
} from '../model/coupon';
import { friendlyFailure } from '../model/labels';

interface ClaimLog {
  at: number;
  jobId: number;
  handle: string;
  status: ClaimOutcome['status'];
  reward: number;
  reason: string;
}

const QUICK: Array<{ label: string; text: string }> = [
  { label: '쿠폰', text: '쿠폰 주세요!' },
  { label: '할인', text: '할인 받고 싶어요' },
  { label: '링크', text: '링크 어디에 있나요?' },
  { label: '키워드 없음', text: '잘 보고 갑니다' },
];

const CALLBACK_PATH = '/webhooks/instagram';

export function CouponPanel() {
  const desk = useMemo(() => new CouponDesk(() => Date.now()), []);
  const [, setTick] = useState(0);
  const [postId, setPostId] = useState(POSTS[0]!.id);
  const [keywords, setKeywords] = useState<string[]>(DEFAULT_RULE.keywords);
  const [keywordDraft, setKeywordDraft] = useState('');
  const [reward, setReward] = useState(DEFAULT_RULE.rewardAmount);
  const [claimLimit, setClaimLimit] = useState(DEFAULT_RULE.claimLimit);
  const [ttl, setTtl] = useState(DEFAULT_RULE.tokenTtlMinutes);
  const [applied, setApplied] = useState(DEFAULT_RULE);
  const [appliedPost, setAppliedPost] = useState<PostItem>(POSTS[0]!);
  const [text, setText] = useState('쿠폰 주세요!');
  const [handle, setHandle] = useState('');
  const [autoWorker, setAutoWorker] = useState(true);
  const [claims, setClaims] = useState<ClaimLog[]>([]);
  const [storming, setStorming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const bump = (): void => setTick((value) => value + 1);

  // The worker: one cycle every 380ms, like a queue poller. Pausing it is how an
  // operator proves what the 5-second deadline does to a late job.
  useEffect(() => {
    if (!autoWorker) return undefined;
    const timer = window.setInterval(() => {
      void desk.runWorkerCycle().then(bump);
    }, 380);
    return () => window.clearInterval(timer);
  }, [autoWorker, desk]);

  useEffect(() => {
    desk.workerPaused = !autoWorker;
  }, [autoWorker, desk]);

  const submit = async (input: { text: string; handle?: string; reuseAuthor?: boolean }): Promise<void> => {
    if (input.text.trim() === '') return;
    await desk.submitComment(input);
    bump();
  };

  const claim = async (jobId: number): Promise<void> => {
    const dm = desk.dms.find((item) => item.jobId === jobId);
    const result = await desk.claimDm(jobId);
    setClaims((prev) =>
      [
        {
          at: Date.now(),
          jobId,
          handle: dm?.handle ?? '-',
          status: result.status,
          reward: result.rewardAmount,
          reason: result.reason,
        },
        ...prev,
      ].slice(0, 6),
    );
    bump();
  };

  const addKeyword = (): void => {
    const word = keywordDraft.trim();
    if (word === '' || keywords.includes(word)) {
      setKeywordDraft('');
      return;
    }
    setKeywords([...keywords, word]);
    setKeywordDraft('');
  };

  const applyRule = (): void => {
    const rule: CouponRule = {
      keywords: keywords.length > 0 ? keywords : DEFAULT_RULE.keywords,
      rewardAmount: reward,
      claimLimit,
      tokenTtlMinutes: ttl,
    };
    const post = POSTS.find((item) => item.id === postId) ?? POSTS[0]!;
    desk.applyRule(post, rule);
    setKeywords(rule.keywords);
    setApplied(rule);
    setAppliedPost(post);
    setClaims([]);
    setOutcome('규칙을 적용했습니다. 이 게시물에 단 댓글부터 새 규칙으로 처리합니다.');
    bump();
  };

  const copyCallback = (): void => {
    const url = `https://내서버주소${CALLBACK_PATH}`;
    const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
      .navigator?.clipboard;
    if (clipboard?.writeText) void clipboard.writeText(url).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const totalDispatch = desk.dispatch.dispatched + desk.dispatch.late;
  const sla = totalDispatch === 0 ? 100 : (desk.dispatch.dispatched / totalDispatch) * 100;
  const funnel = desk.funnel();
  const remaining = desk.poolRemaining;
  const selectedPost = POSTS.find((item) => item.id === postId) ?? POSTS[0]!;

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi
          label="받은 댓글"
          value={num(desk.ingest.received)}
          sub={`규칙에 맞음 ${num(desk.ingest.enqueued)} · 지나감 ${num(desk.ingest.ignored)}`}
        />
        <Kpi
          label="보낸 DM"
          value={num(desk.dispatch.dispatched)}
          sub={`보내지 못함 ${num(desk.dispatch.deadLettered)} · 재시도 ${num(desk.dispatch.retried)}`}
          tone={desk.dispatch.deadLettered > 0 ? 'warn' : undefined}
        />
        <Kpi
          label="5초 안에 보낸 비율"
          value={pct(sla, 1)}
          sub={`가장 늦은 발송 ${(desk.dispatch.worstLatencyMs / 1000).toFixed(2)}초`}
          tone={sla >= 100 ? 'ok' : sla >= 90 ? 'warn' : 'bad'}
        />
        <Kpi
          label="쿠폰 매출"
          value={won(funnel.revenue)}
          sub={`쿠폰 원가 ${won(funnel.rewardCost)} · 매출/원가 ${funnel.roas.toFixed(2)}배`}
          tone={funnel.roas > 0 ? 'ok' : undefined}
        />
      </div>

      <div className="grid two">
        <Card eyebrow="1단계" title="어느 게시물에 걸까요" hint="규칙은 계정이 아니라 게시물 하나에 붙습니다.">
          <div className="post-list">
            {POSTS.map((post: PostItem) => (
              <button
                key={post.id}
                type="button"
                className={post.id === postId ? 'post-card active' : 'post-card'}
                onClick={() => setPostId(post.id)}
                aria-pressed={post.id === postId}
              >
                <span className={`post-kind ${post.kind}`}>{post.kind === 'reel' ? '릴스' : '피드'}</span>
                <span className="post-body">
                  <strong>{post.title}</strong>
                  <span className="small muted">
                    {post.postedLabel} · 조회 {num(post.views)} · 댓글 {num(post.comments)}
                  </span>
                </span>
                <span className={post.id === postId ? 'post-check on' : 'post-check'}>{post.id === postId ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          <p className="note">
            다른 게시물에 단 댓글은 같은 계정이라도 반응하지 않습니다. 댓글의 게시물 번호가 아래 규칙의 게시물과
            같을 때만 쿠폰이 나갑니다.
          </p>
        </Card>

        <Card eyebrow="2단계" title="댓글에 어떻게 답할까요" hint="키워드가 들어간 댓글에 1회용 쿠폰 링크를 DM으로 보냅니다.">
          <div className="stack" style={{ gap: 12 }}>
            <div className="field">
              <span>반응할 키워드</span>
              <div className="chips">
                {keywords.map((word) => (
                  <span key={word} className="chip">
                    {word}
                    <button
                      type="button"
                      aria-label={`${word} 삭제`}
                      onClick={() => setKeywords(keywords.filter((item) => item !== word))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  type="text"
                  value={keywordDraft}
                  onChange={(event) => setKeywordDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addKeyword();
                    }
                  }}
                  placeholder="키워드 추가 후 Enter"
                />
              </div>
            </div>

            <div className="row" style={{ gap: 14, alignItems: 'flex-end' }}>
              <div className="field" style={{ minWidth: 168 }}>
                <span>보상</span>
                <div className="row" style={{ gap: 4 }}>
                  {REWARD_PRESETS.map((amount) => (
                    <Button key={amount} small ghost={reward !== amount} onClick={() => setReward(amount)}>
                      {amount.toLocaleString('ko-KR')}원
                    </Button>
                  ))}
                </div>
              </div>
              <div className="field" style={{ width: 108 }}>
                <span>발급 수량</span>
                <input
                  type="number"
                  min={1}
                  max={10_000}
                  value={claimLimit}
                  onChange={(event) => setClaimLimit(Math.max(1, Number(event.target.value) || 1))}
                />
              </div>
              <div className="field" style={{ width: 120 }}>
                <span>링크 유효시간</span>
                <select value={ttl} onChange={(event) => setTtl(Number(event.target.value))}>
                  <option value={5}>5분</option>
                  <option value={15}>15분</option>
                  <option value={60}>1시간</option>
                </select>
              </div>
            </div>

            <div className="row between">
              <Button primary onClick={applyRule}>
                이 게시물에 규칙 적용
              </Button>
              <span className="small muted">규칙을 바꾸면 시험 기록이 새로 시작됩니다.</span>
            </div>

            <div className="rule-summary">
              <span className="small muted">지금 적용된 규칙 · 캠페인 {desk.campaign.code}</span>
              <strong>
                ‘{applied.keywords.join(' · ')}’ 댓글 → {rewardLabelOf(applied.rewardAmount)} DM ·{' '}
                {num(applied.claimLimit)}장 · {applied.tokenTtlMinutes}분
              </strong>
              <span className="small muted">대상: {appliedPost.title}</span>
              {selectedPost.id !== appliedPost.id ? (
                <span className="small" style={{ color: 'var(--warn)' }}>
                  고른 게시물이 아직 반영되지 않았습니다. ‘이 게시물에 규칙 적용’을 눌러 주세요.
                </span>
              ) : null}
            </div>
          </div>
        </Card>
      </div>

      <Card
        eyebrow="3단계"
        title="인스타에서 댓글을 받으려면"
        hint="이 화면은 데모지만, 이 저장소의 서버는 아래 경로로 댓글을 실제로 받아 DM 발송까지 처리합니다. 인스타 앱에 콜백을 등록하는 일만 남았습니다."
        actions={<Pill tone="ok">서버 경로 연결됨</Pill>}
      >
        <div className="grid three-steps">
          <div className="step">
            <span className="step-no">1</span>
            <h3>콜백 주소 등록 <Pill tone="ghost">계정 연결 시</Pill></h3>
            <p className="small muted">
              Meta 앱 → Instagram → 웹훅에서 아래 주소와 확인 토큰을 넣습니다. 주소는 서버가 공개되어 있어야 합니다.
            </p>
            <div className="copy-line">
              <code>https://내서버주소{CALLBACK_PATH}</code>
              <Button small ghost onClick={copyCallback}>
                {copied ? '복사됨' : '복사'}
              </Button>
            </div>
          </div>
          <div className="step">
            <span className="step-no">2</span>
            <h3>댓글 알림 켜기 <Pill tone="ghost">계정 연결 시</Pill></h3>
            <p className="small muted">
              구독 항목에서 <strong>comments</strong>를 켭니다. 게시물 발행 알림(media)과 댓글 알림(comments)은 같은
              주소로 오고, 서버가 항목별로 나눠 처리합니다.
            </p>
          </div>
          <div className="step">
            <span className="step-no">3</span>
            <h3>서버가 받아서 DM 보내기 <Pill tone="ok">구현됨</Pill></h3>
            <p className="small muted">
              서버는 ① 서명 확인 → ② 게시물·키워드 대조 → ③ DM 발송 대기열 적재 순서로 처리합니다. 인스타는 5초
              안에 응답이 없으면 같은 알림을 다시 보내므로, 발송은 대기열에서 워커가 따로 합니다.
            </p>
          </div>
        </div>
        <div className="divider" />
        <table className="data">
          <thead>
            <tr>
              <th>서버에 있는 것</th>
              <th>하는 일</th>
              <th>상태</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">POST {CALLBACK_PATH}</td>
              <td>서명 확인 → 댓글 파싱 → 키워드 매칭 → 중복 방지 → 5초 데드라인으로 대기열 적재</td>
              <td><Pill tone="ok">연결됨</Pill></td>
            </tr>
            <tr>
              <td className="mono">bin/coupon-worker.php</td>
              <td>대기열 선점 → 1회용 토큰 발급 → DM/알림톡 발송 → 발송 이력 기록 → 재시도·DLQ</td>
              <td><Pill tone="ok">연결됨</Pill></td>
            </tr>
            <tr>
              <td className="mono">GET /c/&#123;token&#125;</td>
              <td>쿠폰 수령. 같은 링크의 두 번째 클릭은 ‘이미 사용됨’으로 끊습니다.</td>
              <td><Pill tone="ok">연결됨</Pill></td>
            </tr>
            <tr>
              <td className="mono">dispatch_attempts</td>
              <td>발송 시도마다 성공·실패·제공자 메시지 id를 남깁니다(CS·정산 근거).</td>
              <td><Pill tone="ok">연결됨</Pill></td>
            </tr>
            <tr>
              <td className="mono">Meta / SENS 실발송</td>
              <td>발송기 코드와 오류 분류는 구현되어 있고, 자격 증명을 넣으면 실제로 나갑니다.</td>
              <td><Pill tone="warn">실호출 미검증</Pill></td>
            </tr>
          </tbody>
        </table>
        <details className="details">
          <summary>개발자용 세부 설정</summary>
          <ul className="small muted">
            <li>확인 토큰: 서버의 <code>IG_VERIFY_TOKEN</code> 값과 같아야 합니다. 다르면 인증에 실패합니다.</li>
            <li>서명: 요청 본문을 그대로 둔 채 <code>X-Hub-Signature-256</code>을 앱 보안 키로 검증합니다.</li>
            <li>
              중복 방지: 같은 댓글 번호는 한 번만 처리합니다. 인스타가 같은 알림을 여러 번 보내도 DM은 한 번입니다.
            </li>
            <li>
              발송기 기본값은 드라이런입니다(<code>COUPON_SENDER=dryrun</code>). 실제 발송은 <code>live</code>와
              Meta·SENS 자격 증명을 넣었을 때만 나갑니다.
            </li>
            <li>콜백 등록 뒤에는 아래 ‘연결 전 점검’ 대신 실제 댓글이 이 흐름으로 들어옵니다.</li>
          </ul>
        </details>
      </Card>

      <div className="grid two">
        <Card title="받은 댓글과 보낸 DM" hint="엔진이 실제로 처리한 순서 그대로입니다.">
          <div className="feed">
            {desk.feed.length === 0 ? (
              <p className="small muted">아직 댓글이 없습니다. 맨 아래 ‘연결 전 점검’에서 첫 댓글을 넣어 보세요.</p>
            ) : null}
            {desk.feed.slice(0, 12).map((item) => (
              <div
                key={item.id}
                className={`msg ${item.kind === 'dm' ? 'dm' : item.kind === 'blocked' ? 'blocked' : item.kind === 'late' ? 'late' : ''}`}
              >
                <div className="who">
                  <span>
                    {item.kind === 'dm'
                      ? '📩 보냄'
                      : item.kind === 'blocked'
                        ? '🚫 차단'
                        : item.kind === 'late'
                          ? '⏰ 취소'
                          : item.kind === 'ignored'
                            ? '↩︎ 지나감'
                            : item.kind === 'duplicate'
                              ? '↩︎ 중복'
                              : '💬 댓글'}{' '}
                    {item.handle}
                  </span>
                  <span className="mono">{hhmmss(item.at)}</span>
                </div>
                {item.text ? <div className="text">{item.text}</div> : null}
                {item.detail ? <div className="small muted">{item.detail}</div> : null}
                {item.deepLink ? (
                  <div className="link">
                    <button
                      type="button"
                      className="btn small"
                      style={{ padding: '1px 6px', fontSize: 10.5 }}
                      onClick={() => {
                        void claim(item.dmId ?? -1);
                      }}
                    >
                      받은 사람처럼 링크 열기
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {outcome ? <p className="note" style={{ marginTop: 10 }}>{outcome}</p> : null}
        </Card>

        <Card title="DM 발송 이력" hint="한 사람에게 한 번만 나갑니다. 링크는 1회용입니다.">
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>받은 사람</th>
                  <th>보낸 시각</th>
                  <th>남은 시간</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {desk.dms.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      아직 보낸 DM이 없습니다.
                    </td>
                  </tr>
                ) : null}
                {desk.dms.slice(0, 10).map((dm) => {
                  const leftSec = Math.round((dm.expiresAt - Date.now()) / 1000);
                  return (
                    <tr key={dm.jobId}>
                      <td className="mono">{dm.handle}</td>
                      <td className="mono">{hhmmss(dm.at)}</td>
                      <td className="mono">
                        {leftSec > 0 ? `${Math.floor(leftSec / 60)}분 ${String(leftSec % 60).padStart(2, '0')}초` : '만료'}
                      </td>
                      <td>
                        {dm.purchased ? (
                          <Pill tone="ok">구매</Pill>
                        ) : dm.claimed ? (
                          <Pill tone="ok">사용함</Pill>
                        ) : dm.claimStatus === 'SOLD_OUT' ? (
                          <Pill tone="bad">소진</Pill>
                        ) : leftSec <= 0 ? (
                          <Pill tone="warn">만료</Pill>
                        ) : (
                          <Pill>보냄</Pill>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                          <Button small onClick={() => void claim(dm.jobId)}>
                            링크 열기
                          </Button>
                          {dm.claimed && !dm.purchased ? (
                            <Button
                              small
                              ghost
                              onClick={() => {
                                desk.recordPurchase(dm.jobId, 39_900);
                                setOutcome(`${dm.handle} 구매 39,900원으로 기록했습니다.`);
                                bump();
                              }}
                            >
                              구매로 기록
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {claims.length > 0 ? (
            <div className="log" style={{ marginTop: 10 }}>
              {claims.map((log, index) => (
                <div key={`${log.jobId}-${index}`}>
                  <span className="t">{hhmmss(log.at)}</span> {log.handle} ·{' '}
                  {log.status === 'GRANTED' ? `쿠폰 사용 ${won(log.reward)}` : '이미 사용했거나 만료된 링크'}
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid two">
        <Card title="오늘 성과" hint="댓글 → 링크 클릭 → 사용 → 구매">
          <div className="bars">
            {[
              { label: '댓글', value: funnel.comments, rate: 100 },
              { label: '링크 클릭', value: funnel.clicks, rate: funnel.clickThroughRate },
              { label: '쿠폰 사용', value: funnel.claims, rate: funnel.claimRate },
              { label: '구매', value: funnel.purchases, rate: funnel.purchaseRate },
            ].map((stage) => (
              <div key={stage.label} className="bar-line">
                <span className="muted">{stage.label}</span>
                <span className="meter">
                  <span style={{ width: `${Math.min(100, (stage.value / Math.max(1, funnel.comments)) * 100)}%` }} />
                </span>
                <span className="num">
                  {num(stage.value)} <span className="muted">({pct(stage.rate, 0)})</span>
                </span>
              </div>
            ))}
          </div>
          <div className="divider" />
          <div className="stack" style={{ gap: 6 }}>
            <Meter
              label="남은 쿠폰"
              value={Math.max(0, applied.claimLimit - desk.poolGranted)}
              max={applied.claimLimit}
              readout={`${remaining}장 남음`}
              tone={remaining === 0 ? 'bad' : remaining < 15 ? 'warn' : 'ok'}
            />
            <Meter
              label="쓴 예산"
              value={funnel.rewardCost}
              max={applied.rewardAmount * applied.claimLimit}
              readout={won(funnel.rewardCost)}
            />
          </div>
          <p className="note" style={{ marginTop: 10 }}>
            같은 링크를 두 번 눌러도 한 장만 인정합니다. 잔여 수량은 동시에 눌러도 0장 아래로 내려가지 않습니다.
          </p>
        </Card>

        <Card title="보내지 못한 DM" hint="5초를 넘겼거나 다시 시도해도 풀리지 않은 건">
          <table className="data">
            <thead>
              <tr>
                <th>받는 사람</th>
                <th className="num">시도</th>
                <th>이유와 다음 할 일</th>
              </tr>
            </thead>
            <tbody>
              {desk.deadLetters.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">
                    비어 있습니다. ‘자동 처리’를 끄고 댓글을 넣으면 여기에 쌓입니다.
                  </td>
                </tr>
              ) : null}
              {desk.deadLetters.slice(0, 5).map((item) => {
                const reason = friendlyFailure(item.error);
                return (
                  <tr key={item.jobId}>
                    <td className="mono">{item.recipient.slice(0, 12)}</td>
                    <td className="num">{item.attempts}</td>
                    <td className="small">
                      <strong>{reason.title}</strong>
                      <div className="muted" style={{ marginTop: 2 }}>{reason.hint}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      </div>

      <Card
        eyebrow="연결 전 점검"
        title="같은 엔진에 댓글을 넣어 보기"
        hint="실제 인스타 대신 여기서 만든 댓글을 같은 처리 흐름에 넣습니다. 연결하면 이 자리에 실제 댓글이 들어옵니다."
      >
        <div className="grid two">
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <span>댓글 내용</span>
              <input
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit({ text, handle });
                }}
                placeholder="예: 쿠폰 주세요"
              />
            </div>
            <div className="field">
              <span>보낸 사람 계정 (비우면 새 계정)</span>
              <input
                type="text"
                value={handle}
                onChange={(event) => setHandle(event.target.value)}
                placeholder="예: guri_home"
              />
            </div>
            <div className="row">
              {QUICK.map((item) => (
                <Button key={item.label} small onClick={() => setText(item.text)}>
                  {item.label}
                </Button>
              ))}
            </div>
            <div className="row">
              <Button
                primary
                onClick={() => {
                  void submit({ text, handle });
                  setHandle('');
                }}
              >
                댓글 넣기
              </Button>
              <Button
                onClick={() => {
                  void submit({ text: '쿠폰', reuseAuthor: true });
                }}
                title="같은 계정이 10초 안에 세 번 쓰면 도배로 보고 발급하지 않습니다."
              >
                같은 계정으로 도배
              </Button>
              <Button
                ghost
                small
                onClick={() => {
                  desk.reset();
                  setClaims([]);
                  setOutcome(null);
                  bump();
                }}
              >
                기록 지우기
              </Button>
            </div>
            <div className="divider" />
            <div className="row between">
              <Toggle checked={autoWorker} onChange={setAutoWorker} label="자동 처리" />
              <Button
                small
                onClick={() => {
                  void desk.runWorkerCycle().then(bump);
                }}
              >
                지금 한 번 처리
              </Button>
            </div>
            <p className="note">
              자동 처리를 끄고 5초가 지난 뒤 다시 켜 보세요. 그 사이 댓글은 ‘보내지 못한 DM’으로 옮겨집니다 —
              늦은 쿠폰은 보내지 않는 것이 이 제품의 규칙입니다.
            </p>
          </div>

          <div className="stack" style={{ gap: 10 }}>
            <div className="row between">
              <strong style={{ fontSize: 13 }}>폭주 대응 점검</strong>
              <Button
                primary
                small
                disabled={storming}
                onClick={() => {
                  setStorming(true);
                  void desk
                    .runStorm(1_000)
                    .then((report: StormReport) => {
                      setOutcome(
                        `댓글 ${num(report.comments)}건 · 발송 ${num(report.dispatched)} · 사용 ${num(report.claimsGranted)} · 초과 발급 ${report.poolOversold}건`,
                      );
                    })
                    .finally(() => {
                      setStorming(false);
                      bump();
                    });
                }}
              >
                {storming ? '돌리는 중…' : '1,000건 한 번에'}
              </Button>
            </div>
            {desk.storm ? (
              <div className="grid stat-strip">
                {[
                  { label: '댓글', value: num(desk.storm.comments) },
                  { label: '발송', value: num(desk.storm.dispatched) },
                  { label: '사용', value: num(desk.storm.claimsGranted) },
                  { label: '초과 발급', value: `${desk.storm.poolOversold}건` },
                  { label: '1초당 댓글', value: num(desk.storm.commentsPerSecond) },
                  { label: '동시 접속 대기', value: `${desk.storm.poolContentionRetries}회` },
                  { label: '중복', value: `${desk.storm.duplicates}건` },
                  { label: '도배 차단', value: `${desk.storm.abuseBlocked}건` },
                ].map((item) => (
                  <div key={item.label} className="stat-cell">
                    <div className="small muted">{item.label}</div>
                    <div className="mono stat-value">{item.value}</div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="small muted">
                댓글 1,000건을 넣고 클릭·사용까지 돌립니다. 쿠폰 100장에 초과 발급이 0건이면 동시 사용을 정확히
                막았다는 뜻입니다.
              </p>
            )}
            <div className="divider" />
            <div className="small muted">
              이 화면은 서버 없이 같은 규칙을 브라우저에서 돌린 것입니다. 실제 서버 경로는 위 3단계 표에 있고,
              인스타가 보낸 댓글이 오면 같은 계산이 MySQL에서 일어납니다.
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
