import { useMemo, useState } from 'react';
import type { SceneDraft } from '../../src/services/scriptEngine';
import type { Language } from '../../src/types/script';
import {
  OSMU_LIMITS,
  convertToOsmu,
  type OsmuFormat,
  type OsmuFormatId,
  type OsmuSummaryTarget,
} from '../../src/services/osmuConverter';
import { Button, Card, Kpi, num } from '../ui';

/**
 * OSMU conversion console.
 *
 * The studio's four-beat script is the single source. This screen does not write
 * a new script, it rewrites the *same* lines for three publishing surfaces and
 * shows, next to each draft, the platform limit and the writing checks that the
 * pattern library already states (Reels 5–8 tags, Shorts 3 tags or fewer, Threads
 * 500 characters per post).
 *
 * Editing a line in the studio and coming back here changes these drafts — that
 * is the whole point of putting it on the same drafts rather than on the topic.
 */

export interface OsmuPanelProps {
  topic: string;
  drafts: SceneDraft[];
  durationSec: number;
  language?: Language;
  onBackToStudio: () => void;
}

function copyText(text: string): void {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } })
    .navigator?.clipboard;
  if (clipboard?.writeText) {
    void clipboard.writeText(text).catch(() => undefined);
    return;
  }
  if (typeof document === 'undefined') return;
  const area = document.createElement('textarea');
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } finally {
    area.remove();
  }
}

