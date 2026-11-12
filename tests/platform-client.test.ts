import assert from 'node:assert/strict';
import test from 'node:test';
import { api } from '../src/api.ts';
import { apiUrl, getPlatformContext, platformFetch, setPlatformContext } from '../src/platform-context.ts';
import { componentHarness, componentStubs, elementText, findElement } from './component-harness.ts';

function scopedImageFixture(t: test.TestContext, token?: string, label = 'image') {
  const created: string[] = [];
  const revoked: string[] = [];
  const h = componentHarness({
    URL: {
      createObjectURL: () => {
        const url = 'blob:' + label + '-' + (created.length + 1);
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => revoked.push(url),
    },
  });
  t.after(() => h.cleanup());
  const context = h.load('../src/platform-context.ts');
  if (token) context.setPlatformContext({ gymId: 'gym-a', supportToken: token });
  const { default: ScopedImage } = h.load('../src/ScopedImage.tsx', { './platform-context': context });
  let src = '/api/gyms/gym-a/branding/logo?v=1';
  h.render(() => ScopedImage({ src, alt: 'Logo del gimnasio' }));
  return {
    h,
    context,
    created,
    revoked,
    change(next: string) {
      src = next;
      h.render(() => ScopedImage({ src, alt: 'Logo del gimnasio' }));
    },
  };
}

test('Plataforma: las imágenes de dos pestañas conservan su soporte aunque se revoque la otra', async (t) => {
  let revokedB = false;
  const requests: { path: string; token: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (path: string, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('X-GymPASS-Support');
    requests.push({ path, token });
    if (token !== 'grant-A' && (token !== 'grant-B' || revokedB)) return new Response(null, { status: 403 });
    return new Response(new Blob(['image'], { type: 'image/png' }));
  });
  const a = scopedImageFixture(t, 'grant-A', 'A');
  const b = scopedImageFixture(t, 'grant-B', 'B');
  assert.equal(findElement(await a.h.settle(), (el) => el.type === 'img').props.src, 'blob:A-1');
  assert.equal(findElement(await b.h.settle(), (el) => el.type === 'img').props.src, 'blob:B-1');
  revokedB = true;
  a.change('/api/gyms/gym-a/people/person-1/photo?v=2');
  b.change('/api/gyms/gym-a/people/person-1/photo?v=2');
  assert.equal(findElement(await a.h.settle(), (el) => el.type === 'img').props.src, 'blob:A-2');
  assert.equal(findElement(await b.h.settle(), (el) => el.type === 'img').props.src, undefined);
  assert.deepEqual(requests.slice(-2), [
    { path: '/api/gyms/gym-a/people/person-1/photo?v=2', token: 'grant-A' },
    { path: '/api/gyms/gym-a/people/person-1/photo?v=2', token: 'grant-B' },
  ]);
  assert.deepEqual(a.revoked, ['blob:A-1']);
  a.h.cleanup();
  assert.deepEqual(a.revoked, ['blob:A-1', 'blob:A-2']);
});

test('Plataforma: las imágenes locales siguen directas sin peticiones Blob', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => {
    assert.fail('La imagen local debe cargarse directamente.');
  });
  const f = scopedImageFixture(t);
  f.change('/api/branding/logo?v=local');
  const image = findElement(await f.h.settle(), (el) => el.type === 'img');
  assert.equal(image.props.src, '/api/branding/logo?v=local');
  assert.equal(image.props.alt, 'Logo del gimnasio');
  assert.equal(f.created.length, 0);
});

test('Plataforma: cambiar de gimnasio cancela la imagen y descarta un cuerpo tardío', async (t) => {
  let release!: (blob: Blob) => void;
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', async (_path: string, init?: RequestInit) => {
    signal = init?.signal;
    return {
      ok: true,
      blob: () =>
        new Promise<Blob>((resolve) => {
          release = resolve;
        }),
    } as Response;
  });
  const f = scopedImageFixture(t, 'grant-A');
  await f.h.settle();
  f.context.setPlatformContext({ gymId: 'gym-b', supportToken: 'grant-new' });
  assert.equal(signal?.aborted, true);
  release(new Blob(['old-image']));
  assert.equal(findElement(await f.h.settle(), (el) => el.type === 'img').props.src, undefined);
  assert.equal(f.created.length, 0);
});

