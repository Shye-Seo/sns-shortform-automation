import { measureTextPx, wrapText } from '../lib/text';

/**
 * 업로드 전 규제어·금칙어·9:16 안전영역 스캐너.
 *
 * 왜 이 검사가 필요한가: 렌더는 성공했는데 캡션에 "국내 유일", "부작용 없음"이
 * 들어 있으면 플랫폼 심사나 표시광고 이슈로 내려간다. 그리고 9:16은 화면 가장자리가
 * 플랫폼 UI에 가려지므로, 자막 한 줄이 길면 폰에서 잘린다. 둘 다 발행 버튼을 누르기
 * 전에 알 수 있는 일이라 여기서 모은다.
 *
 * 정직한 경계: 이 검사는 **법률 검토가 아니다**. 방송통신심의위원회·공정거래위원회가
 * 문제 삼아 온 표현과 플랫폼 게시 정책에서 흔한 항목을 규칙으로 옮긴 것이고,
 * 규칙에 없는 표현은 통과시킨다. 그래서 결과를 "통과/주의/차단"으로 나누되
 * 차단 사유에는 항상 원문과 고칠 문장을 함께 보여준다.
 */

export type ScanSeverity = 'block' | 'warn' | 'info';
export type ScanKind = 'claim' | 'policy' | 'safe-area' | 'length';

export interface ScanFinding {
  id: string;
  kind: ScanKind;
  severity: ScanSeverity;
  /** 사람이 읽는 규칙 이름. */
  label: string;
  /** 어디서 걸렸는지(훅·문제·해결 2·캡션·화면 자막 …). */
  where: string;
  /** 실제로 걸린 문자열. */
  matched: string;
  suggestion: string;
}

export interface ScanRule {
  id: string;
  kind: ScanKind;
  severity: ScanSeverity;
  label: string;
  pattern: RegExp;
  suggestion: string;
}

/**
 * 문장 규칙. 정규식은 짧게 유지하고, 걸린 문자열을 그대로 보여준다.
 * `block`은 의료 효능·최저가 보장·개인정보처럼 내려갈 위험이 큰 것만 둔다.
 */
