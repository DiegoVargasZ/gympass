import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError } from '../lib/service.ts';
import { passwordHash, verifyPassword, sessionSeconds } from './auth.ts';
import { initializeBilling, PlatformBilling, recordBillingActivity } from './platform-billing.ts';

export type PlatformUser = {
  id: string;
  email: string;
  name: string;
  global_role: 'superadmin' | 'user';
  active: boolean;
};
export type Gym = {
  id: string;
  name: string;
  slug: string;
  status: 'provisioning' | 'active' | 'suspended';
  archived: boolean;
  archived_at: number | null;
  /** Baja lógica: el gimnasio desaparece del panel y nadie puede operarlo, pero sus datos siguen. */
  deleted: boolean;
  deleted_at: number | null;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  role?: 'admin' | 'operator' | 'viewer';
};
/** Qué subconjunto del panel se está mirando. `archived` y `deleted` son solo para superadministradores. */
export type GymScope = 'active' | 'archived' | 'deleted';
export type PlatformSession = { id: string; user: PlatformUser; mobileGymId?: string; kioskGymId?: string };
export type GymAuthorization = {
  user: PlatformUser;
  gym: Gym;
  actor: { id: string; email: string; name: string; role: 'admin' | 'operator' | 'viewer' };
  support: boolean;
  readOnly: boolean;
};
type MembershipRole = 'admin' | 'operator' | 'viewer';
type Row = Record<string, any>;
type InvitationInput = { email: string; name: string; role: MembershipRole };
type LoginInput = { email: string; password: string; remember?: boolean };
const secretHash = (secret: string) => createHash('sha256').update(secret).digest('hex');
const token = () => randomBytes(32).toString('hex');
const day = 86400_000;
function email(value: string) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()))
    throw new ApiError(400, 'Introduce un correo válido.');
  return value.trim().toLowerCase();
}
function name(value: string) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120)
    throw new ApiError(400, 'El nombre es obligatorio y admite hasta 120 caracteres.');
  return value.trim();
}
function role(value: string): MembershipRole {
  if (!['admin', 'operator', 'viewer'].includes(value)) throw new ApiError(400, 'Rol de gimnasio inválido.');
  return value as MembershipRole;
}
function memberPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length < 6 || value.length > 200)
    throw new ApiError(400, 'La contraseña debe tener entre 6 y 200 caracteres.');
  return value;
}
function publicUser(row: Row): PlatformUser {
  return { id: row.id, email: row.email, name: row.name, global_role: row.global_role, active: Boolean(row.active) };
}
function publicGym(row: Row): Gym {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    archived: row.archived_at !== null,
    archived_at: row.archived_at,
    deleted: row.deleted_at !== null,
    deleted_at: row.deleted_at,
    contact_name: row.contact_name,
    contact_email: row.contact_email,
    contact_phone: row.contact_phone,
    ...(row.role ? { role: row.role } : {}),
  };
}

export class PlatformStore {
  readonly root: string;
  readonly raw: DatabaseSync;
  readonly billing: PlatformBilling;