test('Plataforma: desmontar cancela la petición de imagen pendiente', async (t) => {
  let signal: AbortSignal | null | undefined;
  t.mock.method(globalThis, 'fetch', (_path: string, init?: RequestInit) => {
    signal = init?.signal;
    return new Promise<Response>(() => {});
  });
  const f = scopedImageFixture(t, 'grant-A');
  f.h.cleanup();
  assert.equal(signal?.aborted, true);
});

test('Plataforma: las rutas de datos, fotos y exportaciones quedan ligadas al gimnasio', () => {
  setPlatformContext({ gymId: 'gym-a' });
  assert.equal(apiUrl('bootstrap'), '/api/gyms/gym-a/bootstrap');
  assert.equal(apiUrl('/api/people/12/photo?v=3'), '/api/gyms/gym-a/people/12/photo?v=3');
  assert.equal(apiUrl('reports/export?month=2026-11'), '/api/gyms/gym-a/reports/export?month=2026-11');
  assert.equal(apiUrl('platform/status'), '/api/platform/status');
  assert.equal(apiUrl('health'), '/api/health');
  assert.equal(apiUrl('blob:photo'), 'blob:photo');
  assert.deepEqual(getPlatformContext(), { gymId: 'gym-a' });
  setPlatformContext(null);
  assert.equal(apiUrl('bootstrap'), '/api/bootstrap');
});

test('Plataforma: el soporte acompaña consultas y subidas sin alterar la petición central', async (t) => {
  t.after(() => setPlatformContext(null));
  const requests: { url: string; support: string | null; marker: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers);
    requests.push({ url, support: headers.get('X-GymPASS-Support'), marker: headers.get('X-Requested-With') });
    return Response.json({ ok: true });
  });
  setPlatformContext({ gymId: 'gym-a', supportToken: 'support-secret' });
  await platformFetch('people', { headers: { 'X-Requested-With': 'GymPASS' } });
  await platformFetch('platform/status');
  assert.deepEqual(requests, [
    { url: '/api/gyms/gym-a/people', support: 'support-secret', marker: 'GymPASS' },
    { url: '/api/platform/status', support: null, marker: null },
  ]);
});

for (const status of [200, 401]) {
  test(`Plataforma: descarta una respuesta ${status} del gimnasio anterior`, async (t) => {
    const events = new EventTarget();
    Object.defineProperty(globalThis, 'window', { configurable: true, value: events });
    t.after(() => {
      setPlatformContext(null);
      Reflect.deleteProperty(globalThis, 'window');
    });
    let expired = 0;
    events.addEventListener('session-expired', () => expired++);
    let release!: (response: Response) => void;
    let previousSignal: AbortSignal | null | undefined;
    t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => {
      previousSignal = init.signal;
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    setPlatformContext({ gymId: 'gym-a' });
    const request = assert.rejects(
      api('bootstrap'),
      (error: unknown) => error instanceof Error && error.name === 'AbortError',
    );
    setPlatformContext({ gymId: 'gym-b' });
    assert.equal(previousSignal?.aborted, true);
    release(Response.json(status === 200 ? { gym: 'gym-a' } : { error: 'Inicia sesión.' }, { status }));
    await request;
    assert.equal(expired, 0);
  });
}

test('Plataforma: protege el contexto de mutaciones hechas por consumidores', () => {
  const context = { gymId: 'gym-a', supportToken: 'first' };
  setPlatformContext(context);
  context.gymId = 'gym-b';
  const copy = getPlatformContext()!;
  copy.supportToken = 'changed';
  assert.equal(apiUrl('bootstrap'), '/api/gyms/gym-a/bootstrap');
  assert.equal(getPlatformContext()?.supportToken, 'first');
  setPlatformContext(null);
});

test('Plataforma: no envía el secreto de soporte a una URL externa', async (t) => {
  t.after(() => setPlatformContext(null));
  let support: string | null = 'not-read';
  t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    support = new Headers(init.headers).get('X-GymPASS-Support');
    return Response.json({ ok: true });
  });
  setPlatformContext({ gymId: 'gym-a', supportToken: 'support-secret' });
  await platformFetch('https://elsewhere.example.test/image');
  assert.equal(support, null);
});

