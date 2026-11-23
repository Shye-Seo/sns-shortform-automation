/**
 * POST /api/analyze-reference
 *
 * 링크가 유튜브·틱톡이면 공개 oEmbed에서 제목과 작성자를 읽어 온다. oEmbed가
 * 막히거나 인스타그램처럼 토큰이 필요한 곳이면 사용자가 적은 제목·자막으로
 * 구조를 읽는다. 어느 쪽이든 구조를 읽는 규칙은 하나다.
 */
import { analyzeReference, oembedUrlFor, parseReferenceUrl, readOembed } from '../src/services/sonder/reference';
import {
  asRecord,
  fail,
  methodOf,
  numberField,
  readJsonBody,
  sendJson,
  textField,
  type ApiHandler,
} from './_lib/http';

export interface AnalyzeDeps {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function fetchOembed(url: string, deps: AnalyzeDeps): Promise<{ title: string; author: string } | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'sns-shortform-automation/2.0' },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 5000),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const meta = readOembed(payload);
    return meta ? { title: meta.title, author: meta.author } : null;
  } catch {
    return null;
  }
}

export function createAnalyzeHandler(deps: AnalyzeDeps = {}): ApiHandler {
  return async (req, res) => {
    if (methodOf(req) !== 'POST') {
      fail(res, 405, 'POST만 지원합니다', 'method_not_allowed');
      return;
    }
    const body = asRecord(await readJsonBody(req));
    if (!body) {
      fail(res, 400, '참고 영상 정보를 JSON으로 보내 주세요', 'invalid_body');
      return;
    }

    const url = textField(body, 'url');
    let title = textField(body, 'title');
    let author = textField(body, 'author');
    let metadata: 'oembed' | 'input' | 'none' = title || textField(body, 'transcript') ? 'input' : 'none';

    const parsed = parseReferenceUrl(url);
    const endpoint = oembedUrlFor(parsed, url);
    if (endpoint) {
      const meta = await fetchOembed(endpoint, deps);
      if (meta) {
        if (!title) title = meta.title;
        if (!author) author = meta.author;
        metadata = 'oembed';
      }
    }

    try {
      const analysis = analyzeReference({
        url,
        title: title || undefined,
        transcript: textField(body, 'transcript') || undefined,
        durationSec: numberField(body, 'durationSec') || undefined,
        author: author || undefined,
      });
      sendJson(res, 200, {
        structure: analysis.structure,
        title: analysis.title,
        author: analysis.author,
        platform: analysis.platform,
        metadata,
      });
    } catch (error) {
      fail(res, 400, error instanceof Error ? error.message : '구조를 읽지 못했습니다');
    }
  };
}

export default async function handler(req: Parameters<ApiHandler>[0], res: Parameters<ApiHandler>[1]): Promise<void> {
  await createAnalyzeHandler()(req, res);
}
