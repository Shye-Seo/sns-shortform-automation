import type { QueueCounts } from '../types/queue';

/**
 * 렌더 큐 시계열 메트릭 — "지금 몇 편/초로 처리 중이고, 실패율은 얼마이며, 플랫폼 토큰은 얼마나 남았나"
 *
 * 왜 스냅샷만으로는 부족한가
 * ------------------------
 * `StudioConsole.snapshot()`은 **현재 값**만 준다. 운영자가 새벽 3시에 알고 싶은 것은 현재 값이 아니라
 * 기울기다: 처리량이 떨어지고 있는지, 실패율이 튀는지, Meta 토큰이 바닥나서 발행이 막히기 직전인지.
 * 그 판단에는 "지난 5분"이 필요하고, 지난 5분은 어디에도 저장되어 있지 않다.
 *
 * 그래서 이 모듈은 스냅샷을 **고정 크기 링 버퍼**에 쌓고, 누적 카운터의 차분으로 초당 처리량과 실패율을
 * 계산한다. 저장소에 쓰지 않는 이유: 이건 운영 관측치이고, 프로세스가 죽으면 함께 사라지는 것이 맞다.
 * (장기 보관은 Prometheus가 한다 — 같은 숫자를 `toPrometheus()`로 노출한다)
 *
 * 왜 이산화(DOM 없이 문자열)인가
 * -----------------------------
 * 이 패키지에는 프론트엔드 프레임워크가 없다. 콘솔 HTML은 Node가 문자열로 만든다. 그래서 차트의
 * **기하 계산**을 순수 함수로 두고(`buildMetricsChart`), 두 개의 얇은 표현 계층을 그 위에 얹었다.
 *   · `renderMetricsTimeSeriesSvg` — 서버 렌더 HTML용 문자열 (의존성 0)
 *   · `MetricsTimeSeriesChart.tsx` — React 호스트가 임베드할 때 쓰는 컴포넌트
 * 같은 `buildMetricsChart`를 쓰므로 두 경로의 곡선이 달라질 수 없다.
 */

/* ------------------------------------------------------------------ */
/* 샘플 · 포인트                                                       */
/* ------------------------------------------------------------------ */

export interface RateLimitReading {
  provider: 'meta' | 'youtube';
  /** 남은 요청 버킷(토큰) 수 */
  remaining: number;
  capacity: number;
}

export interface MetricsSampleInput {
  /** 샘플 시각(ms). 주입 가능하게 둬서 테스트가 실제 시간을 기다리지 않는다 */
  at: number;
  counts: QueueCounts;
  /** 테넌트 스냅샷에서 뽑은 플랫폼별 잔여 토큰. 없으면 이전 값을 유지한다 */
  providers?: RateLimitReading[];
}

export interface MetricsPoint {
  at: number;
  /** 직전 샘플 대비 완료 편수 / 경과 초 */
  throughputPerSec: number;
  /** 직전 샘플의 종료 작업 중 실패(failed + dlq) 비율 0~1 */
  failureRate: number;
  completed: number;
  failed: number;
  dlq: number;
  waiting: number;
  active: number;
  tokens: { meta: number; youtube: number };
  capacity: { meta: number; youtube: number };
}

export interface MetricsSeriesView {
  points: MetricsPoint[];
  samples: number;
  windowMs: number;
  /** 데모용으로 만들어 넣은 이력인지. 화면에 그대로 표시한다 */
  seeded: boolean;
}

/* ------------------------------------------------------------------ */
/* 링 버퍼 + 차분 계산                                                  */
/* ------------------------------------------------------------------ */

export interface MetricsTimeSeriesOptions {
  /** 보관 샘플 수 상한. 기본 600 (5초 간격이면 50분) */
  capacity?: number;
  now?: () => number;
}

export class MetricsTimeSeries {
  private readonly buffer: MetricsPoint[] = [];
  private readonly capacity: number;
  private readonly now: () => number;
  private seeded = false;
  /** 토큰 값을 안 준 샘플에서도 그래프가 끊기지 않도록 마지막 값을 기억한다 */
  private lastTokens: { meta: number; youtube: number } | null = null;
  private lastCapacity: { meta: number; youtube: number } | null = null;

