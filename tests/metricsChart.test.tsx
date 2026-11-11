import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MetricsTimeSeriesChart } from '../src/studio/MetricsTimeSeriesChart';
import type { MetricsPoint } from '../src/studio/metricsTimeSeries';

const T0 = Date.parse('2026-11-11T03:00:00.000Z');

function series(length = 12): MetricsPoint[] {
  return Array.from({ length }, (_, index) => ({
    at: T0 + index * 5_000,
    throughputPerSec: 0.5 + index * 0.25,
    failureRate: index > 8 ? 0.2 : 0,
    completed: index * 3,
    failed: index > 8 ? 1 : 0,
    dlq: 0,
    waiting: 2,
    active: 1,
    tokens: { meta: 30 - index, youtube: 18 - index },
    capacity: { meta: 60, youtube: 40 },
  }));
}

describe('MetricsTimeSeriesChart (React)', () => {
  it('같은 기하로 SVG를 그린다(문자열 렌더러와 동일한 path)', () => {
    const markup = renderToStaticMarkup(<MetricsTimeSeriesChart series={series()} width={720} height={240} />);
    expect(markup).toContain('<svg');
    expect(markup).toContain('data-testid="metrics-time-series-chart"');
    expect(markup).toContain('role="img"');
    expect(markup.match(/<path/g)).toHaveLength(6); // 처리량·실패율은 면적+선, 토큰 2개는 선만
    expect(markup).toContain('처리량 · 편/초');
    expect(markup).toContain('레이트 리밋 잔여 토큰');
    expect(markup).toContain('3.25/s');
    expect(markup).toContain('20.0%');
  });

  it('aria-label로 마지막 상태를 읽어 준다', () => {
    const markup = renderToStaticMarkup(<MetricsTimeSeriesChart series={series()} />);
    expect(markup).toContain('처리량 3.25/초');
    expect(markup).toContain('YouTube 토큰 7');
  });

  it('샘플이 부족하면 빈 상태 문구만 렌더한다', () => {
    const markup = renderToStaticMarkup(<MetricsTimeSeriesChart series={series(1)} />);
    expect(markup).not.toContain('<svg');
    expect(markup).toContain('샘플이 2개 이상');
  });
});
