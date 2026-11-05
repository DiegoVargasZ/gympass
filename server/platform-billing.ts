import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../lib/service.ts';
import type { PlatformStore, PlatformUser } from './platform-store.ts';

type Row = Record<string, any>;
export type BillingConfig = { monthly_fee_cents: number; start_month: string; due_day: number };
export type BillingPaymentInput = {
  request_id: string;
  charge_id: string;
  amount_cents: number;
  paid_on: string;
  method: 'cash' | 'transfer' | 'card';
  reference?: string;
};
export type BillingCharge = {
  id: string;
  month: string;
  amount_cents: number;
  paid_cents: number;
  balance_cents: number;
  due_on: string;
  status: 'paid' | 'overdue' | 'partial' | 'pending';
};
export type BillingPayment = BillingPaymentInput & {
  id: string;
  created_by: string;
  created_at: number;
  voided_at: number | null;
  void_reason: string | null;
  actor_name: string;
};
export type BillingAccount = {
  currency: 'BOB';
  config: BillingConfig | null;
  charges: BillingCharge[];
  payments: BillingPayment[];
  balance_cents: number;
};

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/La_Paz',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
function today() {
  return dateFormatter.format(Date.now());
}
function month(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:20|21)\d{2}-(?:0[1-9]|1[0-2])$/.test(value))
    throw new ApiError(400, 'Mes inválido; utiliza YYYY-MM entre 2000 y 2199.');
  return value;
}
function money(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 100000000000)
    throw new ApiError(400, 'El importe debe ser positivo y estar expresado en centavos enteros.');
  return Number(value);
}
function text(value: unknown, label: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max)
    throw new ApiError(400, `${label} inválido.`);
  return value.trim();
}

export function initializeBilling(raw: DatabaseSync) {
  raw.exec(`CREATE TABLE IF NOT EXISTS platform_billing_config(gym_id TEXT PRIMARY KEY REFERENCES gyms(id),monthly_fee_cents INTEGER NOT NULL CHECK(monthly_fee_cents>0),start_month TEXT NOT NULL,due_day INTEGER NOT NULL CHECK(due_day BETWEEN 1 AND 28));
    CREATE TABLE IF NOT EXISTS platform_billing_intervals(id TEXT PRIMARY KEY,gym_id TEXT NOT NULL REFERENCES gyms(id),start_month TEXT NOT NULL,end_month TEXT);
    CREATE INDEX IF NOT EXISTS platform_billing_intervals_gym ON platform_billing_intervals(gym_id);
    CREATE UNIQUE INDEX IF NOT EXISTS platform_billing_intervals_open ON platform_billing_intervals(gym_id) WHERE end_month IS NULL;
    CREATE TABLE IF NOT EXISTS platform_billing_charges(id TEXT PRIMARY KEY,gym_id TEXT NOT NULL REFERENCES gyms(id),month TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),due_on TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(gym_id,month));
    CREATE TABLE IF NOT EXISTS platform_billing_payments(id TEXT PRIMARY KEY,gym_id TEXT NOT NULL REFERENCES gyms(id),charge_id TEXT NOT NULL REFERENCES platform_billing_charges(id),request_id TEXT NOT NULL,payload TEXT NOT NULL,amount_cents INTEGER NOT NULL CHECK(amount_cents>0),paid_on TEXT NOT NULL,method TEXT NOT NULL CHECK(method IN ('cash','transfer','card')),reference TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES platform_users(id),created_at INTEGER NOT NULL,voided_at INTEGER,voided_by TEXT REFERENCES platform_users(id),void_reason TEXT,UNIQUE(gym_id,request_id));
    CREATE INDEX IF NOT EXISTS platform_billing_payments_charge ON platform_billing_payments(charge_id);`);
  // The first interval covers the configured start; later resumptions begin in their actual month.
  raw
    .prepare(
      "INSERT INTO platform_billing_intervals(id,gym_id,start_month) SELECT lower(hex(randomblob(16))),id,'0001-01' FROM gyms WHERE status='active' AND archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM platform_billing_intervals i WHERE i.gym_id=gyms.id)",
    )
    .run();
}

export function recordBillingActivity(
  raw: DatabaseSync,
  gymId: string,
  wasActive: boolean,
  active: boolean,
  initialActivation = false,
) {
  if (wasActive === active) return;
  const currentMonth = today().slice(0, 7);
  const history = raw.prepare('SELECT 1 FROM platform_billing_intervals WHERE gym_id=?').get(gymId);
  if (wasActive) {
    if (!history)
      raw
        .prepare('INSERT INTO platform_billing_intervals(id,gym_id,start_month,end_month) VALUES(?,?,?,?)')
        .run(randomUUID(), gymId, '0001-01', currentMonth);
    else
      raw
        .prepare('UPDATE platform_billing_intervals SET end_month=? WHERE gym_id=? AND end_month IS NULL')
        .run(currentMonth, gymId);
  } else if (active)
    raw
      .prepare('INSERT INTO platform_billing_intervals(id,gym_id,start_month) VALUES(?,?,?)')
      .run(randomUUID(), gymId, initialActivation && !history ? '0001-01' : currentMonth);
}