function platformFixture(t: test.TestContext, initial: any) {
  const calls: { path: string; method?: string; body?: any }[] = [];
  let current = initial;
  const contexts: unknown[] = [];
  const h = componentHarness({
    location: { hash: '', search: '', origin: 'https://gym.example.test', pathname: '/' },
    history: { replaceState() {} },
    URL,
  });
  t.after(() => h.cleanup());
  const { default: Platform } = h.load('../src/Platform.tsx', {
    'lucide-react': componentStubs,
    './ui': { ...componentStubs, Skeleton: 'Skeleton', Empty: 'Empty', Form: 'Form', Field: 'Field', Modal: 'Modal' },
    './App': { default: 'OperationalApp' },
    './CloudSync': { default: 'CloudSync' },
    './PlatformBackups': { default: 'PlatformBackups' },
    './PlatformKiosk': { default: 'PlatformKiosk' },
    './AppDownloads': { default: 'AppDownloads' },
    './BrandLogo': { default: 'BrandLogo' },
    './PlatformMembers': { default: 'PlatformMembers' },
    './PlatformAnnouncements': { default: 'PlatformAnnouncements' },
    './PlatformBilling': { default: 'PlatformBilling', PlatformBillingSummary: 'PlatformBillingSummary' },
    './styles/platform.css': {},
    './platform-context': {
      setPlatformContext: (value: unknown) => contexts.push(value ? JSON.parse(JSON.stringify(value)) : null),
    },
    './api': {
      HttpError: class extends Error {},
      api: async (path: string, method?: string, body?: any) => {
        calls.push({ path, method, body });
        if (path === 'platform/status') {
          if (current instanceof Error) throw current;
          return current;
        }
        if (path === 'platform/logout') {
          current = { ...current, user: null, gyms: [] };
          return { ok: true };
        }
        if (path === 'platform/gyms' && method === 'POST')
          return {
            gym: { id: 'new', name: body.name, slug: body.slug, status: 'provisioning' },
            member: { id: 'first-admin', name: body.admin_name, email: body.admin_email, role: 'admin', active: true },
          };
        if (path.endsWith('/support') && method === 'POST')
          return { support_token: 'support-secret', expires_at: Date.now() + 1800000 };
        return { ok: true };
      },
    },
  });
  h.render(() => Platform());
  return {
    h,
    calls,
    contexts,
    setStatus(value: any) {
      current = value;
    },
  };
}

const account = { id: 'user-1', email: 'admin@example.test', name: 'Ana', global_role: 'user' };
const gymA = { id: 'gym-a', name: 'Gimnasio A', slug: 'gimnasio-a', status: 'active', role: 'admin' };
const gymB = { id: 'gym-b', name: 'Gimnasio B', slug: 'gimnasio-b', status: 'active', role: 'operator' };

test('Plataforma: abre directamente el único gimnasio autorizado', async (t) => {
  const f = platformFixture(t, { mode: 'platform', protocol: 1, user: account, gyms: [gymA] });
  const tree = await f.h.settle();
  assert.ok(findElement(tree, (el) => el.type === 'OperationalApp'));
  assert.deepEqual(f.contexts.at(-1), { gymId: 'gym-a' });
  assert.ok(findElement(tree, (el) => el.type === 'BrandLogo'));
  assert.match(elementText(tree), /Ana/);
});

