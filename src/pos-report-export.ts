import { toCsv } from '../lib/csv.ts';
import { nextDate } from '../lib/domain.ts';
import type { PaymentMethod, PosReport, PosReportPeriod } from '../lib/pos-types.ts';
import { marginComplete, marginKnown, type ProductMargin } from '../lib/product-costs.ts';

export const money = (cents: number) =>
  new Intl.NumberFormat('es-BO', { style: 'currency', currency: 'BOB' }).format(cents / 100);
export const methodNames: Record<PaymentMethod, string> = {
  cash: 'Efectivo',
  transfer: 'Transferencia o QR',
  card: 'Tarjeta',
};
export const periodNames: Record<PosReportPeriod, string> = {
  day: 'Día',
  week: 'Semana',
  month: 'Mes',
  year: 'Año',
};
const day = (value: string) => value.split('-').reverse().join('/');
const months = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];
/** Nombre legible de un grupo: la semana se muestra por su lunes. */
export function bucketLabel(period: PosReportPeriod, bucket: string) {
  if (period === 'day') return day(bucket);
  if (period === 'week') return 'Semana del ' + day(bucket);
  if (period === 'month') return months[Number(bucket.slice(5, 7)) - 1] + ' ' + bucket.slice(0, 4);
  return bucket;
}
const decimal = (cents: number) => (cents / 100).toFixed(2);
export function marginMoney(margin: ProductMargin | undefined, field: 'cost_cents' | 'profit_cents') {
  if (!margin || !marginKnown(margin)) return 'Sin registrar';
  return money(margin[field]) + (marginComplete(margin) ? '' : ' (parcial)');
}

function marginCsv(section: string, name: string, margin: ProductMargin): unknown[][] {
  const suffix = marginComplete(margin) ? '' : ' (parcial)';
  const known = margin.quantity - margin.missing_cost_quantity;
  return [
    [section, name + ' · ingresos', margin.quantity, decimal(margin.revenue_cents)],
    [section, name + ' · costo de compra' + suffix, known, marginKnown(margin) ? decimal(margin.cost_cents) : 'Sin registrar'],
    [section, name + ' · ganancia bruta' + suffix, known, marginKnown(margin) ? decimal(margin.profit_cents) : 'Sin registrar'],
    ...(margin.missing_cost_quantity ? [[section, name + ' · unidades sin costo registrado', margin.missing_cost_quantity, 'No calculado']] : []),
  ];
}

export function reportCsv(report: PosReport) {
  const { summary } = report;
  const rows: unknown[][] = [
    ['Resumen', 'Período', `${day(report.from)} al ${day(report.to)}`, ''],
    ['Resumen', 'Ingresos', summary.count, decimal(summary.total_cents)],
    ['Resumen', 'Ticket promedio', '', decimal(summary.average_cents)],
    ['Resumen', 'Ventas anuladas', summary.void_count, decimal(summary.void_cents)],
    ...(summary.product_margin ? marginCsv('Resumen de productos', 'Productos', summary.product_margin) : []),
    [
      'Resumen',
      `Período anterior (${day(summary.previous.from)} al ${day(summary.previous.to)})`,
      summary.previous.count,
      decimal(summary.previous.total_cents),
    ],
    ...report.series.map((row) => [
      'Por ' + periodNames[report.period].toLowerCase(),
      bucketLabel(report.period, row.bucket),
      row.count,
      decimal(row.total_cents),
    ]),
    ...report.plans.map((row) => ['Planes', row.name, row.quantity, decimal(row.total_cents)]),
    ...report.products.map((row) => ['Productos', row.name, row.quantity, decimal(row.total_cents)]),
    ...report.products.flatMap((row) => row.margin ? marginCsv('Costos y ganancias', row.name, row.margin) : []),
    ...report.by_method.map((row) => [
      'Método de pago',
      methodNames[row.payment_method],
      row.count,
      decimal(row.total_cents),
    ]),
    ...report.by_cashier.map((row) => ['Cajero', row.name, row.count, decimal(row.total_cents)]),
  ];
  return toCsv(['Sección', 'Detalle', 'Cantidad', 'Importe (BOB)'], rows);
}
export function reportFileName(report: PosReport) {
  return `ventas-${periodNames[report.period].toLowerCase()}-${report.from}-a-${report.to}.csv`;
}

const escapeHtml = (value: unknown) => String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const table = (title: string, headers: string[], rows: (string | number)[][]) =>
  rows.length
    ? `<h2>${escapeHtml(title)}</h2><table><thead><tr>${headers
        .map((header, index) => `<th${index ? ' class="n"' : ''}>${escapeHtml(header)}</th>`)
        .join('')}</tr></thead><tbody>${rows
        .map(
          (row) =>
            `<tr>${row.map((cell, index) => `<td${index ? ' class="n"' : ''}>${escapeHtml(cell)}</td>`).join('')}</tr>`,
        )
        .join('')}</tbody></table>`
    : '';
