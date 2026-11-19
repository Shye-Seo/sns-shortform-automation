import { useMemo, useState } from 'react';
import { ANGLE_LIST, CHANNEL_LABEL, PATTERN_LIBRARY } from '../../src/services/patternLibrary';
import { buildPlannerPrompt, planCrossChannel } from '../../src/services/crossChannelPlanner';
import { planToMarkdown } from '../../src/services/planMarkdown';
import type { AngleChoice, BlogPlatform, ChannelId, ReferenceAnalysis } from '../../src/types/plan';
import { Button, Card, Kpi, Pill } from '../ui';

/**
 * Cross-channel planning console.
 *
 * One topic in, three artifacts out. The numbers on this screen come from the
 * same pattern engine the CLI and the renderer use; nothing is typed by hand.
 * A pasted reference changes the angle and the outline order, and the
 * repurposing map shows exactly which Reel scene became which chapter and
 * which blog section.
 */

const REF_CHANNELS: ChannelId[] = ['instagram-reels', 'youtube-shorts', 'youtube-longform', 'naver-blog', 'tistory', 'wordpress'];

const BEAT_KO: Record<string, string> = { hook: '훅', problem: '문제', solution: '해결', cta: 'CTA' };

function copyText(text: string): void {
  const clipboard = (globalThis as { navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } } }).navigator?.clipboard;
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

export interface CrossChannelPanelProps {
  topic: string;
  onTopic: (value: string) => void;
  onBackToStudio: () => void;
}