export const SCAN_RULES: ScanRule[] = [
  {
    id: 'medical-cure',
    kind: 'claim',
    severity: 'block',
    label: '치료·완치 효능 단정',
    pattern: /(완치|치료(?:가|는|됩니다|효과|법)|항암\s*효과|만병통치|특효|즉효)/u,
    suggestion: '질병의 치료·예방 효과를 단정하면 의료광고 규제 대상입니다. "도움이 됐다" 같은 경험 서술로 바꾸세요.',
  },
  {
    id: 'medical-sideeffect',
    kind: 'claim',
    severity: 'block',
    label: '부작용 없음 단정',
    pattern: /부작용(?:이|은|는)?\s*(?:전혀\s*)?(?:없|없습니다|없어요)/u,
    suggestion: '"부작용이 없다"는 단정은 쓸 수 없습니다. 개인차가 있다는 문장으로 바꾸세요.',
  },
  {
    id: 'medical-antiaging',
    kind: 'claim',
    severity: 'block',
    label: '재생·노화방지·면역력 단정',
    pattern: /(피부\s*재생|노화\s*방지|주름\s*제거|탈모\s*치료|면역력\s*(?:강화|증진|향상)|체지방\s*(?:감소|분해)\s*보장)/u,
    suggestion: '효능을 단정하는 표현은 화장품·건강기능식품 규제에 걸립니다. 사용감·성분 설명으로 바꾸세요.',
  },
  {
    id: 'price-best',
    kind: 'claim',
    severity: 'block',
    label: '최저가 보장',
    pattern: /(최저가\s*보장|최저가\s*도전|업계\s*최저|무조건\s*최저)/u,
    suggestion: '비교 근거 없는 최저가 보장은 표시광고법 위반 소지가 있습니다. "이번 주 기준" 같은 조건을 붙이세요.',
  },
  {
    id: 'rank-first',
    kind: 'claim',
    severity: 'warn',
    label: '1위·유일 표현',
    pattern: /(국내\s*유일|세계\s*유일|유일무이|판매\s*1위|업계\s*1위|단\s*하나뿐인)/u,
    suggestion: '1위·유일은 조사 시점과 기준을 함께 적어야 합니다. 기준이 없으면 지워 주세요.',
  },
  {
    id: 'absolute-claim',
    kind: 'claim',
    severity: 'warn',
    label: '절대·완벽·무조건',
    pattern: /(완벽(?:하게|한|히)?|무조건|절대(?:로)?|영구적|반영구|만능|100%\s*(?:효과|보장|재생|해결)|전혀\s*없)/u,
    suggestion: '결과를 보장하는 단정은 개인차·조건을 붙이거나 빼는 편이 안전합니다.',
  },
  {
    id: 'guarantee-result',
    kind: 'claim',
    severity: 'warn',
    label: '결과 보장',
    pattern: /(다이어트\s*(?:성공|보장|확정)|살\s*(?:이|이\s*)?빠지(?:는|습니다)|수익\s*보장|원금\s*보장|매출\s*보장)/u,
    suggestion: '결과 보장 문구는 광고 심사에서 자주 반려됩니다. 경험과 조건 중심으로 바꾸세요.',
  },
  {
    id: 'phone-number',
    kind: 'policy',
    severity: 'block',
    label: '전화번호 노출',
    pattern: /(?:\+82[-\s]?)?0\d{1,2}[-.\s]?\d{3,4}[-.\s]?\d{4}/u,
    suggestion: '전화번호는 게시물에 남기지 말고 프로필 링크나 DM으로 안내하세요.',
  },
  {
    id: 'resident-number',
    kind: 'policy',
    severity: 'block',
    label: '주민등록번호 형태',
    pattern: /\d{6}[-\s]?[1-4]\d{6}/u,
    suggestion: '주민등록번호는 어떤 이유로도 게시물에 넣지 않습니다. 즉시 지우세요.',
  },
  {
    id: 'account-number',
    kind: 'policy',
    severity: 'warn',
    label: '계좌번호 형태',
    pattern: /\d{3,6}[-\s]\d{2,6}[-\s]\d{4,8}/u,
    suggestion: '계좌번호는 사기 오인과 개인정보 노출 위험이 있습니다. 결제 링크로 바꾸세요.',
  },
  {
    id: 'external-link',
    kind: 'policy',
    severity: 'warn',
    label: '외부 링크',
    pattern: /https?:\/\//u,
    suggestion: '릴스·쇼츠 캡션의 외부 링크는 도달이 줄고 정책 위반 소지가 있습니다. 프로필 링크로 안내하세요.',
  },
  {
    id: 'auto-dm',
    kind: 'policy',
    severity: 'warn',
    label: '자동 DM 유도',
    pattern: /(DM\s*(?:주세요|주시|보내|드립니다|주면)|디엠\s*(?:주세요|주시)|댓글\s*(?:달면|남기면|쓰면).{0,12}(?:보내|드립니다|링크))/u,
    suggestion: '플랫폼은 자동 DM을 제한합니다. 댓글 키워드 캠페인이라면 이 제품의 댓글→DM 기능을 쓰세요.',
  },
  {
    id: 'ad-disclosure',
    kind: 'policy',
    severity: 'info',
    label: '광고 표기 확인',
    pattern: /(협찬|광고|제공\s*받|체험단|내돈내산)/u,
    suggestion: '협찬·제공을 받은 글에는 대가 관계를 첫 부분에 표시해야 합니다.',
  },
];

export interface ScanTextPart {
  where: string;
  text: string;
}

export interface SafeAreaInput {
  /** 자막 박스 너비(px). 1080x1920 캔버스 기준. */
  captionWidthPx: number;
  /** 자막 최대 줄 수(엔진 기본 2줄). */
  captionLines?: number;
  /** 자막 글자 크기(px). */
  fontPx: number;
  /** 화면 자막(뱃지) 최대 너비(px). */
  badgeWidthPx?: number;
  /** 플랫폼 UI 영역과 겹친 결과. 빌더가 계산한 값을 그대로 받는다. */
  collisions?: Array<{ layer: string; zone: string; overlapPx: number }>;
  /** 목표 길이와 훅 길이. */
  totalDurationSec?: number;
  targetDurationSec?: number;
  hookDurationSec?: number;
  /** 자막 큐. 있으면 큐 단위로 잘림을 검사한다. */
  cues?: Array<{ index: number; startSec: number; lines: string[] }>;
  /** 화면 자막 목록. */
  screenTexts?: string[];
}

