import { useEffect, useMemo, useState } from 'react';
import type { ClaimOutcome, StormReport } from '../../src/core/interactiveCouponDispatcher';
import { Button, Card, Kpi, Meter, Pill, Toggle, hhmmss, num, pct, won } from '../ui';
import { CAMPAIGN, CouponDesk } from '../model/coupon';

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

export function CouponPanel() {
  const desk = useMemo(() => new CouponDesk(() => Date.now()), []);
  const [, setTick] = useState(0);
  const [text, setText] = useState('쿠폰 주세요!');
  const [handle, setHandle] = useState('');
  const [autoWorker, setAutoWorker] = useState(true);
  const [claims, setClaims] = useState<ClaimLog[]>([]);
  const [storming, setStorming] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

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

  // The panel's toggle is the single source; the engine reads the flag.
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
      ].slice(0, 8),
    );
    bump();
  };

  const totalDispatch = desk.dispatch.dispatched + desk.dispatch.late;
  const sla = totalDispatch === 0 ? 100 : (desk.dispatch.dispatched / totalDispatch) * 100;
  const funnel = desk.funnel();
  const remaining = desk.poolRemaining;

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi
          label="웹훅 접수"
          value={num(desk.ingest.received)}
          sub={`수락 ${num(desk.ingest.accepted)} · 중복 ${num(desk.ingest.duplicates)}`}
        />
        <Kpi
          label="DM 발송"
          value={num(desk.dispatch.dispatched)}
          sub={`DLQ ${num(desk.dispatch.deadLettered)} · 재시도 ${num(desk.dispatch.retried)}`}
          tone={desk.dispatch.deadLettered > 0 ? 'warn' : undefined}
        />
        <Kpi
          label="5초 SLA"
          value={pct(sla, 1)}
          sub={`최악 지연 ${desk.dispatch.worstLatencyMs}ms`}
          tone={sla >= 100 ? 'ok' : sla >= 90 ? 'warn' : 'bad'}
        />
        <Kpi
          label="ROAS"
          value={`${funnel.roas.toFixed(2)}x`}
          sub={`매출 ${won(funnel.revenue)} / 쿠폰 원가 ${won(funnel.rewardCost)}`}
          tone={funnel.roas > 0 ? 'ok' : undefined}
        />
      </div>

      <div className="grid two">
        <Card
          eyebrow="인스타 댓글"
          title={`${CAMPAIGN.code} · 댓글 → DM 쿠폰`}
          hint={`트리거 ${CAMPAIGN.triggerKeywords.join(' · ')} · ${CAMPAIGN.rewardLabel} · 1회용 링크 ${CAMPAIGN.tokenTtlMinutes}분`}
          actions={<Pill tone={remaining === 0 ? 'bad' : remaining < 15 ? 'warn' : 'ok'}>{`잔여 ${remaining}장`}</Pill>}
        >
          <div className="stack" style={{ gap: 10 }}>
            <div className="field">
              <span>테스트 댓글</span>
              <input
                type="text"
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit({ text, handle });
                }}
                placeholder="쿠폰 / 할인 / 링크"
              />
            </div>
            <div className="field">
              <span>계정 (비우면 새 계정)</span>
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
                댓글 등록 (웹훅 전송)
              </Button>
              <Button
                onClick={() => {
                  void submit({ text: '쿠폰', reuseAuthor: true });
                }}
                title="같은 계정이 10초 안에 3번 쓰면 AUTHOR_BURST 40점 + 짧은 본문 15점"
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
                초기화
              </Button>
            </div>
            <p className="note">
              웹훅 본문은 Meta 형식 그대로 만들고 <strong>HMAC-SHA256 서명</strong>을 붙여
              <strong> dispatcher.verifySignature</strong>로 먼저 검증합니다. 서명이 틀리면 파싱조차 하지 않습니다.
            </p>
            <div className="divider" />
            <div className="row between">
              <Toggle checked={autoWorker} onChange={setAutoWorker} label="워커 자동 처리" />
              <Button
                small
                onClick={() => {
                  void desk.runWorkerCycle().then(bump);
                }}
              >
                워커 1회 실행
              </Button>
            </div>
            <p className="note">
              워커를 끄고 5초가 지난 뒤 다시 켜 보세요. 큐에 남은 건은 <strong>DEAD_LETTER(SLA_EXCEEDED)</strong>로
              빠지고 늦은 쿠폰은 발송되지 않습니다.
            </p>
          </div>
        </Card>

        <Card title="실시간 피드" hint="댓글 접수 → 판정 → DM 발급">
          <div className="feed">
            {desk.feed.length === 0 ? <p className="small muted">아직 댓글이 없습니다. 위에서 댓글을 등록해 보세요.</p> : null}
            {desk.feed.slice(0, 14).map((item) => (
              <div key={item.id} className={`msg ${item.kind === 'dm' ? 'dm' : item.kind === 'blocked' ? 'blocked' : item.kind === 'late' ? 'late' : ''}`}>
                <div className="who">
                  <span>
                    {item.kind === 'dm' ? '📩 DM' : item.kind === 'blocked' ? '🚫 차단' : item.kind === 'late' ? '⏰ 지연' : item.kind === 'ignored' ? '↩︎ 무시' : '💬 댓글'}{' '}
                    {item.handle}
                  </span>
                  <span className="mono">{hhmmss(item.at)}</span>
                </div>
                {item.text ? <div className="text">{item.text}</div> : null}
                {item.detail ? <div className="small muted">{item.detail}</div> : null}
                {item.deepLink ? (
                  <div className="link">
                    {item.deepLink}
                    <button
                      type="button"
                      className="btn small"
                      style={{ padding: '1px 6px', fontSize: 10.5 }}
                      onClick={() => {
                        void claim(item.dmId ?? -1);
                      }}
                    >
                      링크 열기
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          {outcome ? <p className="note" style={{ marginTop: 10 }}>{outcome}</p> : null}
        </Card>
      </div>

      <div className="grid two">
        <Card title="퍼널" hint="댓글 → 클릭 → 수령 → 구매 (같은 dispatcher가 집계)">
          <div className="bars">
            {[
              { label: '댓글', value: funnel.comments, rate: 100 },
              { label: '링크 클릭', value: funnel.clicks, rate: funnel.clickThroughRate },
              { label: '쿠폰 수령', value: funnel.claims, rate: funnel.claimRate },
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
              label="쿠폰 풀"
              value={desk.poolGranted}
              max={CAMPAIGN.claimLimit}
              readout={`${desk.poolGranted}/${CAMPAIGN.claimLimit}장`}
              tone={remaining === 0 ? 'bad' : remaining < 15 ? 'warn' : 'ok'}
            />
            <Meter
              label="예산"
              value={funnel.rewardCost}
              max={CAMPAIGN.totalRewardBudget}
              readout={won(funnel.rewardCost)}
            />
          </div>
          <p className="note" style={{ marginTop: 10 }}>
            수령은 풀 잔여를 <strong>원자적으로 감소</strong>시키고 토큰을 한 번만 인정합니다. 같은 링크를 두 번 눌러도
            한 장입니다.
          </p>
        </Card>

        <Card title="발급된 1회용 링크" hint="HMAC 서명 · SHA-256 해시만 저장 · 클릭 시 수령">
          <div className="scroll">
            <table className="data">
              <thead>
                <tr>
                  <th>수신자</th>
                  <th>발급</th>
                  <th>만료</th>
                  <th>상태</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {desk.dms.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="muted">
                      발급된 DM이 없습니다.
                    </td>
                  </tr>
                ) : null}
                {desk.dms.slice(0, 12).map((dm) => {
                  const leftSec = Math.round((dm.expiresAt - Date.now()) / 1000);
                  return (
                    <tr key={dm.jobId}>
                      <td className="mono">{dm.handle}</td>
                      <td className="mono">{hhmmss(dm.at)}</td>
                      <td className="mono">{leftSec > 0 ? `${Math.floor(leftSec / 60)}:${String(leftSec % 60).padStart(2, '0')}` : '만료'}</td>
                      <td>
                        {dm.purchased ? (
                          <Pill tone="ok">구매</Pill>
                        ) : dm.claimed ? (
                          <Pill tone="ok">수령</Pill>
                        ) : dm.claimStatus === 'SOLD_OUT' ? (
                          <Pill tone="bad">소진</Pill>
                        ) : leftSec <= 0 ? (
                          <Pill tone="warn">만료</Pill>
                        ) : (
                          <Pill>대기</Pill>
                        )}
                      </td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <Button small onClick={() => void claim(dm.jobId)}>
                            링크 열기
                          </Button>
                          {dm.claimed && !dm.purchased ? (
                            <Button
                              small
                              ghost
                              onClick={() => {
                                desk.recordPurchase(dm.jobId, 39_900);
                                setOutcome(`${dm.handle} 구매 39,900원 → ROAS 갱신`);
                                bump();
                              }}
                            >
                              구매 연결
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
                  <span className="t">{hhmmss(log.at)}</span> {log.handle} → {log.status}
                  {log.status === 'GRANTED' ? ` ${won(log.reward)}` : ` (${log.reason})`}
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      </div>

      <div className="grid two">
        <Card
          title="폭주 시뮬레이션"
          hint="같은 엔진으로 1,000건을 실제로 처리합니다"
          actions={
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
                      `폭주 ${num(report.comments)}건 · 발송 ${num(report.dispatched)} · 수령 ${num(report.claimsGranted)} · 오버이슈 ${report.poolOversold}건`,
                    );
                  })
                  .finally(() => {
                    setStorming(false);
                    bump();
                  });
              }}
            >
              {storming ? '실행 중…' : '1,000건 실행'}
            </Button>
          }
        >
          {desk.storm ? (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8 }}>
              {[
                { label: '댓글', value: num(desk.storm.comments) },
                { label: '발송', value: num(desk.storm.dispatched) },
                { label: '수령', value: num(desk.storm.claimsGranted) },
                { label: '오버이슈', value: `${desk.storm.poolOversold}건` },
                { label: '댓글/초', value: num(desk.storm.commentsPerSecond) },
                { label: '경합 재시도', value: `${desk.storm.poolContentionRetries}회` },
                { label: '중복', value: `${desk.storm.duplicates}건` },
                { label: '어뷰징', value: `${desk.storm.abuseBlocked}건` },
              ].map((item) => (
                <div key={item.label} style={{ background: '#f7f9fb', borderRadius: 8, padding: '8px 10px' }}>
                  <div className="small muted">{item.label}</div>
                  <div className="mono" style={{ fontSize: 14, fontWeight: 600 }}>
                    {item.value}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="small muted">
              1,000건을 한 번에 넣고 워커 사이클·클릭·수령까지 돌립니다. 풀 100장에 오버이슈 0건이면 원자적 감소가
              동작한 것입니다.
            </p>
          )}
        </Card>

        <Card title="DLQ — 사람이 확인할 건" hint="5초를 넘겼거나 재시도로 풀리지 않은 발송">
          <table className="data">
            <thead>
              <tr>
                <th>작업</th>
                <th>수신자</th>
                <th>시도</th>
                <th>사유</th>
              </tr>
            </thead>
            <tbody>
              {desk.deadLetters.length === 0 ? (
                <tr>
                  <td colSpan={4} className="muted">
                    비어 있습니다. 워커를 끄고 5초 뒤에 켜면 여기에 쌓입니다.
                  </td>
                </tr>
              ) : null}
              {desk.deadLetters.slice(0, 6).map((item) => (
                <tr key={item.jobId}>
                  <td className="mono">#{item.jobId}</td>
                  <td className="mono">{item.recipient.slice(0, 12)}</td>
                  <td>{item.attempts}</td>
                  <td>{item.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
