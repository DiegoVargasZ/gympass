import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { restoreSignedApk } from './apk-delta.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const base = Buffer.from('signed-original-APK'), literal = Buffer.from('new');
const expected = Buffer.from('signed-new-APK');
const patch = { base_sha256: hash(base), sha256: hash(expected), size: expected.length, operations: [['copy', 0, 7], ['insert', 0, 3], ['copy', 15, 4]] };
test('el delta conserva exactamente los bytes firmados del APK', () => { assert.deepEqual(restoreSignedApk(base, literal, patch), expected); });
test('no reconstruye un APK sobre una base distinta', () => { assert.throws(() => restoreSignedApk(Buffer.from('different'), literal, patch), /base/); });
test('rechaza offsets, tamaños y operaciones fuera del archivo', () => {
  for (const operations of [[['copy', -1, 3]], [['copy', 0, 999]], [['copy', 0.5, 2]], [['other', 0, 1]], [['copy', 0, 1]]])
    assert.throws(() => restoreSignedApk(base, literal, { ...patch, operations }));
});
test('rechaza una reconstrucción cuya huella difiere del APK firmado', () => { assert.throws(() => restoreSignedApk(base, literal, { ...patch, sha256: '0'.repeat(64) }), /firmado/); });