export interface ScanInput {
  title?: string;
  caption?: string;
  hashtags?: string[];
  scenes: Array<{ beat: string; narration: string; onScreenText?: string }>;
  parts?: ScanTextPart[];
  safeArea?: SafeAreaInput;
  limits?: { captionChars?: number; hashtagMax?: number; hookMaxSec?: number };
}

export interface ScanReport {
  ok: boolean;
  blocking: number;
  warnings: number;
  infos: number;
  findings: ScanFinding[];
  checkedTexts: number;
  rulesChecked: number;
  summary: string;
}

const BEAT_LABEL: Record<string, string> = {
  hook: '훅',
  problem: '문제',
  solution: '해결',
  cta: '마지막 유도',
};

function collectParts(input: ScanInput): ScanTextPart[] {
  const parts: ScanTextPart[] = [];
  input.scenes.forEach((scene, index) => {
    const label = scene.beat === 'solution' ? `해결 ${index}` : (BEAT_LABEL[scene.beat] ?? scene.beat);
    if (scene.narration.trim() !== '') parts.push({ where: label, text: scene.narration });
    if ((scene.onScreenText ?? '').trim() !== '') parts.push({ where: `${label} 화면 자막`, text: scene.onScreenText ?? '' });
  });
  if (input.title) parts.push({ where: '제목', text: input.title });
  if (input.caption) parts.push({ where: '캡션', text: input.caption });
  if (input.hashtags && input.hashtags.length > 0) parts.push({ where: '해시태그', text: input.hashtags.join(' ') });
  for (const part of input.parts ?? []) parts.push(part);
  return parts;
}

function scanText(parts: ScanTextPart[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const part of parts) {
    for (const rule of SCAN_RULES) {
      const match = part.text.match(rule.pattern);
      if (!match) continue;
      findings.push({
        id: `${rule.id}:${part.where}`,
        kind: rule.kind,
        severity: rule.severity,
        label: rule.label,
        where: part.where,
        matched: match[0],
        suggestion: rule.suggestion,
      });
    }
  }
  return findings;
}

