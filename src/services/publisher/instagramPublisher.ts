import { ShortformError } from '../../lib/errors';
import { round } from '../../lib/ids';
import { withRetry, defaultSleep } from '../../lib/retry';
import {
  PLATFORM_RULES,
  type PublishResult,
} from '../../types/publish';
import {
  createFetchClient,
  jsonRequest,
  parseJson,
  parseMetaError,
  PlatformApiError,
  type HttpClient,
} from './http';

export interface InstagramConfig {
  igUserId: string;
  accessToken: string;
  apiVersion?: string;
  baseUrl?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface InstagramReelInput {
  /** Public HTTPS URL. The Graph API fetches the file itself. */
  videoUrl: string;
  caption: string;
  coverUrl?: string;
  thumbOffsetMs?: number;
  shareToFeed?: boolean;
  /** ISO-8601; must be between 10 minutes and 75 days ahead. */
  scheduleAt?: string;
}

interface ContainerStatus {
  status_code?: 'EXPIRED' | 'ERROR' | 'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED';
  status?: string;
  id?: string;
}

const GRAPH_ERROR_HINTS: Record<number, string> = {
  4: '앱 단위 호출 한도에 걸렸습니다. 1시간 뒤 다시 시도하세요.',
  10: '권한 부족: instagram_content_publish 스코프와 앱 심사 상태를 확인하세요.',
  17: '사용자 단위 호출 한도입니다. 잠시 후 재시도하세요.',
  100: '잘못된 파라미터입니다. video_url이 공개 HTTPS인지 확인하세요.',
  190: '액세스 토큰이 만료되었습니다. 토큰을 갱신하세요.',
  9004: 'video_url을 Meta가 내려받지 못했습니다. 공개 접근 가능한 URL인지 확인하세요.',
  9007: '컨테이너가 아직 처리 중입니다(FINISHED 대기).',
};

export function captionLengthError(caption: string): string | null {
  if (caption.length > PLATFORM_RULES['instagram-reels'].captionMaxChars) {
    return `caption is ${caption.length} chars, Instagram allows ${PLATFORM_RULES['instagram-reels'].captionMaxChars}`;
  }
  const hashtags = caption.match(/#[^\s#]+/gu) ?? [];
  if (hashtags.length > PLATFORM_RULES['instagram-reels'].hashtagMaxCount) {
    return `${hashtags.length} hashtags, Instagram allows ${PLATFORM_RULES['instagram-reels'].hashtagMaxCount}`;
  }
  return null;
}

export function buildReelCaption(caption: string, hashtags: string[]): string {
  const existing = new Set((caption.match(/#[^\s#]+/gu) ?? []).map((tag) => tag.toLowerCase()));
  const missing = hashtags.filter((tag) => !existing.has(tag.toLowerCase()));
  const merged = `${caption.trim()}${missing.length ? `\n\n${missing.join(' ')}` : ''}`.trim();
  return merged.slice(0, PLATFORM_RULES['instagram-reels'].captionMaxChars);
}

/**
 * Instagram Content Publishing protocol:
 *   create container -> poll status_code until FINISHED -> media_publish.
 * The poll is mandatory: publishing before FINISHED returns a generic error
 * and burns a publish attempt against the 24h quota.
 */
export class InstagramPublisher {
  private readonly config: Required<Omit<InstagramConfig, 'sleep' | 'now'>>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly http: HttpClient;

  constructor(config: InstagramConfig, http: HttpClient = createFetchClient()) {
    if (!config.igUserId) {
      throw new ShortformError('IG_USER_ID is not set', { code: 'CONFIG', details: { env: 'IG_USER_ID' } });
    }
    if (!config.accessToken) {
      throw new ShortformError('IG_ACCESS_TOKEN is not set', {
        code: 'CONFIG',
        details: { env: 'IG_ACCESS_TOKEN' },
      });
    }
    this.config = {
      igUserId: config.igUserId,
      accessToken: config.accessToken,
      apiVersion: config.apiVersion ?? process.env.IG_GRAPH_VERSION ?? 'v21.0',
      baseUrl: config.baseUrl ?? 'https://graph.facebook.com',
      pollIntervalMs: config.pollIntervalMs ?? 2_000,
      pollTimeoutMs: config.pollTimeoutMs ?? 180_000,
    };
    this.sleep = config.sleep ?? defaultSleep;
    this.now = config.now ?? (() => new Date());
    this.http = http;
  }

  private get base(): string {
    return `${this.config.baseUrl}/${this.config.apiVersion}`;
  }

  private form(fields: Record<string, string | number | boolean | undefined>): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      params.set(key, String(value));
    }
    params.set('access_token', this.config.accessToken);
    return params.toString();
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: string, context = 'Instagram'): Promise<T> {
    const response = await withRetry(
      context,
      async () => {
        const result = await this.http({
          method,
          url: `${this.base}${path}`,
          headers: body
            ? { 'content-type': 'application/x-www-form-urlencoded' }
            : undefined,
          body,
        });
        if (result.status >= 400) {
          const info = parseMetaError(result);
          if (PLATFORM_RULES['instagram-reels'] && info.retryAfterMs && info.retryAfterMs > 0) {
            await this.sleep(Math.min(info.retryAfterMs, 30_000));
          }
          const error = new PlatformApiError('meta', info, context);
          if (typeof info.code === 'number') {
            const hint = GRAPH_ERROR_HINTS[info.code];
            if (hint) (error.details as Record<string, unknown>).hint = hint;
          }
          throw error;
        }
        return result;
      },
      {
        attempts: 4,
        baseDelayMs: 700,
        maxDelayMs: 15_000,
        jitter: true,
        sleep: this.sleep,
      },
    );
    return parseJson<T>(response);
  }

  /** 24-hour publishing quota (Instagram allows 25 API-published posts). */
  async getPublishingQuota(): Promise<{ quotaUsage: number; quotaTotal: number; config: unknown }> {
    const { data } = await jsonRequest<{
      data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
    }>(
      this.http,
      'meta',
      {
        method: 'GET',
        url: `${this.base}/${this.config.igUserId}/content_publishing_limit?fields=quota_usage,config&access_token=${encodeURIComponent(this.config.accessToken)}`,
      },
      'Instagram publishing limit',
    );
    const entry = data.data?.[0];
    return {
      quotaUsage: entry?.quota_usage ?? 0,
      quotaTotal: entry?.config?.quota_total ?? PLATFORM_RULES['instagram-reels'].publishPerDay,
      config: entry?.config,
    };
  }

  async createContainer(input: InstagramReelInput): Promise<string> {
    const lengthError = captionLengthError(input.caption);
    if (lengthError) {
      throw new ShortformError(lengthError, { code: 'VALIDATION' });
    }
    if (!/^https:\/\//i.test(input.videoUrl)) {
      throw new ShortformError('Instagram requires a public https video URL', {
        code: 'VALIDATION',
        details: {
          hint: 'S3/CloudFront/Cloudflare R2 등 공개 URL에 렌더 결과를 올린 뒤 --video-url 로 전달하세요',
        },
      });
    }

    const body = this.form({
      media_type: 'REELS',
      video_url: input.videoUrl,
      caption: input.caption,
      share_to_feed: input.shareToFeed ?? true,
      thumb_offset: input.thumbOffsetMs,
      cover_url: input.coverUrl,
      published: input.scheduleAt ? false : undefined,
      scheduled_publish_time: input.scheduleAt
        ? Math.floor(new Date(input.scheduleAt).getTime() / 1000)
        : undefined,
    });

    const result = await this.call<{ id?: string }>(
      'POST',
      `/${this.config.igUserId}/media`,
      body,
      'Instagram container',
    );
    if (!result.id) {
      throw new ShortformError('Instagram did not return a container id', { code: 'PLATFORM' });
    }
    return result.id;
  }

  async getContainerStatus(containerId: string): Promise<ContainerStatus> {
    return this.call<ContainerStatus>(
      'GET',
      `/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(this.config.accessToken)}`,
      undefined,
      'Instagram container status',
    );
  }

  async waitForContainer(containerId: string): Promise<'FINISHED'> {
    const startedAt = this.now().getTime();
    let interval = this.config.pollIntervalMs;

    for (;;) {
      const status = await this.getContainerStatus(containerId);
      if (status.status_code === 'FINISHED') return 'FINISHED';
      if (status.status_code === 'ERROR' || status.status_code === 'EXPIRED') {
        throw new ShortformError(
          `Instagram container ${status.status_code}: ${status.status ?? 'no detail'}`,
          { code: 'PLATFORM', details: { containerId, status: status.status } },
        );
      }
      if (this.now().getTime() - startedAt > this.config.pollTimeoutMs) {
        throw new ShortformError('Instagram container did not finish in time', {
          code: 'PLATFORM',
          retryable: false,
          details: { containerId, elapsedMs: this.now().getTime() - startedAt },
        });
      }
      await this.sleep(interval);
      interval = Math.min(interval * 1.35, 8_000);
    }
  }

  async publishContainer(containerId: string): Promise<string> {
    const result = await this.call<{ id?: string }>(
      'POST',
      `/${this.config.igUserId}/media_publish`,
      this.form({ creation_id: containerId }),
      'Instagram publish',
    );
    if (!result.id) {
      throw new ShortformError('Instagram did not return a media id', { code: 'PLATFORM' });
    }
    return result.id;
  }

  async getPermalink(mediaId: string): Promise<string | null> {
    const { data } = await jsonRequest<{ permalink?: string }>(
      this.http,
      'meta',
      {
        method: 'GET',
        url: `${this.base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(this.config.accessToken)}`,
      },
      'Instagram permalink',
    );
    return data.permalink ?? null;
  }

  async publishReel(
    input: InstagramReelInput,
    options: { dryRun?: boolean } = {},
  ): Promise<PublishResult> {
    const startedAt = this.now().toISOString();
    const messages: string[] = [];
    const warnings: string[] = [];

    // Validate local input before spending a rate-limit slot on the quota call.
    const lengthError = captionLengthError(input.caption);
    if (lengthError) {
      throw new ShortformError(lengthError, { code: 'VALIDATION' });
    }
    if (!/^https:\/\//i.test(input.videoUrl)) {
      throw new ShortformError('Instagram requires a public https video URL', {
        code: 'VALIDATION',
        details: {
          hint: 'S3/CloudFront/Cloudflare R2 등 공개 URL에 렌더 결과를 올린 뒤 --video-url 로 전달하세요',
        },
      });
    }

    if (options.dryRun) {
      return {
        platform: 'instagram-reels',
        status: 'dry-run',
        remoteId: null,
        url: null,
        attempts: 0,
        messages: [
          `POST /${this.config.igUserId}/media (media_type=REELS)`,
          'GET /{container-id}?fields=status_code (poll until FINISHED)',
          `POST /${this.config.igUserId}/media_publish`,
        ],
        warnings: input.scheduleAt ? ['예약 발행은 Graph API가 10분~75일 범위만 허용합니다'] : [],
        startedAt,
        finishedAt: this.now().toISOString(),
      };
    }

    const quota = await this.getPublishingQuota().catch(() => null);
    if (quota && quota.quotaUsage >= quota.quotaTotal) {
      throw new ShortformError(`Instagram publishing quota used up (${quota.quotaUsage}/${quota.quotaTotal})`, {
        code: 'RATE_LIMIT',
        details: quota,
      });
    }

    const containerId = await this.createContainer(input);
    messages.push(`container created: ${containerId}`);

    await this.waitForContainer(containerId);
    messages.push('container status: FINISHED');

    const mediaId = await this.publishContainer(containerId);
    messages.push(`published: ${mediaId}`);

    const permalink = await this.getPermalink(mediaId).catch(() => null);

    return {
      platform: 'instagram-reels',
      status: 'published',
      remoteId: mediaId,
      url: permalink,
      attempts: 1,
      messages,
      warnings,
      startedAt,
      finishedAt: this.now().toISOString(),
    };
  }
}

/** Helper used by the CLI to show what will be sent without sending it. */
export function describeInstagramRequest(config: InstagramConfig, input: InstagramReelInput): string {
  const version = config.apiVersion ?? process.env.IG_GRAPH_VERSION ?? 'v21.0';
  const base = config.baseUrl ?? 'https://graph.facebook.com';
  return [
    `POST ${base}/${version}/${config.igUserId}/media`,
    `  media_type=REELS`,
    `  video_url=${input.videoUrl}`,
    `  caption=${round(input.caption.length, 0)} chars`,
    `  share_to_feed=${input.shareToFeed ?? true}`,
    `POST ${base}/${version}/${config.igUserId}/media_publish (creation_id=<container>)`,
  ].join('\n');
}
