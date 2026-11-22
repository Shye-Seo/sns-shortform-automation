import { useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { ImportAttempt, ProxyMode } from '../../model/creator/importSource';
import { PROXY_PRESETS } from '../../model/creator/importSource';
import { Button } from '../../ui';

/**
 * 1단계: 소스 가져오기.
 *
 * 네 갈래(링크 / 사진·영상 / 붙여넣기 / 주제)를 한 카드 안의 탭으로 둔다.
 * "링크가 막히면 붙여넣기"가 바로 옆에 있어야 사용자가 빈 화면에서 멈추지 않는다.
 */

export type SourceTab = 'url' | 'files' | 'paste' | 'topic';

export interface SourceCardProps {
  tab: SourceTab;
  onTab: (tab: SourceTab) => void;
  url: string;
  onUrl: (value: string) => void;
  proxy: ProxyMode;
  onProxy: (value: ProxyMode) => void;
  proxyPrefix: string;
  onProxyPrefix: (value: string) => void;
  onFetchUrl: () => void;
  onFiles: (files: File[]) => void;
  pasteTitle: string;
  onPasteTitle: (value: string) => void;
  pasteBody: string;
  onPasteBody: (value: string) => void;
  onPasteBuild: () => void;
  topic: string;
  onTopic: (value: string) => void;
  onTopicBuild: () => void;
  busy: string | null;
  message: { tone: 'ok' | 'warn' | 'bad'; text: string } | null;
  attempts: ImportAttempt[];
}

const TABS: Array<{ id: SourceTab; label: string }> = [
  { id: 'files', label: '사진 · 영상' },
  { id: 'url', label: '링크' },
  { id: 'paste', label: '본문 붙여넣기' },
  { id: 'topic', label: '주제만' },
];

export function SourceCard(props: SourceCardProps) {
  const {
    tab,
    onTab,
    url,
    onUrl,
    proxy,
    onProxy,
    proxyPrefix,
    onProxyPrefix,
    onFetchUrl,
    onFiles,
    pasteTitle,
    onPasteTitle,
    pasteBody,
    onPasteBody,
    onPasteBuild,
    topic,
    onTopic,
    onTopicBuild,
    busy,
    message,
    attempts,
  } = props;
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const takeFiles = (files: FileList | null): void => {
    if (!files || files.length === 0) return;
    onFiles(Array.from(files));
  };

  return (
    <div>
      <div className="segmented" role="tablist" aria-label="소스 종류">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={tab === item.id ? 'seg active' : 'seg'}
            onClick={() => onTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'files' ? (
        <div
          className={dragging ? 'dropzone dragging' : 'dropzone'}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            takeFiles(event.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
          }}
          data-testid="creator-dropzone"
        >
          <strong>사진이나 짧은 영상을 끌어다 놓으세요</strong>
          <span className="small muted">
            JPG · PNG · WebP / MP4 · WebM · MOV · 여러 개 한 번에 · 파일은 브라우저 밖으로 나가지 않습니다
          </span>
          <input
            ref={inputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            data-testid="creator-file-input"
            onChange={(event) => {
              takeFiles(event.target.files);
              event.target.value = '';
            }}
          />
        </div>
      ) : null}

      {tab === 'url' ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="field">
            <span>블로그 · 유튜브 링크</span>
            <input
              type="text"
              value={url}
              placeholder="https://blog.naver.com/... 또는 https://www.youtube.com/watch?v=..."
              onChange={(event) => onUrl(event.target.value)}
              data-testid="creator-url"
            />
          </div>
          <div className="field-row">
            <div className="field w-angle">
              <span>프록시</span>
              <select value={proxy} onChange={(event) => onProxy(event.target.value as ProxyMode)}>
                {PROXY_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>
            {proxy === 'custom' ? (
              <div className="field topic">
                <span>프록시 주소 (뒤에 원본 URL을 붙입니다)</span>
                <input
                  type="text"
                  value={proxyPrefix}
                  placeholder="https://my-worker.example.workers.dev/?url="
                  onChange={(event) => onProxyPrefix(event.target.value)}
                />
              </div>
            ) : null}
          </div>
          <div className="row between">
            <span className="small muted">
              {PROXY_PRESETS.find((preset) => preset.id === proxy)?.description}
            </span>
            <Button small primary onClick={onFetchUrl} disabled={busy !== null}>
              {busy === 'url' ? '가져오는 중…' : '가져오기'}
            </Button>
          </div>
          {attempts.length > 0 ? (
            <ul className="attempt-list">
              {attempts.map((attempt, index) => (
                <li key={`${attempt.route}-${index}`} className={attempt.ok ? 'ok' : 'bad'}>
                  <span className="mono">{attempt.route}</span> {attempt.detail}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="note" style={{ margin: 0 }}>
            블로그가 직접 요청을 막으면(CORS) 프록시를 켜거나 아래 &lsquo;본문 붙여넣기&rsquo;로 넘어가면 됩니다. 유튜브는 제목·썸네일만
            공개 API로 가져옵니다.
          </p>
        </div>
      ) : null}

      {tab === 'paste' ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="field">
            <span>제목</span>
            <input type="text" value={pasteTitle} onChange={(event) => onPasteTitle(event.target.value)} data-testid="creator-paste-title" />
          </div>
          <div className="field">
            <span>본문</span>
            <textarea
              rows={6}
              value={pasteBody}
              placeholder="블로그 글·영상 설명을 그대로 붙여넣으세요. 문장마다 컷이 하나씩 생깁니다."
              onChange={(event) => onPasteBody(event.target.value)}
              data-testid="creator-paste-body"
            />
          </div>
          <div className="row between">
            <span className="small muted">문장 {pasteBody.split(/[.!?…\n]+/).filter((line) => line.trim().length >= 12).length}개 감지</span>
            <Button small primary onClick={onPasteBuild} disabled={busy !== null || pasteBody.trim() === ''}>
              컷으로 만들기
            </Button>
          </div>
        </div>
      ) : null}

      {tab === 'topic' ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="field">
            <span>주제</span>
            <input type="text" value={topic} onChange={(event) => onTopic(event.target.value)} data-testid="creator-topic" />
          </div>
          <div className="row between">
            <span className="small muted">내장 대본 엔진이 4비트 문장을 만들고, 사진은 나중에 끼워 넣습니다.</span>
            <Button small onClick={onTopicBuild} disabled={busy !== null}>
              주제로 컷 만들기
            </Button>
          </div>
        </div>
      ) : null}

      {message ? (
        <p className={`notice ${message.tone}`} role="status" data-testid="creator-notice">
          {message.text}
        </p>
      ) : null}

      <div className="source-foot">
        <span className="small muted">
          컷 {busy === 'files' ? '불러오는 중…' : '추가·교체는 위에서'} · 업로드한 파일은 서버로 전송되지 않습니다
        </span>
        <span className="pill ghost" style={{ justifySelf: 'end' } as CSSProperties}>
          브라우저 100% 처리
        </span>
      </div>
    </div>
  );
}
