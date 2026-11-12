import type { CSSProperties, JSX } from "react";
import type {
  DispatchCycleReport,
  FunnelReport,
  IngestReport,
  InteractiveCampaign,
  StormReport,
} from "../core/interactiveCouponDispatcher";

/**
 * 숏폼 실시간 댓글 웹훅 & 즉시 쿠폰 디스패치 콘솔 (React)
 *
 * 이 컴포넌트는 **표현 계층**이다. 판정은 전부 `interactiveCouponDispatcher.ts`가 하고, 여기서는
 * 이미 계산된 리포트(웹훅 집계·5초 SLA·퍼널·ROAS)를 그린다. 그래서 데모 화면의 숫자와 테스트가
 * 검증하는 숫자가 같은 함수에서 나온다.
 *
 * 왜 차트 라이브러리를 안 쓰나
 * ---------------------------
 * 필요한 것은 막대 몇 개와 게이지뿐이다. 라이브러리를 넣으면 이 패키지에 브라우저 번들과 React
 * 버전 결합이 따라오고, Node 콘솔(`services/studio/console.ts`)이 그리는 그림과도 어긋난다.
 */

export interface InteractivePromotionConsoleProps {
  campaign: InteractiveCampaign;
  ingest?: IngestReport | null;
  dispatch?: DispatchCycleReport | null;
  funnel: FunnelReport;
  storm?: StormReport | null;
  deadLetters?: Array<{ id: number; recipient: string; error: string; attempts: number }>;
  onRunStorm?: () => void;
}

const BG = "#0A0F1C";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT = "#e2e8f0";
const MUTED = "#8b949e";
const ACCENT = "#34d399";

const won = (value: number): string => `${Math.round(value).toLocaleString("ko-KR")}원`;
const pct = (value: number): string => `${value.toFixed(1)}%`;

export function InteractivePromotionConsole({
  campaign,
  ingest,
  dispatch,
  funnel,
  storm,
  deadLetters = [],
  onRunStorm,
}: InteractivePromotionConsoleProps): JSX.Element {
  const sla = dispatch ? dispatch.slaCompliance * 100 : 100;
  const slaTone = sla >= 99 ? ACCENT : sla >= 90 ? "#fbbf24" : "#fb7185";

  return (
    <section
      style={{
        background: BG,
        color: TEXT,
        border: `1px solid ${BORDER}`,
        borderRadius: 14,
        padding: 20,
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif',
      }}
    >
      <header style={{ marginBottom: 16 }}>
        <p style={{ margin: 0, fontSize: 11, letterSpacing: "0.18em", color: ACCENT, textTransform: "uppercase" }}>
          Shortform Drop
        </p>
        <h2 style={{ margin: "4px 0 0", fontSize: 18, fontWeight: 600 }}>
          {campaign.code} · 댓글 → 5초 쿠폰
        </h2>
        <p style={{ margin: "4px 0 0", fontSize: 12, color: MUTED }}>
          트리거 키워드 {campaign.triggerKeywords.join(" · ")} · {campaign.rewardLabel} · 1회용 링크{" "}
          {campaign.tokenTtlMinutes}분
        </p>
      </header>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gap: 1,
          background: BORDER,
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <Kpi
          label="웹훅 접수"
          value={(ingest?.received ?? 0).toLocaleString("ko-KR")}
          hint={`수락 ${ingest?.accepted ?? 0} · 중복 ${ingest?.duplicates ?? 0}`}
        />
        <Kpi
          label="발송 (DISPATCHED)"
          value={(dispatch?.dispatched ?? 0).toLocaleString("ko-KR")}
          hint={`재시도 ${dispatch?.retried ?? 0} · DLQ ${dispatch?.deadLettered ?? 0}`}
        />
        <Kpi label="5초 SLA" value={pct(sla)} hint={sla >= 99 ? "데드라인 준수" : "지연 발생 — DLQ 확인"} tone={slaTone} />
        <Kpi label="ROAS" value={`${funnel.roas.toFixed(2)}x`} hint={`매출 ${won(funnel.revenue)} / 원가 ${won(funnel.rewardCost)}`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 12, marginTop: 12 }}>
        <Panel title="퍼널" hint="댓글 → 클릭 → 수령 → 구매">
          <Funnel funnel={funnel} />
        </Panel>

        <Panel title="어뷰징·중복" hint="차단은 예산을 쓰지 않는다">
          <Bar label="웹훅 중복" value={ingest?.duplicates ?? 0} total={Math.max(1, ingest?.received ?? 1)} tone="#60a5fa" />
          <Bar label="어뷰징 차단" value={ingest?.abuseBlocked ?? 0} total={Math.max(1, ingest?.received ?? 1)} tone="#fb7185" />
          <Bar label="키워드 불일치" value={ingest?.ignored ?? 0} total={Math.max(1, ingest?.received ?? 1)} tone="#a1a1aa" />
          <p style={{ margin: "8px 0 0", fontSize: 11, color: MUTED }}>
            발급 한도 {campaign.claimLimit.toLocaleString("ko-KR")}장 · 예산 {won(campaign.totalRewardBudget)}
          </p>
        </Panel>
      </div>

      {storm ? (
        <Panel title="댓글 폭주 시뮬레이션" hint="같은 엔진으로 실제 처리한 결과" style={{ marginTop: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 }}>
            <Mini label="댓글" value={storm.comments.toLocaleString("ko-KR")} />
            <Mini label="발송" value={storm.dispatched.toLocaleString("ko-KR")} />
            <Mini label="수령" value={storm.claimsGranted.toLocaleString("ko-KR")} />
            <Mini
              label="오버이슈"
              value={`${storm.poolOversold}건`}
              tone={storm.poolOversold === 0 ? ACCENT : "#fb7185"}
            />
            <Mini label="댓글/초" value={storm.commentsPerSecond.toLocaleString("ko-KR")} />
            <Mini label="경합 재시도" value={`${storm.poolContentionRetries}회`} />
            <Mini label="중복" value={`${storm.duplicates}건`} />
            <Mini label="어뷰징" value={`${storm.abuseBlocked}건`} />
          </div>
        </Panel>
      ) : null}

      {deadLetters.length > 0 ? (
        <Panel title="DLQ (사람이 봐야 하는 건)" hint="재시도로 해결되지 않은 실패" style={{ marginTop: 12 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ color: MUTED, textAlign: "left" }}>
                <th style={cellHead}>수신자</th>
                <th style={cellHead}>시도</th>
                <th style={cellHead}>사유</th>
              </tr>
            </thead>
            <tbody>
              {deadLetters.slice(0, 5).map((item) => (
                <tr key={item.id} style={{ borderTop: `1px solid ${BORDER}` }}>
                  <td style={cell}>{item.recipient.slice(0, 12)}…</td>
                  <td style={cell}>{item.attempts}</td>
                  <td style={cell}>{item.error}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      ) : null}

      {onRunStorm ? (
        <button
          type="button"
          onClick={onRunStorm}
          style={{
            marginTop: 14,
            background: ACCENT,
            color: "#04140d",
            border: "none",
            borderRadius: 8,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          댓글 1,000건 폭주 시뮬레이션
        </button>
      ) : null}
    </section>
  );
}

function Kpi({ label, value, hint, tone = TEXT }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div style={{ background: BG, padding: "12px 14px" }}>
      <p style={{ margin: 0, fontSize: 11, color: MUTED }}>{label}</p>
      <p style={{ margin: "4px 0 0", fontSize: 19, fontWeight: 600, color: tone, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </p>
      <p style={{ margin: "2px 0 0", fontSize: 10.5, color: MUTED }}>{hint}</p>
    </div>
  );
}

function Panel({
  title,
  hint,
  children,
  style,
}: {
  title: string;
  hint: string;
  children: JSX.Element | JSX.Element[];
  style?: CSSProperties;
}) {
  return (
    <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: 14, ...style }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
        <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600 }}>{title}</h3>
        <span style={{ fontSize: 10.5, color: MUTED }}>{hint}</span>
      </div>
      {children}
    </div>
  );
}

function Bar({ label, value, total, tone }: { label: string; value: number; total: number; tone: string }) {
  const width = Math.min(100, (value / total) * 100);

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED }}>
        <span>{label}</span>
        <span style={{ color: TEXT, fontVariantNumeric: "tabular-nums" }}>{value.toLocaleString("ko-KR")}</span>
      </div>
      <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 999, marginTop: 3 }}>
        <div style={{ height: "100%", width: `${width}%`, background: tone, borderRadius: 999 }} />
      </div>
    </div>
  );
}

