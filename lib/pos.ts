import { z } from 'zod';
import { ApiError, hash, personSchema, randomToken, type Service } from './service.ts';
import { localParts, nextDate } from './domain.ts';
import {
  planEndDate,
  type PosCatalog,
  type PosProduct,
  type PosPlan,
  type PosSaleDetail,
  type PosSales,
  type PosReport,
  type PosReportPeriod,
  type PlanGate,
  type MembershipSummary,
  type PosMembership,
} from './pos-types.ts';
export { planEndDate } from './pos-types.ts';

const reportLimit: Record<PosReportPeriod, number> = { day: 366, week: 160, month: 120, year: 50 };
const reportUnit: Record<PosReportPeriod, string> = { day: 'día', week: 'semana', month: 'mes', year: 'año' };
/** Claves de cada grupo del rango, incluidos los vacíos: la semana se identifica por su lunes. */
export function reportBuckets(period: PosReportPeriod, from: string, to: string) {
  const keys: string[] = [];
  if (period === 'day') {
    for (let day = from; day <= to && keys.length <= 400; day = nextDate(day, 1)) keys.push(day);
    return keys;
  }
  if (period === 'week') {
    const weekday = (new Date(from + 'T00:00:00Z').getUTCDay() + 6) % 7;
    for (let day = nextDate(from, -weekday); day <= to && keys.length <= 400; day = nextDate(day, 7)) keys.push(day);
    return keys;
  }
  const size = period === 'month' ? 7 : 4;
  let year = Number(from.slice(0, 4)),
    month = Number(from.slice(5, 7));
  for (;;) {
    const key = period === 'month' ? `${year}-${String(month).padStart(2, '0')}` : String(year);
    if (key > to.slice(0, size) || keys.length > 400) return keys;
    keys.push(key);
    if (period === 'year') year++;
    else if (++month > 12) ((month = 1), year++);
  }
}
const text = z.string().trim().min(1).max(120);
const cents = z.number().int().min(0).max(1000000000);
const flag = z.union([z.boolean(), z.number().int().min(0).max(1)]).transform(Number);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v, 'Fecha inválida');
const productSchema = z.object({
  name: text,
  sku: z.string().trim().max(80).default(''),
  category: z.string().trim().max(100).default(''),
  price_cents: cents,
  stock: z.number().int().min(0).max(1000000000).optional(),
  track_stock: flag.default(1),
  active: flag.default(1),
});
const planSchema = z.object({
  name: text,
  price_cents: cents,
  unit: z.enum(['days', 'months', 'sessions']),
  duration: z.number().int().positive().max(3660),
  active: flag.default(1),
});
const checkoutSchema = z.object({
  expected_total_cents: z.number().int().min(0).max(100000000000).optional(),
  request_id: z.string().uuid(),
  person_id: text.optional(),
  // El alta con cobro vale tanto para un socio como para alguien del personal.
  new_member: personSchema
    .extend({ kind: z.enum(['member', 'employee']), status: z.literal('active'), expires: z.null().default(null) })
    .optional(),
  start_date: date.optional(),
  // Solo el administrador: da de baja el plan en curso del socio para vender uno nuevo.
  replace_active: z.object({ reason: z.string().trim().min(3).max(300) }).optional(),
  payment_method: z.enum(['cash', 'transfer', 'card']),
  lines: z
    .array(
      z.object({
        kind: z.enum(['product', 'plan']),
        id: text,
        quantity: z.number().int().positive().max(1000),
        expected_plan: z
          .object({ unit: z.enum(['days', 'months', 'sessions']), duration: z.number().int().positive().max(3660) })
          .optional(),
      }),
    )
    .min(1)
    .max(100),
});
export class PosService {
  service: Service;
  constructor(service: Service) {
    this.service = service;
  }
  async today() {
    const settings = await this.service.one('SELECT timezone FROM settings WHERE id=1');
    return localParts(new Date(), settings!.timezone).date;
  }
  async atomic(statements: Parameters<Service['db']['batch']>[0]) {
    try {
      await this.service.db.batch(statements);
    } catch (error) {
      const message = String(error);
      if (/POS_STOCK|CHECK constraint failed: stock/.test(message))
        throw new ApiError(409, 'Existencias insuficientes.');
      if (message.includes('POS_ACTIVE_PLAN'))
        throw new ApiError(409, 'Este socio ya tiene un plan en curso. Actualiza su ficha e inténtalo de nuevo.');
      if (message.includes('POS_STARTED')) throw new ApiError(409, 'El plan ya comenzó o se consumió una sesión.');
      if (message.includes('POS_MEMBER_REQUIRED'))
        throw new ApiError(
          409,
          'Selecciona un socio o alguien del personal, activo y sin dar de baja, para vender un plan.',
        );
      if (message.includes('POS_CATALOG_CHANGED'))
        throw new ApiError(409, 'El catálogo cambió. Revisa la venta e inténtalo de nuevo.');
      if (message.includes('pos_products.sku')) throw new ApiError(409, 'Ya existe un producto con ese código.');
      throw error;
    }
  }
  async catalog(): Promise<PosCatalog> {
    const [products, plans] = await Promise.all([
      this.service.all('SELECT * FROM pos_products ORDER BY name,id'),
      this.service.all('SELECT * FROM pos_plans ORDER BY name,id'),
    ]);
    return { products: products as PosProduct[], plans: plans as PosPlan[] };
  }
  async saveProduct(body: unknown, id?: string): Promise<PosProduct> {
    this.service.require('admin');
    const p = productSchema.parse(body),
      key = id || crypto.randomUUID();
    if (id) await this.service.exists('pos_products', id);
    if (id && p.stock !== undefined) {
      const existing = await this.service.one('SELECT stock FROM pos_products WHERE id=?', id);
      if (existing!.stock !== p.stock)
        throw new ApiError(400, 'Usa un ajuste con motivo para cambiar las existencias.');
    }
    await this.atomic([
      id
        ? this.service.stmt(
            'UPDATE pos_products SET name=?,sku=?,category=?,price_cents=?,track_stock=?,active=? WHERE id=?',
            p.name,
            p.sku,
            p.category,
            p.price_cents,
            p.track_stock,
            p.active,
            key,
          )
        : this.service.stmt(
            'INSERT INTO pos_products(id,name,sku,category,price_cents,stock,track_stock,active) VALUES(?,?,?,?,?,?,?,?)',
            key,
            p.name,
            p.sku,
            p.category,
            p.price_cents,
            p.stock || 0,
            p.track_stock,
            p.active,
          ),
      ...(!id && p.stock
        ? [
            this.service.stmt(
              'INSERT INTO pos_stock_movements(id,product_id,quantity,reason,actor,created_at) VALUES(?,?,?,?,?,?)',
              crypto.randomUUID(),
              key,
              p.stock,
              'Existencia inicial',
              this.service.actor.email,
              Date.now(),
            ),
          ]
        : []),
      this.service.audit(id ? 'pos.product.updated' : 'pos.product.created', key),
    ]);
    return (await this.service.one('SELECT * FROM pos_products WHERE id=?', key)) as PosProduct;
  }
  async adjustStock(id: string, body: unknown): Promise<PosProduct> {
    this.service.require('admin');
    const p = z
      .object({
        quantity: z
          .number()
          .int()
          .min(-1000000000)
          .max(1000000000)
          .refine((v) => v !== 0),
        reason: z.string().trim().min(3).max(300),
      })
      .parse(body);
    await this.service.exists('pos_products', id);
    await this.atomic([
      this.service.stmt('UPDATE pos_products SET stock=stock+? WHERE id=?', p.quantity, id),
      this.service.stmt(
        'INSERT INTO pos_stock_movements(id,product_id,quantity,reason,actor,created_at) VALUES(?,?,?,?,?,?)',
        crypto.randomUUID(),
        id,
        p.quantity,
        p.reason,
        this.service.actor.email,
        Date.now(),
      ),
      this.service.audit('pos.stock.adjusted', id),
    ]);
    return (await this.service.one('SELECT * FROM pos_products WHERE id=?', id)) as PosProduct;
  }
  async savePlan(body: unknown, id?: string): Promise<PosPlan> {
    this.service.require('admin');
    const p = planSchema.parse(body),
      key = id || crypto.randomUUID();
    if (p.unit === 'months' && p.duration > 120) throw new ApiError(400, 'La duración máxima es de 120 meses.');
    if (id) await this.service.exists('pos_plans', id);
    await this.atomic([
      id
        ? this.service.stmt(
            'UPDATE pos_plans SET name=?,unit=?,duration=?,price_cents=?,active=? WHERE id=?',
            p.name,
            p.unit,
            p.duration,
            p.price_cents,
            p.active,
            key,
          )
        : this.service.stmt(
            'INSERT INTO pos_plans(id,name,unit,duration,price_cents,active) VALUES(?,?,?,?,?,?)',
            key,
            p.name,
            p.unit,
            p.duration,
            p.price_cents,
            p.active,
          ),
      this.service.audit(id ? 'pos.plan.updated' : 'pos.plan.created', key),
    ]);
    return (await this.service.one('SELECT * FROM pos_plans WHERE id=?', key)) as PosPlan;
  }
  async checkout(body: unknown): Promise<PosSaleDetail> {
    this.service.require('operator');
    const p = checkoutSchema.parse(body);
    const today = await this.today();
    let start = p.new_member ? today : p.start_date || today;
    if (p.new_member) {
      this.service.require('admin');
      if (p.person_id || p.start_date || !p.lines.some((line) => line.kind === 'plan'))
        throw new ApiError(400, 'El alta requiere un socio nuevo y un plan que comience hoy.');
    }
    const normalized = {
      expected_total_cents: p.expected_total_cents ?? null,
      person_id: p.person_id || null,
      start_date: p.start_date || null,
      ...(p.replace_active ? { replace_active: p.replace_active.reason } : {}),
      payment_method: p.payment_method,
      lines: p.lines,
      ...(p.new_member ? { new_member: p.new_member } : {}),
    };
    const payloadHash = await hash(JSON.stringify(normalized));
    const retry = async () => {
      const previous = await this.service.one('SELECT * FROM pos_sales WHERE request_id=?', p.request_id);
      if (!previous) return null;
      if (previous.payload_hash !== payloadHash)
        throw new ApiError(409, 'El identificador de solicitud ya se utilizó con otros datos.');
      return this.sale(previous.id);
    };
    const previous = await retry();
    if (previous) return previous;
    const registration = p.new_member ? await this.service.preparePerson(p.new_member) : null;
    const personId = registration?.id || p.person_id;
    const person =
      registration?.person || (personId ? await this.service.one('SELECT * FROM people WHERE id=?', personId) : null);
    if (p.person_id && !person) throw new ApiError(404, 'Socio no encontrado.');
    // Los planes se venden a socios y al personal del gimnasio; un visitante entra por invitación.
    if (p.lines.some((l) => l.kind === 'plan')) {
      if (!person || !['member', 'employee'].includes(String(person.kind)) || person.status !== 'active')
        throw new ApiError(400, 'Selecciona un socio o alguien del personal, activo, para vender un plan.');
      // Una ficha recién registrada nunca está de baja; solo hay que mirar las que vienen de la base.
      if ('deleted_at' in person && person.deleted_at)
        throw new ApiError(409, 'Esta ficha está dada de baja. Restáurala antes de venderle un plan.');
      if (person.kind === 'member' && !/^[1-9]\d{8,14}$/.test(String(person.phone || '')))
        throw new ApiError(400, 'Registra el WhatsApp del socio antes de cobrar su plan.');
    }
    const planLines = p.lines.filter((line) => line.kind === 'plan');
    if (planLines.length > 1 || planLines.some((line) => line.quantity > 1))
      throw new ApiError(400, 'Un socio solo puede tener un plan: vende uno a la vez.');
    let replacing = false;
    if (planLines.length && !registration) {
      const gate = await this.planGate(personId!, today);
      if (p.replace_active) {
        this.service.require('admin');
        replacing = gate.state !== 'free';
      } else if (gate.state === 'blocked') throw new ApiError(409, gate.message);
      else if (gate.state === 'renewal' && start < gate.start_date) start = gate.start_date;
    }
    const items = await Promise.all(
      p.lines.map(async (line) => {
        const item = await this.service.one(
          `SELECT * FROM ${line.kind === 'product' ? 'pos_products' : 'pos_plans'} WHERE id=?`,
          line.id,
        );
        if (!item || !item.active) throw new ApiError(409, 'El producto o plan ya no está disponible.');
        if (
          line.kind === 'plan' &&
          line.expected_plan &&
          (item.unit !== line.expected_plan.unit || item.duration !== line.expected_plan.duration)
        )
          throw new ApiError(409, 'El plan cambió. Actualiza el catálogo y revisa la vigencia antes de confirmar.');
        return { ...line, item, lineId: crypto.randomUUID() };
      }),
    );
    const total = items.reduce((sum, line) => sum + line.item.price_cents * line.quantity, 0);
    if (p.expected_total_cents !== undefined && total !== p.expected_total_cents)
      throw new ApiError(409, 'El precio cambió. Actualiza el catálogo y revisa el total antes de confirmar.');
    if (!Number.isSafeInteger(total) || total > 100000000000)
      throw new ApiError(400, 'El importe de venta es demasiado alto.');
    const monthly = items.some((line) => line.kind === 'plan' && line.item.unit === 'months');
    const credentialId = monthly ? crypto.randomUUID() : null;
    const id = crypto.randomUUID(),
      now = Date.now();
    const statements = [
      ...(registration?.statements || []),
      this.service.stmt(
        'INSERT INTO pos_sales(id,request_id,payload_hash,person_id,person_name,actor,created_at,local_date,start_date,payment_method,total_cents,replace_reason,credential_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id,
        p.request_id,
        payloadHash,
        personId || null,
        person?.name || null,
        this.service.actor.email,
        now,
        today,
        start,
        p.payment_method,
        total,
        replacing ? p.replace_active!.reason : null,
        credentialId,
      ),
      ...(replacing
        ? [
            this.service.stmt(
              `UPDATE pos_memberships SET status='void' WHERE person_id=? AND status='active'
               AND ((unit<>'sessions' AND end_date>?) OR (unit='sessions' AND sessions_remaining>0))`,
              personId,
              today,
            ),
            this.service.audit('pos.plan.replaced', id),
          ]
        : []),
    ];
    for (const line of items) {
      const item = line.item;
      statements.push(
        this.service.stmt(
          'INSERT INTO pos_sale_lines(id,sale_id,kind,item_id,name,quantity,price_cents,total_cents,track_stock,unit,duration) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          line.lineId,
          id,
          line.kind,
          line.id,
          item.name,
          line.quantity,
          item.price_cents,
          item.price_cents * line.quantity,
          line.kind === 'product' ? item.track_stock : 0,
          item.unit || null,
          item.duration || null,
        ),
      );
      if (line.kind === 'plan')
        for (let n = 0; n < line.quantity; n++)
          statements.push(
            this.service.stmt(
              'INSERT INTO pos_memberships(id,sale_id,line_id,person_id,name,unit,duration,price_cents,start_date,end_date,sessions_total,sessions_remaining,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
              crypto.randomUUID(),
              id,
              line.lineId,
              personId,
              item.name,
              item.unit,
              item.duration,
              item.price_cents,
              start,
              planEndDate(start, item.unit, item.duration),
              item.unit === 'sessions' ? item.duration : null,
              item.unit === 'sessions' ? item.duration : null,
              now,
            ),
          );
    }
    if (credentialId) {
      const code = randomToken('GYM');
      statements.push(
        this.service.stmt(
          "UPDATE credentials SET active=0 WHERE person_id=? AND kind='qr' AND active=1 AND NOT EXISTS(SELECT 1 FROM visits WHERE credential_id=credentials.id)",
          personId,
        ),
        this.service.stmt(
          'INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher) VALUES(?,?,?,?,?,?,?,?)',
          credentialId,
          personId,
          'qr',
          'Pago mensual',
          await hash(code),
          code.slice(-6),
          now,
          this.service.codec?.seal(code, credentialId) || null,
        ),
        this.service.audit('credential.monthly', credentialId),
      );
    }
    statements.push(this.service.audit('pos.sale.created', id));
    try {
      await this.atomic(statements);
    } catch (error) {
      const repeated = await retry();
      if (repeated) return repeated;
      throw error;
    }
    return this.sale(id);
  }
  async sale(id: string): Promise<PosSaleDetail> {
    const sale = await this.service.one('SELECT * FROM pos_sales WHERE id=?', id);
    if (!sale) throw new ApiError(404, 'Venta no encontrada.');
    const lines = await this.service.all('SELECT * FROM pos_sale_lines WHERE sale_id=? ORDER BY rowid', id);
    const memberships = await this.service.all('SELECT * FROM pos_memberships WHERE sale_id=? ORDER BY rowid', id);
    const warnings: string[] = [];
    for (const m of memberships.filter((m) => m.unit !== 'sessions' && m.status === 'active')) {
      const overlaps = await this.service.one(
        "SELECT id FROM pos_memberships WHERE person_id=? AND id<>? AND status='active' AND unit<>'sessions' AND start_date<? AND end_date>? LIMIT 1",
        m.person_id,
        m.id,
        m.end_date,
        m.start_date,
      );
      if (overlaps) {
        warnings.push('Hay planes temporales que se solapan para este socio.');
        break;
      }
    }
    const credential = sale.credential_id
      ? await this.service.one(
          'SELECT c.id,c.active,p.phone FROM credentials c JOIN people p ON p.id=c.person_id WHERE c.id=?',
          sale.credential_id,
        )
      : null;
    return { ...sale, lines, memberships, warnings, credential } as PosSaleDetail;
  }
  async sales(params: URLSearchParams): Promise<PosSales> {
    const conditions: string[] = [],
      args: unknown[] = [];
    for (const [key, column] of [
      ['from', 'local_date>=?'],
      ['to', 'local_date<=?'],
      ['person', 'person_id=?'],
      ['payment_method', 'payment_method=?'],
      ['status', 'status=?'],
    ] as const) {
      const value = params.get(key);
      if (!value) continue;
      if (key === 'from' || key === 'to') date.parse(value);
      if (key === 'payment_method') z.enum(['cash', 'transfer', 'card']).parse(value);
      if (key === 'status') z.enum(['paid', 'void']).parse(value);
      conditions.push(column);
      args.push(value);
    }
    if (params.get('from') && params.get('to') && params.get('from')! > params.get('to')!)
      throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    const q = params.get('q')?.trim().slice(0, 120);
    if (q) {
      conditions.push('(person_name LIKE ? OR id LIKE ?)');
      args.push('%' + q + '%', '%' + q + '%');
    }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const page = Math.max(1, Math.min(100000, Math.floor(Number(params.get('page')) || 1)));
    const [rows, count, by_method] = await Promise.all([
      this.service.all(
        `SELECT * FROM pos_sales ${where} ORDER BY created_at DESC,rowid DESC LIMIT 50 OFFSET ?`,
        ...args,
        (page - 1) * 50,
      ),
      this.service.one(
        `SELECT COUNT(*) total,COALESCE(SUM(CASE WHEN status='paid' THEN total_cents ELSE 0 END),0) total_cents FROM pos_sales ${where}`,
        ...args,
      ),
      this.service.all(
        `SELECT payment_method,SUM(total_cents) total_cents,COUNT(*) count FROM pos_sales ${where}${where ? ' AND' : ' WHERE'} status='paid' GROUP BY payment_method`,
        ...args,
      ),
    ]);
    return { rows, total: count!.total, page, total_cents: count!.total_cents, by_method } as PosSales;
  }
  /** Ingresos pagados del rango agrupados por día, semana (lunes), mes o año, con rankings y desgloses. */
  async report(params: URLSearchParams): Promise<PosReport> {
    this.service.require('admin');
    const period = z.enum(['day', 'week', 'month', 'year']).parse(params.get('period') || 'day') as PosReportPeriod;
    const from = date.parse(params.get('from')),
      to = date.parse(params.get('to'));
    if (from > to) throw new ApiError(400, 'La fecha inicial debe ser anterior a la final.');
    const keys = reportBuckets(period, from, to);
    if (keys.length > reportLimit[period])
      throw new ApiError(400, 'El rango es demasiado largo para agrupar por ' + reportUnit[period] + '. Acórtalo.');
    const bucket = {
      day: 's.local_date',
      week: "date(s.local_date,'weekday 0','-6 days')",
      month: 'substr(s.local_date,1,7)',
      year: 'substr(s.local_date,1,4)',
    }[period];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
    const previous = { from: nextDate(from, -days), to: nextDate(from, -1) };
    const paid = "s.status='paid' AND s.local_date BETWEEN ? AND ?";
    const item = (kind: 'plan' | 'product') =>
      this.service.all(
        `SELECT l.item_id,MAX(l.name) name,SUM(l.quantity) quantity,SUM(l.total_cents) total_cents
         FROM pos_sale_lines l JOIN pos_sales s ON s.id=l.sale_id
         WHERE ${paid} AND l.kind=? GROUP BY l.item_id ORDER BY total_cents DESC,quantity DESC,name LIMIT 20`,
        from,
        to,
        kind,
      );
    const [totals, voided, before, rows, plans, products, by_method, by_cashier] = await Promise.all([
      this.service.one(
        `SELECT COUNT(*) count,COALESCE(SUM(total_cents),0) total_cents FROM pos_sales s WHERE ${paid}`,
        from,
        to,
      ),
      this.service.one(
        `SELECT COUNT(*) count,COALESCE(SUM(total_cents),0) total_cents FROM pos_sales s WHERE s.status='void' AND s.local_date BETWEEN ? AND ?`,
        from,
        to,
      ),
      this.service.one(
        `SELECT COUNT(*) count,COALESCE(SUM(total_cents),0) total_cents FROM pos_sales s WHERE ${paid}`,
        previous.from,
        previous.to,
      ),
      this.service.all(
        `SELECT ${bucket} bucket,COUNT(*) count,SUM(total_cents) total_cents FROM pos_sales s WHERE ${paid} GROUP BY bucket`,
        from,
        to,
      ),
      item('plan'),
      item('product'),
      this.service.all(
        `SELECT payment_method,SUM(total_cents) total_cents,COUNT(*) count FROM pos_sales s WHERE ${paid} GROUP BY payment_method ORDER BY total_cents DESC`,
        from,
        to,
      ),
      this.service.all(
        `SELECT s.actor,COALESCE(m.name,s.actor) name,SUM(s.total_cents) total_cents,COUNT(*) count
         FROM pos_sales s LEFT JOIN members m ON m.email=s.actor WHERE ${paid} GROUP BY s.actor ORDER BY total_cents DESC`,
        from,
        to,
      ),
    ]);
    const found = new Map(rows.map((row) => [String(row.bucket), row]));
    return {
      period,
      from,
      to,
      summary: {
        count: totals!.count,
        total_cents: totals!.total_cents,
        average_cents: totals!.count ? Math.round(totals!.total_cents / totals!.count) : 0,
        void_count: voided!.count,
        void_cents: voided!.total_cents,
        previous: { ...previous, count: before!.count, total_cents: before!.total_cents },
      },
      series: keys.map((key) => ({
        bucket: key,
        count: Number(found.get(key)?.count ?? 0),
        total_cents: Number(found.get(key)?.total_cents ?? 0),
      })),
      plans,
      products,
      by_method,
      by_cashier,
    } as PosReport;
  }
  async voidSale(id: string, body: unknown): Promise<PosSaleDetail> {
    this.service.require('admin');
    const p = z.object({ reason: z.string().trim().min(3).max(300) }).parse(body);
    await this.service.exists('pos_sales', id);
    const now = Date.now(),
      today = await this.today();
    await this.atomic([
      this.service.stmt(
        "UPDATE pos_sales SET status='void',void_reason=?,void_by=?,void_at=?,void_local_date=? WHERE id=? AND status='paid'",
        p.reason,
        this.service.actor.email,
        now,
        today,
        id,
      ),
      this.service.stmt(
        "INSERT INTO audit(actor,action,entity_id,occurred_at) SELECT ?,'pos.sale.voided',?,? WHERE changes()>0",
        this.service.actor.email,
        id,
        now,
      ),
    ]);
    return this.sale(id);
  }
  /**
   * Un socio solo puede tener un plan en curso. Si el actual vence, el siguiente puede comprarse por
   * adelantado y empieza el día en que termina; con sesiones disponibles o una renovación ya comprada, no.
   */
  async planGate(personId: string, today: string): Promise<PlanGate> {
    const rows = (await this.service.all(
      `SELECT name,unit,start_date,end_date,sessions_remaining FROM pos_memberships
       WHERE person_id=? AND status='active' AND ((unit<>'sessions' AND end_date>?) OR (unit='sessions' AND sessions_remaining>0))
       ORDER BY start_date,created_at,rowid`,
      personId,
      today,
    )) as {
      name: string;
      unit: string;
      start_date: string;
      end_date: string | null;
      sessions_remaining: number | null;
    }[];
    if (!rows.length) return { state: 'free' };
    const sessions = rows.find((row) => row.unit === 'sessions');
    if (sessions)
      return {
        state: 'blocked',
        message: `Ya tiene «${sessions.name}» con ${sessions.sessions_remaining} sesión(es) disponibles. Podrá comprar otro plan cuando las agote.`,
      };
    const queued = rows.find((row) => row.start_date > today);
    if (queued)
      return {
        state: 'blocked',
        message: `Ya tiene «${queued.name}» por comenzar el ${queued.start_date}. Podrá comprar otro plan cuando termine.`,
      };
    // Con membresías antiguas solapadas manda la que termina más tarde: el nuevo plan empieza después de todas.
    const current = rows.reduce((last, row) => (row.end_date! > last.end_date! ? row : last));
    return {
      state: 'renewal',
      start_date: current.end_date!,
      message: `Tiene «${current.name}» hasta el ${nextDate(current.end_date!, -1)}. El plan nuevo empezará el ${current.end_date}.`,
    };
  }
  async memberships(id: string): Promise<MembershipSummary> {
    const person = await this.service.one('SELECT * FROM people WHERE id=?', id);
    if (!person) throw new ApiError(404, 'Persona no encontrada.');
    const today = await this.today();
    const memberships = (await this.service.all(
      'SELECT * FROM pos_memberships WHERE person_id=? ORDER BY created_at DESC,rowid DESC',
      id,
    )) as PosMembership[];
    const active = memberships.filter((m) => m.status === 'active' && m.start_date <= today);
    const temporal = active.filter((m) => m.end_date && m.end_date > today);
    const sessions = active.reduce((sum, m) => sum + (m.sessions_remaining || 0), 0);
    const managed = memberships.length > 0;
    return {
      plan_gate: await this.planGate(id, today),
      managed,
      legacy: !managed,
      legacy_expires: person.expires,
      valid:
        person.status === 'active' &&
        (managed ? temporal.length > 0 || sessions > 0 : !person.expires || person.expires >= today),
      valid_until:
        temporal
          .map((m) => nextDate(m.end_date!, -1))
          .sort()
          .at(-1) || null,
      sessions_remaining: sessions,
      memberships,
    };
  }
}
