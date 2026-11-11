import { z } from 'zod';
import { ShortformError } from '../errors';

export const OAuthPlatformSchema = z.enum(['instagram-reels', 'youtube-shorts']);
export type OAuthPlatform = z.infer<typeof OAuthPlatformSchema>;

export const PROVIDER_OF: Record<OAuthPlatform, 'meta' | 'youtube'> = {
  'instagram-reels': 'meta',
  'youtube-shorts': 'youtube',
};

export interface OAuthCredentialInput {
  tenantId: string;
  platform: OAuthPlatform;
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms. Omitted means "assume expired and refresh now". */
  expiresAtMs?: number;
  scopes?: string[];
}

export interface TokenLease {
  accessToken: string;
  expiresAtMs: number;
  /** True when this call is the one that hit the token endpoint. */
  refreshed: boolean;
}

export interface RotationEvent {
  at: string;
  tenantId: string;
  platform: OAuthPlatform;
  outcome: 'reused' | 'refreshed' | 'failed';
  reason?: string;
}

export type OAuthStatus = 'active' | 'expired' | 'needs-reauth';

export interface CredentialSnapshot {
  tenantId: string;
  platform: OAuthPlatform;
  status: OAuthStatus;
  expiresInMs: number;
  refreshCount: number;
  lastRefreshedAt: string | null;
  /** When the provider last rotated the refresh token itself. */
  lastRotatedAt: string | null;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  scopes: string[];
}

/**
 * `permanent` separates "the network hiccuped, retry" from "the user changed
 * their password / revoked the app, a human must reconnect". Retrying the
 * second kind is how a queue burns a tenant's whole daily quota on 401s.
 */
export class OAuthRefreshError extends ShortformError {
  constructor(
    message: string,
    readonly permanent: boolean,
    details: Record<string, unknown> = {},
  ) {
    super(message, { code: 'EXTERNAL', retryable: !permanent, details });
    this.name = 'OAuthRefreshError';
  }
}

export interface RefreshResult {
  accessToken: string;
  /** Providers that rotate the refresh token return a new one each time. */
  refreshToken?: string;
  expiresInSec: number;
  scopes?: string[];
}

export type TokenRefresher = (input: {
  tenantId: string;
  platform: OAuthPlatform;
  refreshToken: string;
}) => Promise<RefreshResult>;

interface CredentialState {
  tenantId: string;
  platform: OAuthPlatform;
  refreshToken: string;
  accessToken?: string;
  expiresAtMs: number;
  scopes: string[];
  status: OAuthStatus;
  refreshCount: number;
  lastRefreshedAt: number | null;
  lastRotatedAt: number | null;
}

export interface TokenRotatorOptions {
  refresher: TokenRefresher;
  now?: () => number;
  /** Refresh this long before expiry so a slow token call never races a publish. */
  refreshAheadMs?: number;
}

/**
 * Multi-tenant OAuth 2.0 credential vault with single-flight refresh and
 * refresh-token rotation.
 *
 * The failure mode this exists for: 30 scheduled posts fire at 09:00, each
 * finds an expired access token, each calls the token endpoint, and the
 * provider invalidates the first 29 refresh tokens as "reused". Single-flight
 * collapses those 30 calls into one, and rotation stores the refresh token the
 * provider hands back before any other caller can read the old one.
 */
export class OAuthTokenRotator {
  private readonly refresher: TokenRefresher;
  private readonly now: () => number;
  private readonly refreshAheadMs: number;
  private readonly credentials = new Map<string, CredentialState>();
  private readonly inflight = new Map<string, Promise<TokenLease>>();
  private readonly log: RotationEvent[] = [];

  constructor(options: TokenRotatorOptions) {
    this.refresher = options.refresher;
    this.now = options.now ?? Date.now;
    this.refreshAheadMs = options.refreshAheadMs ?? 5 * 60 * 1_000;
  }

  private key(tenantId: string, platform: OAuthPlatform): string {
    return `${tenantId}::${platform}`;
  }

  register(input: OAuthCredentialInput): void {
    if (!input.refreshToken) {
      throw new ShortformError('refreshToken is required', {
        code: 'CONFIG',
        details: { tenantId: input.tenantId, platform: input.platform },
      });
    }
    this.credentials.set(this.key(input.tenantId, input.platform), {
      tenantId: input.tenantId,
      platform: input.platform,
      refreshToken: input.refreshToken,
      accessToken: input.accessToken,
      expiresAtMs: input.expiresAtMs ?? 0,
      scopes: input.scopes ?? [],
      status: 'active',
      refreshCount: 0,
      lastRefreshedAt: null,
      lastRotatedAt: null,
    });
  }