test('Plataforma: un servidor local conserva la aplicación existente al responder 404', async (t) => {
  const f = platformFixture(t, Object.assign(new Error('No existe.'), { status: 404 }));
  const tree = await f.h.settle();
  assert.ok(findElement(tree, (el) => el.type === 'OperationalApp'));
  assert.equal(f.contexts.at(-1), null);
});

test('Plataforma: reconoce el protocolo local sin tratarlo como error de conexión', async (t) => {
  const f = platformFixture(t, { mode: 'local', protocol: 1, user: null, gyms: [] });
  const tree = await f.h.settle();
  assert.ok(findElement(tree, (el) => el.type === 'OperationalApp'));
  assert.equal(f.contexts.at(-1), null);
});

test('Plataforma: permite la selección inicial y no ofrece cambiar de gimnasio a cuentas normales', async (t) => {
  const f = platformFixture(t, { mode: 'platform', protocol: 1, user: account, gyms: [gymA, gymB] });
  let tree = await f.h.settle();
  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Gimnasio B')).props.onClick();
  tree = await f.h.settle();
  assert.deepEqual(f.contexts.at(-1), { gymId: 'gym-b' });
  assert.equal(findElement(tree, (el) => el.type === 'OperationalApp').props['data-gym'], undefined);
  assert.doesNotMatch(elementText(tree), /Cambiar gimnasio|Volver a gimnasios|Terminar soporte/);
  assert.ok(findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Cerrar sesión')));
});

test('Plataforma: el alta crea al primer administrador con contraseña y sin invitación', async (t) => {
  const f = platformFixture(t, {
    mode: 'platform',
    protocol: 1,
    user: { ...account, global_role: 'superadmin' },
    gyms: [],
  });
  let tree = await f.h.settle();
  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Crear gimnasio')).props.onClick();
  tree = await f.h.settle();
  const form = findElement(tree, (el) => el.type === 'Form');
  assert.ok(findElement(form, (el) => el.type === 'input' && el.props.name === 'admin_password'));
  const values = new FormData();
  for (const [key, value] of Object.entries({
    name: 'Nuevo gimnasio',
    slug: 'nuevo',
    admin_name: 'María',
    admin_email: 'maria@example.test',
    admin_password: 'maria-secret',
    admin_password_confirmation: 'maria-secret',
  }))
    values.set(key, value);
  await form.props.onSubmit(values);
  tree = await f.h.settle();
  const created = f.calls.find((call) => call.path === 'platform/gyms' && call.method === 'POST');
  assert.equal(created?.body.admin_password, 'maria-secret');
  assert.equal(created?.body.admin_password_confirmation, undefined);
  assert.match(elementText(tree), /administrador ya puede iniciar sesión/);
  assert.throws(() => findElement(tree, (el) => el.type === 'input' && el.props.readOnly));
});

test('Plataforma: el superadministrador entra en soporte solo después de registrar un motivo', async (t) => {
  const f = platformFixture(t, {
    mode: 'platform',
    protocol: 1,
    user: { ...account, global_role: 'superadmin' },
    gyms: [gymA],
  });
  let tree = await f.h.settle();
  assert.equal(
    f.calls.some((call) => call.path.endsWith('/support')),
    false,
  );
  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Abrir soporte')).props.onClick();
  tree = await f.h.settle();
  const values = new FormData();
  values.set('reason', 'Revisar recepción con el administrador');
  await findElement(tree, (el) => el.type === 'Form').props.onSubmit(values);
  tree = await f.h.settle();
  assert.deepEqual(f.contexts.at(-1), { gymId: 'gym-a', supportToken: 'support-secret' });
  assert.match(elementText(tree), /Soporte/);
  assert.ok(findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Terminar soporte')));
});

test('Plataforma: el administrador crea personal directamente y actualiza la lista', async (t) => {
  const requests: { path: string; method?: string; body?: any }[] = [];
  const h = componentHarness({ location: { origin: 'https://gym.example.test', pathname: '/' } });
  t.after(() => h.cleanup());
  const { default: PlatformMembers } = h.load('../src/PlatformMembers.tsx', {
    'lucide-react': componentStubs,
    './ui': { ...componentStubs, Skeleton: 'Skeleton', Empty: 'Empty', Form: 'Form', Field: 'Field', Modal: 'Modal' },
    './api': {
      api: async (path: string, method?: string, body?: any) => {
        requests.push({ path, method, body });
        if (path.endsWith('/members') && method !== 'POST')
          return { members: [{ id: 'member-a', name: 'Ana', email: 'ana@example.test', role: 'admin', active: true }] };
        return { member: { id: 'new-member', ...body, active: true } };
      },
    },
  });
  h.render(() => PlatformMembers({ gymId: 'gym-a' }));
  let tree = await h.settle();
  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Crear usuario')).props.onClick();
  tree = await h.settle();
  const form = findElement(tree, (el) => el.type === 'Form');
  assert.ok(
    findElement(form, (el) => el.type === 'input' && el.props.name === 'password' && el.props.type === 'password'),
  );
  const values = new FormData();
  values.set('name', 'Beatriz');
  values.set('email', 'bea@example.test');
  values.set('role', 'operator');
  values.set('password', 'bea-secret');
  values.set('password_confirmation', 'bea-secret');
  await form.props.onSubmit(values);
  tree = await h.settle();
  const created = requests.find((request) => request.method === 'POST');
  assert.equal(created?.path, 'platform/gyms/gym-a/members');
  assert.equal(created?.body.role, 'operator');
  assert.equal(created?.body.password, 'bea-secret');
  assert.equal(created?.body.password_confirmation, undefined);
  assert.equal(requests.at(-1)?.method, undefined);
  assert.match(elementText(tree), /Usuario creado/);
  assert.throws(() => findElement(tree, (el) => el.type === 'input' && el.props.readOnly));
});

for (const section of ['members', 'network', 'system', 'password']) {
  test(`Plataforma: configuración ${section} usa las herramientas centrales`, async (t) => {
    let sessionEnded = 0;
    const h = componentHarness({
      location: { hash: '#settings?tab=' + section, origin: 'https://gym.example.test' },
      document: { getElementById: () => null },
      Event,
      window: {
        dispatchEvent: (event: Event) => {
          if (event.type === 'session-expired') sessionEnded++;
        },
      },
    });
    t.after(() => h.cleanup());
    const { default: Settings } = h.load('../src/Settings.tsx', {
      'lucide-react': componentStubs,
      './ui': { ...componentStubs, Field: 'Field', Form: 'Form', stamp: () => '' },
      './api': { api: async () => ({ ok: true }) },
      './Members': { default: 'LocalMembers' },
      './Devices': { default: 'Devices' },
      './Appearance': { default: 'Appearance' },
      './GymLogo': { default: 'GymLogo' },
      './CredentialStyle': { default: 'CredentialStyle' },
      '../lib/domain': { generalAccessId: 'general' },
      './ConnectionSettings': { default: 'ConnectionSettings' },
      './styles/app-downloads.css': {},
      './CloudSync': { default: 'CloudSync' },
      './Network': { default: 'LocalNetwork' },
      './SystemSettings': { default: 'LocalSystem' },
      './RecoveryKey': { default: 'LocalRecovery' },
      './PlatformMembers': { default: 'PlatformMembers' },
      './PlatformAnnouncements': { default: 'PlatformAnnouncements' },
      './PlatformBackups': { default: 'PlatformBackups' },
    });
    const tree = h.render(() =>
      Settings({
        data: {
          user: { id: 'current-admin' },
          platform: { gym_id: 'gym-a', gym_name: 'Gimnasio A', support: false, superadmin: false },
          settings: { name: 'Gimnasio A', timezone: 'America/La_Paz' },
        },
        admin: true,
        saved: async () => {},
        notify() {},
        members: [],
        devices: [],
        audit: [],
      }),
    );
    assert.throws(() =>
      findElement(tree, (el) =>
        ['LocalMembers', 'LocalNetwork', 'LocalSystem', 'LocalRecovery'].includes(String(el.type)),
      ),
    );
    if (section === 'members') {
      assert.equal(findElement(tree, (el) => el.type === 'PlatformMembers').props.gymId, 'gym-a');
      assert.equal(findElement(tree, (el) => el.type === 'PlatformMembers').props.currentUserId, 'current-admin');
    }
    if (section === 'network') assert.match(elementText(tree), /HTTPS|https:/);
    if (section === 'system') assert.match(elementText(tree), /respaldo/i);
    if (section === 'password') {
      const values = new FormData();
      values.set('current', 'Anterior123');
      values.set('password', 'Nueva123');
      values.set('confirm', 'Nueva123');
      await findElement(tree, (el) => el.type === 'Form').props.onSubmit(values);
      assert.equal(sessionEnded, 1, 'Cambiar la contraseña central exige volver a entrar con la sesión revocada.');
    }
  });
}

test('Plataforma: restaurar un respaldo exige confirmación y contraseña central', async (t) => {
  const calls: { path: string; method?: string; body?: any }[] = [];
  const downloads: { path: string; filename: string }[] = [];
  const copy = {
    id: 'copy-a',
    created_at: 1793469845334,
    version: '2.2.0',
    kind: 'manual',
    people: 4,
    events: 12,
    invitations: 0,
    schema: 14,
    bytes: 4000,
  };
  const h = componentHarness();
  t.after(() => h.cleanup());
  const { default: PlatformBackups } = h.load('../src/PlatformBackups.tsx', {
    'lucide-react': componentStubs,
    './ui': { ...componentStubs, Skeleton: 'Skeleton', Empty: 'Empty', Form: 'Form', Field: 'Field', Modal: 'Modal' },
    './api': {
      download: async (path: string, filename: string) => {
        downloads.push({ path, filename });
      },
      api: async (path: string, method?: string, body?: any) => {
        calls.push({ path, method, body });
        if (path === 'backups' && !method) return { copies: [copy], settings: {}, last: copy, error: '' };
        if (path.endsWith('/inspect')) return copy;
        if (path.endsWith('/restore')) return { preview: copy, safety: 'safety-a', restart: false };
        return copy;
      },
    },
  });
  h.render(() => PlatformBackups({ gymName: 'Gimnasio A', suspended: false, canRestore: true }));
  let tree = await h.settle();
  findElement(tree, (el) => el.type === 'button' && /Descargar|Exportar/.test(elementText(el))).props.onClick();
  tree = await h.settle();
  assert.deepEqual(downloads, [{ path: 'backups/copy-a/export', filename: 'copy-a.gympassbackup' }]);
  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Restaurar')).props.onClick();
  tree = await h.settle();
  const form = findElement(tree, (el) => el.type === 'Form');
  const invalid = new FormData();
  invalid.set('password', 'Seguro123');
  invalid.set('confirm', 'NO');
  await assert.rejects(form.props.onSubmit(invalid), /RESTAURAR/);
  assert.equal(
    calls.some((call) => call.path.endsWith('/restore')),
    false,
  );
  const valid = new FormData();
  valid.set('password', 'Seguro123');
  valid.set('confirm', 'RESTAURAR');
  await form.props.onSubmit(valid);
  assert.equal(calls.find((call) => call.path.endsWith('/restore'))?.body.password, 'Seguro123');
  tree = await h.settle();
  assert.match(elementText(tree), /Datos restaurados. Copia previa: safety-a/);
});

test('Plataforma: el superadministrador envía un aviso a los gimnasios elegidos y lo retira', async (t) => {
  const requests: { path: string; method?: string; body?: any }[] = [];
  const sent: any[] = [];
  const h = componentHarness({
    location: { origin: 'https://gym.example.test', pathname: '/' },
    confirm: () => true,
  });
  t.after(() => h.cleanup());
  const { default: PlatformAnnouncements } = h.load('../src/PlatformAnnouncements.tsx', {
    'lucide-react': componentStubs,
    './ui': { ...componentStubs, Skeleton: 'Skeleton', Empty: 'Empty', Form: 'Form', Field: 'Field' },
    './api': {
      api: async (path: string, method?: string, body?: any) => {
        requests.push({ path, method, body });
        if (method === 'POST') {
          sent.push({ id: 'aviso-1', ...body, created_at: 0, expires_at: null, revoked_at: null, author: 'Dueño' });
          return { announcement: sent.at(-1) };
        }
        if (method === 'DELETE') {
          sent[0] = { ...sent[0], revoked_at: 1 };
          return { announcement: sent[0] };
        }
        return { announcements: sent };
      },
    },
  });
  const gyms = [
    { id: 'gym-a', name: 'Centro' },
    { id: 'gym-b', name: 'Norte' },
  ];
  h.render(() => PlatformAnnouncements({ gyms }));
  let tree = await h.settle();
  assert.ok(findElement(tree, (el) => el.type === 'Empty'));

  // Sin elegir destinatarios el aviso va a todos los gimnasios.
  const values = new FormData();
  values.set('title', 'Mantenimiento el domingo');
  values.set('body', 'El servicio se detendrá de 02:00 a 04:00.');
  values.set('severity', 'warning');
  values.set('days', '3');
  const form = () => findElement(h.render(() => PlatformAnnouncements({ gyms })), (el) => el.type === 'Form');
  await findElement(tree, (el) => el.type === 'Form').props.onSubmit(values);
  tree = await h.settle();
  const created = requests.find((request) => request.method === 'POST');
  assert.equal(created?.path, 'platform/announcements');
  assert.equal(created?.body.title, 'Mantenimiento el domingo');
  assert.equal(created?.body.body, 'El servicio se detendrá de 02:00 a 04:00.');
  assert.equal(created?.body.severity, 'warning');
  assert.equal(created?.body.days, '3');
  assert.equal(created?.body.gym_ids.length, 0, 'Sin destinatarios elegidos el aviso va a todos');
  assert.match(elementText(tree), /todos los gimnasios/i);
  assert.match(elementText(tree), /Importante/);

  // Elegir gimnasios exige marcar al menos uno.
  findElement(tree, (el) => el.type === 'select' && el.props.value === 'all').props.onChange({
    target: { value: 'selected' },
  });
  tree = await h.settle();
  await assert.rejects(form().props.onSubmit(values), /al menos un gimnasio/);
  findElement(tree, (el) => el.type === 'input' && el.props.type === 'checkbox').props.onChange({
    target: { checked: true },
  });
  tree = await h.settle();
  await form().props.onSubmit(values);
  tree = await h.settle();
  assert.deepEqual([...requests.filter((request) => request.method === 'POST').at(-1)?.body.gym_ids], ['gym-a']);

  findElement(tree, (el) => el.type === 'button' && elementText(el).includes('Retirar')).props.onClick();
  tree = await h.settle();
  const removed = requests.filter((request) => request.method === 'DELETE');
  assert.equal(removed.length, 1);
  assert.equal(removed[0].path, 'platform/announcements/aviso-1');
  // Retirar recarga la lista: el aviso queda marcado y solo el que sigue vigente conserva el botón.
  assert.equal(requests.at(-1)?.method, undefined);
  assert.match(elementText(tree), /Retirado/);
  const remaining = findElement(tree, (el) => el.type === 'li' && elementText(el).includes('Retirar'));
  assert.doesNotMatch(elementText(remaining), /Retirado/);
});
