import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { Button, Card, Kpi, Pill } from '../ui';
import {
  HOOK_PATTERN_LABEL,
  PLAN_GOAL_LABEL,
  type ChannelIdentity,
  type ContentPlan,
  type HookId,
  type PlanGoal,
  type TrendItem,
} from '../../src/services/sonder/types';
import { shortCaption } from '../../src/services/sonder/planner';
import type { SonderMode, SonderStore } from '../model/sonder/repo';
import type { CreatorSeed } from './CreatorStudioPanel';
import { RatioBar, count, sec } from './sonder/BeatBars';

/**
 * 합체 기획안 — 빌린 구조에 내 채널 정체성을 얹어 후킹 3안·컷별 자막·박자표·
 * 캡션을 만든다. 만든 기획안은 실사용 스튜디오로 컷을 넘겨 바로 편집할 수 있다.
 */

export interface PlanComposerPanelProps {
  store: SonderStore | null;
  mode: SonderMode;
  topic: string;
  onTopic: (value: string) => void;
  initialTrend: TrendItem | null;
  onOpenStudio: (seed: CreatorSeed) => void;
  onOpenPerformance: (plan: ContentPlan) => void;
  onOpenTrends: () => void;
}

const GOALS: PlanGoal[] = ['save', 'comment', 'follow', 'link'];

