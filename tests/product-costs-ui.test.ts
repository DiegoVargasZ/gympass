import test from 'node:test';
import assert from 'node:assert/strict';
import { componentHarness, componentStubs, elementText, findElement } from './component-harness.ts';

function editor(t: { after(fn: () => void): void }, item?: unknown) {
  const calls: any[] = [];
  const h = componentHarness(); t.after(() => h.cleanup());
  const { CatalogEditor } = h.load('../src/Pos.tsx', {
    'react-dom': { createPortal: (value: unknown) => value }, 'lucide-react': componentStubs,
    '../lib/pos-types': {}, './api': { api: async (...args: unknown[]) => { calls.push(args); return { id: 'product' }; } },
    './usePeople': {}, './browser': {}, './PersonMemberships': { default: 'PersonMemberships' },
    './PosReports': { default: 'PosReports' }, './ShareCredentialButton': { default: 'ShareCredentialButton' },
    './ui': componentStubs, './styles/pos.css': {},
  });
  const tree = h.render(() => CatalogEditor({ kind: 'product', item, onClose() {}, onSaved: async () => {} }));
  return { h, tree, calls };
}

test('el producto pide costo y precio, no muestra SKU y envía centavos con coma decimal', async t => {
  const { tree, calls } = editor(t);
  assert.ok(findElement(tree, el => el.props.label === 'Costo de compra por unidad (BOB)'));
  assert.ok(findElement(tree, el => el.props.label === 'Precio de venta (BOB)'));
  assert.throws(() => findElement(tree, el => el.props.name === 'sku'));
  assert.doesNotMatch(elementText(tree), /SKU|Código/);
  assert.equal(findElement(tree, el => el.type === 'input' && el.props.name === 'cost').props.required, true);
  const form = new FormData();
  for (const [key, value] of Object.entries({ name: 'Agua', price: '5,50', cost: '2,25', stock: '10', active: '1', track_stock: '1' })) form.set(key, value);
  await findElement(tree, el => el.type === 'Form').props.onSubmit(form);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].cost_cents, 225);
  assert.equal(calls[0][2].price_cents, 550);
  assert.ok(!('sku' in calls[0][2]));
});

test('un costo ausente o inválido impide guardar; el cero sí se guarda', async t => {
  const { tree, calls } = editor(t);
  const submit = findElement(tree, el => el.type === 'Form').props.onSubmit;
  const form = new FormData(); form.set('name', 'Agua'); form.set('price', '5');
  for (const cost of ['', '-1', '1.234', '10000001', 'abc']) { form.set('cost', cost); await assert.rejects(submit(form), /costo/); }
  assert.equal(calls.length, 0);
  form.set('cost', '0'); await submit(form);
  assert.equal(calls[0][2].cost_cents, 0);
});

test('previsualiza pérdidas y distingue un costo antiguo sin registrar', async t => {
  const { h, tree } = editor(t, { id: 'product', name: 'Agua', price_cents: 500, cost_cents: null });
  assert.equal(findElement(tree, el => el.type === 'input' && el.props.name === 'cost').props.value, '');
  findElement(tree, el => el.type === 'input' && el.props.name === 'cost').props.onChange({ target: { value: '6' } });
  const updated = await h.settle();
  assert.match(elementText(updated), /precio de venta está por debajo/);
});
