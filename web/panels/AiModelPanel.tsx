import { useEffect, useState } from 'react';
import type { SceneDraft } from '../../src/services/scriptEngine';
import type { AngleChoice } from '../../src/types/plan';
import { Button, Card } from '../ui';
import {
  AI_MODELS,
  AI_PROVIDER_LABEL,
  clearAiConfig,
  describeAiResult,
  generateDraftsWithAi,
  loadAiConfig,
  saveAiConfig,
  type AiConfig,
  type AiProvider,
} from '../model/aiScript';

/**
 * AI 모델 직접 연결(선택).
 *
 * 정적 웹 데모에는 서버가 없다. 그래서 키는 브라우저 localStorage에만 두고,
 * 호출은 브라우저에서 제공자 API로 바로 나간다. 키를 넣지 않으면 이 카드는
 * 아무 일도 하지 않고, 아래 대본은 개편된 내장 도메인 엔진이 만든다.
 */

export interface AiModelPanelProps {
  topic: string;
  durationSec: number;
  angle: AngleChoice;
  /** 지금 대본을 만든 주체. null이면 내장 엔진. */
  source: string | null;
  onDrafts: (drafts: SceneDraft[], source: string) => void;
  onReset: () => void;
}

type Status = { kind: 'idle' } | { kind: 'running' } | { kind: 'ok'; message: string } | { kind: 'error'; message: string };

export function AiModelPanel({ topic, durationSec, angle, source, onDrafts, onReset }: AiModelPanelProps) {
  const [config, setConfig] = useState<AiConfig>(() => loadAiConfig());
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // 저장이 막힌 브라우저(사생활 보호 모드)에서는 키를 메모리에만 둔다.
  useEffect(() => {
    if (config.apiKey.trim().length === 0) return;
    saveAiConfig(config);
  }, [config]);

  const update = (patch: Partial<AiConfig>): void => {
    setConfig((current) => {
      const next = { ...current, ...patch };
      // 제공자를 바꾸면 그 제공자의 기본 모델로 맞춘다.
      if (patch.provider && !AI_MODELS[patch.provider].includes(next.model)) {
        next.model = AI_MODELS[patch.provider][0] as string;
      }
      return next;
    });
    setStatus({ kind: 'idle' });
  };

  const run = async (): Promise<void> => {
    setStatus({ kind: 'running' });
    try {
      const result = await generateDraftsWithAi(config, { topic, durationSec, angle, ctaGoal: 'save' });
      const label = describeAiResult(result);
      onDrafts(result.drafts, label);
      setStatus({ kind: 'ok', message: `${label} · 장면 ${result.drafts.length}개` });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: error instanceof Error ? error.message : '대본을 생성하지 못했습니다.',
      });
    }
  };

  const removeKey = (): void => {
    clearAiConfig();
    setConfig({ ...config, apiKey: '' });
    setStatus({ kind: 'idle' });
    onReset();
  };

  const ready = config.apiKey.trim().length > 0 && topic.trim().length >= 2;
  const hasKey = config.apiKey.trim().length > 0;

  return (
    <Card
      eyebrow="선택"
      title="AI 모델 직접 연결"
      hint="키를 넣으면 이 주제를 실제 LLM에 보내 대본을 받고, 넣지 않으면 아래 내장 도메인 엔진이 만듭니다."
      actions={
        hasKey ? (
          <Button small ghost onClick={removeKey} title="저장된 키를 이 브라우저에서 지웁니다">
            키 삭제
          </Button>
        ) : undefined
      }
    >
      <div className="field-row">
        <div className="field w-angle">
          <span>제공자</span>
          <select
            value={config.provider}
            onChange={(event) => update({ provider: event.target.value as AiProvider })}
            aria-label="AI 제공자"
          >
            <option value="openai">{AI_PROVIDER_LABEL.openai}</option>
            <option value="anthropic">{AI_PROVIDER_LABEL.anthropic}</option>
          </select>
        </div>
        <div className="field w-angle">
          <span>모델</span>
          <select
            value={config.model}
            onChange={(event) => update({ model: event.target.value })}
            aria-label="AI 모델"
          >
            {AI_MODELS[config.provider].map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </div>
        <div className="field topic">
          <span>API 키</span>
          <input
            type="password"
            value={config.apiKey}
            placeholder={config.provider === 'openai' ? 'sk-...' : 'sk-ant-...'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => update({ apiKey: event.target.value })}
            aria-label="API 키"
          />
        </div>
        <div className="field w-toggle">
          <span>&nbsp;</span>
          <Button small primary onClick={() => void run()} disabled={!ready || status.kind === 'running'}>
            {status.kind === 'running' ? '생성 중…' : 'AI로 대본 생성'}
          </Button>
        </div>
      </div>

      <p className="note">
        키는 이 브라우저(localStorage)에만 저장되고 어디로도 전송되지 않습니다. 호출은 브라우저에서{' '}
        {AI_PROVIDER_LABEL[config.provider]} API로 바로 나가고, 대본은 입력한 주제·길이만 보냅니다. 정적 웹
        데모에서는 키가 없을 때 내장 도메인 엔진이 동작하며, 키를 넣으면 실제 LLM이 맞춤 대본을 만듭니다.
      </p>

      <div className="row between" style={{ marginTop: 8 }}>
        <span className="small muted">
          지금 대본: <strong>{source ?? '내장 도메인 엔진 (지식 팩 22개)'}</strong>
        </span>
        {status.kind === 'error' ? (
          <span className="pill bad">{status.message}</span>
        ) : status.kind === 'ok' ? (
          <span className="pill ok">{status.message}</span>
        ) : status.kind === 'running' ? (
          <span className="pill ghost">응답 기다리는 중</span>
        ) : (
          <span className="pill ghost">{hasKey ? '키 저장됨 · 대본 생성 준비' : '키 없음 · 내장 엔진 사용'}</span>
        )}
      </div>
    </Card>
  );
}
