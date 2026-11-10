import { describe, expect, it } from 'vitest';
import {
  InstagramPublisher,
  buildReelCaption,
  captionLengthError,
} from '../src/services/publisher/instagramPublisher';
import {
  YoutubePublisher,
  buildVideoMetadata,
  youtubeErrorHint,
} from '../src/services/publisher/youtubePublisher';
import { PlatformApiError } from '../src/services/publisher/http';
import { createApproval, assertApproval, computeContentHash, subjectFromScript } from '../src/services/approval';
import { createScriptEngine } from '../src/services/scriptEngine';
import type { HttpClient, HttpRequest, HttpResponse } from '../src/services/publisher/http';

interface Call {
  request: HttpRequest;
}

function mockHttp(handler: (request: HttpRequest, call: number) => HttpResponse | Promise<HttpResponse>): {
  http: HttpClient;
  calls: Call[];
} {
  const calls: Call[] = [];
  const http: HttpClient = async (request) => {
    calls.push({ request });
    return handler(request, calls.length);
  };
  return { http, calls };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

function raw(status: number, body: string, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers, body };
}

const sleep = async (): Promise<void> => undefined;

describe('Instagram caption rules', () => {
  it('rejects a caption over 2,200 characters', () => {
    expect(captionLengthError('가'.repeat(2201))).toContain('2201');
    expect(captionLengthError('가'.repeat(2200))).toBeNull();
  });

  it('rejects more than 30 hashtags', () => {
    const caption = Array.from({ length: 31 }, (_, index) => `#태그${index}`).join(' ');
    expect(captionLengthError(caption)).toContain('31 hashtags');
  });

  it('appends missing hashtags exactly once', () => {
    const merged = buildReelCaption('본문 #릴스', ['#릴스', '#주방수납']);
    expect(merged.match(/#릴스/g)).toHaveLength(1);
    expect(merged).toContain('#주방수납');
  });
});

describe('Instagram publisher', () => {
  const config = {
    igUserId: '17841400000',
    accessToken: 'token',
    sleep,
  };

  it('runs create → poll → publish and returns the permalink', async () => {
    const { http, calls } = mockHttp((request) => {
      if (request.url.includes('content_publishing_limit')) {
        return json(200, { data: [{ quota_usage: 2, config: { quota_total: 25 } }] });
      }
      if (request.url.endsWith('/media') && request.method === 'POST') {
        return json(200, { id: 'container-1' });
      }
      if (request.url.includes('container-1')) {
        return json(200, { status_code: 'FINISHED' });
      }
      if (request.url.includes('media_publish')) {
        return json(200, { id: 'media-1' });
      }
      if (request.url.includes('media-1')) {
        return json(200, { permalink: 'https://www.instagram.com/reel/abc/' });
      }
      return json(404, {});
    });

    const publisher = new InstagramPublisher(config, http);
    const result = await publisher.publishReel({
      videoUrl: 'https://cdn.example.com/render.mp4',
      caption: '주방수납 정리, 3단계면 끝납니다. #릴스',
    });

    expect(result.status).toBe('published');
    expect(result.remoteId).toBe('media-1');
    expect(result.url).toContain('instagram.com/reel/abc');
    expect(result.messages.join(' ')).toContain('container created');
    const containerCall = calls.find((call) => call.request.url.endsWith('/media'));
    expect(String(containerCall?.request.body)).toContain('media_type=REELS');
  });

  it('polls while the container is in progress', async () => {
    let polls = 0;
    const { http } = mockHttp((request) => {
      if (request.url.includes('content_publishing_limit')) return json(200, { data: [] });
      if (request.url.endsWith('/media')) return json(200, { id: 'c2' });
      if (request.url.includes('c2') && request.url.includes('fields=status_code')) {
        polls += 1;
        return json(200, { status_code: polls < 3 ? 'IN_PROGRESS' : 'FINISHED' });
      }
      if (request.url.includes('media_publish')) return json(200, { id: 'm2' });
      return json(200, {});
    });
    const publisher = new InstagramPublisher(config, http);
    const result = await publisher.publishReel({
      videoUrl: 'https://cdn.example.com/a.mp4',
      caption: '테스트',
    });
    expect(polls).toBe(3);
    expect(result.remoteId).toBe('m2');
  });

  it('refuses a non-https video url before calling the API', async () => {
    const { http, calls } = mockHttp(() => json(200, {}));
    const publisher = new InstagramPublisher(config, http);
    await expect(
      publisher.publishReel({ videoUrl: 'http://cdn.example.com/a.mp4', caption: '테스트' }),
    ).rejects.toThrow(/public https video URL/);
    expect(calls).toHaveLength(0);
  });

  it('refuses an over-long caption before calling the API', async () => {
    const { http, calls } = mockHttp(() => json(200, {}));
    const publisher = new InstagramPublisher(config, http);
    await expect(
      publisher.publishReel({ videoUrl: 'https://cdn.example.com/a.mp4', caption: '가'.repeat(2300) }),
    ).rejects.toThrow(/Instagram allows 2200/);
    expect(calls).toHaveLength(0);
  });

  it('stops when the daily quota is exhausted', async () => {
    const { http } = mockHttp((request) => {
      if (request.url.includes('content_publishing_limit')) {
        return json(200, { data: [{ quota_usage: 25, config: { quota_total: 25 } }] });
      }
      return json(200, {});
    });
    const publisher = new InstagramPublisher(config, http);
    await expect(
      publisher.publishReel({ videoUrl: 'https://cdn.example.com/a.mp4', caption: '테스트' }),
    ).rejects.toThrow(/quota used up/);
  });

  it('maps a Meta error into a typed, non-retryable error', async () => {
    const { http } = mockHttp((request) => {
      if (request.url.includes('content_publishing_limit')) return json(200, { data: [] });
      return json(400, {
        error: {
          message: 'Media download has failed.',
          code: 9004,
          error_subcode: 2207026,
          fbtrace_id: 'trace-1',
        },
      });
    });
    const publisher = new InstagramPublisher(config, http);
    const error = await publisher
      .publishReel({ videoUrl: 'https://cdn.example.com/a.mp4', caption: '테스트' })
      .catch((unknown: unknown) => unknown);

    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).info.code).toBe(9004);
    expect((error as PlatformApiError).retryable).toBe(false);
  });

  it('describes the dry-run call sequence', async () => {
    const { http, calls } = mockHttp(() => json(200, {}));
    const publisher = new InstagramPublisher(config, http);
    const result = await publisher.publishReel(
      { videoUrl: 'https://cdn.example.com/a.mp4', caption: '테스트' },
      { dryRun: true },
    );
    expect(result.status).toBe('dry-run');
    expect(result.messages.length).toBe(3);
    expect(calls).toHaveLength(0);
  });
});

