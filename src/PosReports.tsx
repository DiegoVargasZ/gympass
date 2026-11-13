import { useEffect, useState } from 'react';
import { Download, Printer } from 'lucide-react';
import type { Bootstrap } from '../lib/domain';
import type { PosReport, PosReportItem, PosReportPeriod } from '../lib/pos-types';
import { api } from './api';
import { Donut, SplitBar, foldParts } from './PosCharts';
import { Field, Skeleton, type Notify } from './ui';
import {
  bucketLabel,
  defaultRange,
  methodNames,
  money,
  marginMoney,
  periodNames,
  reportCsv,
  reportFileName,
  reportPrintHtml,
} from './pos-report-export';

/** El color sigue a la entidad: cada método conserva el suyo aunque cambie el rango. */
const methodColor = { cash: 'var(--viz-1)', transfer: 'var(--viz-2)', card: 'var(--viz-3)' } as const;

function Delta({ current, previous }: { current: number; previous: number }) {
  if (!previous) return <small>{current ? 'Sin ventas en el período anterior' : 'Sin cambios'}</small>;
  const change = Math.round(((current - previous) / previous) * 100);
  return (
    <small className={change < 0 ? 'pos-report-down' : 'pos-report-up'}>
      {change > 0 ? '+' : ''}
      {change} % frente al período anterior
    </small>
  );
}

