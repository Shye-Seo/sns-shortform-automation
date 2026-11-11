import { describe, expect, it } from 'vitest';
import {
  MetricsTimeSeries,
  buildMetricsChart,
  downsample,
  rateLimitReadings,
  renderMetricsTimeSeriesSvg,
  sparkline,
  type MetricsPoint,
} from '../src/studio/metricsTimeSeries';
import { createDemoStudio } from '../src/services/studio/demo';
import type { QueueCounts } from '../src/types/queue';

const T0 = Date.parse('2026-11-11T03:00:00.000Z');

function counts(overrides: Partial<QueueCounts> = {}): QueueCounts {
  return { waiting: 0, delayed: 0, active: 0, completed: 0, failed: 0, dlq: 0, ...overrides };
}

function point(at: number, overrides: Partial<MetricsPoint> = {}): MetricsPoint {
  return {
    at,
    throughputPerSec: 1,
    failureRate: 0,
    completed: 0,
    failed: 0,
    dlq: 0,
    waiting: 0,
    active: 0,
    tokens: { meta: 30, youtube: 20 },
    capacity: { meta: 60, youtube: 40 },
    ...overrides,
  };
}

describe('MetricsTimeSeries · 차분 계산', () => {
  it('첫 샘플은 비교 대상이 없으므로 0/0이다', () => {
    const series = new MetricsTimeSeries();
    const first = series.record({ at: T0, counts: counts({ completed: 5, waiting: 3 }) });
    expect(first.throughputPerSec).toBe(0);
    expect(first.failureRate).toBe(0);
    expect(first.waiting).toBe(3);
  });

  it('처리량은 직전 샘플 대비 완료 편수 / 경과 초다', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts({ completed: 0 }) });
    const second = series.record({ at: T0 + 2_000, counts: counts({ completed: 10 }) });
    expect(second.throughputPerSec).toBe(5);
  });

  it('실패율은 그 구간에서 끝난 작업 중 실패 비율이다', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts({ completed: 0, failed: 0, dlq: 0 }) });
    const second = series.record({ at: T0 + 1_000, counts: counts({ completed: 8, failed: 1, dlq: 1 }) });
    expect(second.failureRate).toBe(0.2);
    expect(second.throughputPerSec).toBe(8);
  });

  it('끝난 작업이 없던 구간의 실패율은 0으로 둔다(0으로 나누지 않는다)', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts({ completed: 4 }) });
    const second = series.record({ at: T0 + 500, counts: counts({ completed: 4 }) });
    expect(second.failureRate).toBe(0);
    expect(second.throughputPerSec).toBe(0);
  });

  it('카운터가 줄어들면(재시작·리셋) 음수가 아니라 0으로 본다', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts({ completed: 40, failed: 4 }) });
    const second = series.record({ at: T0 + 1_000, counts: counts({ completed: 2, failed: 0 }) });
    expect(second.throughputPerSec).toBe(0);
    expect(second.failureRate).toBe(0);
  });

  it('시각이 같으면 경과 초가 0이라 처리량을 0으로 둔다(무한대 금지)', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts({ completed: 0 }) });
    expect(series.record({ at: T0, counts: counts({ completed: 9 }) }).throughputPerSec).toBe(0);
  });

  it('플랫폼별 잔여 토큰을 테넌트 합계로 모으고, 값을 안 준 샘플은 마지막 값을 유지한다', () => {
    const series = new MetricsTimeSeries();
    const first = series.record({
      at: T0,
      counts: counts(),
      providers: [
        { provider: 'meta', remaining: 12, capacity: 30 },
        { provider: 'meta', remaining: 8, capacity: 30 },
        { provider: 'youtube', remaining: 4, capacity: 20 },
      ],
    });
    expect(first.tokens).toEqual({ meta: 20, youtube: 4 });
    expect(first.capacity).toEqual({ meta: 60, youtube: 20 });

    const second = series.record({ at: T0 + 1_000, counts: counts() });
    expect(second.tokens).toEqual({ meta: 20, youtube: 4 });
  });

  it('링 버퍼는 상한을 넘으면 가장 오래된 샘플을 버린다', () => {
    const series = new MetricsTimeSeries({ capacity: 3 });
    for (let index = 0; index < 5; index += 1) series.record({ at: T0 + index * 1_000, counts: counts({ completed: index }) });
    const view = series.view();
    expect(view.samples).toBe(3);
    expect(view.points.map((item) => item.at)).toEqual([T0 + 2_000, T0 + 3_000, T0 + 4_000]);
    expect(view.windowMs).toBe(2_000);
    expect(view.seeded).toBe(false);
  });

  it('reset과 markSeeded', () => {
    const series = new MetricsTimeSeries();
    series.record({ at: T0, counts: counts() });
    series.markSeeded();
    expect(series.view().seeded).toBe(true);
    series.reset();
    expect(series.view().samples).toBe(0);
    expect(series.view().seeded).toBe(false);
  });

  it('테넌트 스냅샷에서 플랫폼별 토큰만 뽑는다', () => {
    const readings = rateLimitReadings([
      {
        providers: [
          { provider: 'meta', requestRemaining: 3, requestCapacity: 30 },
          { provider: 'youtube', requestRemaining: 1, requestCapacity: 20 },
          { provider: 'tiktok', requestRemaining: 9, requestCapacity: 10 },
        ],
      },
      { providers: [{ provider: 'meta', requestRemaining: 2, requestCapacity: 30 }] },
    ]);
    expect(readings).toEqual([
      { provider: 'meta', remaining: 3, capacity: 30 },
      { provider: 'youtube', remaining: 1, capacity: 20 },
      { provider: 'meta', remaining: 2, capacity: 30 },
    ]);
  });
});