function timecode(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const CHECK_KO: Record<string, string> = { CTA: '마지막 유도' };

function FormatChecks({ format }: { format: OsmuFormat }) {
  return (
    <div className="check">
      {format.checks.map((check) => (
        <span key={check.id} className={check.ok ? 'ok' : 'bad'} title={check.label}>
          <span className="mark" aria-hidden="true">
            {check.ok ? '✓' : '!'}
          </span>
          {CHECK_KO[check.label.split(' ')[0] ?? ''] ?? check.label.split(' ')[0]} {check.detail}
        </span>
      ))}
    </div>
  );
}

export function OsmuPanel({ topic, drafts, durationSec, language = 'ko', onBackToStudio }: OsmuPanelProps) {
  const [active, setActive] = useState<OsmuFormatId>('reels');
  const [platform, setPlatform] = useState<OsmuSummaryTarget>('naver-blog');
  const [copied, setCopied] = useState<string | null>(null);

  const conversion = useMemo(
    () => convertToOsmu({ topic, scenes: drafts, durationSec, language, platform }),
    [topic, drafts, durationSec, language, platform],
  );

  const activeFormat = conversion.formats.find((format) => format.id === active) ?? conversion.formats[0]!;
  const failedChecks = conversion.formats.reduce(
    (sum, format) => sum + format.checks.filter((check) => !check.ok).length,
    0,
  );

  const markCopied = (label: string): void => {
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };

  const copyOne = (format: OsmuFormat): void => {
    copyText(format.id === 'summary' && platform === 'threads' ? (format.threads ?? []).join('\n\n') : format.text);
    markCopied(format.id);
  };

  const copyAll = (): void => {
    const blocks = conversion.formats.map((format) => `■ ${format.label}\n${format.text}`);
    copyText(blocks.join('\n\n———\n\n'));
    markCopied('all');
  };

  return (
    <div className="stack">
      <div className="grid kpi">
        <Kpi label="대본 비트" value={`${conversion.beats.length}개`} sub={`${conversion.beats.filter((beat) => beat.beat === 'solution').length}단계 해결`} />
        <Kpi
          label="훅 길이"
          value={`${conversion.beats[0]?.endSec?.toFixed(1) ?? '0.0'}s`}
          sub="3.5초 상한 기준"
          tone={(conversion.beats[0]?.endSec ?? 0) > 3.5 ? 'bad' : 'ok'}
        />
        <Kpi label="포맷" value="3종" sub="릴스 · 쇼츠 · 블로그/스레드" />
        <Kpi
          label="확인 필요"
          value={failedChecks === 0 ? '0건' : `${failedChecks}건`}
          sub="플랫폼 상한·작성 규칙"
          tone={failedChecks === 0 ? 'ok' : 'warn'}
        />
      </div>

      <Card
        title="대본 하나로 세 곳에 올릴 글"
        hint="스튜디오의 4비트 대본을 그대로 읽어 캡션·설명·요약 포스트를 만듭니다. 대본을 고치면 여기도 같이 바뀝니다."
        actions={
          <>
            <Button small onClick={onBackToStudio}>
              스튜디오로
            </Button>
            <Button small primary onClick={copyAll}>
              {copied === 'all' ? '복사됨' : '3종 모두 복사'}
            </Button>
          </>
        }
      >
        <div className="stack" style={{ gap: 0 }}>
          {conversion.beats.map((beat) => (
            <div key={`${beat.index}-${beat.beat}`} className="beat-line">
              <span className="time mono">{timecode(beat.startSec)}</span>
              <span className="beat-tag">{beat.label}</span>
              <span className="narration">{beat.narration}</span>
            </div>
          ))}
        </div>
        {conversion.warnings.length > 0 ? (
          <ul className="small" style={{ margin: '12px 0 0 16px', padding: 0, color: 'var(--warn)' }}>
            {conversion.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </Card>

      <Card
        title="변환 결과"
        hint={`스튜디오 대본에서 바로 계산했습니다 · 요약 포스트 대상 ${platform === 'threads' ? '스레드' : platform === 'tistory' ? '티스토리' : '네이버 블로그'}`}
        actions={
          <Button small primary onClick={() => copyOne(activeFormat)}>
            {copied === activeFormat.id ? '복사됨' : '이 포맷 복사'}
          </Button>
        }
      >
        <div className="tab-row" role="tablist" aria-label="변환 포맷">
          {conversion.formats.map((format) => (
            <button
              key={format.id}
              type="button"
              role="tab"
              aria-selected={active === format.id}
              className="tab"
              data-testid={`osmu-tab-${format.id}`}
              onClick={() => setActive(format.id)}
            >
              {format.label}
              <span className="small muted mono" style={{ marginLeft: 6 }}>
                {num(format.chars)}자
              </span>
            </button>
          ))}
        </div>

        {active === 'summary' ? (
          <div className="row" style={{ gap: 6, marginBottom: 10 }}>
            <span className="small muted">올릴 곳</span>
            {(['naver-blog', 'threads'] as const).map((target) => (
              <Button
                key={target}
                small
                ghost={platform !== target}
                onClick={() => setPlatform(target)}
                title={target === 'threads' ? `글당 ${OSMU_LIMITS.threadsPost}자씩 이어 올립니다` : '검색 유입용 요약'}
              >
                {target === 'threads' ? '스레드' : '네이버 블로그'}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="stack" style={{ gap: 14 }}>
          <pre
            data-testid="osmu-text"
            style={{
              margin: 0,
              padding: 18,
              borderRadius: 12,
              background: 'var(--surface-2)',
              border: '1px solid var(--line)',
              fontFamily: 'var(--font)',
              fontSize: 14.5,
              lineHeight: 1.75,
              color: 'var(--ink-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              minHeight: 180,
            }}
          >
            {activeFormat.text}
          </pre>

          <div className="row between" style={{ gap: 12 }}>
            <FormatChecks format={activeFormat} />
            <span className="small muted mono">
              {num(activeFormat.chars)} / {activeFormat.limitLabel}
            </span>
          </div>

          {active === 'summary' && activeFormat.threads && activeFormat.threads.length > 0 ? (
            <div>
              <div className="row between">
                <h3 style={{ margin: 0 }}>스레드 분할 ({activeFormat.threads.length}개)</h3>
                <span className="small muted">글당 {OSMU_LIMITS.threadsPost}자 이내</span>
              </div>
              <div className="stack" style={{ gap: 10, marginTop: 10 }}>
                {activeFormat.threads.map((chunk, index) => (
                  <div key={index} className="scene-card">
                    <div className="row between" style={{ marginBottom: 6 }}>
                      <span className="small muted mono">
                        {index + 1}/{activeFormat.threads!.length} · {chunk.length}자
                      </span>
                      <Button
                        small
                        ghost
                        onClick={() => {
                          copyText(chunk);
                          markCopied(`thread-${index}`);
                        }}
                      >
                        {copied === `thread-${index}` ? '복사됨' : '복사'}
                      </Button>
                    </div>
                    <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.75, whiteSpace: 'pre-wrap' }}>{chunk}</p>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <p className="note">{activeFormat.note}</p>
        </div>
      </Card>

      <Card title="왜 이 문장인가" hint="포맷마다 다른 것만 바꾸고, 대본의 사실은 그대로 둡니다">
        <ul className="small muted" style={{ margin: 0, paddingLeft: 16, lineHeight: 1.7 }}>
          <li>
            릴스 캡션은 첫 두 줄에 결론과 문제를 두고, 마지막에 저장을 한 번만 요청합니다. 해시태그는{' '}
            {OSMU_LIMITS.reelsHashtagMin}~{OSMU_LIMITS.reelsHashtagMax}개로 제한했습니다.
          </li>
          <li>
            쇼츠 설명은 검색 유입을 위해 제목·첫 문장·타임라인의 키워드를 같은 말로 맞추고, 해시태그는{' '}
            {OSMU_LIMITS.shortsHashtagMax}개를 넘기지 않습니다.
          </li>
          <li>
            블로그 요약은 본문 대신 “무엇을 몇 단계로 정리했는지”만 남깁니다. 스레드는 같은 글을{' '}
            {OSMU_LIMITS.threadsPost}자 단위로 끊어 이어 올립니다.
          </li>
        </ul>
      </Card>
    </div>
  );
}
