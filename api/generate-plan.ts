/**
 * GET/POST /api/generate-plan
 *
 * 빌린 구조 + 채널 정체성으로 기획안을 만든다. 서버에 모델 키가 있으면 모델이
 * 훅 3안과 장면 문장을 쓰고, 없거나 실패하면 내장 엔진이 쓴다. 어느 쪽이든
 * 시간·자막·박자표는 엔진이 다시 계산한다.
 *
 * 만든 기획안은 content_plans에 남긴다. 저장이 실패해도 기획안은 돌려준다 —
 * 화면에서 이어서 작업할 수 있는데 저장 실패로 통째로 잃을 이유는 없다.
 */
import { normalizeIdentity } from '../src/services/sonder/identity';
import { summarizeLogs } from '../src/services/sonder/performance';
import {
  buildPlan,
  buildPlanPrompt,
  planFromModelDrafts,
  readModelPlanPayload,
  type PlanInput,
} from '../src/services/sonder/planner';
import type {
  BeatKey,
  BorrowedBeat,
  BorrowedStructure,
  ChannelIdentity,
  ContentPlan,
  HookId,
  HookPattern,
  PlanGoal,
} from '../src/services/sonder/types';
import { readEnv } from './_lib/env';
import {
  asRecord,
  fail,
  methodOf,
  numberField,
  readJsonBody,
  sendJson,
  stringList,
  textField,
  type ApiHandler,
} from './_lib/http';
import type { LlmClient } from './_lib/llm';
import { llmFromEnv } from './_lib/llm';
import { DATABASE_MISSING_MESSAGE, storeFromEnv } from './_lib/runtime';
import type { Store } from './_lib/store';

const BEATS: BeatKey[] = ['hook', 'problem', 'solution', 'cta'];
const PATTERNS: HookPattern[] = ['question', 'numbers', 'howto', 'contrarian', 'story'];
const GOALS: PlanGoal[] = ['save', 'comment', 'follow', 'link'];
const HOOK_IDS: HookId[] = ['A', 'B', 'C'];

function readStructure(value: unknown): BorrowedStructure | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.beats)) return null;
  const beats: BorrowedBeat[] = record.beats
    .map((beat): BorrowedBeat | null => {
      if (typeof beat !== 'object' || beat === null) return null;
      const item = beat as Record<string, unknown>;
      const key = textField(item, 'beat') as BeatKey;
      if (!BEATS.includes(key)) return null;
      return {
        beat: key,
        label: textField(item, 'label') || key,
        intent: textField(item, 'intent'),
        startSec: numberField(item, 'startSec'),
        endSec: numberField(item, 'endSec'),
        ratio: numberField(item, 'ratio'),
      };
    })
    .filter((beat): beat is BorrowedBeat => beat !== null);
  if (beats.length < 2) return null;

  const goalText = textField(record, 'goal');
  return {
    hookPattern: PATTERNS.includes(textField(record, 'hookPattern') as HookPattern)
      ? (textField(record, 'hookPattern') as HookPattern)
      : 'story',
    hookLine: textField(record, 'hookLine'),
    beats,
    transitions: Array.isArray(record.transitions) ? record.transitions.map((value) => Number(value) || 0) : [],
    cta: textField(record, 'cta'),
    goal: GOALS.includes(goalText as PlanGoal) ? (goalText as PlanGoal) : null,
    pace: numberField(record, 'pace'),
    durationSec: numberField(record, 'durationSec', 45),
    signals: stringList(record, 'signals', 8),
    basis: Array.isArray(record.basis)
      ? (record.basis.filter((item) => item === 'title' || item === 'transcript' || item === 'duration') as BorrowedStructure['basis'])
      : [],
  };
}

function identityFromBody(value: unknown): ChannelIdentity | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (!textField(record, 'name')) return null;
  try {
    return normalizeIdentity({
      id: textField(record, 'id') || undefined,
      name: textField(record, 'name'),
      handle: textField(record, 'handle'),
      posture: textField(record, 'posture'),
      audience: textField(record, 'audience'),
      voice: textField(record, 'voice'),
      strengths: stringList(record, 'strengths'),
      banned: stringList(record, 'banned'),
      signature: stringList(record, 'signature'),
    });
  } catch {
    return null;
  }
}