  has(tenantId: string, platform: OAuthPlatform): boolean {
    return this.credentials.has(this.key(tenantId, platform));
  }

  /**
   * A valid access token, refreshing at most once per credential even when
   * called concurrently. Callers never see the refresh token.
   */
  async getAccessToken(tenantId: string, platform: OAuthPlatform): Promise<TokenLease> {
    const state = this.credentials.get(this.key(tenantId, platform));
    if (!state) {
      throw new OAuthRefreshError(`no credential registered for tenant ${tenantId} / ${platform}`, true, {
        tenantId,
        platform,
      });
    }
    if (state.status === 'needs-reauth') {
      throw new OAuthRefreshError(`credential for ${tenantId} / ${platform} needs re-authorisation`, true, {
        tenantId,
        platform,
      });
    }
    if (state.accessToken && state.expiresAtMs - this.now() > this.refreshAheadMs) {
      this.record('reused', state);
      return { accessToken: state.accessToken, expiresAtMs: state.expiresAtMs, refreshed: false };
    }
    return this.refresh(state);
  }

  private async refresh(state: CredentialState): Promise<TokenLease> {
    const key = this.key(state.tenantId, state.platform);
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const task = (async (): Promise<TokenLease> => {
      try {
        const result = await this.refresher({
          tenantId: state.tenantId,
          platform: state.platform,
          refreshToken: state.refreshToken,
        });
        if (!result.accessToken) {
          throw new OAuthRefreshError('token endpoint returned no access token', false, {
            tenantId: state.tenantId,
            platform: state.platform,
          });
        }
        const at = this.now();
        state.accessToken = result.accessToken;
        // Rotation: the new refresh token must land before the old one is used again.
        if (result.refreshToken && result.refreshToken !== state.refreshToken) {
          state.refreshToken = result.refreshToken;
          state.lastRotatedAt = at;
        }
        if (result.scopes?.length) state.scopes = result.scopes;
        state.expiresAtMs = at + Math.max(0, result.expiresInSec) * 1_000;
        state.refreshCount += 1;
        state.lastRefreshedAt = at;
        state.status = 'active';
        this.record('refreshed', state);
        return { accessToken: state.accessToken, expiresAtMs: state.expiresAtMs, refreshed: true };
      } catch (error) {
        if (error instanceof OAuthRefreshError && error.permanent) {
          state.status = 'needs-reauth';
          this.record('failed', state, error.message);
        } else {
          this.record('failed', state, error instanceof Error ? error.message : String(error));
        }
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, task);
    return task;
  }

  markNeedsReauth(tenantId: string, platform: OAuthPlatform, reason = 'revoked by operator'): void {
    const state = this.credentials.get(this.key(tenantId, platform));
    if (!state) return;
    state.status = 'needs-reauth';
    state.accessToken = undefined;
    state.expiresAtMs = 0;
    this.record('failed', state, reason);
  }

  revoke(tenantId: string, platform: OAuthPlatform): void {
    this.credentials.delete(this.key(tenantId, platform));
  }

  get events(): RotationEvent[] {
    return [...this.log];
  }

  snapshot(): CredentialSnapshot[] {
    return [...this.credentials.values()].map((state) => ({
      tenantId: state.tenantId,
      platform: state.platform,
      status: state.status === 'active' && state.expiresAtMs <= this.now() ? 'expired' : state.status,
      expiresInMs: Math.max(0, state.expiresAtMs - this.now()),
      refreshCount: state.refreshCount,
      lastRefreshedAt: state.lastRefreshedAt ? new Date(state.lastRefreshedAt).toISOString() : null,
      lastRotatedAt: state.lastRotatedAt ? new Date(state.lastRotatedAt).toISOString() : null,
      hasAccessToken: Boolean(state.accessToken),
      hasRefreshToken: Boolean(state.refreshToken),
      scopes: [...state.scopes],
    }));
  }

  private record(outcome: RotationEvent['outcome'], state: CredentialState, reason?: string): void {
    this.log.push({
      at: new Date(this.now()).toISOString(),
      tenantId: state.tenantId,
      platform: state.platform,
      outcome,
      reason,
    });
  }
}