describe('YouTube metadata', () => {
  it('adds the #Shorts tag once', () => {
    const { metadata } = buildVideoMetadata({
      title: '주방 수납 3단계',
      description: '본문',
      visibility: 'public',
    });
    expect(metadata.snippet.title).toBe('주방 수납 3단계 #Shorts');
    expect(metadata.snippet.description).toContain('#Shorts');
    expect(metadata.snippet.tags).toContain('Shorts');
  });

  it('does not duplicate an existing tag', () => {
    const { metadata } = buildVideoMetadata({
      title: '주방 수납 #shorts',
      description: '#shorts 포함',
      visibility: 'public',
    });
    expect(metadata.snippet.title.match(/#shorts/gi)).toHaveLength(1);
  });

  it('keeps the title inside 100 characters', () => {
    const { metadata } = buildVideoMetadata({
      title: '가'.repeat(120),
      description: '본문',
      visibility: 'public',
    });
    expect(metadata.snippet.title.length).toBeLessThanOrEqual(100);
  });

  it('forces private status for a scheduled upload', () => {
    const { metadata, warnings } = buildVideoMetadata({
      title: '예약',
      description: '본문',
      visibility: 'public',
      scheduleAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(metadata.status.privacyStatus).toBe('private');
    expect(metadata.status.publishAt).toBeDefined();
    expect(warnings.join(' ')).toContain('private');
  });

  it('rejects a malformed schedule', () => {
    expect(() =>
      buildVideoMetadata({
        title: 'x',
        description: 'y',
        visibility: 'public',
        scheduleAt: 'not-a-date',
      }),
    ).toThrow(/invalid scheduleAt/);
  });

  it('hints at the quota reset for a quotaExceeded failure', () => {
    expect(youtubeErrorHint({ status: 403, reason: 'quotaExceeded' })).toContain('10,000');
  });
});

describe('YouTube resumable upload', () => {
  const config = {
    accessToken: 'yt-token',
    chunkSizeBytes: 4,
    sleep,
  };

  it('resumes from the byte range the server reports', async () => {
    const ranges: string[] = [];
    const { http } = mockHttp((request) => {
      if (request.method === 'POST') {
        return raw(200, '', { location: 'https://upload.example.com/session?id=1' });
      }
      const range = request.headers?.['content-range'] ?? '';
      ranges.push(range);
      if (range === 'bytes 0-3/10') {
        return raw(308, '', { range: 'bytes=0-3' });
      }
      if (range === 'bytes 4-7/10') {
        return raw(308, '', { range: 'bytes=0-7' });
      }
      if (range === 'bytes 8-9/10') {
        return raw(200, JSON.stringify({ id: 'video-1' }));
      }
      return raw(400, '{}');
    });

    const publisher = new YoutubePublisher(config, http);
    const result = await publisher.publishShort({
      title: '테스트',
      description: '설명',
      visibility: 'public',
      videoBytes: new Uint8Array(10).fill(7),
    });

    expect(result.remoteId).toBe('video-1');
    expect(result.url).toBe('https://youtu.be/video-1');
    expect(ranges).toEqual(['bytes 0-3/10', 'bytes 4-7/10', 'bytes 8-9/10']);
  });

  it('surfaces a quota error as retryable=false', async () => {
    const { http } = mockHttp((request) => {
      if (request.method === 'POST') {
        return raw(200, '', { location: 'https://upload.example.com/s' });
      }
      return raw(
        403,
        JSON.stringify({
          error: {
            code: 403,
            message: 'quota exceeded',
            status: 'PERMISSION_DENIED',
            errors: [{ reason: 'quotaExceeded' }],
          },
        }),
      );
    });
    const publisher = new YoutubePublisher(config, http);
    const error = await publisher
      .publishShort({
        title: 't',
        description: 'd',
        visibility: 'public',
        videoBytes: new Uint8Array(4),
      })
      .catch((unknown: unknown) => unknown);
    expect(error).toBeInstanceOf(PlatformApiError);
    expect((error as PlatformApiError).retryable).toBe(false);
  });

  it('sends the metadata in the session request', async () => {
    let sessionBody = '';
    const { http } = mockHttp((request) => {
      if (request.method === 'POST') {
        sessionBody = String(request.body);
        return raw(200, '', { location: 'https://upload.example.com/s' });
      }
      return raw(200, JSON.stringify({ id: 'v2' }));
    });
    const publisher = new YoutubePublisher(config, http);
    await publisher.publishShort({
      title: '제목',
      description: '설명',
      tags: ['#주방수납'],
      visibility: 'unlisted',
      videoBytes: new Uint8Array(4),
    });
    const parsed = JSON.parse(sessionBody) as { snippet: { title: string; tags: string[] }; status: { privacyStatus: string } };
    expect(parsed.snippet.title).toContain('#Shorts');
    expect(parsed.snippet.tags).toContain('주방수납');
    expect(parsed.status.privacyStatus).toBe('unlisted');
  });

  it('dry-runs without opening a session', async () => {
    const { http, calls } = mockHttp(() => raw(200, '{}'));
    const publisher = new YoutubePublisher(config, http);
    const result = await publisher.publishShort(
      { title: 't', description: 'd', visibility: 'public' },
      { dryRun: true },
    );
    expect(result.status).toBe('dry-run');
    expect(calls).toHaveLength(0);
  });
});

describe('approval gate', () => {
  it('accepts an unchanged artifact', async () => {
    const { script } = await createScriptEngine().craft({ topic: '주방 수납 정리법', targetDurationSec: 30 });
    const subject = subjectFromScript(script, '1\n00:00:00,000 --> 00:00:01,000\n테스트\n');
    const approval = createApproval(subject, { approvedBy: '서승혜' });
    expect(() => assertApproval(approval, subject)).not.toThrow();
  });

  it('ignores line-ending differences', async () => {
    const { script } = await createScriptEngine().craft({ topic: '주방 수납 정리법', targetDurationSec: 30 });
    const a = subjectFromScript(script, 'line1\r\nline2');
    const b = subjectFromScript(script, 'line1\nline2');
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it('rejects a subtitle edited after approval', async () => {
    const { script } = await createScriptEngine().craft({ topic: '주방 수납 정리법', targetDurationSec: 30 });
    const approved = createApproval(subjectFromScript(script, '원본 자막'), { approvedBy: '서승혜' });
    const edited = subjectFromScript(script, '수정된 자막');
    expect(() => assertApproval(approved, edited)).toThrow(/content changed after approval/);
  });

  it('rejects publishing with no approval on file', async () => {
    const { script } = await createScriptEngine().craft({ topic: '주방 수납 정리법', targetDurationSec: 30 });
    const subject = subjectFromScript(script, '자막');
    expect(() => assertApproval(null, subject)).toThrow(/no approval on file/);
  });

  it('rejects an explicitly withheld approval', async () => {
    const { script } = await createScriptEngine().craft({ topic: '주방 수납 정리법', targetDurationSec: 30 });
    const subject = subjectFromScript(script, '자막');
    const approval = { ...createApproval(subject, { approvedBy: '서승혜' }), approved: false };
    expect(() => assertApproval(approval, subject)).toThrow(/withheld/);
  });
});
