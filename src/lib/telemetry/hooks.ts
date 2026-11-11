import { createHash } from 'node:crypto';
import { ShortformError } from '../errors';
import { estimateSpeechSeconds } from '../text';
import { HookAngleSchema, type HookAngle, type HookVariant } from '../../types/telemetry';

/**
 * Variant ids are fixed letters, not generated: "variant A" survives a rebuild,
 * a log line and a CSV export unchanged.
 */
const VARIANT_IDS = ['A', 'B', 'C', 'D'] as const;

export interface HookTemplate {
  id: string;
  angle: HookAngle;
  build: (topic: string) => string;
}

/**
 * Six hook angles, each a different reason a thumb stops. The text is a
 * template on purpose: the A/B test measures the angle, and a free-form LLM
 * hook would measure the model's mood that day instead.
 */
export const HOOK_TEMPLATES: readonly HookTemplate[] = [
  { id: 'q-regress', angle: 'question', build: (topic) => `${topic}, 왜 또 원래대로일까요?` },
  { id: 'q-mistake', angle: 'question', build: (topic) => `${topic}, 순서가 틀렸습니다` },
  { id: 'n-three', angle: 'numbers', build: (topic) => `${topic} 3가지만 바꾸세요` },
  { id: 'n-ninety', angle: 'numbers', build: (topic) => `${topic}, 90%가 포기합니다` },
  { id: 'c-effort', angle: 'contrarian', build: (topic) => `${topic}, 더 하면 안 됩니다` },
  { id: 'c-cheap', angle: 'contrarian', build: (topic) => `${topic}에 돈 쓰지 마세요` },
  { id: 'h-three-min', angle: 'howto', build: (topic) => `${topic}, 3분이면 됩니다` },
  { id: 'h-one-thing', angle: 'howto', build: (topic) => `${topic}, 하나만 고치세요` },
  { id: 'p-changed', angle: 'proof', build: (topic) => `${topic}로 한 달 만에 바뀌었습니다` },
  { id: 's-lost', angle: 'shock', build: (topic) => `저는 ${topic} 때문에 3년을 버렸습니다` },
] as const;

export const HOOK_SECONDS_CEILING = 3.5;

function trimTopic(topic: string, maxSyllables = 14): string {
  const cleaned = topic.replace(/\s+/g, ' ').trim().replace(/[.?!]$/u, '');
  if (estimateSpeechSeconds(cleaned) <= 2.2) return cleaned;
  // Cut on word boundaries until the topic fits, never mid-word.
  const words = cleaned.split(' ');
  const kept: string[] = [];
  for (const word of words) {
    const candidate = [...kept, word].join(' ');
    if (estimateSpeechSeconds(candidate) > 2.2 && kept.length > 0) break;
    kept.push(word);
    if ((candidate.match(/[가-힣]/g) ?? []).length >= maxSyllables) break;
  }
  return kept.join(' ');
}

function shortenTopic(topic: string, maxWords: number): string {
  const words = topic.split(' ');
  return words.slice(0, Math.max(1, maxWords)).join(' ');
}

/**
 * Build a hook and, if the template plus topic overruns 3.5s, retry with a
 * shorter topic before giving up. Long topics are common; failing the whole
 * experiment because 'shock' is wordy would hide the useful variants.
 */
function fitTemplate(
  template: HookTemplate,
  topic: string,
): { text: string; hookSeconds: number } {
  const attempts = [topic, shortenTopic(topic, 4), shortenTopic(topic, 2), shortenTopic(topic, 1)];
  for (const candidate of attempts) {
    const text = template.build(candidate);
    const hookSeconds = Math.round(estimateSpeechSeconds(text) * 100) / 100;
    if (hookSeconds <= HOOK_SECONDS_CEILING) return { text, hookSeconds };
  }
  throw new ShortformError(`hook template ${template.id} cannot fit ${HOOK_SECONDS_CEILING}s`, {
    code: 'VALIDATION',
    details: { templateId: template.id, topic },
  });
}

export interface GenerateHooksOptions {
  count?: number;
  angles?: HookAngle[];
  /** Angle weights from the feedback loop; used only to order the shortlist. */
  weights?: Partial<Record<HookAngle, number>>;
}

/**
 * Build 2–4 hook variants for the same episode. Every variant is checked
 * against the same 3.5s ceiling the script engine enforces, so a hook that
 * would fail review is never even tested.
 */
export function generateHookVariants(topic: string, options: GenerateHooksOptions = {}): HookVariant[] {
  const cleaned = trimTopic(topic);
  if (!cleaned) {
    throw new ShortformError('topic is required to generate hooks', { code: 'VALIDATION' });
  }
  const angles = (options.angles ?? [...HookAngleSchema.options]).filter((angle) =>
    HOOK_TEMPLATES.some((template) => template.angle === angle),
  );
  if (angles.length < 2) {
    throw new ShortformError('at least two hook angles are required', {
      code: 'VALIDATION',
      details: { angles },
    });
  }
  const weights = options.weights ?? {};
  const ordered = [...angles].sort((a, b) => (weights[b] ?? 0) - (weights[a] ?? 0));
  const count = Math.max(2, Math.min(4, Math.floor(options.count ?? 3)));

  const picked: HookTemplate[] = [];
  for (const angle of ordered) {
    const template = HOOK_TEMPLATES.find((candidate) => candidate.angle === angle);
    if (template && !picked.some((p) => p.angle === angle)) picked.push(template);
    if (picked.length >= count) break;
  }

  return picked.map((template, index) => {
    const { text, hookSeconds } = fitTemplate(template, cleaned);
    return {
      id: VARIANT_IDS[index],
      angle: template.angle,
      text,
      templateId: template.id,
      hookSeconds,
    };
  });
}

/**
 * Deterministic bucketing: the same viewer sees the same variant on every
 * request, without a database row per viewer. sha256 of experiment + unit
 * modulo 10,000 gives a stable 0–1 position.
 */
export function bucketOf(experimentId: string, unitId: string): number {
  const digest = createHash('sha256').update(`${experimentId}\u0000${unitId}`).digest();
  return digest.readUInt32BE(0) % 10_000;
}

export function assignVariant<T extends { id: string }>(
  experimentId: string,
  unitId: string,
  variants: T[],
): T {
  if (variants.length === 0) {
    throw new ShortformError('cannot assign a variant from an empty list', { code: 'VALIDATION' });
  }
  const bucket = bucketOf(experimentId, unitId);
  const index = Math.min(variants.length - 1, Math.floor((bucket / 10_000) * variants.length));
  return variants[index];
}

/** Split check used by the console: are viewers landing evenly? */
export function assignmentSpread(
  experimentId: string,
  unitIds: string[],
  variantIds: string[],
): Array<{ variantId: string; count: number; share: number }> {
  const counts = new Map<string, number>(variantIds.map((id) => [id, 0]));
  for (const unitId of unitIds) {
    const bucket = bucketOf(experimentId, unitId);
    const index = Math.min(variantIds.length - 1, Math.floor((bucket / 10_000) * variantIds.length));
    const id = variantIds[index];
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return variantIds.map((variantId) => ({
    variantId,
    count: counts.get(variantId) ?? 0,
    share: unitIds.length === 0 ? 0 : Math.round(((counts.get(variantId) ?? 0) / unitIds.length) * 10_000) / 10_000,
  }));
}
