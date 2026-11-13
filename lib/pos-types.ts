import type { ProductMargin } from './product-costs.ts';
export type PlanUnit = 'days' | 'months' | 'sessions';
export function planEndDate(start: string, unit: PlanUnit, duration: number): string | null {
  if (unit === 'sessions') return null;
  const value = new Date(start + 'T12:00:00Z');
  if (unit === 'days') value.setUTCDate(value.getUTCDate() + duration);
  else {
    const day = value.getUTCDate();
    value.setUTCDate(1);
    value.setUTCMonth(value.getUTCMonth() + duration);
    const last = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
    value.setUTCDate(Math.min(day, last));
  }
  return value.toISOString().slice(0, 10);
}
export type PaymentMethod = 'cash' | 'transfer' | 'card';
export type PosProduct = {
  id: string;
  name: string;
  sku: string;
  category: string;
  price_cents: number;
  cost_cents: number | null;
  stock: number;
  track_stock: number;
  active: number;
};
export type PosPlan = {
  id: string;
  name: string;
  unit: PlanUnit;
  duration: number;
  price_cents: number;
  active: number;
};
export type PosLineInput = {
  kind: 'product' | 'plan';
  id: string;
  quantity: number;
  expected_plan?: { unit: PlanUnit; duration: number };
};
export type PosCheckout = {
  expected_total_cents?: number;
  request_id: string;
  person_id?: string;
  new_member?: {
    name: string;
    document: string;
    kind: 'member' | 'employee';
    status: 'active';
    email?: string;
    phone?: string;
    department?: string;
    notes?: string;
  };
  start_date?: string;
  replace_active?: { reason: string };
  payment_method: PaymentMethod;
  lines: PosLineInput[];
};
export type PosSaleLine = {
  id: string;
  sale_id: string;
  kind: 'product' | 'plan';
  item_id: string;
  name: string;
  quantity: number;
  price_cents: number;
  total_cents: number;
  track_stock: number;
  cost_cents: number | null;
  unit: PlanUnit | null;
  duration: number | null;
};
export type PosSale = {
  id: string;
  request_id: string;
  person_id: string | null;
  person_name: string | null;
  actor: string;
  created_at: number;
  local_date: string;
  start_date: string;
  payment_method: PaymentMethod;
  currency: 'BOB';
  total_cents: number;
  status: 'paid' | 'void';
  void_reason: string | null;
  replace_reason: string | null;
  void_at: number | null;
  void_by: string | null;
};
export type PosSaleDetail = PosSale & {
  lines: PosSaleLine[];
  memberships: PosMembership[];
  warnings: string[];
  credential?: { id: string; active: number; phone: string } | null;
};
export type PosMembership = {
  id: string;
  sale_id: string;
  line_id: string;
  person_id: string;
  name: string;
  unit: PlanUnit;
  duration: number;
  price_cents: number;
  start_date: string;
  end_date: string | null;
  sessions_total: number | null;
  sessions_remaining: number | null;
  status: 'active' | 'void';
  created_at: number;
};
/** Qué puede comprar un socio ahora: libre, renovación que empieza al vencer el plan actual, o bloqueado. */
export type PlanGate =
  { state: 'free' } | { state: 'renewal'; start_date: string; message: string } | { state: 'blocked'; message: string };
export type MembershipSummary = {
  plan_gate: PlanGate;
  managed: boolean;
  legacy: boolean;
  legacy_expires: string | null;
  valid: boolean;
  valid_until: string | null;
  sessions_remaining: number;
  memberships: PosMembership[];
};
export type PosCatalog = { products: PosProduct[]; plans: PosPlan[] };
export type PosSales = {
  rows: PosSale[];
  total: number;
  page: number;
  total_cents: number;
  by_method: { payment_method: PaymentMethod; total_cents: number; count: number }[];
};
export type PosReportPeriod = 'day' | 'week' | 'month' | 'year';
export type PosReportTotals = { total_cents: number; count: number };
export type PosReportItem = { item_id: string; name: string; quantity: number; total_cents: number; margin?: ProductMargin };
export type PosReport = {
  period: PosReportPeriod;
  from: string;
  to: string;
  summary: PosReportTotals & {
    average_cents: number;
    void_count: number;
    void_cents: number;
    previous: PosReportTotals & { from: string; to: string };
    product_margin?: ProductMargin;
  };
  series: ({ bucket: string } & PosReportTotals)[];
  plans: PosReportItem[];
  products: PosReportItem[];
  by_method: { payment_method: PaymentMethod; total_cents: number; count: number }[];
  by_cashier: { actor: string; name: string; total_cents: number; count: number }[];
};