  constructor(rootDirectory: string) {
    this.root = resolve(rootDirectory);
    mkdirSync(this.root, { recursive: true });
    this.raw = new DatabaseSync(resolve(this.root, 'platform.sqlite'));
    this.raw.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS platform_users(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,name TEXT NOT NULL,password_hash TEXT NOT NULL,global_role TEXT NOT NULL CHECK(global_role IN ('superadmin','user')),active INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gyms(id TEXT PRIMARY KEY,name TEXT NOT NULL,slug TEXT NOT NULL UNIQUE,status TEXT NOT NULL CHECK(status IN ('provisioning','active','suspended')),provisioned INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gym_memberships(user_id TEXT NOT NULL REFERENCES platform_users(id),gym_id TEXT NOT NULL REFERENCES gyms(id),role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(user_id,gym_id));
      CREATE TABLE IF NOT EXISTS platform_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES platform_users(id),kind TEXT NOT NULL CHECK(kind IN ('web','mobile')),gym_id TEXT REFERENCES gyms(id),expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS invitations(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,gym_id TEXT NOT NULL REFERENCES gyms(id),email TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('admin','operator','viewer')),created_by TEXT NOT NULL REFERENCES platform_users(id),expires_at INTEGER NOT NULL,consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS password_resets(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES platform_users(id),expires_at INTEGER NOT NULL,consumed_at INTEGER);
      CREATE TABLE IF NOT EXISTS support_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL REFERENCES platform_users(id),session_id TEXT NOT NULL REFERENCES platform_sessions(id),gym_id TEXT NOT NULL REFERENCES gyms(id),reason TEXT NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE IF NOT EXISTS platform_audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES platform_users(id),gym_id TEXT REFERENCES gyms(id),action TEXT NOT NULL,entity_id TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS platform_sessions_user ON platform_sessions(user_id);
      CREATE INDEX IF NOT EXISTS gym_memberships_gym ON gym_memberships(gym_id);
      CREATE INDEX IF NOT EXISTS platform_audit_date ON platform_audit(created_at);`);
    const gymColumns = new Set(
      (this.raw.prepare('PRAGMA table_info(gyms)').all() as Row[]).map((column) => column.name),
    );
    for (const [column, definition] of [
      ['archived_at', 'INTEGER'],
      ['deleted_at', 'INTEGER'],
      ['deleted_by', 'TEXT'],
      ['contact_name', "TEXT NOT NULL DEFAULT ''"],
      ['contact_email', "TEXT NOT NULL DEFAULT ''"],
      ['contact_phone', "TEXT NOT NULL DEFAULT ''"],
    ])
      if (!gymColumns.has(column)) this.raw.exec(`ALTER TABLE gyms ADD COLUMN ${column} ${definition}`);
    initializeBilling(this.raw);
    if (!(this.raw.prepare('PRAGMA table_info(platform_sessions)').all() as Row[]).some(c => c.name === 'kiosk_gym_id'))
      this.raw.exec('ALTER TABLE platform_sessions ADD COLUMN kiosk_gym_id TEXT REFERENCES gyms(id)');
    this.billing = new PlatformBilling(this);
  }

  private transaction<T>(operation: () => T): T {
    const savepoint = this.raw.isTransaction ? 'platform_' + randomUUID().replaceAll('-', '') : null;
    this.raw.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.raw.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.raw.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    }
  }

  private currentUser(user: PlatformUser): PlatformUser {
    const row = this.raw.prepare('SELECT * FROM platform_users WHERE id=? AND active=1').get(user.id) as
      Row | undefined;
    if (!row) throw new ApiError(401, 'Inicia sesión de nuevo.');
    return publicUser(row);
  }

  private superadmin(user: PlatformUser) {
    const current = this.currentUser(user);
    if (current.global_role !== 'superadmin') throw new ApiError(403, 'Se requiere superadministrador.');
    return current;
  }

  private gymAdmin(user: PlatformUser, gymId: string) {
    const current = this.currentUser(user);
    const gym = this.getGym(gymId);
    if (!gym) throw new ApiError(404, 'Gimnasio no encontrado.');
    if (current.global_role === 'superadmin') return current;
    const member = this.raw
      .prepare("SELECT 1 FROM gym_memberships WHERE user_id=? AND gym_id=? AND role='admin' AND active=1")
      .get(current.id, gymId);
    if (!member || gym.deleted || gym.archived || gym.status !== 'active')
      throw new ApiError(403, 'No tienes permiso para administrar este gimnasio.');
    return current;
  }

  async bootstrap(input: { name: string; email: string; password: string }): Promise<PlatformUser> {
    const normalized = email(input.email),
      displayName = name(input.name),
      hashed = await passwordHash(input.password);
    return this.transaction(() => {
      if (this.raw.prepare("SELECT 1 FROM platform_users WHERE global_role='superadmin'").get())
        throw new ApiError(409, 'La plataforma ya tiene propietario.');
      const id = randomUUID();
      this.raw
        .prepare('INSERT INTO platform_users(id,email,name,password_hash,global_role,created_at) VALUES(?,?,?,?,?,?)')
        .run(id, normalized, displayName, hashed, 'superadmin', Date.now());
      this.audit(id, 'platform.bootstrap');
      return this.currentUser({ id } as PlatformUser);
    });
  }

  private async credentials(input: LoginInput) {
    const normalized = email(input.email);
    if (typeof input.password !== 'string' || input.password.length > 200)
      throw new ApiError(401, 'Correo o contraseña incorrectos.');
    const before = this.raw.prepare('SELECT * FROM platform_users WHERE email=? AND active=1').get(normalized) as
      Row | undefined;
    if (!before || !(await verifyPassword(input.password, before.password_hash)))
      throw new ApiError(401, 'Correo o contraseña incorrectos.');
    const current = this.raw
      .prepare('SELECT * FROM platform_users WHERE id=? AND active=1 AND password_hash=?')
      .get(before.id, before.password_hash) as Row | undefined;
    if (!current) throw new ApiError(401, 'Las credenciales han cambiado. Inicia sesión de nuevo.');
    return publicUser(current);
  }

  private newSession(user: PlatformUser, remember = false, gymId?: string) {
    const value = (gymId ? 'm_' : '') + token(),
      id = randomUUID();
    this.raw
      .prepare('INSERT INTO platform_sessions(id,token_hash,user_id,kind,gym_id,expires_at) VALUES(?,?,?,?,?,?)')
      .run(
        id,
        secretHash(value),
        user.id,
        gymId ? 'mobile' : 'web',
        gymId ?? null,
        Date.now() + sessionSeconds(remember) * 1000,
      );
    this.audit(user.id, gymId ? 'session.mobile_login' : 'session.login', gymId);
    return { token: value, session: { id, user, ...(gymId ? { mobileGymId: gymId } : {}) } as PlatformSession };
  }

  async login(input: LoginInput) {
    return this.newSession(await this.credentials(input), Boolean(input.remember));
  }

  async mobileLogin(input: LoginInput & { gymId?: string }) {
    const user = await this.credentials(input);
    const gyms = this.listGyms(user).filter(
      (gym) => gym.status === 'active' && ['admin', 'operator'].includes(gym.role ?? ''),
    );
    if (!input.gymId && gyms.length > 1) return { gyms };
    const gym = input.gymId ? gyms.find((entry) => entry.id === input.gymId) : gyms[0];
    if (!gym) throw new ApiError(403, 'No tienes acceso a un gimnasio activo.');
    const login = this.newSession(user, true, gym.id);
    return {
      token: login.token,
      user: { ...user, role: gym.role as 'admin' | 'operator' },
      installation_id: secretHash(gym.id),
      gym_id: gym.id,
      server_mode: 'platform' as const,
      protocol: 1 as const,
    };
  }

  async authenticate(value: string): Promise<PlatformSession | null> {
    return this.authenticateSync(value);
  }

  authenticateSync(value: string): PlatformSession | null {
    if (typeof value !== 'string' || !/^(?:m_)?[a-f0-9]{64}$/.test(value)) return null;
    const row = this.raw
      .prepare(
        'SELECT s.id AS session_id,s.kind,s.gym_id,s.kiosk_gym_id,u.* FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND s.revoked_at IS NULL AND u.active=1',
      )
      .get(secretHash(value), Date.now()) as Row | undefined;
    return row
      ? { id: row.session_id, user: publicUser(row), ...(row.kind === 'mobile' ? { mobileGymId: row.gym_id } : {}), ...(row.kiosk_gym_id ? { kioskGymId: row.kiosk_gym_id } : {}) }
      : null;
  }

  async requireWebSession(value: string) {
    const session = await this.authenticate(value);
    if (!session || session.mobileGymId || session.kioskGymId) throw new ApiError(401, 'Inicia sesión en la plataforma.');
    return session;
  }

  async logout(value: string) {
    const session = await this.authenticate(value);
    if (!session) return;
    this.raw.prepare('UPDATE platform_sessions SET revoked_at=? WHERE id=?').run(Date.now(), session.id);
    this.raw
      .prepare('UPDATE support_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL')
      .run(Date.now(), session.id);
    this.audit(session.user.id, 'session.logout', session.mobileGymId);
  }

  async authorize(value: string, gymId: string, supportToken?: string, write = false, kiosk = false): Promise<GymAuthorization> {
    return this.authorizeSync(value, gymId, supportToken, write, kiosk);
  }

  authorizeSync(value: string, gymId: string, supportToken?: string, write = false, kiosk = false): GymAuthorization {
    const session = this.authenticateSync(value);
    if (!session) throw new ApiError(401, 'Inicia sesión de nuevo.');
    if (session.kioskGymId && (!kiosk || session.kioskGymId !== gymId))
      throw new ApiError(403, 'La sesión de acceso automático solo permite leer credenciales. Inicia sesión para volver al panel.');
    if (session.mobileGymId && session.mobileGymId !== gymId)
      throw new ApiError(403, 'El lector está vinculado a otro gimnasio.');
    const gym = this.getGym(gymId);
    if (!gym) throw new ApiError(404, 'Gimnasio no encontrado.');
    let memberRole: MembershipRole,
      support = false;
    if (supportToken) {
      const grant = this.raw
        .prepare(
          'SELECT 1 FROM support_sessions WHERE token_hash=? AND user_id=? AND session_id=? AND gym_id=? AND expires_at>? AND revoked_at IS NULL',
        )
        .get(secretHash(supportToken), session.user.id, session.id, gymId, Date.now());
      if (!grant || session.user.global_role !== 'superadmin' || session.mobileGymId)
        throw new ApiError(403, 'La autorización de soporte ha terminado.');
      support = true;
      memberRole = 'admin';
    } else {
      const member = this.raw
        .prepare('SELECT role FROM gym_memberships WHERE user_id=? AND gym_id=? AND active=1')
        .get(session.user.id, gymId) as Row | undefined;
      if (!member) throw new ApiError(403, 'No tienes acceso a este gimnasio.');
      memberRole = member.role;
    }
    if (gym.deleted) throw new ApiError(403, 'Este gimnasio está dado de baja.');
    if (gym.archived || gym.status === 'provisioning' || (gym.status === 'suspended' && !support))
      throw new ApiError(403, 'El gimnasio no está activo.');
    const readOnly = gym.status === 'suspended' || memberRole === 'viewer';
    if (write && readOnly) throw new ApiError(403, 'Este acceso es de solo lectura.');
    return {
      user: session.user,
      gym,
      actor: { id: session.user.id, email: session.user.email, name: session.user.name, role: memberRole },
      support,
      readOnly,
    };
  }

  requireOperationalGym(id: string): Gym {
    const gym = this.getGym(id);
    if (!gym || gym.status !== 'active' || gym.archived || gym.deleted)
      throw new ApiError(403, 'Gimnasio no disponible.');
    return gym;
  }
  authorizeLinkedUser(userId: string, gymId: string): GymAuthorization {
    const user = this.currentUser({ id: userId } as PlatformUser);
    const gym = this.requireOperationalGym(gymId);
    const member = this.raw.prepare('SELECT role FROM gym_memberships WHERE user_id=? AND gym_id=? AND active=1').get(userId, gymId) as Row | undefined;
    if (!member) throw new ApiError(403, 'La cuenta ya no pertenece a este gimnasio.');
    return { user, gym, actor: { id: user.id, name: user.name, email: user.email, role: member.role }, support: false, readOnly: member.role === 'viewer' };
  }
  linkedCredentialRevision(userId: string): string {
    const row = this.raw.prepare('SELECT password_hash FROM platform_users WHERE id=? AND active=1').get(userId);
    if (!row) throw new ApiError(401, 'La cuenta fue desactivada.');
    return secretHash(String(row.password_hash));
  }

  startKiosk(value: string, gymId: string, supportToken?: string) {
    const auth = this.authorizeSync(value, gymId, supportToken, true, true);
    const session = this.authenticateSync(value)!;
    if (session.mobileGymId || auth.actor.role === 'viewer' || auth.support)
      throw new ApiError(403, 'Abre el lector con una cuenta de recepción o administración del gimnasio.');
    this.raw.prepare('UPDATE platform_sessions SET kiosk_gym_id=? WHERE id=?').run(gymId, session.id);
    this.raw.prepare('UPDATE support_sessions SET revoked_at=? WHERE session_id=? AND revoked_at IS NULL').run(Date.now(), session.id);
    this.audit(auth.user.id, 'session.kiosk', gymId);
  }

  getGym(id: string): Gym | null {
    const row = this.raw.prepare('SELECT * FROM gyms WHERE id=?').get(id) as Row | undefined;
    return row ? publicGym(row) : null;
  }

  listAllGyms(): Gym[] {
    return (this.raw.prepare('SELECT * FROM gyms ORDER BY created_at,id').all() as Row[]).map(publicGym);
  }

  listGyms(user: PlatformUser, scope: GymScope = 'active'): Gym[] {
    const current = this.currentUser(user);
    const rows =
      current.global_role === 'superadmin'
        ? this.raw
            .prepare(
              'SELECT g.*,m.role FROM gyms g LEFT JOIN gym_memberships m ON m.gym_id=g.id AND m.user_id=? AND m.active=1 ORDER BY g.name,g.id',
            )
            .all(current.id)
        : this.raw
            .prepare(
              'SELECT g.*,m.role FROM gyms g JOIN gym_memberships m ON m.gym_id=g.id WHERE m.user_id=? AND m.active=1 ORDER BY g.name,g.id',
            )
            .all(current.id);
    const superadmin = current.global_role === 'superadmin';
    return (rows as Row[]).map(publicGym).filter((gym) => {
      if (scope === 'deleted') return superadmin && gym.deleted;
      if (gym.deleted) return false;
      return scope === 'archived' ? superadmin && gym.archived : !gym.archived;
    });
  }

  /**
   * Baja lógica de un gimnasio: sale del panel, deja de poder operarse y de generar
   * cargos, pero su base de datos y su historial de cobros se conservan intactos.
   */
  deleteGym(user: PlatformUser, gymId: string): Gym {
    const actor = this.superadmin(user),
      gym = this.getGym(gymId);
    if (!gym) throw new ApiError(404, 'Gimnasio no encontrado.');
    if (gym.deleted) return gym;
    return this.transaction(() => {
      recordBillingActivity(
        this.raw,
        gymId,
        !gym.archived && gym.status === 'active',
        false,
        gym.status === 'provisioning',
      );
      this.raw
        .prepare('UPDATE gyms SET deleted_at=?,deleted_by=?,updated_at=? WHERE id=?')
        .run(Date.now(), actor.id, Date.now(), gymId);
      this.raw
        .prepare('UPDATE platform_sessions SET revoked_at=? WHERE gym_id=? AND revoked_at IS NULL')
        .run(Date.now(), gymId);
      this.raw
        .prepare('UPDATE support_sessions SET revoked_at=? WHERE gym_id=? AND revoked_at IS NULL')
        .run(Date.now(), gymId);
      this.audit(actor.id, 'gym.deleted', gymId, gymId);
      return this.getGym(gymId)!;
    });
  }

  /** Devuelve un gimnasio dado de baja al panel. Vuelve suspendido para revisarlo antes de reactivarlo. */
  restoreGym(user: PlatformUser, gymId: string): Gym {
    const actor = this.superadmin(user),
      gym = this.getGym(gymId);
    if (!gym) throw new ApiError(404, 'Gimnasio no encontrado.');
    if (!gym.deleted) return gym;
    return this.transaction(() => {
      const status = gym.status === 'active' ? 'suspended' : gym.status;
      this.raw
        .prepare('UPDATE gyms SET deleted_at=NULL,deleted_by=NULL,status=?,updated_at=? WHERE id=?')
        .run(status, Date.now(), gymId);
      this.audit(actor.id, 'gym.restored_from_delete', gymId, gymId);
      return this.getGym(gymId)!;
    });
  }

  createGym(user: PlatformUser, input: { name: string; slug: string }): Gym {
    const actor = this.superadmin(user),
      displayName = name(input.name);
    if (typeof input.slug !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(input.slug))
      throw new ApiError(400, 'Identificador inválido: usa letras minúsculas, números y guiones.');
    const existing = this.raw.prepare('SELECT * FROM gyms WHERE slug=?').get(input.slug) as Row | undefined;
    if (existing) {
      if (existing.status === 'provisioning' && existing.name === displayName && existing.deleted_at === null)
        return publicGym(existing);
      throw new ApiError(
        409,
        existing.deleted_at === null
          ? 'Ese identificador ya existe.'
          : 'Ese identificador pertenece a un gimnasio dado de baja. Restáuralo o elige otro.',
      );
    }
    const id = randomUUID(),
      now = Date.now();
    this.raw
      .prepare("INSERT INTO gyms(id,name,slug,status,created_at,updated_at) VALUES(?,?,?,'provisioning',?,?)")
      .run(id, displayName, input.slug, now, now);
    this.audit(actor.id, 'gym.created', id, id);
    return this.getGym(id)!;
  }

  markGymProvisioned(gymId: string) {
    if (!this.getGym(gymId)) throw new ApiError(404, 'Gimnasio no encontrado.');
    this.raw.prepare('UPDATE gyms SET provisioned=1,updated_at=? WHERE id=?').run(Date.now(), gymId);
  }

  updateGym(
    user: PlatformUser,
    gymId: string,
    patch: {
      name?: string;
      status?: 'active' | 'suspended';
      archived?: boolean;
      contact_name?: string;
      contact_email?: string;
      contact_phone?: string;
    },
  ): Gym {
    const actor = this.superadmin(user),
      gym = this.getGym(gymId);
    if (!gym) throw new ApiError(404, 'Gimnasio no encontrado.');
    if (gym.deleted) throw new ApiError(409, 'Restaura el gimnasio antes de editarlo.');
    if (patch.status !== undefined && !['active', 'suspended'].includes(patch.status))
      throw new ApiError(400, 'Estado inválido.');
    if (patch.archived !== undefined && typeof patch.archived !== 'boolean')
      throw new ApiError(400, 'Estado de archivo inválido.');
    const contacts: Record<string, string> = {};
    for (const field of ['contact_name', 'contact_email', 'contact_phone'] as const) {
      const value = patch[field] ?? gym[field];
      if (typeof value !== 'string' || value.trim().length > (field === 'contact_email' ? 254 : 120))
        throw new ApiError(400, 'Datos de contacto inválidos.');
      contacts[field] = field === 'contact_email' && value.trim() ? email(value) : value.trim();
    }
    if (patch.status === 'active') {
      const ready = this.raw
        .prepare(
          "SELECT 1 FROM gyms g WHERE g.id=? AND g.provisioned=1 AND EXISTS(SELECT 1 FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=g.id AND m.role='admin' AND m.active=1 AND u.active=1)",
        )
        .get(gymId);
      if (!ready) throw new ApiError(409, 'El gimnasio requiere provisión y un administrador activo.');
    }
    const displayName = patch.name === undefined ? gym.name : name(patch.name);
    return this.transaction(() => {
      const archived = patch.archived ?? gym.archived,
        status = patch.status ?? gym.status;
      recordBillingActivity(
        this.raw,
        gymId,
        !gym.archived && gym.status === 'active',
        !archived && status === 'active',
        gym.status === 'provisioning',
      );
      this.raw
        .prepare(
          'UPDATE gyms SET name=?,status=?,archived_at=?,contact_name=?,contact_email=?,contact_phone=?,updated_at=? WHERE id=?',
        )
        .run(
          displayName,
          status,
          archived ? (gym.archived_at ?? Date.now()) : null,
          contacts.contact_name,
          contacts.contact_email,
          contacts.contact_phone,
          Date.now(),
          gymId,
        );
      this.audit(
        actor.id,
        patch.archived === undefined ? 'gym.updated' : archived ? 'gym.archived' : 'gym.restored',
        gymId,
        gymId,
      );
      return this.getGym(gymId)!;
    });
  }

  invite(user: PlatformUser, gymId: string, input: InvitationInput) {
    const actor = this.gymAdmin(user, gymId),
      normalized = email(input.email),
      displayName = name(input.name),
      memberRole = role(input.role);
    if (this.getGym(gymId)!.status === 'provisioning' && memberRole !== 'admin')
      throw new ApiError(409, 'El primer usuario debe ser administrador.');
    if (
      this.raw
        .prepare(
          'SELECT 1 FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=? AND u.email=? AND m.active=1',
        )
        .get(gymId, normalized)
    )
      throw new ApiError(409, 'La cuenta ya pertenece al gimnasio.');
    const value = token(),
      expiresAt = Date.now() + day;
    this.raw
      .prepare('UPDATE invitations SET consumed_at=? WHERE gym_id=? AND email=? AND consumed_at IS NULL')
      .run(Date.now(), gymId, normalized);
    this.raw
      .prepare(
        'INSERT INTO invitations(id,token_hash,gym_id,email,name,role,created_by,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(randomUUID(), secretHash(value), gymId, normalized, displayName, memberRole, actor.id, expiresAt);
    this.audit(actor.id, 'invitation.created', gymId, normalized);
    return { token: value, email: normalized, expires_at: expiresAt };
  }

  async acceptInvitation(
    input: { token: string; name?: string; password?: string },
    currentToken?: string,
  ): Promise<PlatformUser> {
    const getInvite = () =>
      this.raw
        .prepare('SELECT * FROM invitations WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
        .get(secretHash(input.token), Date.now()) as Row | undefined;
    const invite = getInvite();
    if (!invite) throw new ApiError(400, 'La invitación venció o ya fue utilizada.');
    const existing = this.raw.prepare('SELECT * FROM platform_users WHERE email=?').get(invite.email) as
      Row | undefined;
    const session = existing && currentToken ? await this.requireWebSession(currentToken) : null;
    if (existing && (!session || session.user.id !== existing.id))
      throw new ApiError(401, 'Inicia sesión con el correo invitado.');
    const hashed = existing ? null : await passwordHash(input.password ?? '');
    const freshSession = session ? await this.requireWebSession(currentToken!) : null;
    return this.transaction(() => {
      const fresh = getInvite();
      if (!fresh) throw new ApiError(400, 'La invitación venció o ya fue utilizada.');
      const gymRow = this.raw.prepare('SELECT * FROM gyms WHERE id=?').get(fresh.gym_id) as Row;
      if (!gymRow.provisioned) throw new ApiError(409, 'La preparación del gimnasio aún no ha terminado.');
      if (gymRow.status === 'suspended') throw new ApiError(403, 'El gimnasio está suspendido.');
      this.gymAdmin({ id: fresh.created_by } as PlatformUser, fresh.gym_id);
      const nowExisting = this.raw.prepare('SELECT * FROM platform_users WHERE email=?').get(fresh.email) as
        Row | undefined;
      if (nowExisting && (!freshSession || freshSession.user.id !== nowExisting.id || !nowExisting.active))
        throw new ApiError(401, 'Inicia sesión con el correo invitado.');
      const userId = nowExisting?.id ?? randomUUID();
      if (!nowExisting)
        this.raw
          .prepare(
            "INSERT INTO platform_users(id,email,name,password_hash,global_role,created_at) VALUES(?,?,?,?,'user',?)",
          )
          .run(userId, fresh.email, input.name === undefined ? fresh.name : name(input.name), hashed!, Date.now());
      const membership = this.raw
        .prepare('SELECT active FROM gym_memberships WHERE user_id=? AND gym_id=?')
        .get(userId, fresh.gym_id) as Row | undefined;
      if (membership?.active) throw new ApiError(409, 'La cuenta ya pertenece al gimnasio.');
      this.raw
        .prepare(
          'INSERT INTO gym_memberships(user_id,gym_id,role,active) VALUES(?,?,?,1) ON CONFLICT(user_id,gym_id) DO UPDATE SET role=excluded.role,active=1',
        )
        .run(userId, fresh.gym_id, fresh.role);
      this.raw.prepare('UPDATE invitations SET consumed_at=? WHERE id=?').run(Date.now(), fresh.id);
      if (gymRow.status === 'provisioning' && fresh.role === 'admin') {
        this.raw.prepare("UPDATE gyms SET status='active',updated_at=? WHERE id=?").run(Date.now(), fresh.gym_id);
        recordBillingActivity(this.raw, fresh.gym_id, false, gymRow.archived_at === null, true);
      }
      this.audit(userId, 'invitation.accepted', fresh.gym_id, fresh.id);
      return this.currentUser({ id: userId } as PlatformUser);
    });
  }

  private memberCreationActor(user: PlatformUser, gymId: string, memberRole: MembershipRole) {
    const actor = this.gymAdmin(user, gymId);
    const gym = this.raw.prepare('SELECT * FROM gyms WHERE id=?').get(gymId) as Row;
    if (gym.deleted_at !== null || gym.archived_at !== null || gym.status === 'suspended')
      throw new ApiError(403, 'El gimnasio no está disponible para crear personal.');
    if (!gym.provisioned) throw new ApiError(409, 'La preparación del gimnasio aún no ha terminado.');
    if (gym.status === 'provisioning' && memberRole !== 'admin')
      throw new ApiError(409, 'El primer usuario debe ser administrador.');
    return { actor, gym };
  }

  private requireMemberSession(user: PlatformUser, currentToken?: string) {
    if (currentToken === undefined) return;
    const session = this.authenticateSync(currentToken);
    if (!session || session.mobileGymId || session.kioskGymId || session.user.id !== user.id)
      throw new ApiError(401, 'Inicia sesión en la plataforma.');
  }

  async createMember(
    user: PlatformUser,
    gymId: string,
    input: InvitationInput & { password: string },
    currentToken?: string,
  ) {
    this.requireMemberSession(user, currentToken);
    this.gymAdmin(user, gymId);
    const normalized = email(input.email),
      displayName = name(input.name),
      memberRole = role(input.role),
      password = memberPassword(input.password);
    this.memberCreationActor(user, gymId, memberRole);
    const ensureNewIdentity = () => {
      if (this.raw.prepare('SELECT 1 FROM platform_users WHERE email=?').get(normalized))
        throw new ApiError(409, 'Ese correo ya tiene una cuenta. Usa otro correo para crear personal.');
    };
    ensureNewIdentity();
    const hashed = await passwordHash(password);
    this.requireMemberSession(user, currentToken);
    this.memberCreationActor(user, gymId, memberRole);
    return this.transaction(() => {
      this.requireMemberSession(user, currentToken);
      const { actor, gym } = this.memberCreationActor(user, gymId, memberRole);
      ensureNewIdentity();
      const id = randomUUID();
      this.raw
        .prepare(
          "INSERT INTO platform_users(id,email,name,password_hash,global_role,created_at) VALUES(?,?,?,?,'user',?)",
        )
        .run(id, normalized, displayName, hashed, Date.now());
      this.raw
        .prepare('INSERT INTO gym_memberships(user_id,gym_id,role,active) VALUES(?,?,?,1)')
        .run(id, gymId, memberRole);
      if (gym.status === 'provisioning') {
        this.raw.prepare("UPDATE gyms SET status='active',updated_at=? WHERE id=?").run(Date.now(), gymId);
        recordBillingActivity(this.raw, gymId, false, true, true);
      }
      this.audit(actor.id, 'member.created', gymId, id);
      return { id, name: displayName, email: normalized, role: memberRole, active: true };
    });
  }

  private canResetMemberPassword(actor: PlatformUser, gymId: string, member: Row) {
    return (
      member.global_role === 'user' &&
      Boolean(member.user_active) &&
      (actor.global_role === 'superadmin' ||
        !this.raw.prepare('SELECT 1 FROM gym_memberships WHERE user_id=? AND gym_id<>? LIMIT 1').get(member.id, gymId))
    );
  }

  private memberPasswordTarget(user: PlatformUser, gymId: string, userId: string) {
    const actor = this.gymAdmin(user, gymId);
    const member = this.raw
      .prepare(
        'SELECT u.id,u.global_role,u.active AS user_active FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=? AND u.id=?',
      )
      .get(gymId, userId) as Row | undefined;
    if (!member) throw new ApiError(404, 'Usuario no encontrado en este gimnasio.');
    if (!this.canResetMemberPassword(actor, gymId, member))
      throw new ApiError(403, 'No tienes permiso para cambiar la contraseña de esta cuenta.');
    return actor;
  }

  async setMemberPassword(user: PlatformUser, gymId: string, userId: string, password: string, currentToken?: string) {
    this.requireMemberSession(user, currentToken);
    this.memberPasswordTarget(user, gymId, userId);
    const hashed = await passwordHash(memberPassword(password));
    this.requireMemberSession(user, currentToken);
    this.memberPasswordTarget(user, gymId, userId);
    this.transaction(() => {
      this.requireMemberSession(user, currentToken);
      const actor = this.memberPasswordTarget(user, gymId, userId);
      this.raw.prepare('UPDATE platform_users SET password_hash=? WHERE id=?').run(hashed, userId);
      this.revokeUserSessions(userId);
      this.raw
        .prepare('UPDATE password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL')
        .run(Date.now(), userId);
      this.audit(actor.id, 'member.password_changed', gymId, userId);
    });
  }

  listMembers(user: PlatformUser, gymId: string) {
    const actor = this.gymAdmin(user, gymId);
    return (
      this.raw
        .prepare(
          'SELECT u.id,u.email,u.name,u.global_role,u.active AS user_active,m.role,m.active FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=? ORDER BY u.name,u.id',
        )
        .all(gymId) as Row[]
    ).map((row) => ({
      id: row.id,
      email: row.email,
      name: row.name,
      role: row.role as MembershipRole,
      active: Boolean(row.active),
      can_reset_password: this.canResetMemberPassword(actor, gymId, row),
    }));
  }

  updateMembership(
    user: PlatformUser,
    gymId: string,
    userId: string,
    patch: { role?: MembershipRole; active?: boolean },
  ) {
    return this.transaction(() => {
      const actor = this.gymAdmin(user, gymId);
      const member = this.raw
        .prepare('SELECT * FROM gym_memberships WHERE user_id=? AND gym_id=?')
        .get(userId, gymId) as Row | undefined;
      if (!member) throw new ApiError(404, 'Usuario no encontrado en este gimnasio.');
      if (patch.active !== undefined && typeof patch.active !== 'boolean')
        throw new ApiError(400, 'Estado de usuario inválido.');
      const nextRole = patch.role === undefined ? member.role : role(patch.role),
        active = patch.active === undefined ? Boolean(member.active) : patch.active;
      if (member.role === 'admin' && member.active && (nextRole !== 'admin' || !active)) {
        const other = this.raw
          .prepare(
            "SELECT 1 FROM gym_memberships m JOIN platform_users u ON u.id=m.user_id WHERE m.gym_id=? AND m.user_id<>? AND m.role='admin' AND m.active=1 AND u.active=1 LIMIT 1",
          )
          .get(gymId, userId);
        if (!other) throw new ApiError(409, 'El gimnasio debe conservar al menos un administrador activo.');
      }
      this.raw
        .prepare('UPDATE gym_memberships SET role=?,active=? WHERE user_id=? AND gym_id=?')
        .run(nextRole, active ? 1 : 0, userId, gymId);
      this.audit(actor.id, 'membership.updated', gymId, userId);
      const identity = this.raw.prepare('SELECT id,email,name FROM platform_users WHERE id=?').get(userId) as {
        id: string;
        email: string;
        name: string;
      };
      return { ...identity, role: nextRole as MembershipRole, active };
    });
  }

  async createSupport(value: string, gymId: string, reason: string) {
    const session = await this.requireWebSession(value);
    this.superadmin(session.user);
    const target = this.getGym(gymId);
    if (!target) throw new ApiError(404, 'Gimnasio no encontrado.');
    if (target.deleted) throw new ApiError(409, 'Restaura el gimnasio antes de iniciar soporte.');
    if (target.archived) throw new ApiError(409, 'Restaura el gimnasio antes de iniciar soporte.');
    if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 1000)
      throw new ApiError(400, 'Indica un motivo de soporte de 3 a 1000 caracteres.');
    const secret = token(),
      expiresAt = Date.now() + 30 * 60_000;
    this.raw
      .prepare(
        'INSERT INTO support_sessions(id,token_hash,user_id,session_id,gym_id,reason,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(randomUUID(), secretHash(secret), session.user.id, session.id, gymId, reason.trim(), Date.now(), expiresAt);
    this.audit(session.user.id, 'support.started', gymId);
    return { support_token: secret, expires_at: expiresAt };
  }

  async revokeSupport(value: string, supportToken: string) {
    const session = await this.requireWebSession(value);
    this.superadmin(session.user);
    const grant = this.raw
      .prepare('SELECT * FROM support_sessions WHERE token_hash=? AND session_id=? AND user_id=?')
      .get(secretHash(supportToken), session.id, session.user.id) as Row | undefined;
    if (!grant) throw new ApiError(404, 'Soporte no encontrado.');
    this.raw.prepare('UPDATE support_sessions SET revoked_at=? WHERE id=?').run(Date.now(), grant.id);
    this.audit(session.user.id, 'support.ended', grant.gym_id, grant.id);
  }

  private revokeUserSessions(userId: string) {
    this.raw
      .prepare('UPDATE platform_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .run(Date.now(), userId);
    this.raw
      .prepare('UPDATE support_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
      .run(Date.now(), userId);
  }

  async changePassword(value: string, current: string, password: string) {
    const session = await this.requireWebSession(value);
    const row = this.raw.prepare('SELECT * FROM platform_users WHERE id=?').get(session.user.id) as Row;
    if (typeof current !== 'string' || current.length > 200 || !(await verifyPassword(current, row.password_hash)))
      throw new ApiError(403, 'La contraseña actual no coincide.');
    const hashed = await passwordHash(password);
    await this.requireWebSession(value);
    this.transaction(() => {
      const updated = this.raw
        .prepare('UPDATE platform_users SET password_hash=? WHERE id=? AND password_hash=? AND active=1')
        .run(hashed, session.user.id, row.password_hash);
      if (!updated.changes) throw new ApiError(409, 'La contraseña ya cambió.');
      this.revokeUserSessions(session.user.id);
      this.raw
        .prepare('UPDATE password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL')
        .run(Date.now(), session.user.id);
      this.audit(session.user.id, 'password.changed');
    });
  }

  createRecovery(user: PlatformUser, userId: string) {
    const actor = this.superadmin(user);
    if (!this.raw.prepare('SELECT 1 FROM platform_users WHERE id=? AND active=1').get(userId))
      throw new ApiError(404, 'Usuario no encontrado.');
    const secret = token(),
      expiresAt = Date.now() + day;
    this.raw
      .prepare('UPDATE password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL')
      .run(Date.now(), userId);
    this.raw
      .prepare('INSERT INTO password_resets(id,token_hash,user_id,expires_at) VALUES(?,?,?,?)')
      .run(randomUUID(), secretHash(secret), userId, expiresAt);
    this.audit(actor.id, 'recovery.created', undefined, userId);
    return { token: secret, expires_at: expiresAt };
  }

  async acceptRecovery(secret: string, password: string) {
    const hashed = await passwordHash(password);
    this.transaction(() => {
      const reset = this.raw
        .prepare('SELECT * FROM password_resets WHERE token_hash=? AND consumed_at IS NULL AND expires_at>?')
        .get(secretHash(secret), Date.now()) as Row | undefined;
      if (!reset) throw new ApiError(400, 'El enlace venció o ya fue utilizado.');
      const result = this.raw
        .prepare('UPDATE platform_users SET password_hash=? WHERE id=? AND active=1')
        .run(hashed, reset.user_id);
      if (!result.changes) throw new ApiError(400, 'El enlace no está disponible.');
      this.raw
        .prepare('UPDATE password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL')
        .run(Date.now(), reset.user_id);
      this.revokeUserSessions(reset.user_id);
      this.audit(reset.user_id, 'recovery.accepted');
    });
  }

  async administrativeRecovery(input: { email: string; password: string }) {
    const normalized = email(input.email),
      hashed = await passwordHash(input.password);
    this.transaction(() => {
      const row = this.raw
        .prepare("SELECT * FROM platform_users WHERE email=? AND global_role='superadmin' AND active=1")
        .get(normalized) as Row | undefined;
      if (!row) throw new ApiError(404, 'Propietario no encontrado.');
      this.raw.prepare('UPDATE platform_users SET password_hash=? WHERE id=?').run(hashed, row.id);
      this.revokeUserSessions(row.id);
      this.raw
        .prepare('UPDATE password_resets SET consumed_at=? WHERE user_id=? AND consumed_at IS NULL')
        .run(Date.now(), row.id);
      this.audit(row.id, 'recovery.administrative');
    });
  }

  audit(userId: string, action: string, gymId?: string, entityId?: string): void {
    this.raw
      .prepare('INSERT INTO platform_audit(id,user_id,gym_id,action,entity_id,created_at) VALUES(?,?,?,?,?,?)')
      .run(randomUUID(), userId, gymId ?? null, action, entityId ?? null, Date.now());
  }

  listAudit(user: PlatformUser, limit = 200) {
    this.superadmin(user);
    return this.raw
      .prepare(
        'SELECT a.*,u.name AS actor_name,u.email AS actor_email FROM platform_audit a JOIN platform_users u ON u.id=a.user_id ORDER BY a.created_at DESC,a.id DESC LIMIT ?',
      )
      .all(Math.max(1, Math.min(1000, limit)));
  }

  close(): void {
    this.raw.close();
  }
}