function scanSafeArea(input: SafeAreaInput): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const captionLines = input.captionLines ?? 2;

  for (const cue of input.cues ?? []) {
    const lines = wrapText(cue.lines.join(' '), { maxWidthPx: input.captionWidthPx, fontSizePx: input.fontPx, maxLines: captionLines });
    if (lines.length > captionLines) {
      findings.push({
        id: `cue-lines:${cue.index}`,
        kind: 'safe-area',
        severity: 'warn',
        label: '자막 줄 수 초과',
        where: `${cue.startSec.toFixed(2)}s 자막 ${cue.index}`,
        matched: cue.lines.join(' '),
        suggestion: `${captionLines}줄을 넘으면 아래가 잘립니다. 문장을 끊어 주세요.`,
      });
    }
    for (const line of cue.lines) {
      const width = measureTextPx(line, input.fontPx);
      if (width > input.captionWidthPx) {
        findings.push({
          id: `cue-width:${cue.index}`,
          kind: 'safe-area',
          severity: 'block',
          label: '자막이 9:16 안전영역을 넘음',
          where: `${cue.startSec.toFixed(2)}s 자막 ${cue.index}`,
          matched: line,
          suggestion: `한 줄 폭 ${Math.round(width)}px > 자막 박스 ${Math.round(input.captionWidthPx)}px. 띄어쓰기를 넣거나 줄을 나누세요.`,
        });
      }
    }
  }

  for (const text of input.screenTexts ?? []) {
    if (input.badgeWidthPx === undefined) break;
    const width = measureTextPx(text, 34);
    if (width > input.badgeWidthPx) {
      findings.push({
        id: `badge-width:${text}`,
        kind: 'safe-area',
        severity: 'warn',
        label: '화면 자막이 뱃지 폭을 넘음',
        where: '화면 자막',
        matched: text,
        suggestion: `뱃지 폭 ${Math.round(input.badgeWidthPx)}px을 넘습니다. 14자 안으로 줄이세요.`,
      });
    }
  }

  for (const collision of input.collisions ?? []) {
    findings.push({
      id: `collision:${collision.layer}:${collision.zone}`,
      kind: 'safe-area',
      severity: 'block',
      label: '플랫폼 UI와 겹침',
      where: `${collision.layer} × ${collision.zone}`,
      matched: `${collision.overlapPx}px`,
      suggestion: '상단 여백·버튼 영역과 겹치면 폰에서 가려집니다. 오버레이 위치를 안쪽으로 옮기세요.',
    });
  }

  if (input.hookDurationSec !== undefined && input.hookDurationSec > 3.5) {
    findings.push({
      id: 'hook-duration',
      kind: 'length',
      severity: 'block',
      label: '훅 3.5초 초과',
      where: '훅',
      matched: `${input.hookDurationSec.toFixed(2)}s`,
      suggestion: '첫 3.5초를 넘기면 스크롤 전에 문장이 끝나지 않습니다. 훅을 줄이세요.',
    });
  }

  if (
    input.totalDurationSec !== undefined &&
    input.targetDurationSec !== undefined &&
    input.totalDurationSec > input.targetDurationSec + 0.05
  ) {
    findings.push({
      id: 'duration-overrun',
      kind: 'length',
      severity: 'warn',
      label: '목표 길이 초과',
      where: '타임라인',
      matched: `${input.totalDurationSec.toFixed(2)}s / ${input.targetDurationSec}s`,
      suggestion: '플랫폼 상한을 넘으면 업로드 후 잘립니다. 압축을 켜거나 문장을 줄이세요.',
    });
  }

  return findings;
}

function scanLimits(input: ScanInput): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const captionChars = input.limits?.captionChars;
  if (captionChars !== undefined && input.caption && input.caption.length > captionChars) {
    findings.push({
      id: 'caption-length',
      kind: 'length',
      severity: 'block',
      label: '캡션 길이 초과',
      where: '캡션',
      matched: `${input.caption.length}자`,
      suggestion: `플랫폼 상한 ${captionChars}자를 넘습니다. 뒤쪽 문장을 덜어내세요.`,
    });
  }
  const hashtagMax = input.limits?.hashtagMax;
  if (hashtagMax !== undefined && (input.hashtags?.length ?? 0) > hashtagMax) {
    findings.push({
      id: 'hashtag-count',
      kind: 'length',
      severity: 'warn',
      label: '해시태그 과다',
      where: '해시태그',
      matched: `${input.hashtags?.length ?? 0}개`,
      suggestion: `릴스는 ${hashtagMax}개 이하가 읽기 좋습니다.`,
    });
  }
  return findings;
}

const SEVERITY_ORDER: Record<ScanSeverity, number> = { block: 0, warn: 1, info: 2 };

export function scanUploadContent(input: ScanInput): ScanReport {
  const parts = collectParts(input);
  const findings = [...scanText(parts), ...(input.safeArea ? scanSafeArea(input.safeArea) : []), ...scanLimits(input)]
    .filter((finding, index, all) => all.findIndex((other) => other.id === finding.id) === index)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.where.localeCompare(b.where));

  const blocking = findings.filter((finding) => finding.severity === 'block').length;
  const warnings = findings.filter((finding) => finding.severity === 'warn').length;
  const infos = findings.filter((finding) => finding.severity === 'info').length;

  const summary =
    blocking > 0
      ? `발행 전 ${blocking}건을 고쳐야 합니다${warnings > 0 ? ` (주의 ${warnings})` : ''}`
      : warnings > 0
        ? `발행 가능 · 주의 ${warnings}건${infos > 0 ? `, 참고 ${infos}` : ''}`
        : `발행 가능 · 걸린 항목 없음${infos > 0 ? ` (참고 ${infos})` : ''}`;

  return {
    ok: blocking === 0,
    blocking,
    warnings,
    infos,
    findings,
    checkedTexts: parts.length,
    rulesChecked: SCAN_RULES.length,
    summary,
  };
}
