import type { JSX } from 'react';
import { buildMetricsChart, type MetricsChartOptions, type MetricsPoint } from './metricsTimeSeries';

/**
 * 실시간 렌더 큐 시계열 차트 (React)
 *
 * 이 파일은 **React 호스트에 임베드할 때** 쓰는 표현 계층이다. 이 패키지의 기본 콘솔은 Node가 문자열로
 * HTML을 만들므로 React에 의존하지 않고, 같은 그림을 `renderMetricsTimeSeriesSvg()`가 그린다.
 * 두 경로는 모두 `buildMetricsChart()`의 path 문자열을 쓰므로 곡선·축·라벨이 어긋날 수 없다.
 *
 * 왜 SVG를 직접 그리나
 * -------------------
 * 차트 라이브러리(recharts 등)를 넣으면 이 패키지에 브라우저 번들 크기와 React 버전 결합이 따라온다.
 * 여기서 필요한 것은 선 3~4개와 축뿐이고, 점이 600개를 넘어도 path 문자열 하나면 충분하다.
 * (다운샘플링은 `buildMetricsChart`가 한다)
 */

export interface MetricsTimeSeriesChartProps extends MetricsChartOptions {
  series: readonly MetricsPoint[];
}

const AXIS = '#30363d';
const TEXT = '#8b949e';

export function MetricsTimeSeriesChart({ series, ...options }: MetricsTimeSeriesChartProps): JSX.Element {
  const chart = buildMetricsChart(series, options);

  if (chart.empty) {
    return (
      <div role="status" style={{ color: TEXT, fontSize: 12 }}>
        샘플이 2개 이상 쌓이면 추이가 그려집니다.
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${chart.width} ${chart.height}`}
      width="100%"
      height={chart.height}
      role="img"
      aria-label={chart.ariaLabel}
      preserveAspectRatio="none"
      data-testid="metrics-time-series-chart"
    >
      <title>{chart.ariaLabel}</title>

      {chart.rows.map((row) => (
        <g key={row.key}>
          <line x1={chart.left} y1={row.top} x2={chart.right} y2={row.top} stroke={AXIS} strokeWidth={1} strokeDasharray="2 4" />
          <line x1={chart.left} y1={row.baselineY} x2={chart.right} y2={row.baselineY} stroke={AXIS} strokeWidth={1} />
          <text x={4} y={row.top + 9} fill={TEXT} fontSize={9}>
            {row.label}
          </text>
        </g>
      ))}

      {chart.series.map((item) => (
        <g key={item.key}>
          {item.area ? <path d={item.area} fill={item.color} fillOpacity={0.12} stroke="none" /> : null}
          {item.path ? (
            <path d={item.path} fill="none" stroke={item.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
          ) : null}
          <text
            x={chart.right + 4}
            y={(chart.rows.find((row) => row.key === item.row)?.top ?? 0) + (item.key === 'youtube' ? 20 : 9)}
            fill={item.color}
            fontSize={9}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            {item.lastLabel}
          </text>
        </g>
      ))}

      {chart.legend.map((item) => (
        <g key={`legend-${item.label}`}>
          <rect x={item.x} y={item.y - 7} width={7} height={7} rx={2} fill={item.color} />
          <text x={item.x + 11} y={item.y} fill={TEXT} fontSize={9}>
            {item.label}
          </text>
        </g>
      ))}

      {chart.xLabels.map((tick) => (
        <text key={tick.x} x={tick.x} y={chart.height - 2} fill={TEXT} fontSize={8} textAnchor="middle">
          {tick.label}
        </text>
      ))}
    </svg>
  );
}

export default MetricsTimeSeriesChart;