describe('차트 기하', () => {
  const series: MetricsPoint[] = Array.from({ length: 20 }, (_, index) =>
    point(T0 + index * 5_000, {
      throughputPerSec: 0.4 + index * 0.2,
      failureRate: index > 15 ? 0.25 : 0,
      tokens: { meta: 60 - index, youtube: 30 - index },
      capacity: { meta: 60, youtube: 40 },
    }),
  );

  it('점이 2개 미만이면 빈 차트로 표시한다', () => {
    const chart = buildMetricsChart([point(T0)]);
    expect(chart.empty).toBe(true);
    expect(chart.series.every((item) => item.path === '')).toBe(true);
    expect(renderMetricsTimeSeriesSvg([point(T0)])).toContain('chart-empty');
  });

  it('세 행과 네 시리즈(처리량·실패율·Meta·YouTube)를 만든다', () => {
    const chart = buildMetricsChart(series, { width: 800, height: 240 });
    expect(chart.rows.map((row) => row.key)).toEqual(['throughput', 'failure', 'tokens']);
    expect(chart.series.map((item) => item.key)).toEqual(['throughput', 'failure', 'meta', 'youtube']);
    expect(chart.empty).toBe(false);
  });

  it('path는 첫 점에서 시작하고 면적은 처리량·실패율에만 있다', () => {
    const chart = buildMetricsChart(series);
    for (const item of chart.series) {
      expect(item.path.startsWith('M')).toBe(true);
      expect(item.path.split('L')).toHaveLength(series.length);
    }
    expect(chart.series.find((item) => item.key === 'throughput')?.area).toContain('Z');
    expect(chart.series.find((item) => item.key === 'meta')?.area).toBeNull();
  });

  it('최대값은 각 행의 위쪽에, 0은 기준선에 붙는다', () => {
    const chart = buildMetricsChart(series);
    const throughput = chart.series.find((item) => item.key === 'throughput');
    const row = chart.rows.find((item) => item.key === 'throughput');
    const ys = (throughput?.path ?? '')
      .split('L')
      .map((segment) => Number(segment.replace(/^M/, '').split(',')[1]));
    expect(Math.min(...ys)).toBeGreaterThanOrEqual((row?.top ?? 0) - 0.1);
    expect(Math.min(...ys)).toBeLessThan((row?.baselineY ?? 0) - 5);
    expect(Math.max(...ys)).toBeLessThanOrEqual(row?.baselineY ?? 0);
  });

  it('마지막 값 라벨과 시간축 라벨을 만든다', () => {
    const chart = buildMetricsChart(series);
    expect(chart.series.find((item) => item.key === 'throughput')?.lastLabel).toBe('4.20/s');
    expect(chart.series.find((item) => item.key === 'failure')?.lastLabel).toBe('25.0%');
    expect(chart.series.find((item) => item.key === 'meta')?.lastLabel).toBe('41/60');
    expect(chart.xLabels).toHaveLength(3);
    expect(chart.xLabels[0]?.label).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it('aria-label은 마지막 상태를 문장으로 담는다(스크린리더가 그림 대신 읽는다)', () => {
    const chart = buildMetricsChart(series);
    expect(chart.ariaLabel).toContain('처리량 4.20/초');
    expect(chart.ariaLabel).toContain('실패율 25.0%');
  });

  it('다운샘플링은 첫·마지막 점을 보존한다', () => {
    const values = Array.from({ length: 1_000 }, (_, index) => index);
    const sampled = downsample(values, 100);
    expect(sampled).toHaveLength(100);
    expect(sampled[0]).toBe(0);
    expect(sampled[sampled.length - 1]).toBe(999);
    expect(downsample([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('SVG 문자열은 self-contained이고 라벨을 이스케이프한다', () => {
    const svg = renderMetricsTimeSeriesSvg(series, { title: '<script>alert(1)</script>' });
    expect(svg).toContain('data-metrics-chart="1"');
    expect(svg).toContain('<svg');
    expect(svg).toContain('figcaption');
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&lt;script&gt;');
    expect(svg).toContain('최근 1.6분');
  });
});

describe('터미널 스파크라인', () => {
  it('값이 커지면 더 높은 블록을 쓴다', () => {
    const line = sparkline([0, 1, 2, 3, 4, 8], 6);
    expect(line).toHaveLength(6);
    expect(line[0]).toBe('▁');
    expect(line[line.length - 1]).toBe('█');
    expect(sparkline([])).toBe('');
  });
});

describe('스튜디오 콘솔 연동', () => {
  it('스냅샷이 샘플을 쌓고, HTML·텍스트·Prometheus가 같은 숫자를 쓴다', async () => {
    const studio = await createDemoStudio();
    const snapshot = await studio.console.snapshot();

    expect(snapshot.metrics).toBeDefined();
    expect(snapshot.metrics?.seeded).toBe(true);
    expect(snapshot.metrics?.points.length).toBe(61); // 데모 이력 60 + 이번 스냅샷 1
    const last = snapshot.metrics?.points.at(-1);
    expect(last?.tokens.meta).toBeGreaterThan(0);
    // 이력의 마지막 값은 실제 테넌트 토큰과 이어진다(오른쪽 끝에서 값이 튀지 않는다)
    const seededLast = snapshot.metrics?.points.at(-2);
    expect(seededLast?.tokens.meta).toBe(last?.tokens.meta);
    expect(seededLast?.capacity.meta).toBe(last?.capacity.meta);

    const html = studio.console.renderHtml(snapshot);
    expect(html).toContain('data-metrics-chart="1"');
    expect(html).toContain('demo history');

    const text = studio.console.renderText(snapshot);
    expect(text).toContain('TREND');
    expect(text).toContain('(demo)');

    const prometheus = studio.console.toPrometheus(snapshot);
    expect(prometheus).toContain('shortform_render_throughput_per_sec');
    expect(prometheus).toContain('shortform_rate_limit_tokens_remaining{provider="meta"}');
  });

  it('메트릭을 주입하지 않으면 스냅샷에 없고, 페이지도 빈 차트를 그리지 않는다', async () => {
    const studio = await createDemoStudio();
    const bare = new (studio.console.constructor as new (options: { queue: typeof studio.queue; tenants: typeof studio.tenants }) => typeof studio.console)({
      queue: studio.queue,
      tenants: studio.tenants,
    });
    const snapshot = await bare.snapshot();
    expect(snapshot.metrics).toBeUndefined();
    expect(bare.renderHtml(snapshot)).toContain('chart-empty');
  });
});
