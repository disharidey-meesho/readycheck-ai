// Small chart components for trainer analytics (plain SVG / HTML, no chart library).
import React from 'react';

export interface Point { label: string; attempts: number; avg_score: number | null; pass_rate: number | null; }

const PASS_LINE = 85;
const fmt = (v: number | null) => (v === null ? '—' : `${Math.round(v)}%`);

// average score per day as a line with a dashed pass-mark guide
export function TrendChart({ data, height = 200 }: { data: Point[]; height?: number }) {
  if (!data.length) return <p className="py-8 text-center text-sm text-ink-soft">No attempts yet.</p>;
  const w = 640;
  const pad = { l: 36, r: 12, t: 12, b: 28 };
  const x = (i: number) => pad.l + (data.length === 1 ? (w - pad.l - pad.r) / 2 : (i * (w - pad.l - pad.r)) / (data.length - 1));
  const y = (v: number) => pad.t + ((100 - v) * (height - pad.t - pad.b)) / 100;
  const pts = data.map((d, i) => (d.avg_score === null ? null : [x(i), y(d.avg_score)] as const)).filter(Boolean) as [number, number][];
  const every = Math.ceil(data.length / 8);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className="h-auto w-full" role="img" aria-label="Average PKT score by day">
      {[0, 50, 100].map((v) => (
        <g key={v}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="#E9E3F7" />
          <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#5F5D73">{v}</text>
        </g>
      ))}
      <line x1={pad.l} x2={w - pad.r} y1={y(PASS_LINE)} y2={y(PASS_LINE)} stroke="#B45309" strokeDasharray="5 4" />
      <text x={w - pad.r} y={y(PASS_LINE) - 4} textAnchor="end" fontSize="11" fill="#B45309">pass mark</text>
      <polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke="#9D2AA3" strokeWidth="2.5" />
      {data.map((d, i) => d.avg_score !== null && (
        <g key={d.label}>
          <circle cx={x(i)} cy={y(d.avg_score)} r="4" fill="#9D2AA3"><title>{`${d.label}: avg ${fmt(d.avg_score)}, pass ${fmt(d.pass_rate)}, ${d.attempts} attempts`}</title></circle>
          {i % every === 0 && <text x={x(i)} y={height - 8} textAnchor="middle" fontSize="11" fill="#5F5D73">{d.label.slice(5)}</text>}
        </g>
      ))}
    </svg>
  );
}

// horizontal bars: average score with pass rate as text
export function BarList({ data, empty = 'No attempts yet.' }: { data: Point[]; empty?: string }) {
  if (!data.length) return <p className="py-6 text-center text-sm text-ink-soft">{empty}</p>;
  return (
    <div className="space-y-3">
      {data.map((d) => {
        const v = d.avg_score ?? 0;
        const pass = v >= PASS_LINE;
        return (
          <div key={d.label} className="grid grid-cols-[minmax(0,110px)_1fr_auto] items-center gap-3 sm:grid-cols-[minmax(0,180px)_1fr_auto]">
            <p className="truncate text-sm font-semibold text-ink" title={d.label}>{d.label}</p>
            <div className="h-3 overflow-hidden rounded-full bg-[#F2EEFC]" role="img" aria-label={`${d.label} average ${fmt(d.avg_score)}`}>
              <div className={pass ? 'h-full rounded-full bg-emerald-600' : 'h-full rounded-full bg-rose-500'} style={{ width: `${Math.max(2, v)}%` }} />
            </div>
            <p className="whitespace-nowrap text-right text-xs text-ink-soft">
              <span className="font-bold text-ink">{fmt(d.avg_score)}</span> {pass ? '✓' : '✗'} · pass {fmt(d.pass_rate)} · {d.attempts}
            </p>
          </div>
        );
      })}
    </div>
  );
}

// agent × SOP area accuracy; colour plus the number in every cell
export function Heatmap({ topics, rows }: { topics: string[]; rows: Array<{ agent: string; cells: Array<number | null> }> }) {
  if (!rows.length || !topics.length) return <p className="py-6 text-center text-sm text-ink-soft">No attempts yet.</p>;
  const tone = (v: number | null) =>
    v === null ? 'bg-slate-50 text-slate-500' : v >= 90 ? 'bg-emerald-100 text-emerald-900' : v >= 85 ? 'bg-lime-100 text-lime-900' : v >= 70 ? 'bg-amber-100 text-amber-900' : 'bg-rose-100 text-rose-900';
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] border-separate border-spacing-1 text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white px-2 py-1 text-left font-semibold text-ink-soft">Agent</th>
            {topics.map((t) => <th key={t} className="max-w-[110px] px-1 py-1 text-left font-semibold leading-tight text-ink-soft" title={t}>{t}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.agent}>
              <td className="sticky left-0 max-w-[140px] truncate bg-white px-2 py-1 font-semibold text-ink" title={r.agent}>{r.agent}</td>
              {r.cells.map((v, i) => <td key={i} className={`rounded-md px-2 py-1.5 text-center font-bold ${tone(v)}`}>{v === null ? '–' : `${Math.round(v)}`}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-ink-soft">Accuracy % per SOP area. 90+ strong · 85–89 pass · 70–84 needs practice · below 70 training need.</p>
    </div>
  );
}
