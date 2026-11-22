import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, Kpi, Pill } from '../ui';
import { buildCreatorTimeline, cutProgress, moveCut, segmentAt, transitionProgress } from '../model/creator/timeline';
import { CARD, FRAME, drawFrame, type Paint2D } from '../model/creator/render';
import { buildCardNewsZip, cardFileName, cardNewsZipFileName, drawCard } from '../model/creator/cardNews';
import {
  DISCLOSURES,
  disclosureOf,
  makeCut,
  newCutId,
  sampleCuts,
  type CreatorCut,
  type Disclosure,
} from '../model/creator/types';
import { buildPostCaption, suggestHashtags } from '../model/creator/caption';
import { BGM_LOOPS, bgmLabel, type BgmId } from '../model/creator/bgm';
import { startBgm, type BgmSession } from '../model/creator/bgmPlayer';
import { renderVideo, videoFileName } from '../model/creator/videoExport';
import {
  canUseCanvas,
  canvasToPngBytes,
  downloadBlob,
  fileKind,
  formatBytes,
  blobFromBytes,
  loadImageFile,
  loadRemoteImage,
  loadVideoFile,
  makeCanvas,
  videoFrameTime,
  type LoadedImage,
} from '../model/creator/media';
import { MediaStore, capturePoster } from '../model/creator/mediaStore';
import {
  buildImportedCuts,
  importFromUrl,
  type ImportAttempt,
  type ImportedCutSpec,
  type ProxyMode,
} from '../model/creator/importSource';
import { draftBeatScene } from '../model/studio';
import { PreviewCard } from './creator/PreviewCard';
import { SourceCard, type SourceTab } from './creator/SourceCard';
import { CutList } from './creator/CutList';
import { ExportCard, type CardState, type RenderState } from './creator/ExportCard';

/**
 * 실사용 스튜디오 — 실제 사진·영상으로 편집하고 브라우저에서 바로 렌더한다.
 *
 * 기존 '9:16 스튜디오'가 글에서 대본·자막 계산을 보여 주는 읽기 모델이라면,
 * 이 패널은 사용자가 넣은 파일이 곧 화면이 된다. 편집 상태는 모두 여기 있고,
 * 그리기·타임라인·카드뉴스 계산은 `web/model/creator/*`의 순수 함수가 맡는다.
 */

type Notice = { tone: 'ok' | 'warn' | 'bad'; text: string };

const DEFAULT_TOPIC = '부산 신혼집 3평 주방 수납 정리법';

interface ImportedMedia {
  spec: ImportedCutSpec;
  loaded: LoadedImage | null;
  blocked: boolean;
}