export function PlanComposerPanel({
  store,
  mode,
  topic,
  onTopic,
  initialTrend,
  onOpenStudio,
  onOpenPerformance,
  onOpenTrends,
}: PlanComposerPanelProps) {
  const [identities, setIdentities] = useState<ChannelIdentity[]>([]);
  const [trends, setTrends] = useState<TrendItem[]>([]);
  const [plans, setPlans] = useState<ContentPlan[]>([]);
  const [logs, setLogs] = useState(0);

  const [identityId, setIdentityId] = useState('');
  const [trendId, setTrendId] = useState('');
  const [durationSec, setDurationSec] = useState('45');
  const [goal, setGoal] = useState<PlanGoal>('save');
  const [chosenHook, setChosenHook] = useState<HookId>('A');

  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [recommended, setRecommended] = useState<HookId>('A');
  const [warning, setWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!store) return;
    let alive = true;
    Promise.all([store.listIdentities(), store.listTrends(), store.listPlans(), store.listLogs()])
      .then(([nextIdentities, nextTrends, nextPlans, nextLogs]) => {
        if (!alive) return;
        setIdentities(nextIdentities);
        setTrends(nextTrends);
        setPlans(nextPlans);
        setLogs(nextLogs.length);
        setIdentityId((current) => current || nextIdentities[0]?.id || '');
        setTrendId((current) => current || nextTrends[0]?.id || '');
        if (nextTrends[0]) setDurationSec(String(Math.round(nextTrends[0].structure.durationSec || 45)));
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : '자료를 불러오지 못했습니다');
      });
    return () => {
      alive = false;
    };
  }, [store]);

  // 보관함에서 "기획안으로"를 눌러 들어오면 그 항목을 고른다.
  useEffect(() => {
    if (!initialTrend) return;
    setTrends((prev) => (prev.some((item) => item.id === initialTrend.id) ? prev : [initialTrend, ...prev]));
    setTrendId(initialTrend.id);
    setDurationSec(String(Math.round(initialTrend.structure.durationSec || 45)));
    setGoal(initialTrend.structure.goal ?? 'save');
  }, [initialTrend]);

  const trend = useMemo(() => trends.find((item) => item.id === trendId) ?? null, [trends, trendId]);
  const identity = useMemo(() => identities.find((item) => item.id === identityId) ?? identities[0] ?? null, [identities, identityId]);

  const generate = async (hook: HookId = chosenHook): Promise<void> => {
    if (!store || !identity || !trend) {
      setError('채널 정체성과 참고 영상을 먼저 골라 주세요.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    setWarning('');
    try {
      const result = await store.generatePlan({
        topic,
        identity,
        structure: trend.structure,
        trendId: trend.id,
        trendTitle: trend.title,
        durationSec: Number(durationSec) || trend.structure.durationSec || 45,
        goal,
        chosenHook: hook,
      });
      setPlan(result.plan);
      setRecommended(result.recommended);
      setChosenHook(result.plan.chosenHook);
      setWarning(result.warning ?? '');
      setPlans(await store.listPlans());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '기획안을 만들지 못했습니다');
    } finally {
      setBusy(false);
    }
  };

  const copyCaption = async (): Promise<void> => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.caption);
      setNotice('캡션을 복사했습니다.');
    } catch {
      setError('이 브라우저에서는 클립보드에 쓰지 못했습니다. 캡션을 직접 선택해 복사해 주세요.');
    }
  };

  const openStudio = (): void => {
    if (!plan) return;
    onOpenStudio({
      topic: plan.topic,
      badge: shortCaption(plan.topic, 12),
      cuts: plan.scenes.map((scene) => ({
        caption: scene.caption,
        note: scene.narration,
        durationSec: Math.max(0.6, scene.endSec - scene.startSec),
      })),
    });
  };

  const totalSec = plan?.checks.totalSec ?? 0;

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="채널" value={identity?.name ?? '—'} sub={identity?.handle || '핸들 없음'} />
        <Kpi label="빌린 구조" value={trend ? HOOK_PATTERN_LABEL[trend.structure.hookPattern] : '—'} sub={trend?.title || '보관함에서 고르세요'} />
        <Kpi label="성과 로그" value={`${logs}건`} sub="다음 추천에 반영" />
        <Kpi label="저장한 기획안" value={`${plans.length}건`} sub={mode === 'cloud' ? '클라우드 저장' : '이 브라우저 저장'} />
      </div>

      <Card
        eyebrow="합체"
        title="무엇을 합칠까요"
        hint="빌린 구조가 순서를 정하고, 채널 정체성이 말투를 정합니다. 주제는 그 사이에 끼웁니다."
        actions={
          <Button primary onClick={() => void generate()} disabled={busy || !store || !trend || !identity}>
            {busy ? '만드는 중…' : '기획안 만들기'}
          </Button>
        }
      >
        <div className="form-block">
          <label className="field">
            <span>주제</span>
            <input type="text" value={topic} onChange={(event: ChangeEvent<HTMLInputElement>) => onTopic(event.target.value)} />
          </label>
          <div className="field-row">
            <label className="field">
              <span>채널 정체성</span>
              <select value={identityId} onChange={(event) => setIdentityId(event.target.value)}>
                {identities.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name} {item.handle ? `(${item.handle})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>빌린 구조</span>
              <select
                value={trendId}
                onChange={(event) => {
                  const next = trends.find((item) => item.id === event.target.value) ?? null;
                  setTrendId(event.target.value);
                  if (next) {
                    setDurationSec(String(Math.round(next.structure.durationSec || 45)));
                    setGoal(next.structure.goal ?? goal);
                  }
                }}
              >
                {trends.length === 0 ? <option value="">보관함이 비어 있습니다</option> : null}
                {trends.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title} · {item.multiplier ? `${item.multiplier.toFixed(1)}배` : '배수 없음'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="field-row">
            <label className="field">
              <span>길이(초)</span>
              <input
                type="number"
                min={12}
                max={60}
                value={durationSec}
                onChange={(event) => setDurationSec(event.target.value)}
              />
            </label>
            <label className="field">
              <span>마무리 요구</span>
              <select value={goal} onChange={(event) => setGoal(event.target.value as PlanGoal)}>
                {GOALS.map((item) => (
                  <option key={item} value={item}>
                    {PLAN_GOAL_LABEL[item]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {trends.length === 0 ? (
            <div className="notice">
              <span>빌릴 구조가 아직 없습니다. 트렌드 보관함에서 참고 영상을 하나 저장해 주세요.</span>{' '}
              <Button small ghost onClick={onOpenTrends}>
                트렌드 보관함으로
              </Button>
            </div>
          ) : null}
          {error ? <p className="notice bad">{error}</p> : null}
          {warning ? <p className="notice warn">{warning}</p> : null}
        </div>
      </Card>

      {plan ? (
        <>
          <Card
            title="후킹 3안"
            hint="같은 주제를 세 방식으로 엽니다. 고르면 컷 시간과 자막이 다시 계산됩니다."
            actions={
              <span className="small muted">
                추천 {recommended}안
                {recommended === 'A' ? ' · 빌려온 패턴' : ' · 내 로그에서 저장률이 높은 패턴'}
              </span>
            }
          >
            <div className="hook-options">
              {plan.hooks.map((hook) => (
                <button
                  key={hook.id}
                  type="button"
                  className={hook.id === chosenHook ? 'hook-option active' : 'hook-option'}
                  aria-pressed={hook.id === chosenHook}
                  disabled={busy}
                  onClick={() => {
                    setChosenHook(hook.id);
                    void generate(hook.id);
                  }}
                >
                  <span className="hook-head">
                    <span className="hook-id">{hook.id}</span>
                    <Pill tone="ghost">{HOOK_PATTERN_LABEL[hook.pattern]}</Pill>
                    {hook.id === recommended ? <Pill tone="ok">추천</Pill> : null}
                    <span className="small muted">{hook.text.length}자</span>
                  </span>
                  <span className="hook-text">{hook.text}</span>
                  <span className="small muted hook-reason">{hook.reason}</span>
                </button>
              ))}
            </div>
          </Card>

          <div className="grid two">
            <Card title="컷별 자막" hint="9:16 스튜디오로 넘기면 이 컷들이 그대로 편집 목록이 됩니다.">
              <div className="scroll" style={{ maxHeight: 420 }}>
                <table className="data">
                  <thead>
                    <tr>
                      <th className="num">#</th>
                      <th>구간</th>
                      <th>박자</th>
                      <th>화면 자막</th>
                      <th>내레이션</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.scenes.map((scene, index) => (
                      <tr key={`${scene.beat}-${index}`}>
                        <td className="num">{index + 1}</td>
                        <td className="num mono" style={{ whiteSpace: 'nowrap' }}>
                          {scene.startSec}–{scene.endSec}s
                        </td>
                        <td>{scene.label}</td>
                        <td>
                          <strong>{scene.caption}</strong>
                        </td>
                        <td className="small">{scene.narration}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                <Button primary onClick={openStudio}>
                  실사용 스튜디오에서 열기
                </Button>
                <Button ghost onClick={() => onOpenPerformance(plan)}>
                  성과 로그에 기록
                </Button>
              </div>
            </Card>

            <Card title="박자표" hint="빌린 구조와 이 기획안의 박자를 같은 자로 놓았습니다.">
              <div className="stack" style={{ gap: 14 }}>
                {plan.beatTable.map((row) => (
                  <div key={row.beat}>
                    <RatioBar
                      label={row.label}
                      ratio={row.planRatio}
                      readout={`${sec(row.planSec)} / ${Math.round(row.planRatio * 100)}%`}
                      tone={Math.abs(row.deltaSec) >= 1.5 ? 'warn' : undefined}
                    />
                    <div className="small muted" style={{ marginLeft: 62 }}>
                      빌린 구조 {sec(row.borrowedSec)} · 차이 {row.deltaSec > 0 ? '+' : ''}
                      {row.deltaSec}초
                    </div>
                  </div>
                ))}
                <div className="meta-line">
                  <span className="meta-item">합계 {sec(totalSec)}</span>
                  <span className="sep" aria-hidden="true" />
                  <span className="meta-item">훅 {sec(plan.checks.hookSec)}</span>
                  <span className="sep" aria-hidden="true" />
                  <span className="meta-item">{plan.scenes.length}컷</span>
                </div>
              </div>
            </Card>
          </div>

          <Card
            title="캡션"
            hint="첫 줄은 고른 훅, 본문은 해결 구간, 마지막은 요구와 시그니처입니다."
            actions={
              <Button small onClick={() => void copyCaption()}>
                복사
              </Button>
            }
          >
            <pre className="caption-doc" data-testid="plan-caption">
              {plan.caption}
            </pre>
            {notice ? <p className="notice ok">{notice}</p> : null}
          </Card>

          <div className="grid two">
            <Card title="점검" hint="내보내기 전에 걸리는 것을 먼저 짚습니다.">
              <ul className="check-list">
                <li className={plan.checks.bannedHits.length === 0 ? 'ok' : 'bad'}>
                  <span>쓰지 않는 표현</span>
                  <strong>
                    {plan.checks.bannedHits.length === 0 ? '없음' : `${plan.checks.bannedHits.length}건 · ${plan.checks.bannedHits.join(', ')}`}
                  </strong>
                </li>
                <li className={plan.checks.hookSec <= 3.5 ? 'ok' : 'warn'}>
                  <span>훅 길이</span>
                  <strong>{sec(plan.checks.hookSec)}</strong>
                </li>
                <li
                  className={
                    plan.checks.totalSec <= Number(durationSec) + 0.5 && plan.checks.totalSec >= Number(durationSec) - 3
                      ? 'ok'
                      : 'warn'
                  }
                >
                  <span>총 길이</span>
                  <strong>
                    {sec(plan.checks.totalSec)} / 목표 {durationSec}초
                  </strong>
                </li>
                <li className="plain">
                  <span>채널</span>
                  <strong>{plan.identityName}</strong>
                </li>
              </ul>
              {plan.checks.rhythmNotes.length > 0 ? (
                <ul className="evidence" style={{ marginTop: 12 }}>
                  {plan.checks.rhythmNotes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              ) : (
                <p className="note" style={{ marginTop: 10 }}>
                  빌린 구조의 박자와 크게 어긋나는 구간이 없습니다.
                </p>
              )}
            </Card>

            <Card title="메모" hint="이 기획안을 만들 때 엔진이 남긴 판단입니다.">
              <ul className="plain-list">
                {plan.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
              <p className="note" style={{ marginTop: 10 }}>
                {plan.source === 'rules'
                  ? '대본: 내장 문장 엔진'
                  : `대본: 연결한 모델(${plan.source === 'openai' ? 'OpenAI' : 'Anthropic'})이 쓴 문장, 시간은 엔진 계산`}
              </p>
            </Card>
          </div>
        </>
      ) : (
        <Card title="아직 만든 기획안이 없습니다" hint="위에서 채널과 구조를 고르고 기획안 만들기를 누르세요.">
          <p className="small muted" style={{ margin: 0 }}>
            기획안을 만들면 후킹 3안, 컷별 자막, 박자표, 캡션이 한 번에 나옵니다. 마음에 드는 안을 고르면 컷 시간과
            자막이 다시 계산되고, 그대로 실사용 스튜디오에서 편집할 수 있습니다.
          </p>
        </Card>
      )}

      {plans.length > 0 ? (
        <Card title="최근 기획안" hint="저장된 기획안을 다시 열어 스튜디오로 넘길 수 있습니다.">
          <div className="scroll" style={{ maxHeight: 320 }}>
            <table className="data">
              <thead>
                <tr>
                  <th>주제</th>
                  <th>채널</th>
                  <th>훅</th>
                  <th className="num">길이</th>
                  <th>만든 날</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plans.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{item.topic}</strong>
                      <div className="small muted">{item.trendTitle || '빌린 구조 없음'}</div>
                    </td>
                    <td>{item.identityName}</td>
                    <td>{HOOK_PATTERN_LABEL[item.hooks.find((hook) => hook.id === item.chosenHook)?.pattern ?? 'story']}</td>
                    <td className="num">{count(item.checks.totalSec)}초</td>
                    <td className="small muted">{item.createdAt.slice(0, 10)}</td>
                    <td>
                      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                        <Button
                          small
                          onClick={() => {
                            setPlan(item);
                            setChosenHook(item.chosenHook);
                            setRecommended(item.chosenHook);
                          }}
                        >
                          열기
                        </Button>
                        <Button
                          small
                          ghost
                          onClick={() =>
                            onOpenStudio({
                              topic: item.topic,
                              badge: shortCaption(item.topic, 12),
                              cuts: item.scenes.map((scene) => ({
                                caption: scene.caption,
                                note: scene.narration,
                                durationSec: Math.max(0.6, scene.endSec - scene.startSec),
                              })),
                            })
                          }
                        >
                          스튜디오
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