  constructor(options: MetricsTimeSeriesOptions = {}) {
    this.capacity = Math.max(2, options.capacity ?? 600);
    this.now = options.now ?? Date.now;
  }

  get samples(): number {
    return this.buffer.length;
  }

  /** 데모 이력으로 채웠는지 표시한다(운영자가 "진짜 데이터"로 오해하면 안 된다) */
  markSeeded(): void {
    this.seeded = true;
  }

  reset(): void {
    this.buffer.length = 0;
    this.seeded = false;
    this.lastTokens = null;
    this.lastCapacity = null;
  }

  record(input: MetricsSampleInput): MetricsPoint {
    const previous = this.buffer[this.buffer.length - 1];
    const at = Number.isFinite(input.at) ? input.at : this.now();
    const counts = input.counts;

    let throughputPerSec = 0;
    let failureRate = 0;
    if (previous) {
      const elapsedSec = Math.max(0, (at - previous.at) / 1_000);
      // 누적 카운터는 이론상 단조지만, 재시작·리셋·DLQ 재시도로 줄 수 있다. 줄어든 경우 0으로 본다.
      const completedDelta = Math.max(0, counts.completed - previous.completed);
      const failedDelta = Math.max(0, counts.failed + counts.dlq - (previous.failed + previous.dlq));
      throughputPerSec = elapsedSec > 0 ? round2(completedDelta / elapsedSec) : 0;
      const terminal = completedDelta + failedDelta;
      failureRate = terminal > 0 ? round4(failedDelta / terminal) : 0;
    }

    if (input.providers && input.providers.length > 0) {
      const totals = { meta: { remaining: 0, capacity: 0 }, youtube: { remaining: 0, capacity: 0 } };
      for (const reading of input.providers) {
        const bucket = totals[reading.provider];
        if (!bucket) continue;
        bucket.remaining += Math.max(0, reading.remaining);
        bucket.capacity += Math.max(0, reading.capacity);
      }
      this.lastTokens = { meta: totals.meta.remaining, youtube: totals.youtube.remaining };
      this.lastCapacity = { meta: totals.meta.capacity, youtube: totals.youtube.capacity };
    }

    const point: MetricsPoint = {
      at,
      throughputPerSec,
      failureRate,
      completed: counts.completed,
      failed: counts.failed,
      dlq: counts.dlq,
      waiting: counts.waiting,
      active: counts.active,
      tokens: { ...(this.lastTokens ?? { meta: 0, youtube: 0 }) },
      capacity: { ...(this.lastCapacity ?? { meta: 0, youtube: 0 }) },
    };

    this.buffer.push(point);
    while (this.buffer.length > this.capacity) this.buffer.shift();
    return point;
  }

  get series(): MetricsPoint[] {
    return this.buffer.map((point) => ({ ...point, tokens: { ...point.tokens }, capacity: { ...point.capacity } }));
  }