export function CreatorStudioPanel() {
  const [cuts, setCuts] = useState<CreatorCut[]>(() => sampleCuts());
  const [topic, setTopic] = useState(DEFAULT_TOPIC);
  const [handle, setHandle] = useState('@shye');
  const [badge, setBadge] = useState('주방 수납');
  const [disclosure, setDisclosure] = useState<Disclosure>('none');
  const [bgm, setBgm] = useState<BgmId>('calm');
  const [bgmFile, setBgmFile] = useState<File | null>(null);
  const [volume, setVolume] = useState(0.5);
  const [guides, setGuides] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sourceTab, setSourceTab] = useState<SourceTab>('files');
  const [url, setUrl] = useState('');
  const [proxy, setProxy] = useState<ProxyMode>('none');
  const [proxyPrefix, setProxyPrefix] = useState('');
  const [attempts, setAttempts] = useState<ImportAttempt[]>([]);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteBody, setPasteBody] = useState('');
  const [mediaVersion, setMediaVersion] = useState(0);

  const [renderState, setRenderState] = useState<RenderState>('idle');
  const [renderProgress, setRenderProgress] = useState(0);
  const [renderError, setRenderError] = useState('');
  const [renderRatio, setRenderRatio] = useState(0);
  const [video, setVideo] = useState<{ url: string; name: string; bytes: number; mime: string; label: string } | null>(null);

  const [cardState, setCardState] = useState<CardState>('idle');
  const [cards, setCards] = useState<Array<{ name: string; url: string; bytes: number }>>([]);
  const [copied, setCopied] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const storeRef = useRef<MediaStore | null>(null);
  const snapRef = useRef<HTMLCanvasElement | null>(null);
  const tRef = useRef(0);
  const playingRef = useRef(false);
  const renderingRef = useRef(false);
  const guidesRef = useRef(guides);
  const bgmRef = useRef<BgmSession | null>(null);
  const drawRef = useRef<(sec: number, withGuides: boolean) => void>(() => undefined);
  const canvasReady = useMemo(() => canUseCanvas(), []);
  const cutsRef = useRef(cuts);

  if (storeRef.current === null) storeRef.current = new MediaStore();
  cutsRef.current = cuts;
  guidesRef.current = guides;

  const timeline = useMemo(() => buildCreatorTimeline(cuts, { fps: 30 }), [cuts]);
  const totalSec = timeline.totalSec;
  const activeSegment = segmentAt(timeline, t);
  const activeIndex = activeSegment?.index ?? 0;

  const disclosureInfo = disclosureOf(disclosure);
  const captionText = useMemo(
    () =>
      buildPostCaption({
        cuts,
        disclosure: disclosureInfo,
        handle,
        hashtags: suggestHashtags(topic || '숏폼'),
      }),
    [cuts, disclosureInfo, handle, topic],
  );

  const codecText = useMemo(() => {
    if (typeof MediaRecorder === 'undefined') return '이 브라우저는 영상 녹화를 지원하지 않습니다.';
    const mp4 = MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E');
    const webm = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus');
    if (mp4) {
      return bgm === 'none'
        ? 'MP4(H.264)로 저장합니다 — 인스타·쇼츠에 바로 올릴 수 있습니다.'
        : 'MP4(H.264)로 저장합니다. BGM은 Opus 오디오로 함께 담기며, 업로드·브라우저 재생은 정상이고 일부 데스크톱 플레이어만 소리를 못 낼 수 있습니다.';
    }
    if (webm) return 'WebM(VP9+Opus)로 저장합니다 — 브라우저 재생은 어디서나 되고, 유튜브는 그대로 받습니다.';
    return '브라우저 기본 형식으로 저장합니다.';
  }, [bgm]);

  const specFor = useCallback(
    (segment: NonNullable<ReturnType<typeof segmentAt>>, sec: number, previous: CanvasImageSource | null, transition: number, withGuides: boolean) => ({
      cut: segment.cut,
      index: segment.index,
      total: timeline.segments.length,
      progress: cutProgress(segment, sec),
      previous,
      transition,
      media: (storeRef.current?.get(segment.cut.id) ?? null) as CanvasImageSource | null,
      handle,
      badge,
      disclosure: disclosureInfo,
      isLast: segment.index === timeline.segments.length - 1,
      showGuides: withGuides,
      showProgress: withGuides,
    }),
    [timeline.segments.length, handle, badge, disclosureInfo],
  );

  /** 영상 컷의 재생 위치를 현재 재생 헤드에 맞춘다. */
  const syncVideos = useCallback(
    (sec: number, active: boolean) => {
      const store = storeRef.current;
      if (!store) return;
      const segment = segmentAt(timeline, sec);
      if (!segment) return;
      for (const item of timeline.segments) {
        const element = store.getVideo(item.cut.id);
        if (!element) continue;
        if (item.index === segment.index) {
          const duration = item.cut.videoDurationSec ?? element.duration ?? 0;
          const target = videoFrameTime(item.cut.trimStartSec ?? 0, Math.max(0, sec - item.startSec), duration);
          if (active) {
            if (element.paused) {
              element.currentTime = target;
              void element.play().catch(() => undefined);
            }
          } else {
            if (!element.paused) element.pause();
            if (Number.isFinite(target) && Math.abs(element.currentTime - target) > 0.1) {
              element.currentTime = target;
            }
          }
        } else if (!element.paused) {
          element.pause();
        }
      }
    },
    [timeline],
  );

  const drawAt = useCallback(
    (sec: number, withGuides: boolean) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const segment = segmentAt(timeline, sec);
      if (!segment) {
        const paint = ctx as unknown as Paint2D;
        paint.fillStyle = '#0b1220';
        paint.fillRect(0, 0, FRAME.width, FRAME.height);
        paint.fillStyle = 'rgba(255,255,255,0.5)';
        paint.font = '600 42px "Pretendard", "Apple SD Gothic Neo", system-ui, sans-serif';
        paint.textAlign = 'center';
        paint.textBaseline = 'middle';
        paint.fillText('사진이나 영상을 올려 주세요', FRAME.width / 2, FRAME.height / 2);
        return;
      }

      const transition = transitionProgress(segment, sec, timeline.transitionSec);
      let previous: CanvasImageSource | null = null;
      if (transition < 1 && segment.index > 0) {
        const before = timeline.segments[segment.index - 1];
        if (before) {
          const snap = snapRef.current ?? makeCanvas(FRAME.width, FRAME.height);
          snapRef.current = snap;
          const snapCtx = snap.getContext('2d');
          if (snapCtx) {
            drawFrame(
              snapCtx as unknown as Paint2D,
              specFor(before, Math.max(before.startSec, before.endSec - 0.001), null, 1, false),
            );
            previous = snap;
          }
        }
      }

      drawFrame(ctx as unknown as Paint2D, specFor(segment, sec, previous, transition, withGuides));
      syncVideos(sec, playingRef.current || renderingRef.current);
    },
    [timeline, specFor, syncVideos],
  );

  drawRef.current = drawAt;

  // 편집·가이드 변경 시 현재 프레임을 다시 그린다(재생 중에는 루프가 그린다).
  useEffect(() => {
    if (!canvasReady) return;
    if (!playingRef.current) drawAt(tRef.current, guides);
  }, [drawAt, guides, mediaVersion, canvasReady]);

  // 재생 루프. UI 상태(t)는 초당 약 10번만 갱신하고 캔버스는 매 프레임 그린다.
  useEffect(() => {
    playingRef.current = playing;
    if (!playing) {
      syncVideos(tRef.current, false);
      return undefined;
    }
    let raf = 0;
    let last = performance.now();
    let lastUi = 0;
    const step = (now: number): void => {
      const dt = (now - last) / 1000;
      last = now;
      let next = tRef.current + dt;
      if (next >= timeline.totalSec) {
        next = timeline.totalSec;
        tRef.current = next;
        drawRef.current(next, guidesRef.current);
        setT(next);
        setPlaying(false);
        return;
      }
      tRef.current = next;
      drawRef.current(next, guidesRef.current);
      if (now - lastUi > 90) {
        lastUi = now;
        setT(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, timeline.totalSec, syncVideos]);

  // 재생 중에는 고른 BGM을 실제로 들려준다(누른 순간이 사용자 제스처라 재생이 허용된다).
  useEffect(() => {
    if (!playing) {
      bgmRef.current?.stop();
      bgmRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const remaining = Math.max(0.5, timeline.totalSec - tRef.current);
    void startBgm({ id: bgm, durationSec: remaining + 0.4, volume, file: bgmFile, monitor: true })
      .then((session) => {
        if (cancelled) session?.stop();
        else bgmRef.current = session;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      bgmRef.current?.stop();
      bgmRef.current = null;
    };
  }, [playing, bgm, bgmFile, volume, timeline.totalSec]);

  useEffect(() => {
    const store = storeRef.current;
    return () => {
      bgmRef.current?.stop();
      store?.clear();
    };
  }, []);

  const setPlayhead = useCallback(
    (value: number) => {
      const clamped = Math.max(0, Math.min(timeline.totalSec, value));
      tRef.current = clamped;
      setT(clamped);
      if (canvasReady) drawAt(clamped, guidesRef.current);
    },
    [timeline.totalSec, drawAt, canvasReady],
  );

  const gotoIndex = useCallback(
    (index: number) => {
      const segment = timeline.segments[Math.max(0, Math.min(timeline.segments.length - 1, index))];
      if (segment) setPlayhead(segment.startSec + 0.001);
    },
    [timeline.segments, setPlayhead],
  );

  const replaceCuts = useCallback((next: CreatorCut[]) => {
    const keep = new Set(next.map((cut) => cut.id));
    for (const cut of cutsRef.current) {
      if (!keep.has(cut.id)) storeRef.current?.delete(cut.id);
    }
    setCuts(next);
    const end = next.reduce((sum, cut) => sum + cut.durationSec, 0);
    tRef.current = Math.max(0, Math.min(tRef.current, end - 0.001));
    setT(tRef.current);
    setMediaVersion((value) => value + 1);
  }, []);

  const addFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy('files');
      setNotice(null);
      const added: CreatorCut[] = [];
      const failed: string[] = [];
      for (const file of files) {
        const kind = fileKind(file);
        try {
          if (kind === 'image') {
            const loaded = await loadImageFile(file);
            const cut = makeCut({
              kind: 'image',
              src: loaded.url,
              name: file.name,
              width: loaded.width,
              height: loaded.height,
              durationSec: 3,
              origin: 'upload',
            });
            storeRef.current?.track(loaded.url);
            storeRef.current?.set(cut.id, loaded.element);
            added.push(cut);
          } else if (kind === 'video') {
            const loaded = await loadVideoFile(file);
            const cut = makeCut({
              kind: 'video',
              src: loaded.url,
              name: file.name,
              width: loaded.width,
              height: loaded.height,
              durationSec: Math.min(6, Math.max(1.5, Math.round(loaded.durationSec * 10) / 10)),
              origin: 'upload',
              videoDurationSec: loaded.durationSec,
            });
            storeRef.current?.track(loaded.url);
            storeRef.current?.set(cut.id, loaded.element);
            const poster = capturePoster(loaded.element);
            if (poster) cut.poster = poster;
            added.push(cut);
          } else {
            failed.push(file.name);
          }
        } catch {
          failed.push(file.name);
        }
      }
      const replacesSamples = cutsRef.current.every((cut) => cut.origin === 'sample');
      if (added.length > 0) {
        setCuts((previous) =>
          // 아직 손대지 않은 샘플 컷만 있으면 첫 업로드가 그 자리를 대신한다.
          previous.every((cut) => cut.origin === 'sample') ? added : [...previous, ...added],
        );
        setMediaVersion((value) => value + 1);
      }
      setBusy(null);
      const parts: string[] = [];
      if (added.length > 0) parts.push(replacesSamples ? `샘플 대신 ${added.length}개 컷을 넣었습니다.` : `${added.length}개 컷을 추가했습니다.`);
      if (failed.length > 0) parts.push(`${failed.join(', ')}은(는) 사진·영상이 아니어서 건너뛰었습니다.`);
      setNotice({ tone: failed.length > 0 ? 'warn' : 'ok', text: parts.join(' ') || '추가된 컷이 없습니다.' });
      if (added.length > 0) setSourceTab('files');
    },
    [],
  );

  const cutsFromSpecs = useCallback(async (specs: ImportedCutSpec[], note: string, tone: Notice['tone']): Promise<void> => {
    const resolved: ImportedMedia[] = [];
    for (const spec of specs) {
      if (spec.imageUrl) {
        const result = await loadRemoteImage(spec.imageUrl);
        resolved.push({ spec, loaded: result.ok ? result.loaded : null, blocked: !result.ok });
      } else {
        resolved.push({ spec, loaded: null, blocked: false });
      }
    }

    const next = resolved.map((item, index) => {
      const loaded = item.loaded;
      const cut = makeCut({
        kind: loaded ? 'image' : 'placeholder',
        src: loaded?.url ?? '',
        name: `가져온 컷 ${index + 1}`,
        width: loaded?.width,
        height: loaded?.height,
        caption: item.spec.caption,
        note: item.spec.note,
        durationSec: item.spec.durationSec,
        origin: 'url',
      });
      if (loaded) {
        storeRef.current?.track(loaded.url);
        storeRef.current?.set(cut.id, loaded.element);
      }
      return cut;
    });

    replaceCuts(next);
    const blocked = resolved.filter((item) => item.blocked).length;
    const extra = blocked > 0 ? ` 사진 ${blocked}장은 보호되어 있어(CORS) 자리로 대체했습니다 — 파일로 올리면 그대로 들어갑니다.` : '';
    setNotice({ tone: blocked > 0 ? 'warn' : tone, text: `${note}${extra}` });
  }, [replaceCuts]);

  const fetchUrl = useCallback(async () => {
    if (url.trim() === '') {
      setNotice({ tone: 'warn', text: '링크를 입력해 주세요.' });
      return;
    }
    setBusy('url');
    setNotice(null);
    setAttempts([]);
    try {
      const outcome = await importFromUrl(url, { proxy, proxyPrefix });
      setAttempts(outcome.attempts);
      if (outcome.status !== 'ok') {
        setNotice({ tone: 'warn', text: outcome.message });
        return;
      }
      if (outcome.title !== '') {
        setPasteTitle(outcome.title);
        setTopic(outcome.title);
      }
      await cutsFromSpecs(outcome.cuts, outcome.message, 'ok');
    } catch {
      setNotice({ tone: 'bad', text: '가져오는 중 문제가 생겼습니다. 본문을 붙여넣어 주세요.' });
    } finally {
      setBusy(null);
    }
  }, [url, proxy, proxyPrefix, cutsFromSpecs]);

  const buildFromPaste = useCallback(async () => {
    const title = pasteTitle.trim() !== '' ? pasteTitle.trim() : topic.trim() !== '' ? topic.trim() : '오늘의 기록';
    const specs = buildImportedCuts({ title, body: pasteBody, imageUrls: [] });
    if (pasteTitle.trim() !== '') {
      setTopic(pasteTitle.trim());
    }
    await cutsFromSpecs(specs, '붙여넣은 글에서 컷을 만들었습니다. 사진은 아래에서 올려 끼워 넣으세요.', 'ok');
  }, [pasteTitle, pasteBody, topic, cutsFromSpecs]);

  const buildFromTopic = useCallback(() => {
    const subject = topic.trim() !== '' ? topic.trim() : '오늘의 기록';
    const drafts = draftBeatScene(subject, 30);
    const next = drafts.slice(0, 5).map((draft, index) =>
      makeCut({
        kind: 'placeholder',
        caption: draft.onScreenText ?? draft.narration.slice(0, 24),
        note: draft.narration,
        durationSec: index === 0 ? 2.6 : 3.2,
        origin: 'topic',
        accent: ['#2f5fa8', '#1f7a68', '#8a4f9e', '#a8622f', '#3c6f9c'][index % 5],
      }),
    );
    replaceCuts(next);
    setNotice({ tone: 'ok', text: `'${subject}' 주제로 ${next.length}컷을 만들었습니다. 사진을 올려 채워 넣으세요.` });
  }, [topic, replaceCuts]);

  const updateCut = useCallback((id: string, patch: Partial<CreatorCut>) => {
    setCuts((previous) =>
      previous.map((cut) => {
        if (cut.id !== id) return cut;
        const next = { ...cut, ...patch };
        if (typeof patch.durationSec === 'number') {
          next.durationSec = Math.max(0.5, Math.min(15, Number.isFinite(patch.durationSec) ? patch.durationSec : 3));
        }
        return next;
      }),
    );
  }, []);

  const removeCut = useCallback((id: string) => {
    storeRef.current?.delete(id);
    setCuts((previous) => previous.filter((cut) => cut.id !== id));
    setMediaVersion((value) => value + 1);
  }, []);

  const duplicateCut = useCallback((id: string) => {
    const source = cutsRef.current.find((cut) => cut.id === id);
    if (!source) return;
    const copy: CreatorCut = { ...source, id: newCutId('copy') };
    const element = storeRef.current?.get(id);
    if (element) storeRef.current?.set(copy.id, element);
    setCuts((previous) => {
      const index = previous.findIndex((cut) => cut.id === id);
      const next = [...previous];
      next.splice(index + 1, 0, copy);
      return next;
    });
  }, []);

  const move = useCallback((index: number, direction: -1 | 1) => {
    setCuts((previous) => moveCut(previous, index, index + direction));
  }, []);

  const renderNow = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || totalSec <= 0) return;
    setPlaying(false);
    playingRef.current = false;
    bgmRef.current?.stop();
    bgmRef.current = null;
    renderingRef.current = true;
    setRenderState('rendering');
    setRenderProgress(0);
    setRenderRatio(0);
    setRenderError('');

    let session: BgmSession | null = null;
    try {
      session = await startBgm({ id: bgm, durationSec: totalSec, volume, file: bgmFile, monitor: true });
      const result = await renderVideo({
        canvas,
        totalSec,
        fps: 30,
        drawFrameAt: (sec) => {
          drawRef.current(sec, false);
          return { sec, ratio: sec / totalSec };
        },
        audioStream: session?.stream ?? null,
        onProgress: (ratio) => {
          setRenderProgress(ratio);
          setRenderRatio(ratio);
        },
      });
      session?.stop();
      session = null;
      if (video) URL.revokeObjectURL(video.url);
      const name = videoFileName(topic || 'shortform', result.container);
      const url = URL.createObjectURL(result.blob);
      setVideo({ url, name, bytes: result.blob.size, mime: result.mimeType, label: result.label });
      setRenderState('done');
      setRenderProgress(1);
      setRenderRatio(1);
      downloadBlob(result.blob, name);
      setNotice({ tone: 'ok', text: `영상 ${formatBytes(result.blob.size)}를 만들었습니다(${result.label}). 다운로드가 막히면 아래 '다운로드'를 누르세요.` });
    } catch (error) {
      setRenderState('error');
      setRenderError(error instanceof Error ? error.message : '영상을 만들지 못했습니다.');
    } finally {
      session?.stop();
      renderingRef.current = false;
      // 녹화가 끝나면 미리보기 가이드를 원래대로 되돌린다.
      if (canvasRef.current) drawRef.current(Math.min(tRef.current, totalSec), guidesRef.current);
      for (const element of cutsRef.current.map((cut) => storeRef.current?.getVideo(cut.id))) {
        if (element) element.pause();
      }
    }
  }, [totalSec, bgm, volume, bgmFile, topic, video]);

  const generateCards = useCallback(async () => {
    if (cuts.length === 0) return;
    setCardState('working');
    try {
      const canvas = makeCanvas(CARD.width, CARD.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('카드뉴스를 그릴 캔버스를 만들 수 없습니다.');
      const produced: Array<{ name: string; url: string; bytes: number; data: Uint8Array }> = [];
      for (const [index, cut] of cuts.entries()) {
        drawCard(ctx as unknown as Paint2D, {
          cut,
          index,
          total: cuts.length,
          media: (storeRef.current?.get(cut.id) ?? null) as CanvasImageSource | null,
          handle,
          badge,
          disclosure: disclosureInfo,
        });
        const bytes = await canvasToPngBytes(canvas);
        const url = URL.createObjectURL(blobFromBytes(bytes, 'image/png'));
        produced.push({ name: cardFileName(topic || 'shortform', index, cuts.length), url, bytes: bytes.length, data: bytes });
      }
      for (const card of cards) URL.revokeObjectURL(card.url);
      setCards(produced.map(({ name, url, bytes }) => ({ name, url, bytes })));
      setCardState('done');
      setNotice({ tone: 'ok', text: `카드뉴스 ${produced.length}장을 만들었습니다. ZIP으로 한 번에 받을 수 있습니다.` });
    } catch (error) {
      setCardState('idle');
      setNotice({ tone: 'bad', text: error instanceof Error ? error.message : '카드뉴스를 만들지 못했습니다.' });
    }
  }, [cuts, handle, badge, disclosureInfo, topic, cards]);

  const downloadCards = useCallback(() => {
    if (cards.length === 0) return;
    // 데이터는 카드 객체에 없으므로 다시 그리지 않고 캐시된 PNG를 사용한다.
    const entries: Array<{ name: string; bytes: Uint8Array }> = [];
    setCardState('working');
    void (async () => {
      try {
        const canvas = makeCanvas(CARD.width, CARD.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('캔버스를 만들 수 없습니다.');
        for (const [index, cut] of cuts.entries()) {
          drawCard(ctx as unknown as Paint2D, {
            cut,
            index,
            total: cuts.length,
            media: (storeRef.current?.get(cut.id) ?? null) as CanvasImageSource | null,
            handle,
            badge,
            disclosure: disclosureInfo,
          });
          entries.push({ name: cardFileName(topic || 'shortform', index, cuts.length), bytes: await canvasToPngBytes(canvas) });
        }
        const zip = buildCardNewsZip(entries);
        downloadBlob(blobFromBytes(zip, 'application/zip'), cardNewsZipFileName(topic || 'shortform'));
        setNotice({ tone: 'ok', text: `카드뉴스 ${entries.length}장을 ZIP으로 내려받았습니다(${formatBytes(zip.length)}).` });
      } catch (error) {
        setNotice({ tone: 'bad', text: error instanceof Error ? error.message : 'ZIP을 만들지 못했습니다.' });
      } finally {
        setCardState('done');
      }
    })();
  }, [cards.length, cuts, handle, badge, disclosureInfo, topic]);

  const downloadCard = useCallback(
    async (index: number) => {
      const cut = cuts[index];
      if (!cut) return;
      const canvas = makeCanvas(CARD.width, CARD.height);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      drawCard(ctx as unknown as Paint2D, {
        cut,
        index,
        total: cuts.length,
        media: (storeRef.current?.get(cut.id) ?? null) as CanvasImageSource | null,
        handle,
        badge,
        disclosure: disclosureInfo,
      });
      const bytes = await canvasToPngBytes(canvas);
      downloadBlob(blobFromBytes(bytes, 'image/png'), cardFileName(topic || 'shortform', index, cuts.length));
    },
    [cuts, handle, badge, disclosureInfo, topic],
  );

  const copyCaption = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(captionText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setNotice({ tone: 'warn', text: '브라우저가 복사를 막았습니다. 캡션 칸을 눌러 직접 복사해 주세요.' });
    }
  }, [captionText]);

  const togglePlay = useCallback(() => {
    setPlaying((value) => {
      if (!value && tRef.current >= totalSec - 0.01) {
        tRef.current = 0;
        setT(0);
      }
      return !value;
    });
  }, [totalSec]);

  return (
    <div className="creator" data-testid="creator-studio">
      <div className="grid sidebar creator-grid">
        <div className="stack">
          <Card
            eyebrow="실사용 스튜디오"
            title="실제 미디어로 9:16 렌더"
            hint="올린 사진·영상이 그대로 프레임이 됩니다. 미리보기와 저장 파일은 같은 캔버스에서 나옵니다."
            actions={<Pill tone="ok">{timeline.segments.length}컷 · {totalSec.toFixed(1)}초</Pill>}
          >
            <PreviewCard
              canvasRef={canvasRef}
              playing={playing}
              onTogglePlay={togglePlay}
              onPrev={() => gotoIndex(activeIndex - 1)}
              onNext={() => gotoIndex(activeIndex + 1)}
              t={t}
              totalSec={totalSec}
              onSeek={setPlayhead}
              guides={guides}
              onGuides={setGuides}
              activeIndex={activeIndex}
              cutCount={timeline.segments.length}
              rendering={renderState === 'rendering'}
              renderRatio={renderRatio}
              canvasAvailable={canvasReady}
            />
          </Card>

          <Card
            title="배경음악"
            hint="내장 루프는 Web Audio로 그 자리에서 연주합니다 — 저작권·용량 걱정 없이 영상 길이에 정확히 맞습니다."
          >
            <div className="bgm-row">
              <button
                type="button"
                className={bgm === 'none' ? 'chip active' : 'chip'}
                onClick={() => setBgm('none')}
              >
                없음
              </button>
              {BGM_LOOPS.map((loop) => (
                <button
                  key={loop.id}
                  type="button"
                  className={bgm === loop.id ? 'chip active' : 'chip'}
                  onClick={() => setBgm(loop.id)}
                  title={loop.description}
                >
                  {loop.label}
                  <span className="chip-sub">{loop.bpm}</span>
                </button>
              ))}
              <label className={bgm === 'file' ? 'chip active' : 'chip'}>
                내 오디오
                <input
                  type="file"
                  accept="audio/*"
                  hidden
                  onChange={(event) => {
                    const file = event.target.files?.[0] ?? null;
                    setBgmFile(file);
                    if (file) setBgm('file');
                    event.target.value = '';
                  }}
                />
              </label>
            </div>
            <div className="row between" style={{ marginTop: 12 }}>
              <span className="small muted">
                {bgmLabel(bgm)} · 영상 {totalSec.toFixed(1)}초에 맞춰 {bgm === 'none' ? '무음' : bgm === 'file' ? bgmFile?.name ?? '파일을 고르세요' : '연주'}
              </span>
              <label className="volume">
                <span>볼륨 {Math.round(volume * 100)}%</span>
                <input
                  className="seek"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={volume}
                  onChange={(event) => setVolume(Number(event.target.value))}
                />
              </label>
            </div>
            <p className="note" style={{ marginBottom: 0 }}>
              재생을 누르면 음악도 함께 들립니다. 영상 렌더링에는 같은 음악이 그대로 담깁니다.
            </p>
          </Card>

          <div className="grid kpi">
            <Kpi label="컷" value={`${timeline.segments.length}개`} sub="순서대로 재생" />
            <Kpi label="길이" value={`${totalSec.toFixed(1)}s`} sub="컷 길이의 합" />
            <Kpi
              label="해상도"
              value="1080×1920"
              sub="9:16 · 30fps"
              tone="ok"
            />
            <Kpi
              label="안전영역"
              value={guides ? '표시 중' : '꺼짐'}
              sub="상단·캡션·버튼 회피"
              tone={guides ? 'ok' : undefined}
            />
          </div>
        </div>

        <div className="stack">
          <Card title="1 · 소스 가져오기" hint="링크·사진·영상·붙여넣기·주제 중 무엇으로 시작해도 됩니다.">
            <SourceCard
              tab={sourceTab}
              onTab={setSourceTab}
              url={url}
              onUrl={setUrl}
              proxy={proxy}
              onProxy={setProxy}
              proxyPrefix={proxyPrefix}
              onProxyPrefix={setProxyPrefix}
              onFetchUrl={fetchUrl}
              onFiles={addFiles}
              pasteTitle={pasteTitle}
              onPasteTitle={setPasteTitle}
              pasteBody={pasteBody}
              onPasteBody={setPasteBody}
              onPasteBuild={buildFromPaste}
              topic={topic}
              onTopic={setTopic}
              onTopicBuild={buildFromTopic}
              busy={busy}
              message={notice}
              attempts={attempts}
            />
          </Card>

          <Card
            title="2 · 컷 편집"
            hint="자막·길이·켄 번스·위치·전환을 컷마다. 카드뉴스 본문은 설명 칸에서 나옵니다."
          >
            <CutList
              cuts={cuts}
              activeIndex={activeIndex}
              onSelect={(index) => gotoIndex(index)}
              onChange={updateCut}
              onMove={move}
              onRemove={removeCut}
              onDuplicate={duplicateCut}
              onAddBlank={() => {
                const cut = makeCut({ kind: 'placeholder', caption: '새 컷', note: '', durationSec: 3, origin: 'upload' });
                setCuts((previous) => [...previous, cut]);
                setMediaVersion((value) => value + 1);
              }}
              onResetSamples={() => replaceCuts(sampleCuts())}
              onClear={() => replaceCuts([])}
            />
          </Card>

          <Card title="3 · 문구 · 브랜드" hint="공정위 문구는 영상 배지·마지막 컷 문장·게시물 캡션에 함께 들어갑니다.">
            <div className="field-row">
              <div className="field topic">
                <span>주제 (해시태그·파일 이름)</span>
                <input type="text" value={topic} onChange={(event) => setTopic(event.target.value)} />
              </div>
              <div className="field w-angle">
                <span>표시 이름</span>
                <input type="text" value={handle} onChange={(event) => setHandle(event.target.value)} />
              </div>
              <div className="field w-angle">
                <span>주제 배지</span>
                <input type="text" value={badge} onChange={(event) => setBadge(event.target.value)} />
              </div>
            </div>
            <div className="field" style={{ marginTop: 12 }}>
              <span>경제적 이해관계 표기</span>
              <select value={disclosure} onChange={(event) => setDisclosure(event.target.value as Disclosure)} data-testid="creator-disclosure">
                {DISCLOSURES.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
            </div>
            <p className={disclosure === 'none' ? 'note' : 'note strong'} style={{ marginBottom: 0 }} data-testid="creator-disclosure-text">
              {disclosure === 'none'
                ? '표기 없음. 협찬·제공·수수료가 있는 콘텐츠라면 반드시 골라 주세요.'
                : `${disclosureInfo.badge} — ${disclosureInfo.sentence}`}
            </p>
          </Card>

          <Card title="4 · 내보내기" hint="영상(MP4/WebM)과 카드뉴스 PNG·ZIP은 이 브라우저에서 만들어집니다.">
            <ExportCard
              totalSec={totalSec}
              cutCount={timeline.segments.length}
              codecText={codecText}
              renderState={renderState}
              renderProgress={renderProgress}
              renderError={renderError}
              video={video}
              onRender={renderNow}
              onDownloadVideo={() => {
                if (!video) return;
                void fetch(video.url)
                  .then((response) => response.blob())
                  .then((blob) => downloadBlob(blob, video.name));
              }}
              cardState={cardState}
              cards={cards}
              onGenerateCards={generateCards}
              onDownloadCards={downloadCards}
              onDownloadCard={downloadCard}
              caption={captionText}
              onCopyCaption={copyCaption}
              copied={copied}
            />
          </Card>
        </div>
      </div>

    </div>
  );
}