function Bars({ report }: { report: PosReport }) {
  const max = Math.max(1, ...report.series.map((row) => row.total_cents)),
    width = 640,
    step = width / report.series.length,
    every = Math.ceil(report.series.length / 8);
  return (
    <svg
      className="pos-report-chart"
      viewBox={`0 0 ${width} 220`}
      role="img"
      aria-label={`Ingresos por ${periodNames[report.period].toLowerCase()}`}
    >
      <line x1={0} x2={width} y1={180} y2={180} className="pos-report-axis" />
      {report.series.map((row, index) => {
        const height = (row.total_cents / max) * 160;
        return (
          <g key={row.bucket}>
            <title>{`${bucketLabel(report.period, row.bucket)}: ${money(row.total_cents)} · ${row.count} ventas`}</title>
            <rect
              className="pos-report-bar"
              x={index * step + step * 0.15}
              y={180 - height}
              width={step * 0.7}
              height={Math.max(row.total_cents ? 2 : 0, height)}
              rx={2}
            />
            {index % every === 0 && (
              <text className="pos-report-tick" x={index * step + step / 2} y={200} textAnchor="middle">
                {report.period === 'day'
                  ? row.bucket.slice(5).split('-').reverse().join('/')
                  : bucketLabel(report.period, row.bucket).replace('Semana del ', '')}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function Ranking({ title, items, empty, showMargin = false }: { title: string; items: PosReportItem[]; empty: string; showMargin?: boolean }) {
  const total = items.reduce((sum, row) => sum + row.total_cents, 0);
  const parts = foldParts(
    items.map((row) => ({
      key: row.item_id,
      label: row.name,
      cents: row.total_cents,
      detail: row.quantity + (row.quantity === 1 ? ' vendido' : ' vendidos'),
    })),
  );
  return (
    <section className="panel">
      <h2>{title}</h2>
      {items.length ? (
        <>
          <Donut title={title} parts={parts} centerLabel="Ingresos" />
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th className="num">Cantidad</th>
                  <th className="num">Ingresos</th>
                  <th className="num">% del total</th>
                  {showMargin && <th className="num">Costo de compra</th>}
                  {showMargin && <th className="num">Ganancia bruta</th>}
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.item_id}>
                    <td>
                      {row.name}
                      <span className="pos-report-share" aria-hidden="true">
                        <i style={{ width: (total ? (row.total_cents / total) * 100 : 0) + '%' }} />
                      </span>
                    </td>
                    <td className="num">{row.quantity}</td>
                    <td className="num">{money(row.total_cents)}</td>
                    <td className="num">{total ? Math.round((row.total_cents / total) * 100) : 0} %</td>
                    {showMargin && <td className="num">{marginMoney(row.margin, 'cost_cents')}</td>}
                    {showMargin && <td className="num">{marginMoney(row.margin, 'profit_cents')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="helper">{empty}</p>
      )}
    </section>
  );
}

export default function PosReports({ data, notify }: { data: Bootstrap; notify: Notify }) {
  const [period, setPeriod] = useState<PosReportPeriod>('month'),
    [range, setRange] = useState(() => defaultRange('month', data.today)),
    [report, setReport] = useState<PosReport | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError('');
    api<PosReport>(
      'pos/reports?' + new URLSearchParams({ period, from: range.from, to: range.to }),
      'GET',
      undefined,
      controller.signal,
    )
      .then((result) => {
        if (!controller.signal.aborted) setReport(result);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [period, range.from, range.to, retry]);

  function exportCsv() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([reportCsv(report)], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = reportFileName(report);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function print() {
    if (!report) return;
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(frame);
    const doc = frame.contentDocument;
    if (!doc) {
      frame.remove();
      notify('No se pudo preparar la impresión.', true);
      return;
    }
    doc.open();
    doc.write(reportPrintHtml(report, data.settings.name));
    doc.close();
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 60000);
  }

  const summary = report?.summary;
  return (
    <section className="pos-report">
      <div className="pos-report-controls">
        <div className="pos-tabs" role="group" aria-label="Agrupar ventas por">
          {(Object.keys(periodNames) as PosReportPeriod[]).map((key) => (
            <button
              key={key}
              className={'btn ' + (period === key ? 'primary' : 'secondary')}
              aria-pressed={period === key}
              onClick={() => {
                setPeriod(key);
                setRange(defaultRange(key, data.today));
              }}
            >
              {periodNames[key]}
            </button>
          ))}
        </div>
        <div className="pos-history-filters">
          <Field label="Desde">
            <input
              type="date"
              value={range.from}
              max={range.to}
              onChange={(event) => event.target.value && setRange({ ...range, from: event.target.value })}
            />
          </Field>
          <Field label="Hasta">
            <input
              type="date"
              value={range.to}
              min={range.from}
              onChange={(event) => event.target.value && setRange({ ...range, to: event.target.value })}
            />
          </Field>
          <button className="btn secondary" disabled={!report || busy} onClick={exportCsv}>
            <Download size={16} aria-hidden="true" /> Descargar CSV
          </button>
          <button className="btn secondary" disabled={!report || busy} onClick={print}>
            <Printer size={16} aria-hidden="true" /> Imprimir o PDF
          </button>
        </div>
      </div>
      {error && (
        <div role="alert" className="error-message">
          {error}{' '}
          <button className="btn secondary" onClick={() => setRetry((value) => value + 1)}>
            Reintentar
          </button>
        </div>
      )}
      {!report && !error && <Skeleton />}
      {report && summary && (
        <div className="pos-report-body" aria-busy={busy}>
          <dl className="pos-report-cards">
            <div>
              <dt>Ingresos</dt>
              <dd>{money(summary.total_cents)}</dd>
              <Delta current={summary.total_cents} previous={summary.previous.total_cents} />
            </div>
            <div>
              <dt>Ventas</dt>
              <dd>{summary.count}</dd>
              <Delta current={summary.count} previous={summary.previous.count} />
            </div>
            <div>
              <dt>Ticket promedio</dt>
              <dd>{money(summary.average_cents)}</dd>
              <small>por venta pagada</small>
            </div>
            <div>
              <dt>Ventas anuladas</dt>
              <dd>{summary.void_count}</dd>
              <small>{money(summary.void_cents)} no cobrados</small>
            </div>
            {summary.product_margin && <>
              <div><dt>Ingresos por productos</dt><dd>{money(summary.product_margin.revenue_cents)}</dd><small>Solo ventas de productos</small></div>
              <div><dt>Costo de productos vendidos</dt><dd>{marginMoney(summary.product_margin, 'cost_cents')}</dd><small>Costo registrado al cobrar cada venta</small></div>
              <div><dt>Ganancia bruta de productos</dt><dd>{marginMoney(summary.product_margin, 'profit_cents')}</dd><small>Ingresos por productos menos su costo de compra</small></div>
            </>}
          </dl>
          {summary.product_margin && summary.product_margin.missing_cost_quantity > 0 && (
            <p className="helper" role="status">Hay {summary.product_margin.missing_cost_quantity} unidades vendidas sin costo registrado. Su ganancia no está calculada; los importes parciales incluyen únicamente las unidades con costo conocido.</p>
          )}
          {summary.product_margin && <p className="helper">La ganancia bruta de productos excluye los planes y otros gastos del gimnasio.</p>}
          <h2>Ingresos por {periodNames[report.period].toLowerCase()}</h2>
          {summary.count ? <Bars report={report} /> : <p className="helper">No hay ventas pagadas en este rango.</p>}
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{periodNames[report.period]}</th>
                  <th className="num">Ventas</th>
                  <th className="num">Ingresos</th>
                </tr>
              </thead>
              <tbody>
                {report.series.map((row) => (
                  <tr key={row.bucket}>
                    <td>{bucketLabel(report.period, row.bucket)}</td>
                    <td className="num">{row.count}</td>
                    <td className="num">{money(row.total_cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pos-report-grid">
            <Ranking title="Planes más vendidos" items={report.plans} empty="No se vendieron planes en este rango." />
            <Ranking
              title="Productos más vendidos"
              showMargin
              items={report.products}
              empty="No se vendieron productos en este rango."
            />
            <section className="panel">
              <h2>Por método de pago</h2>
              {report.by_method.length ? (
                <>
                  <SplitBar
                    label="Ingresos por método de pago"
                    parts={report.by_method.map((row) => ({
                      key: row.payment_method,
                      cents: row.total_cents,
                      color: methodColor[row.payment_method],
                    }))}
                  />
                  <ul className="pos-report-list">
                    {report.by_method.map((row) => (
                      <li key={row.payment_method}>
                        <span>
                          <i
                            className="pos-swatch"
                            style={{ background: methodColor[row.payment_method] }}
                            aria-hidden="true"
                          />
                          {methodNames[row.payment_method]}
                        </span>
                        <strong>{money(row.total_cents)}</strong>
                        <small>{row.count} ventas</small>
                      </li>
                    ))}
                  </ul>
                </>
              ) : (
                <p className="helper">Sin ventas en este rango.</p>
              )}
            </section>
            <section className="panel">
              <h2>Por cajero</h2>
              {report.by_cashier.length ? (
                <ul className="pos-report-list">
                  {report.by_cashier.map((row) => (
                    <li key={row.actor}>
                      <span>{row.name}</span>
                      <strong>{money(row.total_cents)}</strong>
                      <small>{row.count} ventas</small>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="helper">Sin ventas en este rango.</p>
              )}
            </section>
          </div>
        </div>
      )}
    </section>
  );
}
