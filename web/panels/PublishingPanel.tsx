import { useEffect, useMemo, useState } from 'react';
import { Button, Card, Kpi, Meter, Pill, hhmmss, num, pct } from '../ui';
import { PublishDesk, type DlqRow, type QuotaView, type SlotView } from '../model/publishing';
import { friendlyFailure, jobKindLabel, jobStateLabel, resetLabel } from '../model/labels';

const CHANNEL_LABEL: Record<SlotView['channel'], string> = {
  'instagram-reels': '인스타그램 릴스',
  'youtube-shorts': '유튜브 쇼츠',
};

const CHANNEL_COLOR: Record<SlotView['channel'], string> = {
  'instagram-reels': '#c13584',
  'youtube-shorts': '#c4302b',
};

const PROVIDER_LABEL = { meta: '인스타그램', youtube: '유튜브' } as const;

export function PublishingPanel() {
  const desk = useMemo(() => new PublishDesk(() => Date.now()), []);
  const [slots, setSlots] = useState<SlotView[]>(desk.slots);
  const [quota, setQuota] = useState<QuotaView[]>(desk.quotas());
  const [dlqRows, setDlqRows] = useState<DlqRow[]>([]);
  const [actions, setActions] = useState(desk.actions);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);

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

  const publish = async (): Promise<void> => {
    const slot = await desk.publishNext();
    if (!slot) {
      setNote('오늘 남은 예약이 없습니다.');
    } else if (slot.state === 'blocked') {
      setNote(`${hhmmss(slot.atMs)} ${CHANNEL_LABEL[slot.channel]} — ${slot.reason}`);
    } else {
      setNote(`${hhmmss(slot.atMs)} ${CHANNEL_LABEL[slot.channel]} 발행 완료 · ${slot.title}`);
    }
    await refresh();
  };

  const drain = async (): Promise<void> => {
    setBusy(true);
    for (let index = 0; index < 12; index += 1) {
      const slot = await desk.publishNext();
      if (!slot) {
        setNote('남은 예약이 없습니다.');
        break;
      }
      if (slot.state === 'blocked') {
        setNote(`${CHANNEL_LABEL[slot.channel]} 발행을 멈췄습니다 — ${slot.reason}`);
        break;
      }
    }
    await refresh();
    setBusy(false);
  };

  const retry = async (jobId: string): Promise<void> => {
    const result = await desk.retry(jobId);
    setNote(
      result.ok
        ? '다시 시도 대기열에 넣었습니다. 잠시 뒤 자동으로 처리됩니다.'
        : '이미 처리 중이거나 끝난 작업이라 다시 시도할 수 없습니다.',
    );
    await refresh();
  };

  const discard = async (jobId: string): Promise<void> => {
    const result = await desk.discard(jobId);
    setNote(
      result.ok ? '목록에서 정리했습니다. 누가 정리했는지는 기록에 남습니다.' : '이미 정리된 작업입니다.',
    );
    await refresh();
  };

  const scheduled = slots.filter((slot) => slot.state === 'scheduled').length;
  const published = slots.filter((slot) => slot.state === 'published').length;
  const blocked = slots.filter((slot) => slot.state === 'blocked').length;
  const visibleRows = showAll ? dlqRows : dlqRows.slice(0, 4);

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="오늘 예약" value={`${slots.length}건`} sub={`남은 예약 ${scheduled}건`} />
        <Kpi
          label="발행 완료"
          value={`${published}건`}
          sub={`예약의 ${pct(slots.length > 0 ? (published / slots.length) * 100 : 0, 0)}`}
          tone="ok"
        />
        <Kpi
          label="한도로 멈춤"
          value={`${blocked}건`}
          sub="다음 날로 넘기거나 다른 채널로"
          tone={blocked > 0 ? 'warn' : undefined}
        />
        <Kpi
          label="확인이 필요한 작업"
          value={`${dlqRows.length}건`}
          sub="자동 재시도로 끝나지 않은 건"
          tone={dlqRows.length > 0 ? 'warn' : 'ok'}
        />
      </div>

      <div className="grid two">
        <Card
          eyebrow="오늘 남은 발행량"
          title="플랫폼별 한도"
          hint="인스타그램은 24시간에 25건, 유튜브는 하루 10,000할당량(업로드 1편 = 1,600)입니다."
        >
          <div className="stack" style={{ gap: 14 }}>
            {quota.map((tenant) => (
              <div key={tenant.tenantId} className="tenant-block">
                <div className="row between" style={{ marginBottom: 6 }}>
                  <strong style={{ fontSize: 13 }}>{tenant.name}</strong>
                  <span className="small muted">{tenant.plan === 'agency' ? '대행사' : '개인'}</span>
                </div>
                <div className="stack" style={{ gap: 10 }}>
                  {tenant.providers.map((provider) => {
                    const ratio = provider.limit === 0 ? 0 : provider.used / provider.limit;
                    return (
                      <div key={provider.provider}>
                        <Meter
                          label={PROVIDER_LABEL[provider.provider]}
                          value={provider.used}
                          max={provider.limit}
                          readout={
                            provider.provider === 'meta'
                              ? `${num(provider.used)}/${num(provider.limit)}건`
                              : `${num(provider.publishesLeft)}편 남음`
                          }
                          tone={ratio >= 1 ? 'bad' : ratio > 0.8 ? 'warn' : 'ok'}
                        />
                        <div className="small muted meter-note">
                          {provider.used === 0
                            ? '아직 사용하지 않았습니다'
                            : provider.provider === 'meta'
                              ? `${resetLabel(provider.resetInMs)} 다시 채워짐`
                              : `${num(provider.used)}/${num(provider.limit)}할당량 · ${resetLabel(provider.resetInMs)} 다시 채워짐`}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
          <p className="note" style={{ marginTop: 12 }}>
            발행을 누를 때마다 한도가 실제로 줄어듭니다. 한도를 넘으면 발행 대신 이유를 보여 주고, 그 작업은
            확인이 필요한 목록으로 들어갑니다.
          </p>
        </Card>

        <Card
          title="오늘의 예약"
          hint="09:00–22:00 사이에 간격을 흔들어 배치했습니다 (매일 같은 시각은 스케줄러로 보입니다)"
          actions={
            <>
              <Button small onClick={() => void publish()}>
                다음 예약 발행
              </Button>
              <Button small primary disabled={busy} onClick={() => void drain()}>
                {busy ? '발행 중…' : '남은 예약 모두 발행'}
              </Button>
            </>
          }
        >
          <div className="row between" style={{ marginBottom: 8 }}>
            <div className="legend">
              <span>
                <i className="tag-dot" style={{ background: CHANNEL_COLOR['instagram-reels'] }} />
                릴스
              </span>
              <span>
                <i className="tag-dot" style={{ background: CHANNEL_COLOR['youtube-shorts'] }} />
                쇼츠
              </span>
            </div>
            <span className="small muted">릴스 최소 45분 · 쇼츠 최소 90분 간격</span>
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
                      <Pill tone="warn">멈춤</Pill>
                    ) : slot.atMs < Date.now() ? (
                      <Pill tone="warn">시간 지남</Pill>
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

      <Card
        title="확인이 필요한 작업"
        hint="자동 재시도로 풀리지 않은 작업만 모입니다. 재시도하거나 정리하면 기록이 남습니다."
        actions={
          dlqRows.length > 4 ? (
            <Button small ghost onClick={() => setShowAll((value) => !value)}>
              {showAll ? '접기' : `전체 ${dlqRows.length}건 보기`}
            </Button>
          ) : null
        }
      >
        <div className="scroll">
          <table className="data">
            <thead>
              <tr>
                <th>무엇이</th>
                <th>상태</th>
                <th className="num">시도</th>
                <th>이유와 다음 할 일</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {dlqRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">
                    지금은 확인할 작업이 없습니다. 실패한 작업이 생기면 여기에 이유와 함께 쌓입니다.
                  </td>
                </tr>
              ) : null}
              {visibleRows.map((row) => {
                const state = jobStateLabel(row.state, row.kind);
                const reason = friendlyFailure(row.error);
                return (
                  <tr key={row.id}>
                    <td>
                      <strong style={{ fontSize: 12.5 }}>{jobKindLabel(row.kind)}</strong>
                      <div className="small muted">{row.name.replace(/^(render|upload|publish)\s+/, '')}</div>
                    </td>
                      <td>
                      <Pill tone={state.tone}>{state.label}</Pill>
                    </td>
                    <td className="num">
                      {row.attempts}/{row.maxAttempts}
                    </td>
                    <td className="small">
                      <strong>{reason.title}</strong>
                      <div className="muted" style={{ marginTop: 2 }}>{reason.hint}</div>
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                        <Button small primary onClick={() => void retry(row.id)}>
                          다시 시도
                        </Button>
                        <Button small ghost onClick={() => void discard(row.id)}>
                          정리
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {actions.length > 0 ? (
          <div className="log" style={{ marginTop: 10 }}>
            {actions.slice(0, 4).map((action, index) => (
              <div key={`${action.jobId}-${index}`}>
                <span className="t">{hhmmss(new Date(action.at).getTime())}</span>{' '}
                {action.action === 'retry' ? '다시 시도' : '정리'} · {action.jobId} ·{' '}
                {action.outcome === 'applied' ? '처리됨' : '거절됨'}
              </div>
            ))}
          </div>
        ) : (
          <p className="note" style={{ marginTop: 10 }}>
            다시 시도를 누르면 누가·언제·결과를 기록합니다. 이미 완료된 작업은 거절되고 그 거절도 기록에 남습니다.
          </p>
        )}
      </Card>

      <Card title="한도에 걸렸을 때 운영 순서" hint="세 가지만 기억하면 됩니다">
        <div className="grid three-steps">
          <div className="step">
            <span className="step-no">1</span>
            <h3>남은 예약을 다음 날로 넘깁니다</h3>
            <p className="small muted">
              인스타그램 25건은 24시간 단위라 그날 더 올릴 수 없습니다. 예약은 사라지지 않고 다음 창으로 밀립니다.
            </p>
          </div>
          <div className="step">
            <span className="step-no">2</span>
            <h3>확인 목록에서 다시 시도합니다</h3>
            <p className="small muted">한도가 풀린 뒤 다시 시도하면 이어서 발행됩니다. 완료된 작업은 거절됩니다.</p>
          </div>
          <div className="step">
            <span className="step-no">3</span>
            <h3>발행 시각은 조금씩 흔듭니다</h3>
            <p className="small muted">매일 같은 분에 올라가면 사람이 아니라 예약 프로그램으로 읽힙니다. 순서와 창은 그대로 둡니다.</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
