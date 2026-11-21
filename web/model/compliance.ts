import { scanUploadContent, type ScanReport } from '../../src/services/complianceScanner';
import { buildCaption } from '../../src/services/scriptEngine';
import type { StudioModel } from './studio';

/**
 * 스튜디오 모델을 발행 전 점검에 넘긴다.
 *
 * 안전영역 수치는 모델이 이미 계산해 둔 값(자막 박스 폭·글자 크기·겹침 결과)을
 * 그대로 쓴다. 스캐너가 따로 계산하면 미리보기와 다른 숫자로 판정하게 된다.
 */
export function scanStudioModel(model: StudioModel, extra: { caption?: string; hashtags?: string[] } = {}): ScanReport {
  const caption = extra.caption ?? buildCaption(model.scenes, model.request, extra.hashtags ?? []);
  return scanUploadContent({
    title: model.request.topic,
    caption,
    hashtags: extra.hashtags,
    scenes: model.scenes.map((scene) => ({
      beat: scene.beat,
      narration: scene.narration,
      onScreenText: scene.onScreenText,
    })),
    safeArea: {
      captionWidthPx: model.layout.caption.w,
      fontPx: model.layout.subtitleStyle.fontSizePx,
      badgeWidthPx: model.layout.badge?.w,
      collisions: model.collisions.violations.map((violation) => ({
        layer: violation.layer,
        zone: violation.zone,
        overlapPx: violation.overlapPx,
      })),
      totalDurationSec: model.totalDurationSec,
      targetDurationSec: model.request.targetDurationSec,
      hookDurationSec: model.scenes.find((scene) => scene.beat === 'hook')?.durationSec ?? 0,
      cues: model.cues.map((cue) => ({ index: cue.index, startSec: cue.startSec, lines: cue.lines })),
      screenTexts: model.scenes.map((scene) => scene.onScreenText ?? '').filter((text) => text !== ''),
    },
    limits: { captionChars: 2_200, hashtagMax: 8 },
  });
}
