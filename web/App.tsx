import { useEffect, useState } from 'react';
import type { SceneDraft } from '../src/services/scriptEngine';
import type { ContentPlan, TrendItem } from '../src/services/sonder/types';
import type { AngleChoice } from '../src/types/plan';
import { StudioPanel } from './panels/StudioPanel';
import { CouponPanel } from './panels/CouponPanel';
import { PublishingPanel } from './panels/PublishingPanel';
import { HookPanel } from './panels/HookPanel';
import { CrossChannelPanel } from './panels/CrossChannelPanel';
import { OsmuPanel } from './panels/OsmuPanel';
import { CreatorStudioPanel, type CreatorSeed } from './panels/CreatorStudioPanel';
import { IdentityPanel } from './panels/IdentityPanel';
import { TrendVaultPanel } from './panels/TrendVaultPanel';
import { PlanComposerPanel } from './panels/PlanComposerPanel';
import { PerformancePanel } from './panels/PerformancePanel';
import { draftBeatScene } from './model/studio';
import { resolveStore, type SonderMode, type SonderStore } from './model/sonder/repo';
import { Button } from './ui';

type TabId =
  | 'identity'
  | 'trends'
  | 'plan'
  | 'performance'
  | 'studio'
  | 'creator'
  | 'cross'
  | 'osmu'
  | 'coupon'
  | 'calendar'
  | 'hooks';

const PLAN_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'identity', label: '채널 정체성' },
  { id: 'trends', label: '트렌드 보관함' },
  { id: 'plan', label: '합체 기획안' },
  { id: 'performance', label: '성과 로그' },
];

const BUILD_TABS: Array<{ id: TabId; label: string }> = [
  { id: 'studio', label: '9:16 스튜디오' },
  { id: 'creator', label: '실사용 스튜디오' },
  { id: 'cross', label: '크로스채널 기획' },
  { id: 'osmu', label: '한 편을 세 곳으로' },
  { id: 'coupon', label: '댓글 → DM 쿠폰' },
  { id: 'calendar', label: '발행 캘린더 · 쿼터' },
  { id: 'hooks', label: '훅 A/B' },
];

const DEFAULT_TOPIC = '부산 신혼집 3평 주방 수납 정리법';

const MODE_LABEL: Record<SonderMode, string> = {
  checking: '연결 확인 중',
  local: '로컬 모드',
  cloud: '클라우드 DB 연결됨',
};

const MODE_HINT: Record<SonderMode, string> = {
  checking: '저장 위치를 확인하고 있습니다.',
  local: '이 브라우저에만 저장합니다. 서버 없이도 모든 계산이 그대로 동작합니다.',
  cloud: 'Supabase에 저장합니다. 다른 기기에서도 같은 채널·기획안을 씁니다.',
};