  view(): MetricsSeriesView {
    const points = this.series;
    return {
      points,
      samples: points.length,
      windowMs: points.length > 1 ? points[points.length - 1]!.at - points[0]!.at : 0,
      seeded: this.seeded,
    };
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 테넌트 스냅샷 → 플랫폼별 잔여 토큰 합계 */
export function rateLimitReadings(
  tenants: ReadonlyArray<{ providers: ReadonlyArray<{ provider: string; requestRemaining: number; requestCapacity: number }> }>,
): RateLimitReading[] {
  const readings: RateLimitReading[] = [];
  for (const tenant of tenants) {
    for (const provider of tenant.providers) {
      if (provider.provider !== 'meta' && provider.provider !== 'youtube') continue;
      readings.push({ provider: provider.provider, remaining: provider.requestRemaining, capacity: provider.requestCapacity });
    }
  }
  return readings;
}

/* ------------------------------------------------------------------ */
/* 차트 기하                                                           */
/* ------------------------------------------------------------------ */

export interface MetricsChartOptions {
  width?: number;
  height?: number;
  /** 시리즈를 몇 점으로 줄일지(기본 120). 점이 많아도 path 문자열 길이만 늘어난다 */
  maxPoints?: number;
  title?: string;
}

export interface ChartSeries {
  key: 'throughput' | 'failure' | 'meta' | 'youtube';
  row: 'throughput' | 'failure' | 'tokens';
  label: string;
  color: string;
  path: string;
  area: string | null;
  /** 마지막 값 표시(단위 포함) */
  lastLabel: string;
  /** 축 최대값 표시 */
  maxLabel: string;
  /** 범례에 넣을지(토큰은 두 줄이 한 행에 겹친다) */
  legend: boolean;
}

export interface ChartRow {
  key: 'throughput' | 'failure' | 'tokens';
  label: string;
  top: number;
  bottom: number;
  baselineY: number;
}

export interface ChartLegendItem {
  x: number;
  y: number;
  label: string;
  color: string;
}

export interface MetricsChart {
  width: number;
  height: number;
  left: number;
  right: number;
  rows: ChartRow[];
  series: ChartSeries[];
  legend: ChartLegendItem[];
  xLabels: { x: number; label: string }[];
  /** 행별 마지막 값 라벨 위치(오른쪽 여백에 붙는다) */
  valueLabels: { x: number; y: number; text: string; color: string }[];
  empty: boolean;
  ariaLabel: string;
}

const COLORS = {
  throughput: '#3fb950',
  failure: '#f85149',
  meta: '#d29922',
  youtube: '#58a6ff',
  axis: '#30363d',
  text: '#8b949e',
} as const;

const ROW_ORDER: ChartRow['key'][] = ['throughput', 'failure', 'tokens'];
const ROW_LABEL: Record<ChartRow['key'], string> = {
  throughput: '처리량 · 편/초',
  failure: '실패율',
  tokens: '레이트 리밋 잔여 토큰',
};

function chartRightPad(right: number): number {
  return right + 4;
}

/** 큰 배열을 균등 간격으로 줄인다. 첫·마지막 점은 반드시 남긴다(기울기의 끝이 판단의 핵심). */
export function downsample<T>(values: readonly T[], maxPoints: number): T[] {
  if (values.length <= maxPoints) return [...values];
  const step = (values.length - 1) / (maxPoints - 1);
  const output: T[] = [];
  for (let index = 0; index < maxPoints; index += 1) {
    output.push(values[Math.round(index * step)] as T);
  }
  return output;
}

function timeLabel(at: number, spanMs: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return spanMs < 10 * 60_000 ? `${clock}:${pad(date.getSeconds())}` : clock;
}

function linePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) return '';
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
}

function areaPath(points: Array<{ x: number; y: number }>, baselineY: number): string {
  if (points.length === 0) return '';
  const first = points[0] as { x: number; y: number };
  const last = points[points.length - 1] as { x: number; y: number };
  return `${linePath(points)} L${last.x.toFixed(1)},${baselineY.toFixed(1)} L${first.x.toFixed(1)},${baselineY.toFixed(1)} Z`;
}

/**
 * 기하 계산. 반환값은 좌표가 아니라 **SVG path 문자열**이라, 문자열 렌더러와 React 컴포넌트가
 * 같은 곡선을 그린다.
 */
