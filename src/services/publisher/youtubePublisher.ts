import { readFile } from 'node:fs/promises';
import { ShortformError } from '../../lib/errors';
import { truncate } from '../../lib/text';
import { withRetry, defaultSleep } from '../../lib/retry';
import type { PublishResult } from '../../types/publish';
import {
  assertOk,
  createFetchClient,
  parseGoogleError,
  PlatformApiError,
  type HttpClient,
} from './http';

export interface YoutubeConfig {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  categoryId?: string;
  apiBaseUrl?: string;
  uploadBaseUrl?: string;
  tokenUrl?: string;
  chunkSizeBytes?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface YoutubeShortInput {
  title: string;
  description: string;
  tags?: string[];
  visibility: 'public' | 'unlisted' | 'private';
  /** ISO-8601 with offset. Requires private status until it fires. */
  scheduleAt?: string;
  madeForKids?: boolean;
  categoryId?: string;
  language?: string;
}

export interface YoutubeMetadata {
  snippet: {
    title: string;
    description: string;
    tags: string[];
    categoryId: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
  };
  status: {
    privacyStatus: 'public' | 'unlisted' | 'private';
    selfDeclaredMadeForKids: boolean;
    publishAt?: string;
  };
}

const SHORTS_TAG = '#Shorts';

/**
 * YouTube rejects a title over 100 characters and silently drops extra tags,
 * so metadata is normalised here instead of being rejected after the upload.
 * Scheduled publishing only works on private videos — the API ignores
 * publishAt on a public video, which looks like "the schedule didn't work".
 */
export function buildVideoMetadata(input: YoutubeShortInput, defaultCategoryId = '22'): {
  metadata: YoutubeMetadata;
  warnings: string[];
} {
  const warnings: string[] = [];
  let title = input.title.trim();
  if (!title) {
    throw new ShortformError('YouTube title is required', { code: 'VALIDATION' });
  }
  const hasShortsTag = /#shorts\b/i.test(title) || /#shorts\b/i.test(input.description);
  if (!hasShortsTag) {
    title = `${title} ${SHORTS_TAG}`.trim();
  }
  title = truncate(title, 100);

  let description = input.description.trim();
  if (!/#shorts\b/i.test(description)) {
    description = `${description}\n\n${SHORTS_TAG}`.trim();
  }
  description = truncate(description, 5000);

  const tagSet = new Set(
    [...(input.tags ?? []), 'Shorts', 'shorts', '숏폼', '릴스']
      .map((tag) => tag.replace(/^#/, '').trim())
      .filter(Boolean),
  );
  let tags = Array.from(tagSet);
  // YouTube caps tags at ~500 characters total.
  while (tags.join(',').length > 480 && tags.length > 1) {
    tags = tags.slice(0, -1);
  }

  let privacyStatus = input.visibility;
  let publishAt: string | undefined;
  if (input.scheduleAt) {
    const fireAt = new Date(input.scheduleAt);
    if (Number.isNaN(fireAt.getTime())) {
      throw new ShortformError(`invalid scheduleAt: ${input.scheduleAt}`, { code: 'VALIDATION' });
    }
    if (fireAt.getTime() <= Date.now()) {
      warnings.push('scheduleAt is in the past; YouTube will publish immediately');
    }
    if (privacyStatus !== 'private') {
      warnings.push('scheduled uploads must be private until publishAt; privacyStatus forced to private');
      privacyStatus = 'private';
    }
    publishAt = fireAt.toISOString();
  }

  return {
    warnings,
    metadata: {
      snippet: {
        title,
        description,
        tags,
        categoryId: input.categoryId ?? defaultCategoryId,
        defaultLanguage: input.language,
        defaultAudioLanguage: input.language,
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: input.madeForKids ?? false,
        ...(publishAt ? { publishAt } : {}),
      },
    },
  };
}

interface UploadSession {
  url: string;
  totalBytes: number;
}

/**
 * YouTube Data API v3 resumable upload.
 *
 * The protocol is a state machine: POST opens a session that returns a
 * `Location`, PUTs carry `Content-Range`, and an incomplete upload answers
 * 308 plus the byte range received. Resuming from that range instead of
 * restarting is what makes a 100MB upload survive a flaky connection.
 */
export class YoutubePublisher {
  private readonly config: Required<Pick<YoutubeConfig, 'apiBaseUrl' | 'uploadBaseUrl' | 'tokenUrl' | 'chunkSizeBytes'>> &
    Omit<YoutubeConfig, 'apiBaseUrl' | 'uploadBaseUrl' | 'tokenUrl' | 'chunkSizeBytes'>;
  private readonly http: HttpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(config: YoutubeConfig = {}, http: HttpClient = createFetchClient()) {
    this.config = {
      ...config,
      apiBaseUrl: config.apiBaseUrl ?? 'https://www.googleapis.com/youtube/v3',
      uploadBaseUrl: config.uploadBaseUrl ?? 'https://www.googleapis.com/upload/youtube/v3',
      tokenUrl: config.tokenUrl ?? 'https://oauth2.googleapis.com/token',
      chunkSizeBytes: config.chunkSizeBytes ?? 8 * 1024 * 1024,
    };
    this.http = http;
    this.sleep = config.sleep ?? defaultSleep;
    this.now = config.now ?? (() => new Date());
  }

  /** Refresh an OAuth2 access token, memoised until shortly before expiry. */
  async getAccessToken(): Promise<string> {
    if (this.config.accessToken && !this.config.refreshToken) return this.config.accessToken;
    if (this.cachedToken && this.cachedToken.expiresAt > this.now().getTime() + 30_000) {
      return this.cachedToken.value;
    }
    const { clientId, clientSecret, refreshToken } = this.config;
    if (!refreshToken || !clientId || !clientSecret) {
      if (this.config.accessToken) return this.config.accessToken;
      throw new ShortformError('YouTube credentials are missing', {
        code: 'CONFIG',
        details: {
          need: ['YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'],
        },
      });
    }

    const response = await withRetry(
      'YouTube token refresh',
      async () =>
        this.http({
          method: 'POST',
          url: this.config.tokenUrl,
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: clientId,
            client_secret: clientSecret,
            refresh_token: refreshToken,
            grant_type: 'refresh_token',
          }).toString(),
        }),
      { attempts: 3, baseDelayMs: 600, jitter: true, sleep: this.sleep },
    );

    if (response.status >= 400) {
      const info = parseGoogleError(response);
      throw new PlatformApiError('google', info, 'YouTube token refresh');
    }
    const data = JSON.parse(response.body) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new ShortformError('YouTube token refresh returned no access_token', { code: 'PLATFORM' });
    }
    this.cachedToken = {
      value: data.access_token,
      expiresAt: this.now().getTime() + (data.expires_in ?? 3600) * 1000,
    };
    return data.access_token;
  }