export function CrossChannelPanel({ topic, onTopic, onBackToStudio }: CrossChannelPanelProps) {
  const [durationSec, setDurationSec] = useState(45);
  const [angle, setAngle] = useState<AngleChoice>('auto');
  const [variation, setVariation] = useState(0);
  const [platform, setPlatform] = useState<BlogPlatform>('naver-blog');
  const [refDraft, setRefDraft] = useState('');
  const [refChannel, setRefChannel] = useState<ChannelId>('instagram-reels');
  const [reference, setReference] = useState<{ text: string; channel: ChannelId } | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const plan = useMemo(
    () =>
      planCrossChannel({
        topic,
        durationSec,
        angle,
        variation,
        blogPlatform: platform,
        reference,
      }),
    [topic, durationSec, angle, variation, platform, reference],
  );

  const analysis: ReferenceAnalysis | null = plan.reference;
  const markCopied = (label: string): void => {
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };

  const copy = (text: string, label: string): void => {
    copyText(text);
    markCopied(label);
  };

  return (
    <div className="stack">
      <Card
        eyebrow="한 주제 · 세 채널"
        title="크로스채널 기획 엔진"
        hint="주제를 넣으면 릴스/쇼츠 대본, 유튜브 롱폼 목차, 블로그 뼈대를 같은 단계 순서로 엮어 냅니다."
        actions={
          <>
            <Button small ghost onClick={onBackToStudio}>
              스튜디오로
            </Button>
            <Button small primary onClick={() => setVariation((value) => value + 1)} title="앵글과 문장을 새로 뽑습니다">
              다른 앵글로 다시
            </Button>
          </>
        }
      >
        <div className="row" style={{ marginBottom: 12, alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: '2 1 260px' }}>
            <span>주제</span>
            <input type="text" value={topic} onChange={(event) => onTopic(event.target.value)} />
          </div>
          <div className="field" style={{ flex: '0 0 92px' }}>
            <span>숏폼 길이</span>
            <select value={durationSec} onChange={(event) => setDurationSec(Number(event.target.value))}>
              {[30, 45, 60].map((value) => (
                <option key={value} value={value}>
                  {value}초
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 128px' }}>
            <span>앵글</span>
            <select value={angle} onChange={(event) => setAngle(event.target.value as AngleChoice)}>
              <option value="auto">자동 (순환)</option>
              {ANGLE_LIST.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field" style={{ flex: '0 0 120px' }}>
            <span>블로그</span>
            <select value={platform} onChange={(event) => setPlatform(event.target.value as BlogPlatform)}>
              <option value="naver-blog">네이버</option>
              <option value="tistory">티스토리</option>
              <option value="wordpress">워드프레스</option>
            </select>
          </div>
          <Button small onClick={() => copy(planToMarkdown(plan), '전체 기획안')} title="Markdown으로 복사">
            {copied === '전체 기획안' ? '복사됨' : '기획안 복사'}
          </Button>
        </div>

        <div className="grid kpi">
          <Kpi label="분류" value={plan.profile.categoryLabel} sub={`${plan.profile.intent} · ${plan.profile.audience}`} />
          <Kpi label="앵글" value={plan.angle.label} sub={plan.angle.hookStyle} />
          <Kpi label="변주" value={`${plan.variation + 1}회`} sub="누를 때마다 앵글·문장 교체" />
          <Kpi
            label="레퍼런스"
            value={analysis ? `${Math.round(analysis.confidence * 100)}%` : '없음'}
            sub={analysis ? `${CHANNEL_LABEL[analysis.channel]} · 단계 ${analysis.numberedSteps}개` : '붙이면 구조를 읽어 반영'}
          />
        </div>

        <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
          엔진: {plan.engineDetail}. 배지 문구는 주제에서 뽑았습니다 — <strong>{plan.shorts.scenes[0]?.onScreenText ?? plan.profile.core}</strong>.
          {analysis ? ' 레퍼런스의 훅 유형·단계 수·저장 유도 횟수를 앵글과 목차에 반영했습니다.' : ''}
        </p>
      </Card>

      <div className="grid sidebar">
        <div className="stack">
          <Card
            title="레퍼런스 패턴 분석"
            hint="릴스·쇼츠 대본, 롱폼 목차, 블로그 글을 붙여넣으면 훅 유형·전개·저장 유도를 읽습니다"
          >
            <div className="row" style={{ marginBottom: 8, alignItems: 'flex-end' }}>
              <div className="field" style={{ flex: '0 0 180px' }}>
                <span>채널</span>
                <select value={refChannel} onChange={(event) => setRefChannel(event.target.value as ChannelId)}>
                  {REF_CHANNELS.map((channel) => (
                    <option key={channel} value={channel}>
                      {CHANNEL_LABEL[channel]}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                small
                primary
                onClick={() => setReference(refDraft.trim() ? { text: refDraft, channel: refChannel } : null)}
                disabled={refDraft.trim().length < 20}
              >
                분석하고 반영
              </Button>
              {reference ? (
                <Button small ghost onClick={() => setReference(null)}>
                  빼기
                </Button>
              ) : null}
            </div>
            <textarea
              rows={6}
              value={refDraft}
              placeholder={'예) 첫 줄 질문 훅\n1. 이동 시간부터 정하기\n2. 숙소는 다음 날 기준\n3. 마지막 날은 비우기\n저장해두고 그대로 따라 해보세요'}
              onChange={(event) => setRefDraft(event.target.value)}
            />

            {analysis ? (
              <div style={{ marginTop: 12 }}>
                <div className="row" style={{ marginBottom: 8 }}>
                  <Pill tone="ok">{`훅 ${analysis.hookStyle}`}</Pill>
                  <Pill tone="ghost">{`번호 단계 ${analysis.numberedSteps}개`}</Pill>
                  <Pill tone={analysis.saveTriggers.length > 0 ? 'warn' : 'ghost'}>
                    {`저장 유도 ${analysis.saveTriggers.length}회`}
                  </Pill>
                  <Pill tone="ghost">{`평균 문장 ${analysis.avgSentenceChars}자`}</Pill>
                </div>
                <p className="small muted" style={{ margin: '0 0 8px' }}>
                  첫 줄 «{analysis.hookQuote}» · 마지막 «{analysis.ctaQuote ?? '-'}»
                </p>
                <div className="scroll" style={{ maxHeight: 160 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>구간</th>
                        <th>내용</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.structure.slice(0, 8).map((entry) => (
                        <tr key={`${entry.step}-${entry.label}`}>
                          <td>{entry.step + 1}</td>
                          <td>{entry.label}</td>
                          <td>{entry.quote}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <ul className="small" style={{ margin: '10px 0 0 16px', padding: 0 }}>
                  {analysis.advice.slice(0, 5).map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
                텍스트만 분석합니다(외부 URL은 CLI에서: <span className="mono">shortform crosschannel --ref-url …</span>).
                브라우저는 다른 사이트를 읽을 수 없어 붙여넣기만 받습니다.
              </p>
            )}
          </Card>

          <Card title="적용한 채널 패턴" hint="채널별 구조는 다릅니다. 같은 대본을 세 채널에 그대로 붙이지 않습니다">
            <div className="stack" style={{ gap: 8 }}>
              {plan.appliedPatterns.map((pattern) => (
                <div key={pattern.channel} className="row between">
                  <div>
                    <strong className="small">{pattern.label}</strong>
                    <div className="small muted">{pattern.appliedIn}</div>
                  </div>
                  <Pill tone="ghost">{pattern.channel}</Pill>
                </div>
              ))}
            </div>
            <p className="note" style={{ marginTop: 10, marginBottom: 0 }}>
              {PATTERN_LIBRARY.length}개 채널 패턴이 내장돼 있고, 레퍼런스를 붙이면 그 글의 순서가 우선합니다.
            </p>
          </Card>
        </div>

        <div className="stack">
          <Card
            title="숏폼 대본 · 자막"
            hint={`${plan.durationSec}초 · ${plan.shorts.hookStyle} · 릴스/쇼츠 공통`}
            actions={
              <Button
                small
                ghost
                onClick={() =>
                  copy(
                    plan.shorts.scenes.map((scene) => `${BEAT_KO[scene.beat] ?? scene.beat}: ${scene.narration}`).join('\n'),
                    '숏폼 대본',
                  )
                }
              >
                {copied === '숏폼 대본' ? '복사됨' : '대본 복사'}
              </Button>
            }
          >
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>비트</th>
                    <th>나레이션</th>
                    <th>화면 자막</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.shorts.scenes.map((scene, index) => (
                    <tr key={`${index}-${scene.beat}`}>
                      <td>{index + 1}</td>
                      <td>{BEAT_KO[scene.beat] ?? scene.beat}</td>
                      <td>{scene.narration}</td>
                      <td>{scene.onScreenText ?? '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 8, marginBottom: 6 }}>
              <strong>캡션</strong>
            </p>
            <pre className="prompt-box">{plan.shorts.caption}</pre>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap', gap: 6 }}>
              {plan.shorts.hashtags.map((tag) => (
                <Pill key={tag} tone="ghost">
                  {tag}
                </Pill>
              ))}
            </div>
          </Card>

          <Card title="유튜브 롱폼 목차" hint={`${plan.longform.title} · 약 ${plan.longform.estimatedMinutes}분`}>
            <p className="small" style={{ marginTop: 0 }}>
              <strong>콜드오픈</strong> {plan.longform.coldOpen}
            </p>
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>시작</th>
                    <th>챕터</th>
                    <th>목적</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.longform.chapters.map((chapter) => (
                    <tr key={chapter.index}>
                      <td>{chapter.index}</td>
                      <td className="num mono">
                        {Math.floor(chapter.startSec / 60)}:{String(chapter.startSec % 60).padStart(2, '0')}
                      </td>
                      <td>{chapter.title}</td>
                      <td>{chapter.purpose}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note" style={{ marginTop: 8, marginBottom: 0 }}>
              썸네일 문구 <strong>{plan.longform.thumbnailText}</strong> · 설명란 3줄에 챕터와 블로그 링크를 넣습니다.
            </p>
          </Card>

          <Card
            title={`블로그 뼈대 · ${CHANNEL_LABEL[plan.blog.platform]}`}
            hint={`약 ${plan.blog.targetChars.toLocaleString('ko-KR')}자 · 핵심 키워드 「${plan.blog.primaryKeyword}」`}
            actions={
              <Button small ghost onClick={() => copy(plan.blog.outline.map((section) => `## ${section.heading}\n${section.points.map((point) => `- ${point}`).join('\n')}`).join('\n\n'), '블로그 목차')}>
                {copied === '블로그 목차' ? '복사됨' : '목차 복사'}
              </Button>
            }
          >
            <div className="row" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
              {plan.blog.titleCandidates.map((title) => (
                <Pill key={title} tone="ghost">
                  {title}
                </Pill>
              ))}
            </div>
            <p className="small muted" style={{ marginTop: 0 }}>
              메타 설명: {plan.blog.metaDescription}
            </p>
            <p className="small">
              <strong>도입</strong> {plan.blog.intro}
            </p>
            <div className="stack" style={{ gap: 8 }}>
              {plan.blog.outline.map((section) => (
                <div key={section.heading} style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 10 }}>
                  <strong className="small">H2 · {section.heading}</strong>
                  <ul className="small" style={{ margin: '6px 0 0 16px', padding: 0 }}>
                    {section.points.map((point) => (
                      <li key={point}>{point}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
            <p className="note" style={{ marginTop: 10, marginBottom: 4 }}>
              <strong>FAQ</strong>
            </p>
            <ul className="small" style={{ margin: '0 0 8px 16px', padding: 0 }}>
              {plan.blog.faq.map((entry) => (
                <li key={entry.question}>
                  {entry.question} — {entry.answer}
                </li>
              ))}
            </ul>
            <p className="small muted" style={{ marginBottom: 6 }}>
              마무리: {plan.blog.closing}
            </p>
            <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
              {plan.blog.hashtags.map((tag) => (
                <Pill key={tag} tone="ghost">
                  {tag}
                </Pill>
              ))}
            </div>
          </Card>

          <Card title="리퍼포징 맵" hint="숏폼 장면이 어느 챕터와 어느 H2로 확장되는지">
            <div className="scroll">
              <table className="data">
                <thead>
                  <tr>
                    <th>숏폼</th>
                    <th>롱폼 챕터</th>
                    <th>블로그 H2</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.repurpose.map((row) => (
                    <tr key={`${row.shortsIndex}-${row.blogHeading}`}>
                      <td>
                        {row.shortsIndex + 1}. {BEAT_KO[row.shortsBeat] ?? row.shortsBeat}
                        <div className="small muted">{row.shortsLine}</div>
                      </td>
                      <td>{row.longformChapter}</td>
                      <td>{row.blogHeading}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="LLM 연결" hint="키가 있으면 같은 스키마로 Claude가 다시 씁니다. 없으면 위 결과가 최종입니다">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="small muted">이 데모는 브라우저에 키가 없어 내장 패턴 엔진으로 실행됩니다.</span>
              <Button small ghost onClick={() => setShowPrompt((value) => !value)}>
                {showPrompt ? '프롬프트 닫기' : 'LLM 프롬프트 보기'}
              </Button>
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              터미널에서 <span className="mono">ANTHROPIC_API_KEY=… npm run cli -- crosschannel --topic "{plan.topic}" --llm --out plan.md</span>
            </p>
            {showPrompt ? <pre className="prompt-box">{buildPlannerPrompt(plan)}</pre> : null}
            <ul className="small" style={{ margin: '10px 0 0 16px', padding: 0 }}>
              {plan.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