export function buildMetricsChart(series: readonly MetricsPoint[], options: MetricsChartOptions = {}): MetricsChart {
  const width = Math.max(320, Math.round(options.width ?? 760));
  const height = Math.max(180, Math.round(options.height ?? 260));
  const left = 34;
  const right = width - 62;
  // 범례는 행 라벨(왼쪽)과 겹치지 않도록 상단 오른쪽에 둔다. header는 범례 높이를 포함한다.
  const header = 22;
  const rowGap = 10;
  const rowHeight = (height - header - rowGap * (ROW_ORDER.length - 1)) / ROW_ORDER.length;
  const points = downsample(series, Math.max(2, options.maxPoints ?? 120));
  const empty = points.length < 2;

  const rows: ChartRow[] = ROW_ORDER.map((key, index) => {
    const top = header + index * (rowHeight + rowGap);
    return { key, label: ROW_LABEL[key], top, bottom: top + rowHeight, baselineY: top + rowHeight - 4 };
  });
  const rowOf = (key: ChartRow['key']): ChartRow => rows.find((row) => row.key === key) as ChartRow;

  const first = points[0]?.at ?? 0;
  const last = points[points.length - 1]?.at ?? first + 1;
  const span = Math.max(1, last - first);
  const xFor = (at: number): number => left + ((at - first) / span) * (right - left);

  const maxThroughput = Math.max(1, ...points.map((point) => point.throughputPerSec));
  const maxTokens = Math.max(1, ...points.map((point) => Math.max(point.capacity.meta, point.capacity.youtube, point.tokens.meta, point.tokens.youtube)));

  const scaleY = (value: number, max: number, row: ChartRow): number => {
    const clamped = Math.max(0, Math.min(1, value / max));
    return row.baselineY - clamped * (row.baselineY - row.top - 2);
  };

  const build = (
    key: ChartSeries['key'],
    rowKey: ChartRow['key'],
    values: number[],
    max: number,
    color: string,
    label: string,
    lastLabel: string,
    maxLabel: string,
    legend: boolean,
    filled: boolean,
  ): ChartSeries => {
    const row = rowOf(rowKey);
    // 한 점만으로는 "추이"가 없다. 선을 그리지 않고 화면이 빈 상태 문구를 대신 보여 준다.
    const coords = empty
      ? []
      : points.map((point, index) => ({ x: xFor(point.at), y: scaleY(values[index] ?? 0, max, row) }));
    return {
      key,
      row: rowKey,
      label,
      color,
      path: linePath(coords),
      area: filled ? areaPath(coords, row.baselineY) : null,
      lastLabel,
      maxLabel,
      legend,
    };
  };

  const lastPoint = points[points.length - 1];

  const seriesOut: ChartSeries[] = [
    build(
      'throughput',
      'throughput',
      points.map((point) => point.throughputPerSec),
      maxThroughput,
      COLORS.throughput,
      '처리량',
      `${(lastPoint?.throughputPerSec ?? 0).toFixed(2)}/s`,
      `${maxThroughput.toFixed(1)}/s`,
      true,
      true,
    ),
    build(
      'failure',
      'failure',
      points.map((point) => point.failureRate),
      1,
      COLORS.failure,
      '실패율',
      `${((lastPoint?.failureRate ?? 0) * 100).toFixed(1)}%`,
      '100%',
      true,
      true,
    ),
    build(
      'meta',
      'tokens',
      points.map((point) => point.tokens.meta),
      maxTokens,
      COLORS.meta,
      'Meta',
      `${lastPoint?.tokens.meta ?? 0}/${lastPoint?.capacity.meta ?? 0}`,
      String(maxTokens),
      true,
      false,
    ),
    build(
      'youtube',
      'tokens',
      points.map((point) => point.tokens.youtube),
      maxTokens,
      COLORS.youtube,
      'YouTube',
      `${lastPoint?.tokens.youtube ?? 0}/${lastPoint?.capacity.youtube ?? 0}`,
      String(maxTokens),
      true,
      false,
    ),
  ];

  const xTicks = empty
    ? []
    : [0, Math.floor((points.length - 1) / 2), points.length - 1]
        .filter((index, position, all) => all.indexOf(index) === position)
        .map((index) => {
          const point = points[index] as MetricsPoint;
          return { x: xFor(point.at), label: timeLabel(point.at, span) };
        });

  const legendItems = seriesOut.filter((item) => item.legend);
  const legend: ChartLegendItem[] = legendItems.map((item, index) => ({
    x: right - (legendItems.length - index) * 76,
    y: 11,
    label: item.label,
    color: item.color,
  }));

  const valueLabels = seriesOut.map((item) => {
    const row = rowOf(item.row);
    return {
      x: chartRightPad(right),
      y: row.top + (item.key === 'youtube' ? 20 : 9),
      text: item.lastLabel,
      color: item.color,
    };
  });

  return {
    width,
    height,
    left,
    right,
    rows,
    series: seriesOut,
    legend,
    valueLabels,
    xLabels: xTicks,
    empty,
    ariaLabel:
      options.title ??
      `렌더 큐 시계열: 처리량 ${(lastPoint?.throughputPerSec ?? 0).toFixed(2)}/초, 실패율 ${((lastPoint?.failureRate ?? 0) * 100).toFixed(1)}%, Meta 토큰 ${lastPoint?.tokens.meta ?? 0}, YouTube 토큰 ${lastPoint?.tokens.youtube ?? 0}`,
  };
}