export function App() {
  const [tab, setTab] = useState<TabId>('studio');
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [durationSec, setDurationSec] = useState(45);
  const [speed, setSpeed] = useState(1);
  const [compress, setCompress] = useState(true);
  const [angle, setAngle] = useState<AngleChoice>('auto');
  const [variation, setVariation] = useState(0);
  const [drafts, setDrafts] = useState<SceneDraft[]>(() => draftBeatScene(DEFAULT_TOPIC, 45, 0, 'auto'));
  /** 대본을 만든 주체. AI 키로 생성하면 그 모델 이름이 들어간다. */
  const [aiSource, setAiSource] = useState<string | null>(null);

  /** 저장 위치. 앱을 열 때 한 번만 확인한다. */
  const [mode, setMode] = useState<SonderMode>('checking');
  const [store, setStore] = useState<SonderStore | null>(null);
  /** 트렌드 보관함 → 기획안으로 넘길 때 고른 항목. */
  const [planTrend, setPlanTrend] = useState<TrendItem | null>(null);
  /** 기획안 → 실사용 스튜디오로 넘길 컷 묶음. */
  const [studioSeed, setStudioSeed] = useState<CreatorSeed | null>(null);
  /** 기획안 → 성과 로그로 넘길 때 미리 채울 값. */
  const [perfPlan, setPerfPlan] = useState<ContentPlan | null>(null);

  useEffect(() => {
    let alive = true;
    resolveStore()
      .then((resolved) => {
        if (!alive) return;
        setMode(resolved.mode);
        setStore(resolved.store);
      })
      .catch(() => {
        if (alive) setMode('local');
      });
    return () => {
      alive = false;
    };
  }, []);

  /**
   * The topic is the input the script is derived from, so changing it has to
   * re-derive the script. Previously the topic field only updated its own state
   * and the old drafts stayed in place — the captions kept saying "주방수납"
   * no matter what was typed.
   */
  const changeTopic = (value: string): void => {
    setTopic(value);
    setDrafts(draftBeatScene(value, durationSec, variation, angle));
    setAiSource(null);
  };

  const regenerate = (): void => {
    const next = variation + 1;
    setVariation(next);
    setDrafts(draftBeatScene(topic, durationSec, next, angle));
    setAiSource(null);
  };

  const changeAngle = (value: AngleChoice): void => {
    setAngle(value);
    setDrafts(draftBeatScene(topic, durationSec, variation, value));
    setAiSource(null);
  };

  const changeDuration = (value: number): void => {
    setDurationSec(value);
    setDrafts(draftBeatScene(topic, value, variation, angle));
    setAiSource(null);
  };

  /**
   * 연결한 AI 모델이 만든 대본을 그대로 받는다. 내장 엔진과 같은 타임라인·
   * 자막 계산을 통과하므로, 미리보기와 편집 패키지도 같은 값으로 나온다.
   */
  const adoptAiDrafts = (next: SceneDraft[], source: string): void => {
    setDrafts(next);
    setAiSource(source);
  };

  const adoptHook = (text: string): void => {
    setDrafts(drafts.map((draft, index) => (index === 0 ? { ...draft, narration: text } : draft)));
    setTab('studio');
  };

  const openStudio = (seed: CreatorSeed): void => {
    setStudioSeed(seed);
    setTab('creator');
  };

  const showFlow = tab === 'studio' || tab === 'creator';

  return (
    <div className="app">
      <header className="masthead">
        <div className="masthead-main">
          <p className="eyebrow">숏폼 운영 콘솔</p>
          <h1>숏폼 스튜디오</h1>
          <p className="lede">
            채널 정체성과 트렌드 구조를 합쳐 기획안을 만들고, 올린 영상의 성과를 다시 다음 기획에 넣습니다. 사진·영상으로
            만든 9:16 결과물과 발행 한도·댓글 쿠폰까지 이 화면에서 확인합니다.
          </p>
        </div>
        <div className="masthead-side">
          <span className={`status mode ${mode}`} title={MODE_HINT[mode]} data-testid="mode-badge">
            <span className="dot" aria-hidden="true" />
            {MODE_LABEL[mode]}
          </span>
          <span className="status-sub">
            {mode === 'cloud' ? '채널·기획안·성과가 서버에 쌓입니다' : '서버 없이 브라우저에서 계산·저장'}
          </span>
        </div>
      </header>

      {showFlow ? (
        <div className="flow">
          <span className="flow-step">
            <span className="flow-no">1</span>사진·영상·링크
          </span>
          <span className="flow-arrow" aria-hidden="true">
            →
          </span>
          <span className="flow-step">
            <span className="flow-no">2</span>9:16 편집 · 미리보기
          </span>
          <span className="flow-arrow" aria-hidden="true">
            →
          </span>
          <span className="flow-step">
            <span className="flow-no">3</span>영상 · 카드뉴스 내보내기
          </span>
          <span className="flow-note">탭을 바꿔도 같은 주제로 이어집니다</span>
        </div>
      ) : null}

      <div className="tabs-wrap">
        <nav className="tabs plan-tabs" role="tablist" aria-label="기획">
          <span className="tabs-label" aria-hidden="true">
            기획
          </span>
          {PLAN_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <nav className="tabs build-tabs" role="tablist" aria-label="제작·운영">
          <span className="tabs-label" aria-hidden="true">
            제작
          </span>
          {BUILD_TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              className="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === 'studio' ? (
        <div className="creator-banner">
          <span>
            <strong>실사용 스튜디오</strong> — 올린 사진·영상으로 9:16 영상과 카드뉴스를 바로 렌더링합니다.
          </span>
          <Button small primary onClick={() => setTab('creator')}>
            실사용 스튜디오 열기
          </Button>
        </div>
      ) : null}

      {tab === 'identity' ? <IdentityPanel store={store} mode={mode} /> : null}

      {tab === 'trends' ? (
        <TrendVaultPanel
          store={store}
          mode={mode}
          onUseTrend={(item) => {
            setPlanTrend(item);
            setTab('plan');
          }}
        />
      ) : null}

      {tab === 'plan' ? (
        <PlanComposerPanel
          store={store}
          mode={mode}
          topic={topic}
          onTopic={changeTopic}
          initialTrend={planTrend}
          onOpenStudio={openStudio}
          onOpenPerformance={(plan) => {
            setPerfPlan(plan);
            setTab('performance');
          }}
          onOpenTrends={() => setTab('trends')}
        />
      ) : null}

      {tab === 'performance' ? <PerformancePanel store={store} mode={mode} initialPlan={perfPlan} /> : null}

      {tab === 'studio' ? (
        <StudioPanel
          topic={topic}
          onTopic={changeTopic}
          durationSec={durationSec}
          onDuration={changeDuration}
          speed={speed}
          onSpeed={setSpeed}
          drafts={drafts}
          onDrafts={setDrafts}
          compress={compress}
          onCompress={setCompress}
          language="ko"
          angle={angle}
          onAngle={changeAngle}
          variation={variation}
          onRegenerate={regenerate}
          onOpenPlan={() => setTab('cross')}
          aiSource={aiSource}
          onAiDrafts={adoptAiDrafts}
          onAiReset={() => {
            setAiSource(null);
            setDrafts(draftBeatScene(topic, durationSec, variation, angle));
          }}
        />
      ) : null}

      {tab === 'creator' ? (
        <CreatorStudioPanel
          key={studioSeed ? `seed-${studioSeed.topic}-${studioSeed.cuts.length}` : 'sample'}
          seed={studioSeed}
          onBackToPlan={() => setTab('plan')}
        />
      ) : null}

      {tab === 'cross' ? (
        <CrossChannelPanel topic={topic} onTopic={changeTopic} onBackToStudio={() => setTab('studio')} />
      ) : null}

      {tab === 'osmu' ? (
        <OsmuPanel topic={topic} drafts={drafts} durationSec={durationSec} onBackToStudio={() => setTab('studio')} />
      ) : null}

      {tab === 'coupon' ? <CouponPanel /> : null}
      {tab === 'calendar' ? <PublishingPanel topic={topic} drafts={drafts} durationSec={durationSec} /> : null}
      {tab === 'hooks' ? <HookPanel topic={topic} onAdopt={adoptHook} /> : null}

      <footer className="foot">
        <span>
          화면의 판정(한도·실패·재시도)은 엔진이 실제로 계산한 결과입니다. 외부 플랫폼 연결 전에는 예시 데이터로
          같은 계산을 보여 줍니다.
        </span>
        <span className="mono">
          <a href="https://github.com/Shye-Seo/sns-shortform-automation" rel="noreferrer noopener">
            github.com/Shye-Seo/sns-shortform-automation
          </a>
        </span>
      </footer>
    </div>
  );
}