export interface GeneratePlanDeps {
  store: Store;
  /** 주입하면 모델 문장을 쓰고, 없으면 내장 엔진이 쓴다. 테스트는 가짜 함수를 넣는다. */
  llm?: LlmClient | null;
}

export function createGeneratePlanHandler(deps: GeneratePlanDeps): ApiHandler {
  return async (req, res) => {
    const method = methodOf(req);

    if (method === 'GET') {
      const items = await deps.store.listPlans();
      sendJson(res, 200, { items });
      return;
    }

    if (method !== 'POST') {
      fail(res, 405, 'GET·POST만 지원합니다', 'method_not_allowed');
      return;
    }

    const body = asRecord(await readJsonBody(req));
    if (!body) {
      fail(res, 400, '기획안 입력을 JSON으로 보내 주세요', 'invalid_body');
      return;
    }

    const topic = textField(body, 'topic');
    if (topic.length < 2) {
      fail(res, 400, '주제를 두 글자 이상 넣어 주세요', 'missing_topic');
      return;
    }

    const identityId = textField(body, 'identityId');
    let identity = identityFromBody(body.identity);
    if (!identity && identityId) {
      const stored = (await deps.store.listIdentities()).find((item) => item.id === identityId);
      if (stored) identity = stored;
    }
    if (!identity) {
      fail(res, 400, '채널 정체성을 고르거나 만들어 주세요', 'missing_identity');
      return;
    }

    const structure = readStructure(body.structure);
    if (!structure) {
      fail(res, 400, '트렌드 보관함의 구조를 함께 보내 주세요', 'missing_structure');
      return;
    }

    const goalText = textField(body, 'goal');
    const hookText = textField(body, 'chosenHook');
    const input: PlanInput = {
      topic,
      identity,
      structure,
      trendId: textField(body, 'trendId') || null,
      trendTitle: textField(body, 'trendTitle'),
      durationSec: numberField(body, 'durationSec') || structure.durationSec,
      goal: GOALS.includes(goalText as PlanGoal) ? (goalText as PlanGoal) : undefined,
      chosenHook: HOOK_IDS.includes(hookText as HookId) ? (hookText as HookId) : undefined,
    };

    const logs = await deps.store.listLogs();
    input.feedback = summarizeLogs(logs);

    let warning = '';
    let result = buildPlan(input);

    if (deps.llm) {
      try {
        const prompt = buildPlanPrompt(input);
        const payload = await deps.llm.complete(prompt.system, prompt.user);
        const drafts = readModelPlanPayload(payload);
        if (!drafts) throw new Error('모델 응답에서 훅·장면을 찾지 못했습니다');
        const fromModel = planFromModelDrafts({ ...input, chosenHook: input.chosenHook ?? 'A' }, drafts, deps.llm.provider);
        result = fromModel;
      } catch (error) {
        warning = `연결한 모델 호출이 실패해 내장 엔진으로 만들었습니다${error instanceof Error ? ` (${error.message.slice(0, 120)})` : ''}.`;
      }
    }

    // 같은 주제·구조·채널의 기획안이 이미 있으면 훅만 바꿔 다시 만든 것으로 보고
    // 그 행을 갱신한다. 훅을 세 번 눌렀다고 기획안이 세 개 쌓이지 않게.
    try {
      const existing = (await deps.store.listPlans()).find(
        (item) =>
          item.topic === result.plan.topic &&
          item.trendId === result.plan.trendId &&
          item.identityId === result.plan.identityId,
      );
      if (existing) {
        result = { ...result, plan: { ...result.plan, id: existing.id, createdAt: existing.createdAt } };
      }
    } catch {
      // 목록을 못 읽어도 저장은 시도한다.
    }

    let saved = true;
    let saveError = '';
    try {
      await deps.store.addPlan(result.plan as ContentPlan);
    } catch (error) {
      saved = false;
      saveError = error instanceof Error ? error.message : '저장에 실패했습니다';
    }

    sendJson(res, 200, {
      plan: result.plan,
      recommended: result.recommended,
      saved,
      saveError: saveError || undefined,
      warning: warning || undefined,
      source: result.plan.source,
    });
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  const env = readEnv();
  const store = storeFromEnv(env);
  if (!store) {
    fail(res, 503, DATABASE_MISSING_MESSAGE, 'database_not_configured');
    return;
  }
  await createGeneratePlanHandler({ store, llm: llmFromEnv(env) })(req, res);
}
