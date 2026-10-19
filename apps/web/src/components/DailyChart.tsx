import { useState } from 'react';
import { shortDay } from '../format.ts';

export interface DailyPoint {
  day: string;
  approved: number;
  declined: number;
  other: number;
}

/** Séries fixas (paleta validada para daltonismo nos modos claro e escuro). */
const SERIES = [
  { key: 'approved', label: 'Aprovados', className: 'series-approved' },
  { key: 'declined', label: 'Recusados', className: 'series-declined' },
  { key: 'other', label: 'Outros (pendentes, desconhecidos, cancelados)', className: 'series-other' },
] as const;

/**
 * Barras empilhadas por dia (fuso de São Paulo). Legenda sempre visível, tooltip
 * por coluna, e a tabela com os mesmos números logo abaixo.
 */
export function DailyChart({ data }: { data: DailyPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const height = 200;
  const pad = { top: 12, right: 8, bottom: 26, left: 32 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...data.map((d) => d.approved + d.declined + d.other));
  const step = innerW / Math.max(1, data.length);
  const barW = Math.max(4, Math.min(28, step - 6));
  const y = (v: number) => (v / max) * innerH;
  const ticks = max <= 4 ? Array.from({ length: max + 1 }, (_, i) => i) : [0, Math.round(max / 2), max];
  const active = hover !== null ? data[hover] : null;

  return (
    <figure className="chart">
      <ul className="legend">
        {SERIES.map((s) => (
          <li key={s.key}>
            <span className={`swatch ${s.className}`} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <p className="chart-readout" aria-live="polite">
        {active
          ? `${shortDay(active.day)}: ${active.approved} aprovado(s), ${active.declined} recusado(s), ${active.other} outro(s)`
          : 'Passe o mouse sobre um dia para ver os números.'}
      </p>
      <div className="chart-plot">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Pagamentos por dia, por resultado">
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.left} x2={width - pad.right} y1={pad.top + innerH - y(t)} y2={pad.top + innerH - y(t)} />
              <text className="axis" x={pad.left - 6} y={pad.top + innerH - y(t) + 4} textAnchor="end">
                {t}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = pad.left + i * step + (step - barW) / 2;
            let base = pad.top + innerH;
            const segments = SERIES.map((s) => {
              const h = y(d[s.key]);
              const seg = h > 0 ? { s, yTop: base - h, h } : null;
              base -= h;
              return seg;
            }).filter((s): s is NonNullable<typeof s> => s !== null);
            return (
              <g key={d.day} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect className="hit" x={pad.left + i * step} y={pad.top} width={step} height={innerH} />
                {segments.map((seg, k) => (
                  <rect
                    key={seg.s.key}
                    className={seg.s.className}
                    x={x}
                    y={seg.yTop + (k < segments.length - 1 ? 1 : 0)}
                    width={barW}
                    height={Math.max(1, seg.h - (k < segments.length - 1 ? 2 : 0))}
                    rx={k === segments.length - 1 ? 3 : 0}
                  />
                ))}
                {i % Math.ceil(data.length / 8) === 0 ? (
                  <text className="axis" x={x + barW / 2} y={height - 8} textAnchor="middle">
                    {shortDay(d.day)}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>
      <details className="chart-table">
        <summary>Ver os números em tabela</summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Dia</th>
              <th scope="col">Aprovados</th>
              <th scope="col">Recusados</th>
              <th scope="col">Outros</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.day}>
                <td>{shortDay(d.day)}</td>
                <td className="num">{d.approved}</td>
                <td className="num">{d.declined}</td>
                <td className="num">{d.other}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
