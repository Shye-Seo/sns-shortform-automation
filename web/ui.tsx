import type { CSSProperties, ReactNode } from 'react';

/** Presentation primitives shared by the panels. No business logic here. */

export function Card({
  title,
  hint,
  eyebrow,
  actions,
  children,
  tight,
  style,
}: {
  title?: string;
  hint?: string;
  eyebrow?: string;
  actions?: ReactNode;
  children: ReactNode;
  tight?: boolean;
  style?: CSSProperties;
}) {
  const hasHead = Boolean(title || hint || eyebrow || actions);
  return (
    <section className={tight ? 'card tight' : 'card'} style={style}>
      {hasHead ? (
        <header className="card-head">
          <div className="card-head-text">
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {title ? <h2>{title}</h2> : null}
            {hint ? <p className="hint">{hint}</p> : null}
          </div>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  return (
    <div className="kpi-card">
      <div className="label">{label}</div>
      <div className={tone ? `value ${tone}` : 'value'}>{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}

export function Meter({
  label,
  value,
  max,
  readout,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  readout?: string;
  tone?: 'ok' | 'warn' | 'bad';
}) {
  const ratio = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  return (
    <div className="meter-row">
      <span>{label}</span>
      <span className={`meter${tone ? ` ${tone}` : ''}`}>
        <span style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </span>
      <span className="num">{readout ?? `${Math.round(value)}/${Math.round(max)}`}</span>
    </div>
  );
}

export function Pill({
  children,
  tone,
  title,
}: {
  children: ReactNode;
  tone?: 'ok' | 'warn' | 'bad' | 'ghost';
  title?: string;
}) {
  return (
    <span className={tone ? `pill ${tone}` : 'pill'} title={title}>
      {children}
    </span>
  );
}

/** 흩어진 배지 대신 쓰는 한 줄 메타. 항목 사이에 가운뎃점을 둔다. */
export function MetaLine({ items }: { items: Array<ReactNode | null | undefined> }) {
  const visible = items.filter((item) => item !== null && item !== undefined && item !== '');
  return (
    <div className="meta-line">
      {visible.map((item, index) => (
        <span key={index} className="meta-item">
          {index > 0 ? <span className="sep" aria-hidden="true" /> : null}
          {item}
        </span>
      ))}
    </div>
  );
}

export function Button({
  children,
  onClick,
  primary,
  ghost,
  small,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  ghost?: boolean;
  small?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const className = ['btn', primary ? 'primary' : '', ghost ? 'ghost' : '', small ? 'small' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button type="button" className={className} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: ReactNode;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export const num = (value: number): string => Math.round(value).toLocaleString('ko-KR');
export const pct = (value: number, digits = 1): string => `${value.toFixed(digits)}%`;
export const won = (value: number): string => `${Math.round(value).toLocaleString('ko-KR')}원`;
export const sec = (value: number): string => `${value.toFixed(2)}s`;
export const clock = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};
export const hhmmss = (ms: number): string =>
  new Date(ms).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