  async startUploadSession(
    metadata: YoutubeMetadata,
    contentLength: number,
    mimeType = 'video/mp4',
  ): Promise<UploadSession> {
    const token = await this.getAccessToken();
    const response = await this.http({
      method: 'POST',
      url: `${this.config.uploadBaseUrl}/videos?uploadType=resumable&part=snippet,status`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-length': String(contentLength),
        'x-upload-content-type': mimeType,
      },
      body: JSON.stringify(metadata),
    });
    assertOk(response, 'google', 'YouTube upload session');
    const location = response.headers['location'] ?? response.headers['Location'];
    if (!location) {
      throw new ShortformError('YouTube did not return an upload session URL', {
        code: 'PLATFORM',
        details: { status: response.status },
      });
    }
    return { url: location, totalBytes: contentLength };
  }

  /** Ask the server how many bytes it already has (0 when it has none). */
  async getResumeOffset(session: UploadSession): Promise<number> {
    const token = await this.getAccessToken();
    const response = await this.http({
      method: 'PUT',
      url: session.url,
      headers: {
        authorization: `Bearer ${token}`,
        'content-range': `bytes */${session.totalBytes}`,
        'content-length': '0',
      },
    });
    if (response.status === 308) {
      const range = response.headers['range'];
      if (!range) return 0;
      const match = range.match(/bytes=0-(\d+)/i);
      return match ? Number(match[1]) + 1 : 0;
    }
    if (response.status >= 200 && response.status < 300) {
      return session.totalBytes;
    }
    const info = parseGoogleError(response);
    throw new PlatformApiError('google', info, 'YouTube upload status');
  }

  /**
   * Upload the payload in chunks. `onProgress` receives bytes committed, which
   * is what the CLI prints while a 60s vertical video travels.
   */
  async uploadContent(
    session: UploadSession,
    data: Uint8Array,
    options: { onProgress?: (sent: number, total: number) => void } = {},
  ): Promise<string> {
    const token = await this.getAccessToken();
    const total = data.byteLength;
    let offset = 0;

    while (offset < total) {
      const end = Math.min(offset + this.config.chunkSizeBytes, total);
      const chunk = data.subarray(offset, end);
      let attempt = 0;

      for (;;) {
        let response;
        try {
          response = await this.http({
            method: 'PUT',
            url: session.url,
            headers: {
              authorization: `Bearer ${token}`,
              'content-length': String(chunk.byteLength),
              'content-type': 'video/mp4',
              'content-range': `bytes ${offset}-${end - 1}/${total}`,
            },
            body: chunk,
          });
        } catch (error) {
          // Connection lost: ask the server where to continue.
          attempt += 1;
          if (attempt >= 5) throw error;
          await this.sleep(500 * 2 ** attempt);
          offset = await this.getResumeOffset(session);
          break;
        }

        if (response.status === 308) {
          const range = response.headers['range'];
          const match = range?.match(/bytes=0-(\d+)/i);
          offset = match ? Number(match[1]) + 1 : end;
          options.onProgress?.(offset, total);
          break;
        }

        if (response.status >= 200 && response.status < 300) {
          const body = JSON.parse(response.body || '{}') as { id?: string };
          if (!body.id) {
            throw new ShortformError('YouTube upload finished without a video id', {
              code: 'PLATFORM',
            });
          }
          options.onProgress?.(total, total);
          return body.id;
        }

        const info = parseGoogleError(response);
        const error = new PlatformApiError('google', info, 'YouTube upload');
        if (!error.retryable || attempt >= 4) throw error;
        attempt += 1;
        await this.sleep((info.retryAfterMs ?? 0) + 500 * 2 ** attempt);
      }
    }

    // All chunks sent but no completion body: confirm with the status probe.
    const offsetNow = await this.getResumeOffset(session);
    if (offsetNow >= total) {
      throw new ShortformError('YouTube accepted all bytes but returned no video id', {
        code: 'PLATFORM',
      });
    }
    throw new ShortformError('YouTube upload ended before completion', {
      code: 'NETWORK',
      retryable: true,
      details: { offset: offsetNow, total },
    });
  }

  async publishShort(
    input: YoutubeShortInput & { videoBytes?: Uint8Array; videoPath?: string },
    options: { dryRun?: boolean; onProgress?: (sent: number, total: number) => void } = {},
  ): Promise<PublishResult> {
    const startedAt = this.now().toISOString();
    const { metadata, warnings } = buildVideoMetadata(input, this.config.categoryId ?? '22');

    if (options.dryRun) {
      return {
        platform: 'youtube-shorts',
        status: 'dry-run',
        remoteId: null,
        url: null,
        attempts: 0,
        messages: [
          `POST ${this.config.uploadBaseUrl}/videos?uploadType=resumable&part=snippet,status`,
          `title: ${metadata.snippet.title}`,
          `status: ${metadata.status.privacyStatus}${metadata.status.publishAt ? ` @ ${metadata.status.publishAt}` : ''}`,
          'PUT <session> (chunked, resumes on 308)',
        ],
        warnings,
        startedAt,
        finishedAt: this.now().toISOString(),
      };
    }

    const bytes =
      input.videoBytes ??
      (input.videoPath ? new Uint8Array(await readFile(input.videoPath)) : undefined);
    if (!bytes) {
      throw new ShortformError('YouTube publish needs videoBytes or videoPath', {
        code: 'VALIDATION',
      });
    }

    const session = await this.startUploadSession(metadata, bytes.byteLength);
    const videoId = await this.uploadContent(session, bytes, { onProgress: options.onProgress });

    if (metadata.status.publishAt) {
      warnings.push(`scheduled for ${metadata.status.publishAt}`);
    }
    warnings.push('YouTube quota: 1600 units per upload, 10,000 units per day by default');

    return {
      platform: 'youtube-shorts',
      status: 'uploaded',
      remoteId: videoId,
      url: `https://youtu.be/${videoId}`,
      attempts: 1,
      messages: [`uploaded: ${videoId}`, `privacy: ${metadata.status.privacyStatus}`],
      warnings,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }
}

export interface YoutubeErrorHintArgs {
  status: number;
  reason?: string;
}

export function youtubeErrorHint({ status, reason }: YoutubeErrorHintArgs): string {
  if (status === 401) return '액세스 토큰이 만료되었습니다. 리프레시 토큰으로 재발급하세요.';
  if (status === 403 && reason === 'quotaExceeded') return '일일 할당량(10,000 units)을 초과했습니다. 태평양 표준시 자정에 초기화됩니다.';
  if (status === 403) return '권한 또는 채널 인증(전화번호 인증) 상태를 확인하세요.';
  if (status === 400) return '메타데이터 오류입니다. 제목/설명 길이와 예약 시간을 확인하세요.';
  return `YouTube API 오류 (${status})`;
}