export class PlatformBilling {
  private store: PlatformStore;
  private raw: DatabaseSync;
  constructor(store: PlatformStore) {
    this.store = store;
    this.raw = store.raw;
  }

  private authorize(user: PlatformUser, gymId?: string) {
    const current = this.raw.prepare('SELECT global_role,active FROM platform_users WHERE id=?').get(user.id) as
      Row | undefined;
    if (!current?.active) throw new ApiError(401, 'Inicia sesión de nuevo.');
    if (current.global_role !== 'superadmin') throw new ApiError(403, 'Se requiere superadministrador.');
    if (gymId && !this.store.getGym(gymId)) throw new ApiError(404, 'Gimnasio no encontrado.');
  }
  private transaction<T>(work: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }
  private config(gymId: string) {
    return this.raw
      .prepare('SELECT monthly_fee_cents,start_month,due_day FROM platform_billing_config WHERE gym_id=?')
      .get(gymId) as BillingConfig | undefined;
  }

  private generate(gymId: string) {
    const config = this.config(gymId);
    if (!config) return;
    const intervals = this.raw
      .prepare('SELECT start_month,end_month FROM platform_billing_intervals WHERE gym_id=?')
      .all(gymId) as Row[];
    const current = today().slice(0, 7);
    for (let cursor = config.start_month; cursor <= current;) {
      if (intervals.some((i) => cursor >= i.start_month && (!i.end_month || cursor <= i.end_month))) {
        this.raw
          .prepare(
            'INSERT OR IGNORE INTO platform_billing_charges(id,gym_id,month,amount_cents,due_on,created_at) VALUES(?,?,?,?,?,?)',
          )
          .run(
            randomUUID(),
            gymId,
            cursor,
            config.monthly_fee_cents,
            cursor + '-' + String(config.due_day).padStart(2, '0'),
            Date.now(),
          );
      }
      const [year, mon] = cursor.split('-').map(Number);
      cursor = mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
    }
  }

  account(user: PlatformUser, gymId: string): BillingAccount {
    this.authorize(user, gymId);
    return this.transaction(() => {
      this.generate(gymId);
      return this.readAccount(gymId);
    });
  }
  private readAccount(gymId: string): BillingAccount {
    const rows = this.raw
      .prepare(
        `SELECT c.id,c.month,c.amount_cents,c.due_on,COALESCE(SUM(CASE WHEN p.voided_at IS NULL THEN p.amount_cents ELSE 0 END),0) AS paid_cents FROM platform_billing_charges c LEFT JOIN platform_billing_payments p ON p.charge_id=c.id WHERE c.gym_id=? GROUP BY c.id ORDER BY c.month DESC`,
      )
      .all(gymId) as Row[];
    const charges: BillingCharge[] = rows.map((r) => {
      const balance = r.amount_cents - r.paid_cents;
      return {
        ...r,
        balance_cents: balance,
        status: !balance ? 'paid' : r.due_on < today() ? 'overdue' : r.paid_cents ? 'partial' : 'pending',
      } as BillingCharge;
    });
    const payments = this.raw
      .prepare(
        'SELECT p.id,p.request_id,p.charge_id,p.amount_cents,p.paid_on,p.method,p.reference,p.created_by,p.created_at,p.voided_at,p.void_reason,u.name AS actor_name FROM platform_billing_payments p JOIN platform_users u ON u.id=p.created_by WHERE p.gym_id=? ORDER BY p.created_at DESC,p.id',
      )
      .all(gymId) as BillingPayment[];
    return {
      currency: 'BOB',
      config: this.config(gymId) ?? null,
      charges,
      payments,
      balance_cents: charges.reduce((sum, c) => sum + c.balance_cents, 0),
    };
  }

  configure(user: PlatformUser, gymId: string, input: BillingConfig) {
    this.authorize(user, gymId);
    const amount = money(input.monthly_fee_cents),
      start = month(input.start_month);
    if (!Number.isInteger(input.due_day) || input.due_day < 1 || input.due_day > 28)
      throw new ApiError(400, 'El vencimiento debe ser un día entre 1 y 28.');
    return this.transaction(() => {
      this.generate(gymId);
      this.raw
        .prepare(
          'INSERT INTO platform_billing_config(gym_id,monthly_fee_cents,start_month,due_day) VALUES(?,?,?,?) ON CONFLICT(gym_id) DO UPDATE SET monthly_fee_cents=excluded.monthly_fee_cents,start_month=excluded.start_month,due_day=excluded.due_day',
        )
        .run(gymId, amount, start, input.due_day);
      this.generate(gymId);
      this.store.audit(user.id, 'billing.configured', gymId);
      return this.readAccount(gymId);
    });
  }