function Mini({ label, value, tone = TEXT }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "8px 10px" }}>
      <p style={{ margin: 0, fontSize: 10, color: MUTED }}>{label}</p>
      <p style={{ margin: "2px 0 0", fontSize: 14, fontWeight: 600, color: tone, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </p>
    </div>
  );
}

/**
 * 퍼널은 "어디서 새는가"를 보여주는 그림이다. 단계 사이 비율을 함께 적어, 예를 들어
 * "댓글 1,000 → 클릭 380(38%)"처럼 이탈 지점을 바로 읽을 수 있게 한다.
 */
function FunnelChart({ funnel }: { funnel: FunnelReport }) {
  const stages = [
    { label: "댓글", value: funnel.comments, tone: "#38bdf8", rate: 100 },
    { label: "링크 클릭", value: funnel.clicks, tone: "#34d399", rate: funnel.clickThroughRate },
    { label: "쿠폰 수령", value: funnel.claims, tone: "#fbbf24", rate: funnel.claimRate },
    { label: "구매", value: funnel.purchases, tone: "#f472b6", rate: funnel.purchaseRate },
  ];
  const max = Math.max(1, ...stages.map((stage) => stage.value));

  return (
    <div>
      {stages.map((stage) => (
        <div key={stage.label} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ width: 62, fontSize: 11, color: MUTED }}>{stage.label}</span>
          <div style={{ flex: 1, height: 16, background: "rgba(255,255,255,0.04)", borderRadius: 4 }}>
            <div
              style={{
                width: `${(stage.value / max) * 100}%`,
                height: "100%",
                background: stage.tone,
                borderRadius: 4,
                minWidth: stage.value > 0 ? 3 : 0,
              }}
            />
          </div>
          <span style={{ width: 84, textAlign: "right", fontSize: 11, color: TEXT, fontVariantNumeric: "tabular-nums" }}>
            {stage.value.toLocaleString("ko-KR")}
          </span>
          <span style={{ width: 46, textAlign: "right", fontSize: 10.5, color: MUTED }}>{pct(stage.rate)}</span>
        </div>
      ))}
    </div>
  );
}

const Funnel = FunnelChart;

const cellHead: CSSProperties = { padding: "4px 6px", fontWeight: 500, fontSize: 11 };
const cell: CSSProperties = { padding: "5px 6px", color: TEXT };
