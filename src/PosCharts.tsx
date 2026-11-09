import { useState } from 'react';
import { foldParts, money, type ChartPart } from './pos-report-export';

export { foldParts, type ChartPart };

const color = (index: number, part: ChartPart) =>
  part.key === 'others' ? 'var(--viz-other)' : `var(--viz-${index + 1})`;
const percent = (part: number, total: number) => (total ? Math.round((part / total) * 100) : 0) + ' %';

/** Dona con la leyenda al lado: cada fila repite nombre, importe y porcentaje, así el color nunca es lo único que informa. */
export function Donut({ title, parts, centerLabel }: { title: string; parts: ChartPart[]; centerLabel: string }) {
  const [active, setActive] = useState<number | null>(null);
  const total = parts.reduce((sum, part) => sum + part.cents, 0);
  if (!total) return null;
  const radius = 44,
    circumference = 2 * Math.PI * radius,
    gap = parts.length > 1 ? 2 : 0;
  let offset = 0;
  const current = active === null ? null : parts[active];
  return (
    <div className="pos-donut">
      <svg viewBox="0 0 120 120" role="group" aria-label={title} onMouseLeave={() => setActive(null)}>
        {parts.map((part, index) => {
          const length = (part.cents / total) * circumference,
            start = offset;
          offset += length;
          return (
            <circle
              key={part.key}
              className={'pos-donut-slice' + (active === index ? ' active' : '')}
              cx={60}
              cy={60}
              r={radius}
              fill="none"
              stroke={color(index, part)}
              strokeWidth={16}
              strokeDasharray={`${Math.max(0, length - gap)} ${circumference}`}
              strokeDashoffset={-start}
              transform="rotate(-90 60 60)"
              tabIndex={0}
              role="img"
              aria-label={`${part.label}: ${money(part.cents)}, ${percent(part.cents, total)}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
            >
              <title>{`${part.label}: ${money(part.cents)} (${percent(part.cents, total)})`}</title>
            </circle>
          );
        })}
        <text className="pos-donut-value" x={60} y={current ? 56 : 62} textAnchor="middle">
          {current ? percent(current.cents, total) : money(total)}
        </text>
        <text className="pos-donut-caption" x={60} y={74} textAnchor="middle">
          {current ? current.label.slice(0, 18) : centerLabel}
        </text>
      </svg>
      <ul className="pos-legend">
        {parts.map((part, index) => (
          <li
            key={part.key}
            className={active === index ? 'active' : ''}
            onMouseEnter={() => setActive(index)}
            onMouseLeave={() => setActive(null)}
          >
            <i style={{ background: color(index, part) }} aria-hidden="true" />
            <span>
              {part.label}
              <small>{part.detail}</small>
            </span>
            <strong>{money(part.cents)}</strong>
            <em>{percent(part.cents, total)}</em>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Barra fina segmentada sin texto: las cifras van en la lista que la acompaña. */
export function SplitBar({ parts, label }: { parts: { key: string; cents: number; color: string }[]; label: string }) {
  const total = parts.reduce((sum, part) => sum + part.cents, 0);
  if (!total) return null;
  return (
    <div className="pos-splitbar" role="img" aria-label={label}>
      {parts
        .filter((part) => part.cents > 0)
        .map((part) => (
          <span key={part.key} style={{ flexGrow: part.cents, background: part.color }} />
        ))}
    </div>
  );
}