  pay(user: PlatformUser, gymId: string, input: BillingPaymentInput): BillingPayment {
    this.authorize(user, gymId);
    const normalized = {
      request_id: text(input.request_id, 'Identificador de operación', 120),
      charge_id: text(input.charge_id, 'Cargo', 120),
      amount_cents: money(input.amount_cents),
      paid_on: input.paid_on,
      method: input.method,
      reference: input.reference === undefined ? '' : text(input.reference, 'Referencia', 300, 0),
    };
    if (
      typeof normalized.paid_on !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(normalized.paid_on) ||
      !Number.isFinite(Date.parse(normalized.paid_on)) ||
      new Date(normalized.paid_on).toISOString().slice(0, 10) !== normalized.paid_on ||
      normalized.paid_on > today()
    )
      throw new ApiError(400, 'Introduce una fecha de pago válida, hasta hoy.');
    if (!['cash', 'transfer', 'card'].includes(normalized.method)) throw new ApiError(400, 'Método de pago inválido.');
    const payload = JSON.stringify(normalized);
    return this.transaction(() => {
      const existing = this.raw
        .prepare('SELECT * FROM platform_billing_payments WHERE gym_id=? AND request_id=?')
        .get(gymId, normalized.request_id) as Row | undefined;
      if (existing) {
        if (existing.payload !== payload) throw new ApiError(409, 'La operación ya fue utilizada con otros datos.');
        return this.readAccount(gymId).payments.find((p) => p.id === existing.id)!;
      }
      this.generate(gymId);
      const charge = this.readAccount(gymId).charges.find((c) => c.id === normalized.charge_id);
      if (!charge) throw new ApiError(404, 'Cargo no encontrado en este gimnasio.');
      if (normalized.amount_cents > charge.balance_cents)
        throw new ApiError(409, 'El importe supera el saldo del cargo.');
      const id = randomUUID();
      this.raw
        .prepare(
          'INSERT INTO platform_billing_payments(id,gym_id,charge_id,request_id,payload,amount_cents,paid_on,method,reference,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          id,
          gymId,
          normalized.charge_id,
          normalized.request_id,
          payload,
          normalized.amount_cents,
          normalized.paid_on,
          normalized.method,
          normalized.reference,
          user.id,
          Date.now(),
        );
      this.store.audit(user.id, 'billing.payment_created', gymId, id);
      return this.readAccount(gymId).payments.find((p) => p.id === id)!;
    });
  }

  voidPayment(user: PlatformUser, gymId: string, paymentId: string, reason: string) {
    this.authorize(user, gymId);
    const normalized = text(reason, 'Motivo de anulación', 1000, 3);
    return this.transaction(() => {
      const payment = this.raw
        .prepare('SELECT * FROM platform_billing_payments WHERE id=? AND gym_id=?')
        .get(paymentId, gymId) as Row | undefined;
      if (!payment) throw new ApiError(404, 'Pago no encontrado en este gimnasio.');
      if (!payment.voided_at) {
        this.raw
          .prepare('UPDATE platform_billing_payments SET voided_at=?,voided_by=?,void_reason=? WHERE id=?')
          .run(Date.now(), user.id, normalized, paymentId);
        this.store.audit(user.id, 'billing.payment_voided', gymId, paymentId);
      }
      return this.readAccount(gymId).payments.find((p) => p.id === paymentId)!;
    });
  }

  summary(user: PlatformUser, selectedMonth: string) {
    this.authorize(user);
    const selected = month(selectedMonth);
    return this.transaction(() => {
      const gyms = this.store.listAllGyms();
      const rows = gyms.map((gym) => {
        this.generate(gym.id);
        const account = this.readAccount(gym.id),
          charge = account.charges.find((c) => c.month === selected);
        return {
          gym_id: gym.id,
          name: gym.name,
          archived: gym.archived,
          configured: Boolean(account.config),
          amount_cents: charge?.amount_cents ?? 0,
          paid_cents: charge?.paid_cents ?? 0,
          balance_cents: charge?.balance_cents ?? 0,
          status: charge?.status ?? 'no_charge',
          total_balance_cents: account.balance_cents,
        };
      });
      return {
        month: selected,
        currency: 'BOB',
        rows,
        amount_cents: rows.reduce((s, r) => s + r.amount_cents, 0),
        paid_cents: rows.reduce((s, r) => s + r.paid_cents, 0),
        balance_cents: rows.reduce((s, r) => s + r.balance_cents, 0),
      };
    });
  }
}
