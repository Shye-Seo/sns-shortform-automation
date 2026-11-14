import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Kpi, Meter, Pill, hhmmss, num, pct } from '../ui';
import { PublishDesk, type DlqRow, type QuotaView, type SlotView } from '../model/publishing';

const CHANNEL_LABEL: Record<SlotView['channel'], string> = {
  'instagram-reels': 'Instagram Reels',
  'youtube-shorts': 'YouTube Shorts',
};

const CHANNEL_COLOR: Record<SlotView['channel'], string> = {
  'instagram-reels': '#c13584',
  'youtube-shorts': '#c4302b',
};

export function PublishingPanel() {
  const desk = useMemo(() => new PublishDesk(() => Date.now()), []);
  const [slots, setSlots] = useState<SlotView[]>(desk.slots);
  const [quota, setQuota] = useState<QuotaView[]>(desk.quotas());
  const [dlqRows, setDlqRows] = useState<DlqRow[]>([]);
  const [actions, setActions] = useState(desk.actions);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = async (): Promise<void> => {
    setSlots([...desk.slots]);
    setQuota(desk.quotas());
    setDlqRows(await desk.rows());
    setActions(desk.actions);
  };

  useEffect(() => {
    void (async () => {
      await desk.seedJobs();
      await refresh();
    })();
  }, []);

  const publish = (): void => {
    const slot = desk.publishNext();
    if (!slot) {
      setNote('예약된 슬롯이 없습니다.');
    } else if (slot.state === 'blocked') {
      setNote(`${hhmmss(slot.atMs)} ${CHANNEL_LABEL[slot.channel]} — ${slot.reason}`);
    } else {
      setNote(`${hhmmss(slot.atMs)} ${CHANNEL_LABEL[slot.channel]} 발행 완료 · ${slot.title}`);
    }
    void refresh();
  };

  const drain = async (): Promise<void> => {
    setBusy(true);
    for (let index = 0; index < 12; index += 1) {
      const slot = desk.publishNext();
      if (!slot) {
        setNote('남은 예약 슬롯이 없습니다.');
        break;
      }
      if (slot.state === 'blocked') {
        setNote(`${CHANNEL_LABEL[slot.channel]} 중단 — ${slot.reason}`);
        break;
      }
    }
    await refresh();
    setBusy(false);
  };

  const retry = async (jobId: string): Promise<void> => {
    const result = await desk.retry(jobId);
    setNote(result.message);
    await refresh();
  };

  const discard = async (jobId: string): Promise<void> => {
    const result = await desk.discard(jobId);
    setNote(result.message);
    await refresh();
  };

  const scheduled = slots.filter((slot) => slot.state === 'scheduled').length;
  const published = slots.filter((slot) => slot.state === 'published').length;
  const blocked = slots.filter((slot) => slot.state === 'blocked').length;
  const slackHours = slots.length > 0 ? 1 - published / slots.length : 0;

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="오늘 예약" value={`${slots.length}건`} sub={`남은 슬롯 ${scheduled}`} />
        <Kpi label="발행 완료" value={`${published}건`} sub={`진행률 ${pct(published > 0 ? (published / slots.length) * 100 : 0, 0)}`} tone="ok" />
        <Kpi
          label="한도로 중단"
          value={`${blocked}건`}
          sub="쿼터 소진 시 큐가 멈추고 DLQ로"
          tone={blocked > 0 ? 'warn' : undefined}
        />
        <Kpi label="DLQ" value={`${dlqRows.length}건`} sub="원클릭 재시도 대상" tone={dlqRows.length > 0 ? 'warn' : 'ok'} />
      </div>

      <div className="grid two">
        <Card
          eyebrow="일일 쿼터"
          title="플랫폼 한도 게이지"
          hint="Meta 25건/24h · YouTube 10,000 unit/일(업로드 1건 = 1,600 unit → 6건)"
        >
          <div className="stack" style={{ gap: 14 }}>
            {quota.map((tenant) => (
              <div key={tenant.tenantId}>
                <div className="row between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>
                    {tenant.name} <span className="muted small">({tenant.plan})</span>
                  </strong>
                  <span className="small muted mono">{tenant.tenantId}</span>
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  {tenant.providers.map((provider) => {
                    const ratio = provider.limit === 0 ? 0 : provider.used / provider.limit;
                    return (
                      <div key={provider.provider}>
                        <Meter
                          label={provider.provider === 'meta' ? 'Meta Graph' : 'YouTube'}
                          value={provider.used}
                          max={provider.limit}
                          readout={
                            provider.provider === 'meta'
                              ? `${provider.used}/${provider.limit}건`
                              : `${num(provider.used)}/${num(provider.limit)}`
                          }
                          tone={ratio >= 1 ? 'bad' : ratio > 0.8 ? 'warn' : 'ok'}
                        />
                        <div className="small muted" style={{ paddingLeft: 88 }}>
                          남은 발행 {provider.publishesLeft}건 · 요청 버킷 {Math.round(provider.requestRemaining)}/
                          {Math.round(provider.requestCapacity)} · {Math.round(provider.resetInMs / 3_600_000)}시간 뒤 초기화
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            슬롯을 발행하면 <strong>TenantRegistry.consume</strong>이 쿼터와 요청 버킷을 함께 차감합니다. 한도를 넘으면
            발행 대신 이유를 돌려주고, 이 실패는 큐에 실제 작업으로 들어가 DLQ 경로를 탑니다.
          </p>
        </Card>

        <Card
          title="예약 발행 큐"
          hint="planPublishSlots가 창(09:00–22:00) 안에서 간격을 흔들어 배치합니다"
          actions={
            <>
              <Button small onClick={publish}>
                다음 슬롯 발행
              </Button>
              <Button small primary disabled={busy} onClick={() => void drain()}>
                {busy ? '처리 중…' : '전체 발행'}
              </Button>
            </>
          }
        >
          <div className="row between" style={{ marginBottom: 8 }}>
            <div className="legend">
              <span>
                <i className="tag-dot" style={{ background: CHANNEL_COLOR['instagram-reels'] }} />
                Reels
              </span>
              <span>
                <i className="tag-dot" style={{ background: CHANNEL_COLOR['youtube-shorts'] }} />
                Shorts
              </span>
            </div>
            <span className="small muted">슬롯 간격 최소 45분 · 90분</span>
          </div>
          <div className="scroll" style={{ maxHeight: 340 }}>
            {slots.map((slot, index) => (
              <div key={slot.id} className="day" style={{ borderBottom: index === slots.length - 1 ? 'none' : undefined }}>
                <div className="label">{hhmmss(slot.atMs).slice(0, 5)}</div>
                <div className={`slot ${slot.state === 'published' ? 'published' : slot.state === 'blocked' ? 'blocked' : ''}`}>
                  <i className="tag-dot" style={{ background: CHANNEL_COLOR[slot.channel] }} />
                  <span className="time">{slot.title}</span>
                  <span className="chan">{CHANNEL_LABEL[slot.channel]}</span>
                  <span style={{ marginLeft: 'auto' }}>
                    {slot.state === 'published' ? (
                      <Pill tone="ok">발행</Pill>
                    ) : slot.state === 'blocked' ? (
                      <Pill tone="warn">중단</Pill>
                    ) : (
                      <Pill tone="ghost">예약</Pill>
                    )}
                  </span>
                </div>
              </div>
            ))}
          </div>
          {note ? <p className="note" style={{ marginTop: 10 }}>{note}</p> : null}
        </Card>
      </div>

      <Card title="DLQ — 원클릭 재시도" hint="재시도는 상태 확인 → 큐 전이 → 운영자 기록을 한 번에 남깁니다">
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>작업</th>
                <th>이름</th>
                <th>종류</th>
                <th className="num">시도</th>
                <th>사유</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dlqRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="muted">
                    실패한 작업이 없습니다.
                  </td>
                </tr>
              ) : null}
              {dlqRows.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.id}</td>
                  <td>{row.name}</td>
                  <td>
                    <Pill tone={row.state === 'dlq' ? 'warn' : 'bad'}>{row.state}</Pill>
                  </td>
                  <td className="num">
                    {row.attempts}/{row.maxAttempts}
                  </td>
                  <td className="small">{row.error ?? '-'}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <Button small primary onClick={() => void retry(row.id)}>
                        재시도
                      </Button>
                      <Button small ghost onClick={() => void discard(row.id)}>
                        폐기
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {actions.length > 0 ? (
          <div className="log" style={{ marginTop: 10 }}>
            {actions.map((action, index) => (
              <div key={`${action.jobId}-${index}`}>
                <span className="t">{hhmmss(new Date(action.at).getTime())}</span> {action.actor} · {action.action} ·{' '}
                {action.jobId} · {action.outcome} — {action.detail}
              </div>
            ))}
          </div>
        ) : (
          <p className="note" style={{ marginTop: 10 }}>
            재시도를 누르면 <strong>DlqActionService</strong>가 운영자·시각·결과를 기록합니다. 감사 기록은 대시보드가
            상태를 바꾸는 것과 별개로 남습니다.
          </p>
        )}
      </Card>

      <Card title="발행 창 운영" hint="한도에 걸린 뒤 무엇을 하는지">
        <div className="row" style={{ gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 260px' }}>
            <h3>1. 한도에 걸리면 큐가 멈춥니다</h3>
            <p className="small muted">
              Meta 25건은 리셋이 24시간 창이라 그날 더 올릴 수 없습니다. 재시도로 풀리지 않으므로 운영자는 남은 슬롯을
              다음 창으로 넘기거나 다른 채널로 돌립니다.
            </p>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <h3>2. 재시도는 상태를 확인합니다</h3>
            <p className="small muted">
              DLQ 또는 실패 상태만 재시도할 수 있습니다. 이미 완료된 작업을 다시 큐에 넣는 실수는 409로 거부되고 그
              거부도 기록에 남습니다.
            </p>
          </div>
          <div style={{ flex: '1 1 260px' }}>
            <h3>3. 슬롯 간격은 흔들어 둡니다</h3>
            <p className="small muted">
              매일 같은 분에 올라가는 계정은 사람이 아니라 스케줄러로 읽힙니다. 지터를 넣어도 발행 순서와 창은
              그대로입니다.
            </p>
          </div>
        </div>
        <div className="divider" />
        <div className="row between small">
          <span className="muted">예약 대비 발행률</span>
          <span className="mono">{pct(published > 0 && slots.length > 0 ? (published / slots.length) * 100 : 0, 0)}</span>
        </div>
        <span className="meter" style={{ marginTop: 6 }}>
          <span style={{ width: `${(1 - slackHours) * 100}%` }} />
        </span>
      </Card>
    </div>
  );
}