/* ------------------------------------------------------------------ */
/* 문자열 렌더러 (서버 HTML)                                            */
/* ------------------------------------------------------------------ */

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** SVG 스파크라인. 외부 라이브러리 없이 문자열로 만든다(콘솔 HTML이 self-contained). */
export function renderMetricsTimeSeriesSvg(series: readonly MetricsPoint[], options: MetricsChartOptions = {}): string {
  const chart = buildMetricsChart(series, options);
  if (chart.empty) {
    return `<div class="chart-empty">샘플이 2개 이상 쌓이면 추이가 그려집니다.</div>`;
  }

  const grid = chart.rows
    .map(
      (row) => `<line x1="${chart.left}" y1="${row.top}" x2="${chart.right}" y2="${row.top}" stroke="${COLORS.axis}" stroke-width="1" stroke-dasharray="2 4" />
      <line x1="${chart.left}" y1="${row.baselineY}" x2="${chart.right}" y2="${row.baselineY}" stroke="${COLORS.axis}" stroke-width="1" />
      <text x="4" y="${row.top + 9}" fill="${COLORS.text}" font-size="9">${escapeXml(row.label)}</text>`,
    )
    .join('\n');

  const curves = chart.series
    .map((item) => {
      if (!item.path) return '';
      const fill = item.area
        ? `<path d="${item.area}" fill="${item.color}" fill-opacity="0.12" stroke="none" />`
        : '';
      return `${fill}<path d="${item.path}" fill="none" stroke="${item.color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round" />`;
    })
    .join('\n');

  const labels = chart.legend
    .map(
      (item) =>
        `<g><rect x="${item.x}" y="${item.y - 7}" width="7" height="7" rx="2" fill="${item.color}" /><text x="${item.x + 11}" y="${item.y}" fill="${COLORS.text}" font-size="9">${escapeXml(item.label)}</text></g>`,
    )
    .join('');

  const rowLast = chart.valueLabels
    .map(
      (item) =>
        `<text x="${item.x}" y="${item.y}" fill="${item.color}" font-size="9" font-variant-numeric="tabular-nums">${escapeXml(item.text)}</text>`,
    )
    .join('');

  const ticks = chart.xLabels
    .map((tick) => `<text x="${tick.x}" y="${chart.height - 2}" fill="${COLORS.text}" font-size="8" text-anchor="middle">${escapeXml(tick.label)}</text>`)
    .join('');

  const lastPoint = series[series.length - 1];
  const peak = Math.max(0, ...series.map((item) => item.throughputPerSec));
  const windowMinutes = series.length > 1 ? ((series[series.length - 1]!.at - series[0]!.at) / 60_000).toFixed(1) : '0';

  return `<figure class="chart" data-metrics-chart="1">
<svg viewBox="0 0 ${chart.width} ${chart.height}" width="100%" height="${chart.height}" role="img" aria-label="${escapeXml(chart.ariaLabel)}" preserveAspectRatio="none">
  <title>${escapeXml(chart.ariaLabel)}</title>
  ${labels}
  ${grid}
  ${curves}
  ${rowLast}
  ${ticks}
</svg>
<figcaption>최근 ${windowMinutes}분 · ${series.length}개 샘플 · 현재 ${(lastPoint?.throughputPerSec ?? 0).toFixed(2)}/초 (피크 ${peak.toFixed(2)}/초) · 실패율 ${((lastPoint?.failureRate ?? 0) * 100).toFixed(1)}% · Meta 토큰 ${lastPoint?.tokens.meta ?? 0}/${lastPoint?.capacity.meta ?? 0} · YouTube ${lastPoint?.tokens.youtube ?? 0}/${lastPoint?.capacity.youtube ?? 0}</figcaption>
</figure>`;
}

/* ------------------------------------------------------------------ */
/* 터미널용 스파크라인                                                  */
/* ------------------------------------------------------------------ */

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

export function sparkline(values: readonly number[], width = 40): string {
  if (values.length === 0) return '';
  const sampled = downsample(values, Math.max(2, width));
  const max = Math.max(...sampled, 0.0001);
  return sampled.map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.max(0, Math.round((value / max) * (BLOCKS.length - 1))))]).join('');
}
