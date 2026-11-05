import { z } from 'zod';
import { ApiError, Service, hash, randomToken, presenceSql } from './service.ts';
import { generalAccessId, type InvitationBatch, type InvitationTicket } from './domain.ts';

const batchSchema = z.object({
  name: z.string().trim().min(2).max(120),
  expected_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(
      (value) => !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value,
      'Fecha inválida',
    ),
  quantity: z.number().int().min(1).max(1000),
  request_id: z.string().uuid(),
  access_mode: z.enum(['single', 'reentry']).default('single'),
});
const designSchema = z.object({
  name: z.string().trim().min(2).max(120),
  access_mode: z.enum(['single', 'reentry']),
  card_theme: z.enum(['midnight', 'minimal', 'celebration']),
  card_color: z.string().regex(/^(#[a-f\d]{6})?$/i),
  location: z.string().trim().max(120),
  event_time: z.string().regex(/^$|^([01]\d|2[0-3]):[0-5]\d$/),
  message: z.string().trim().max(140),
  background_x: z.number().min(0).max(100).default(50),
  background_y: z.number().min(0).max(100).default(50),
  background_zoom: z.number().min(1).max(3).default(1),
  background_shade: z.number().min(0.7).max(0.98).default(0.85),
  logo_data: z
    .string()
    .max(240000)
    .regex(/^$|^data:image\/(?:png|webp);base64,[a-z\d+/=]+$/i)
    .default(''),
});
const summary = `SELECT b.id,b.name,b.expected_date,b.quantity,b.created_at,b.created_by,
  b.access_mode,b.card_theme,b.card_color,b.location,b.event_time,b.message,b.archived_at,
  b.background_x,b.background_y,b.background_zoom,b.background_shade,b.logo_data,b.background_ratio,
  COALESCE(SUM(v.used_at IS NOT NULL),0) used,
  COALESCE(SUM(v.status IN('expected','checked_in') AND (v.used_at IS NULL OR v.access_mode='reentry') AND c.active=1),0) pending,
  COALESCE(SUM(EXISTS(SELECT 1 FROM (${presenceSql}) p WHERE p.person_id=v.person_id AND p.zone_id=v.zone_id)),0) inside,
  COALESCE(SUM(v.status='cancelled' OR (c.active=0 AND v.used_at IS NULL)),0) cancelled
  FROM invitation_batches b LEFT JOIN visits v ON v.batch_id=b.id
  LEFT JOIN credentials c ON c.id=v.credential_id`;
const guestSchema = z.object({
  guest_name: z.string().trim().min(1).max(100),
  invitation_note: z.string().trim().max(140).default(''),
  access_mode: z.enum(['single', 'reentry']).optional(),
});
const operationSchema = z.object({
  request_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(1000).optional(),
  guests: z.array(guestSchema).min(1).max(1000).optional(),
});

export class InvitationBatches {
  service: Service;
  constructor(service: Service) {
    this.service = service;
  }
  async list(params = new URLSearchParams()) {
    const q = params.get('q')?.trim() || '';
    const from = params.get('from') || '',
      to = params.get('to') || '';
    const state = params.get('state') || 'active';
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(1000000)
      .parse(params.get('offset') || 0);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(params.get('limit') || 100);
    const order =
      params.get('order') === 'upcoming'
        ? "b.expected_date ASC,COALESCE(NULLIF(b.event_time,''),'00:00') ASC,b.id ASC"
        : 'b.created_at DESC,b.id';
    return this.service.all(
      `${summary} WHERE (?='all' OR (?='archived' AND b.archived_at IS NOT NULL) OR (?='active' AND b.archived_at IS NULL))
      AND (?='' OR instr(search_fold(b.name),search_fold(?))>0)
      AND (?='' OR b.expected_date>=?) AND (?='' OR b.expected_date<=?)
      GROUP BY b.id ORDER BY ${order} LIMIT ? OFFSET ?`,
      state,
      state,
      state,
      q,
      q,
      from,
      from,
      to,
      to,
      limit,
      offset,
    ) as Promise<InvitationBatch[]>;
  }
  async detail(id: string) {
    const batch = await this.service.one(`${summary} WHERE b.id=? GROUP BY b.id`, id);
    if (!batch) throw new ApiError(404, 'Lote de invitaciones no encontrado.');
    return batch as InvitationBatch;
  }
  async create(body: unknown) {
    const s = this.service;
    s.require('operator');
    const p = batchSchema.parse(body);
    if (!s.codec) throw new ApiError(503, 'No está disponible la protección de los QR. Vuelve a abrir GymPASS.');
    const requestKey = `${s.actor.id}:${p.request_id}`;
    const payloadHash = await hash(
      JSON.stringify([p.name, p.expected_date, p.quantity, ...(p.access_mode === 'single' ? [] : [p.access_mode])]),
    );
    const previous = await s.one('SELECT id,payload_hash FROM invitation_batches WHERE request_key=?', requestKey);
    if (previous) {
      if (previous.payload_hash !== payloadHash)
        throw new ApiError(409, 'Este intento ya generó un lote con otros datos.');
      return this.detail(previous.id);
    }
    const id = crypto.randomUUID(),
      now = Date.now();
    const statements = [
      s.stmt(
        `INSERT INTO invitation_batches(id,request_key,payload_hash,name,expected_date,quantity,created_at,created_by,access_mode)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`,
        id,
        requestKey,
        payloadHash,
        p.name,
        p.expected_date,
        p.quantity,
        now,
        s.actor.email,
        p.access_mode,
      ),
    ];
    // Every dependent write checks ownership of the winning batch, so concurrent retries are atomic.
    for (let number = 1; number <= p.quantity; number++) {
      const personId = crypto.randomUUID(),
        credentialId = crypto.randomUUID(),
        visitId = crypto.randomUUID();
      const code = randomToken('UMB'),
        label = `Invitación ${String(number).padStart(3, '0')}`;
      statements.push(
        s.stmt(
          `INSERT INTO people(id,name,document,kind,status,notes,created_at)
          SELECT ?,?,?,'visitor','active',?,? WHERE EXISTS(SELECT 1 FROM invitation_batches WHERE id=?)`,
          personId,
          `${p.name} · ${label}`,
          `INV-${id}-${number}`,
          `Pase de evento: ${p.name}`,
          now,
          id,
        ),
        s.stmt(
          `INSERT INTO person_zones(person_id,zone_id)
          SELECT ?,? WHERE EXISTS(SELECT 1 FROM invitation_batches WHERE id=?)`,
          personId,
          generalAccessId,
          id,
        ),
        s.stmt(
          `INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher)
          SELECT ?,?,'qr',?,?,?,?,? WHERE EXISTS(SELECT 1 FROM invitation_batches WHERE id=?)`,
          credentialId,
          personId,
          `${p.name} · ${label}`,
          await hash(code),
          code.slice(-6),
          now,
          s.codec.seal(code, credentialId),
          id,
        ),
        s.stmt(
          `INSERT INTO visits(id,person_id,host_email,host_name,purpose,expected_date,expected_from,expected_to,zone_id,credential_id,created_at,created_by,batch_id,ticket_number,access_mode)
          SELECT ?,?,?,?,?,?,'00:00','23:59',?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM invitation_batches WHERE id=?)`,
          visitId,
          personId,
          s.actor.email,
          s.actor.name,
          p.name,
          p.expected_date,
          generalAccessId,
          credentialId,
          now,
          s.actor.email,
          id,
          number,
          p.access_mode,
          id,
        ),
      );
    }
    statements.push(
      s.stmt(
        `INSERT INTO audit(actor,action,entity_id,occurred_at)
      SELECT ?,'invitation_batch.created',?,? WHERE EXISTS(SELECT 1 FROM invitation_batches WHERE id=?)`,
        s.actor.email,
        id,
        now,
        id,
      ),
    );
    await s.db.batch(statements);
    const created = await s.one('SELECT id,payload_hash FROM invitation_batches WHERE request_key=?', requestKey);
    if (!created || created.payload_hash !== payloadHash) throw new ApiError(409, 'Este intento ya generó otro lote.');
    return this.detail(created.id);
  }
  async passes(id: string) {
    const s = this.service;
    s.require('operator');
    const batch = await this.detail(id);
    if (!s.codec) throw new ApiError(503, 'No está disponible la protección de los QR.');
    const rows = await s.all(
      `SELECT v.id,v.ticket_number number,v.status,v.used_at,v.guest_name,v.invitation_note,v.access_mode,v.delivery_status,c.id credential_id,c.active,c.code_cipher,
      EXISTS(SELECT 1 FROM (${presenceSql}) p WHERE p.person_id=v.person_id AND p.zone_id=v.zone_id) inside
      FROM visits v JOIN credentials c ON c.id=v.credential_id WHERE v.batch_id=? ORDER BY v.ticket_number`,
      id,
    );
    const tickets: InvitationTicket[] = rows.map((row) => ({
      id: row.id,
      number: row.number,
      status: row.status,
      used_at: row.used_at,
      active: row.active,
      guest_name: row.guest_name,
      invitation_note: row.invitation_note,
      access_mode: row.access_mode,
      inside: row.inside,
      delivery_status: row.delivery_status,
      code: s.codec!.open(row.code_cipher, row.credential_id),
    }));
    return { batch, tickets };
  }
  async update(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    const p = designSchema.parse(body);
    await this.detail(id);
    await s.db.batch([
      // Only a policy change applies to every pass. Renaming preserves individual overrides.
      s.stmt(
        `UPDATE visits SET access_mode=? WHERE batch_id=? AND EXISTS(
        SELECT 1 FROM invitation_batches WHERE id=? AND access_mode<>?)`,
        p.access_mode,
        id,
        id,
        p.access_mode,
      ),
      s.stmt(
        `UPDATE invitation_batches SET name=?,access_mode=?,card_theme=?,card_color=?,location=?,event_time=?,message=?,background_x=?,background_y=?,background_zoom=?,background_shade=?,logo_data=? WHERE id=?`,
        p.name,
        p.access_mode,
        p.card_theme,
        p.card_color,
        p.location,
        p.event_time,
        p.message,
        p.background_x,
        p.background_y,
        p.background_zoom,
        p.background_shade,
        p.logo_data,
        id,
      ),
      s.stmt('UPDATE visits SET purpose=? WHERE batch_id=?', p.name, id),
      s.stmt(
        `UPDATE people SET name=(SELECT CASE WHEN v.guest_name<>'' THEN v.guest_name ELSE ? || ' · Invitación ' || printf('%03d',v.ticket_number) END FROM visits v WHERE v.person_id=people.id AND v.batch_id=?)
        WHERE id IN(SELECT person_id FROM visits WHERE batch_id=?)`,
        p.name,
        id,
        id,
      ),
      s.audit('invitation_batch.updated', id),
    ]);
    return this.detail(id);
  }
  async append(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    if (!s.codec) throw new ApiError(503, 'No está disponible la protección de los QR.');
    const p = operationSchema.parse(body),
      quantity = p.guests?.length ?? p.quantity;
    if (!quantity) throw new ApiError(400, 'Indica cuántos pases quieres añadir.');
    if (p.guests && p.quantity && p.quantity !== p.guests.length)
      throw new ApiError(400, 'La cantidad no coincide con los nombres.');
    const key = `${s.actor.id}:${p.request_id}`,
      payload = await hash(JSON.stringify(['append', id, p.quantity, p.guests]));
    const previous = await s.one('SELECT * FROM invitation_operations WHERE request_key=?', key);
    if (previous) {
      if (previous.payload_hash !== payload) throw new ApiError(409, 'Este intento ya se usó con otros datos.');
      return this.detail(id);
    }
    const batch = await this.detail(id);
    if (batch.quantity + quantity > 1000) throw new ApiError(400, 'El evento admite hasta 1.000 pases.');
    const op = crypto.randomUUID(),
      now = Date.now();
    const statements = [
      s.stmt(
        `INSERT INTO invitation_operations(id,request_key,batch_id,payload_hash,created_at)
      SELECT ?,?,?,?,? FROM invitation_batches WHERE id=? AND quantity=? ON CONFLICT(request_key) DO NOTHING`,
        op,
        key,
        id,
        payload,
        now,
        id,
        batch.quantity,
      ),
    ];
    const guard = 'EXISTS(SELECT 1 FROM invitation_operations WHERE id=?)';
    for (let index = 0; index < quantity; index++) {
      const number = batch.quantity + index + 1,
        personId = crypto.randomUUID(),
        credentialId = crypto.randomUUID(),
        visitId = crypto.randomUUID();
      const code = randomToken('UMB'),
        guest = p.guests?.[index],
        label = guest?.guest_name || `${batch.name} · Invitación ${String(number).padStart(3, '0')}`;
      statements.push(
        s.stmt(
          `INSERT INTO people(id,name,document,kind,status,notes,created_at) SELECT ?,?,?,'visitor','active',?,? WHERE ${guard}`,
          personId,
          label,
          `INV-${id}-${number}`,
          `Pase de evento: ${batch.name}`,
          now,
          op,
        ),
        s.stmt(`INSERT INTO person_zones(person_id,zone_id) SELECT ?,? WHERE ${guard}`, personId, generalAccessId, op),
        s.stmt(
          `INSERT INTO credentials(id,person_id,kind,label,hash,suffix,created_at,code_cipher) SELECT ?,?,'qr',?,?,?,?,? WHERE ${guard}`,
          credentialId,
          personId,
          label,
          await hash(code),
          code.slice(-6),
          now,
          s.codec.seal(code, credentialId),
          op,
        ),
        s.stmt(
          `INSERT INTO visits(id,person_id,host_email,host_name,purpose,expected_date,expected_from,expected_to,zone_id,credential_id,created_at,created_by,batch_id,ticket_number,access_mode,guest_name,invitation_note)
          SELECT ?,?,?,?,?,?,'00:00','23:59',?,?,?,?,?,?,?,?,? WHERE ${guard}`,
          visitId,
          personId,
          s.actor.email,
          s.actor.name,
          batch.name,
          batch.expected_date,
          generalAccessId,
          credentialId,
          now,
          s.actor.email,
          id,
          number,
          guest?.access_mode || batch.access_mode,
          guest?.guest_name || '',
          guest?.invitation_note || '',
          op,
        ),
      );
    }
    statements.push(
      s.stmt(`UPDATE invitation_batches SET quantity=quantity+? WHERE id=? AND ${guard}`, quantity, id, op),
      s.stmt(
        `INSERT INTO audit(actor,action,entity_id,occurred_at) SELECT ?,'invitation_batch.appended',?,? WHERE ${guard}`,
        s.actor.email,
        id,
        now,
        op,
      ),
    );
    await s.db.batch(statements);
    const winning = await s.one('SELECT * FROM invitation_operations WHERE request_key=?', key);
    if (!winning || winning.payload_hash !== payload)
      throw new ApiError(409, 'El evento cambió. Actualiza y vuelve a intentar.');
    return this.detail(id);
  }
  async importGuests(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    const p = z
      .object({
        request_id: z.string().uuid(),
        guests: z.array(guestSchema).min(1).max(1000),
        mode: z.enum(['assign', 'append']).default('assign'),
      })
      .parse(body);
    if (p.mode === 'append') return this.append(id, { request_id: p.request_id, guests: p.guests });
    const key = `${s.actor.id}:${p.request_id}`,
      payload = await hash(JSON.stringify(['assign', id, p.guests]));
    const previous = await s.one('SELECT * FROM invitation_operations WHERE request_key=?', key);
    if (previous) {
      if (previous.payload_hash !== payload) throw new ApiError(409, 'Este intento ya se usó con otros datos.');
      return this.detail(id);
    }
    const batch = await this.detail(id);
    const slots = await s.all(
      `SELECT v.id,v.person_id FROM visits v JOIN credentials c ON c.id=v.credential_id
      WHERE v.batch_id=? AND v.guest_name='' AND v.used_at IS NULL AND v.status='expected' AND c.active=1 ORDER BY v.ticket_number LIMIT ?`,
      id,
      p.guests.length,
    );
    if (slots.length < p.guests.length)
      throw new ApiError(400, `Solo quedan ${slots.length} pases sin nombre disponibles. Elige añadir pases nuevos.`);
    const op = crypto.randomUUID(),
      now = Date.now(),
      placeholders = slots.map(() => '?').join(',');
    const statements = [
      s.stmt(
        `INSERT INTO invitation_operations(id,request_key,batch_id,payload_hash,created_at)
      SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM visits v JOIN credentials c ON c.id=v.credential_id WHERE v.id IN(${placeholders}) AND v.guest_name='' AND v.used_at IS NULL AND v.status='expected' AND c.active=1)=?
      ON CONFLICT(request_key) DO NOTHING`,
        op,
        key,
        id,
        payload,
        now,
        ...slots.map((v) => v.id),
        slots.length,
      ),
    ];
    for (let index = 0; index < slots.length; index++) {
      const row = slots[index],
        g = p.guests[index];
      statements.push(
        s.stmt(
          `UPDATE visits SET guest_name=?,invitation_note=?,access_mode=? WHERE id=? AND EXISTS(SELECT 1 FROM invitation_operations WHERE id=?)`,
          g.guest_name,
          g.invitation_note,
          g.access_mode || batch.access_mode,
          row.id,
          op,
        ),
        s.stmt(
          'UPDATE people SET name=? WHERE id=? AND EXISTS(SELECT 1 FROM invitation_operations WHERE id=?)',
          g.guest_name,
          row.person_id,
          op,
        ),
      );
    }
    statements.push(
      s.stmt(
        `INSERT INTO audit(actor,action,entity_id,occurred_at) SELECT ?,'invitation_batch.imported',?,? WHERE EXISTS(SELECT 1 FROM invitation_operations WHERE id=?)`,
        s.actor.email,
        id,
        now,
        op,
      ),
    );
    await s.db.batch(statements);
    const winning = await s.one('SELECT * FROM invitation_operations WHERE request_key=?', key);
    if (!winning || winning.payload_hash !== payload)
      throw new ApiError(409, 'Los pases cambiaron. Actualiza antes de importar.');
    return this.detail(id);
  }
  async duplicate(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    const original = await this.detail(id),
      p = batchSchema.parse(body);
    const previous = await s.one(
      'SELECT payload_hash FROM invitation_operations WHERE request_key=?',
      `duplicate:${s.actor.id}:${p.request_id}`,
    );
    if (previous && previous.payload_hash !== (await hash(id)))
      throw new ApiError(409, 'Este intento ya se usó para duplicar otro evento.');
    const created = await this.create(p),
      key = `duplicate:${s.actor.id}:${p.request_id}`,
      op = crypto.randomUUID();
    const source = await s.one('SELECT background_path,background_ratio FROM invitation_batches WHERE id=?', id);
    const design = designSchema.parse({ ...original, name: p.name, access_mode: p.access_mode });
    const fields = [
      'card_theme',
      'card_color',
      'location',
      'event_time',
      'message',
      'background_x',
      'background_y',
      'background_zoom',
      'background_shade',
      'logo_data',
    ] as const;
    await s.db.batch([
      s.stmt(
        `INSERT INTO invitation_operations(id,request_key,batch_id,payload_hash,created_at) VALUES(?,?,?,?,?) ON CONFLICT(request_key) DO NOTHING`,
        op,
        key,
        created.id,
        await hash(id),
        Date.now(),
      ),
      s.stmt(
        `UPDATE invitation_batches SET ${fields.map((f) => `${f}=?`).join(',')},background_path=?,background_ratio=? WHERE id=? AND EXISTS(SELECT 1 FROM invitation_operations WHERE id=?)`,
        ...fields.map((f) => design[f]),
        source?.background_path ?? null,
        source?.background_ratio ?? 638 / 1012,
        created.id,
        op,
      ),
    ]);
    return this.detail(created.id);
  }
  async archive(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    await this.detail(id);
    const p = z.object({ archived: z.boolean() }).parse(body);
    await s.db.batch([
      s.stmt('UPDATE invitation_batches SET archived_at=? WHERE id=?', p.archived ? Date.now() : null, id),
      s.audit(p.archived ? 'invitation_batch.archived' : 'invitation_batch.unarchived', id),
    ]);
    return this.detail(id);
  }
  async delivery(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    const p = z
      .object({ ids: z.array(z.string().uuid()).min(1).max(1000), status: z.enum(['pending', 'sent', 'delivered']) })
      .parse(body);
    await this.detail(id);
    await s.db.batch([
      s.stmt(
        `UPDATE visits SET delivery_status=? WHERE batch_id=? AND id IN(${p.ids.map(() => '?').join(',')})`,
        p.status,
        id,
        ...p.ids,
      ),
      s.audit('invitation_batch.delivery', id),
    ]);
    return { ok: true };
  }
  async report(id: string) {
    const s = this.service,
      batch = await this.detail(id);
    const movements = await s.all(
      `SELECT e.id,e.person_id,e.person_name,e.direction,e.occurred_at,e.method,e.local_date,v.ticket_number,v.guest_name
      FROM events e JOIN visits v ON v.person_id=e.person_id AND v.zone_id=e.zone_id
      WHERE v.batch_id=? AND e.allowed=1 AND e.local_date=v.expected_date ORDER BY e.id`,
      id,
    );
    const entered = new Set<string>(),
      present = new Set<string>();
    let entries = 0,
      exits = 0,
      reentries = 0,
      peak = 0;
    const timeline = movements.map((row) => {
      if (row.direction === 'entry') {
        entries++;
        if (entered.has(row.person_id)) reentries++;
        entered.add(row.person_id);
        present.add(row.person_id);
      } else {
        exits++;
        present.delete(row.person_id);
      }
      peak = Math.max(peak, present.size);
      return { ...row, occupancy: present.size };
    });
    const delivery = await s.all(
      'SELECT delivery_status status,COUNT(*) quantity FROM visits WHERE batch_id=? GROUP BY delivery_status',
      id,
    );
    return {
      batch,
      unique: entered.size,
      entries,
      exits,
      reentries,
      peak,
      inside: batch.inside,
      delivery,
      movements: timeline,
    };
  }
  async templates() {
    this.service.require('operator');
    return this.service.all(
      'SELECT id,name,created_at,created_by FROM invitation_templates ORDER BY created_at DESC LIMIT 100',
    );
  }
  async saveTemplate(id: string, body: unknown) {
    const s = this.service;
    s.require('operator');
    const p = z.object({ name: z.string().trim().min(2).max(80) }).parse(body),
      batch = await this.detail(id);
    if (Number((await s.one('SELECT COUNT(*) n FROM invitation_templates'))?.n) >= 100)
      throw new ApiError(400, 'Elimina una plantilla antes de guardar otra.');
    const source = await s.one('SELECT background_path FROM invitation_batches WHERE id=?', id),
      templateId = crypto.randomUUID();
    const { name: _, access_mode: __, ...design } = designSchema.parse(batch);
    await s.db.batch([
      s.stmt(
        'INSERT INTO invitation_templates(id,name,design,background_path,created_at,created_by) VALUES(?,?,?,?,?,?)',
        templateId,
        p.name,
        JSON.stringify({ ...design, background_ratio: batch.background_ratio }),
        source?.background_path ?? null,
        Date.now(),
        s.actor.email,
      ),
      s.audit('invitation_template.created', templateId),
    ]);
    return { id: templateId };
  }
  async applyTemplate(id: string, templateId: string) {
    const s = this.service;
    s.require('operator');
    const batch = await this.detail(id);
    const template = await s.one('SELECT * FROM invitation_templates WHERE id=?', templateId);
    if (!template) throw new ApiError(404, 'Plantilla no encontrada.');
    await this.update(id, {
      ...batch,
      ...JSON.parse(template.design),
      name: batch.name,
      access_mode: batch.access_mode,
    });
    await s.db.batch([
      s.stmt(
        'UPDATE invitation_batches SET background_path=?,background_ratio=? WHERE id=?',
        template.background_path,
        JSON.parse(template.design).background_ratio || 638 / 1012,
        id,
      ),
      s.audit('invitation_template.applied', id),
    ]);
    return this.detail(id);
  }
  async deleteTemplate(id: string) {
    const s = this.service;
    s.require('operator');
    await s.db.batch([
      s.stmt('DELETE FROM invitation_templates WHERE id=?', id),
      s.audit('invitation_template.deleted', id),
    ]);
    return { ok: true };
  }
}
