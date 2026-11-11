import { describe, expect, it, vi } from 'vitest';
import { OAuthRefreshError, OAuthTokenRotator, PROVIDER_OF } from '../src/lib/rateLimit/oauth';

const START = Date.parse('2026-11-11T00:00:00.000Z');

function setup(options: { refreshAheadMs?: number } = {}) {
  let now = START;
  let counter = 0;
  const refresher = vi.fn(async (_input: { refreshToken: string }) => {
    counter += 1;
    return {
      accessToken: `access-${counter}`,
      refreshToken: `refresh-${counter}`,
      expiresInSec: 3_600,
      scopes: ['instagram_content_publish'],
    };
  });
  const rotator = new OAuthTokenRotator({
    refresher,
    now: () => now,
    refreshAheadMs: options.refreshAheadMs ?? 5 * 60 * 1_000,
  });
  return {
    rotator,
    refresher,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

describe('multi-tenant OAuth rotation', () => {
  it('reuses a valid access token without calling the provider', async () => {
    const h = setup();
    h.rotator.register({
      tenantId: 't1',
      platform: 'instagram-reels',
      refreshToken: 'refresh-0',
      accessToken: 'access-initial',
      expiresAtMs: START + 60 * 60 * 1_000,
    });
    const lease = await h.rotator.getAccessToken('t1', 'instagram-reels');
    expect(lease).toMatchObject({ accessToken: 'access-initial', refreshed: false });
    expect(h.refresher).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and stores the new expiry', async () => {
    const h = setup();
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'refresh-0' });
    const lease = await h.rotator.getAccessToken('t1', 'instagram-reels');
    expect(lease.refreshed).toBe(true);
    expect(lease.accessToken).toBe('access-1');
    expect(lease.expiresAtMs).toBe(START + 3_600_000);
    expect(h.refresher).toHaveBeenCalledTimes(1);
  });

  it('refreshes ahead of expiry inside the skew window', async () => {
    const h = setup({ refreshAheadMs: 300_000 });
    h.rotator.register({
      tenantId: 't1',
      platform: 'youtube-shorts',
      refreshToken: 'refresh-0',
      accessToken: 'old',
      expiresAtMs: START + 120_000,
    });
    const lease = await h.rotator.getAccessToken('t1', 'youtube-shorts');
    expect(lease.refreshed).toBe(true);
  });

  it('collapses concurrent refreshes into one provider call', async () => {
    const h = setup();
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'refresh-0' });
    const leases = await Promise.all(
      Array.from({ length: 8 }, () => h.rotator.getAccessToken('t1', 'instagram-reels')),
    );
    expect(h.refresher).toHaveBeenCalledTimes(1);
    expect(new Set(leases.map((lease) => lease.accessToken)).size).toBe(1);
  });

  it('uses the rotated refresh token on the next refresh', async () => {
    const h = setup();
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'refresh-0' });
    await h.rotator.getAccessToken('t1', 'instagram-reels');
    h.advance(3_600_000);
    await h.rotator.getAccessToken('t1', 'instagram-reels');
    const tokens = h.refresher.mock.calls.map((call) => (call[0] as { refreshToken: string }).refreshToken);
    expect(tokens).toEqual(['refresh-0', 'refresh-1']);
  });

  it('marks the credential needs-reauth on a permanent error and stops calling the provider', async () => {
    const h = setup();
    h.refresher.mockRejectedValueOnce(new OAuthRefreshError('invalid_grant', true));
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'revoked' });
    await expect(h.rotator.getAccessToken('t1', 'instagram-reels')).rejects.toThrow(/invalid_grant/);
    await expect(h.rotator.getAccessToken('t1', 'instagram-reels')).rejects.toThrow(/needs re-authorisation/);
    expect(h.refresher).toHaveBeenCalledTimes(1);
    expect(h.rotator.snapshot()[0].status).toBe('needs-reauth');
  });

  it('keeps a transient failure retryable and does not revoke the credential', async () => {
    const h = setup();
    h.refresher.mockRejectedValueOnce(new OAuthRefreshError('503 from token endpoint', false));
    h.rotator.register({ tenantId: 't1', platform: 'youtube-shorts', refreshToken: 'refresh-0' });
    await expect(h.rotator.getAccessToken('t1', 'youtube-shorts')).rejects.toThrow(/503/);
    expect(h.rotator.snapshot()[0].status).not.toBe('needs-reauth');
    const lease = await h.rotator.getAccessToken('t1', 'youtube-shorts');
    expect(lease.accessToken).toBe('access-1');
  });

  it('isolates tenants and platforms from each other', async () => {
    const h = setup();
    h.refresher.mockRejectedValueOnce(new OAuthRefreshError('invalid_grant', true));
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'bad' });
    h.rotator.register({ tenantId: 't2', platform: 'instagram-reels', refreshToken: 'good' });
    await expect(h.rotator.getAccessToken('t1', 'instagram-reels')).rejects.toThrow();
    const other = await h.rotator.getAccessToken('t2', 'instagram-reels');
    expect(other.accessToken).toBe('access-1');
    expect(h.rotator.snapshot().find((entry) => entry.tenantId === 't1')?.status).toBe('needs-reauth');
  });

  it('refreshes each platform separately for the same tenant', async () => {
    const h = setup();
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'refresh-ig' });
    h.rotator.register({ tenantId: 't1', platform: 'youtube-shorts', refreshToken: 'refresh-yt' });
    await h.rotator.getAccessToken('t1', 'instagram-reels');
    await h.rotator.getAccessToken('t1', 'youtube-shorts');
    expect(h.refresher).toHaveBeenCalledTimes(2);
  });

  it('reports refresh counts, rotation and expiry in a snapshot without leaking secrets', async () => {
    const h = setup();
    h.rotator.register({
      tenantId: 't1',
      platform: 'instagram-reels',
      refreshToken: 'secret-refresh',
      accessToken: 'secret-access',
      expiresAtMs: START + 3_600_000,
      scopes: ['instagram_basic'],
    });
    const snapshot = h.rotator.snapshot()[0];
    expect(snapshot).toMatchObject({
      tenantId: 't1',
      platform: 'instagram-reels',
      status: 'active',
      refreshCount: 0,
      hasRefreshToken: true,
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-refresh');
    expect(JSON.stringify(snapshot)).not.toContain('secret-access');
  });

  it('reports an expired status when the token aged out without a call', () => {
    const h = setup();
    h.rotator.register({
      tenantId: 't1',
      platform: 'instagram-reels',
      refreshToken: 'r',
      accessToken: 'a',
      expiresAtMs: START + 1_000,
    });
    h.advance(2_000);
    expect(h.rotator.snapshot()[0].status).toBe('expired');
  });

  it('marks a credential needs-reauth on demand and revokes on request', () => {
    const h = setup();
    h.rotator.register({ tenantId: 't1', platform: 'instagram-reels', refreshToken: 'r' });
    h.rotator.markNeedsReauth('t1', 'instagram-reels', 'admin revoked');
    expect(h.rotator.snapshot()[0].status).toBe('needs-reauth');
    h.rotator.revoke('t1', 'instagram-reels');
    expect(h.rotator.has('t1', 'instagram-reels')).toBe(false);
  });

  it('rejects a refresh when no credential is registered', async () => {
    const h = setup();
    await expect(h.rotator.getAccessToken('ghost', 'instagram-reels')).rejects.toThrow(/no credential/);
  });

  it('maps publishing platforms to provider quotas', () => {
    expect(PROVIDER_OF['instagram-reels']).toBe('meta');
    expect(PROVIDER_OF['youtube-shorts']).toBe('youtube');
  });
});