/** Documento autónomo (sin estilos de la aplicación) para imprimir o guardar como PDF. */
export function reportPrintHtml(report: PosReport, gym: string) {
  const { summary } = report;
  const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) + ' %' : '—');
  const planTotal = report.plans.reduce((sum, row) => sum + row.total_cents, 0);
  const productTotal = report.products.reduce((sum, row) => sum + row.total_cents, 0);
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte de ventas</title><style>` +
    `@page{size:A4;margin:14mm}body{font:12px/1.4 system-ui,sans-serif;color:#111}h1{font-size:20px;margin:0}` +
    `h2{font-size:14px;margin:18px 0 6px}p{margin:2px 0;color:#444}table{width:100%;border-collapse:collapse}` +
    `th,td{padding:4px 6px;border-bottom:1px solid #ccc;text-align:left}.n{text-align:right}` +
    `.cards{display:flex;gap:10px;margin:12px 0}.cards div{flex:1;border:1px solid #ccc;padding:8px;border-radius:6px}` +
    `.cards strong{display:block;font-size:16px}tr{break-inside:avoid}</style></head><body>` +
    `<h1>Reporte de ventas</h1><p>${escapeHtml(gym)} · ${day(report.from)} al ${day(report.to)} · por ${periodNames[report.period].toLowerCase()}</p>` +
    `<div class="cards"><div>Ingresos<strong>${escapeHtml(money(summary.total_cents))}</strong></div>` +
    `<div>Ventas<strong>${summary.count}</strong></div>` +
    `<div>Ticket promedio<strong>${escapeHtml(money(summary.average_cents))}</strong></div>` +
    `<div>Anuladas<strong>${summary.void_count}</strong></div></div>` +
    (summary.product_margin ? table('Costos y ganancias de productos', ['Concepto', 'Unidades', 'Importe (BOB)'], [
      ['Ingresos por productos', summary.product_margin.quantity, money(summary.product_margin.revenue_cents)],
      ['Costo de productos vendidos', summary.product_margin.quantity - summary.product_margin.missing_cost_quantity, marginMoney(summary.product_margin, 'cost_cents')],
      ['Ganancia bruta de productos', summary.product_margin.quantity - summary.product_margin.missing_cost_quantity, marginMoney(summary.product_margin, 'profit_cents')],
      ...(summary.product_margin.missing_cost_quantity ? [['Unidades sin costo registrado', summary.product_margin.missing_cost_quantity, 'Ganancia pendiente de calcular']] : []),
    ]) + '<p>La ganancia bruta de productos excluye los planes y otros gastos del gimnasio.</p>' : '') +
    table(
      'Evolución',
      [periodNames[report.period], 'Ventas', 'Ingresos'],
      report.series.map((row) => [bucketLabel(report.period, row.bucket), row.count, money(row.total_cents)]),
    ) +
    table(
      'Planes más vendidos',
      ['Plan', 'Cantidad', 'Ingresos', '% de planes'],
      report.plans.map((row) => [row.name, row.quantity, money(row.total_cents), pct(row.total_cents, planTotal)]),
    ) +
    table(
      'Productos más vendidos',
      ['Producto', 'Cantidad', 'Ingresos', '% de productos', 'Costo de compra', 'Ganancia bruta'],
      report.products.map((row) => [
        row.name,
        row.quantity,
        money(row.total_cents),
        pct(row.total_cents, productTotal),
        marginMoney(row.margin, 'cost_cents'),
        marginMoney(row.margin, 'profit_cents'),
      ]),
    ) +
    table(
      'Por método de pago',
      ['Método', 'Ventas', 'Ingresos'],
      report.by_method.map((row) => [methodNames[row.payment_method], row.count, money(row.total_cents)]),
    ) +
    table(
      'Por cajero',
      ['Cajero', 'Ventas', 'Ingresos'],
      report.by_cashier.map((row) => [row.name, row.count, money(row.total_cents)]),
    ) +
    `</body></html>`
  );
}

/** Rango inicial de cada agrupación: suficiente para ver la tendencia sin pedir demasiados grupos. */
export function defaultRange(period: PosReportPeriod, today: string) {
  if (period === 'day') return { from: nextDate(today, -29), to: today };
  if (period === 'week') return { from: nextDate(today, -83), to: today };
  if (period === 'month') {
    const month = Number(today.slice(5, 7)),
      year = Number(today.slice(0, 4)) - (month === 12 ? 0 : 1);
    return { from: `${year}-${String((month % 12) + 1).padStart(2, '0')}-01`, to: today };
  }
  return { from: `${Number(today.slice(0, 4)) - 4}-01-01`, to: today };
}

export type ChartPart = { key: string; label: string; cents: number; detail: string };
/** Los primeros colores van por entidad en orden fijo; lo que sobra se agrupa en "Otros" (gris). */
const maxSlices = 5;

/** Ordena de mayor a menor y deja a lo sumo cinco partes con color más "Otros". */
export function foldParts(parts: ChartPart[]): ChartPart[] {
  const sorted = parts.filter((part) => part.cents > 0).sort((a, b) => b.cents - a.cents);
  if (sorted.length <= maxSlices) return sorted;
  const rest = sorted.slice(maxSlices - 1);
  return [
    ...sorted.slice(0, maxSlices - 1),
    {
      key: 'others',
      label: 'Otros',
      cents: rest.reduce((sum, part) => sum + part.cents, 0),
      detail: rest.length + ' más',
    },
  ];
}
