import test from 'node:test';
import assert from 'node:assert/strict';
import { accessPresentation, feedbackAnnouncement, feedbackSound, feedbackTiming, preferredSpanishVoice } from '../lib/access-feedback.ts';

test('la voz anuncia el movimiento y el nombre, priorizando voces naturales en español', () => {
  assert.equal(feedbackAnnouncement('entry', '  Ana   Pérez  '), 'Entrando, Ana Pérez.');
  assert.equal(feedbackAnnouncement('exit', 'José Núñez'), 'Saliendo, José Núñez.');
  assert.equal(feedbackAnnouncement('entry'), 'Entrando.');
  const local = { name: 'Español', lang: 'es-BO', localService: true, default: true };
  const natural = { name: 'Microsoft Dalia Online (Natural)', lang: 'es-MX', localService: false, default: false };
  const english = { ...natural, name: 'English Neural', lang: 'en-US' };
  assert.equal(preferredSpanishVoice([local, english, natural]), natural);
  assert.equal(preferredSpanishVoice([local, natural], false), local);
  assert.equal(preferredSpanishVoice([english]), undefined);
});

test('los avisos de entrada, salida y rechazo conservan identidad, vigencia y sonidos distintos', () => {
  const event = { allowed: 1, direction: 'entry', person_name: 'Ana Pérez', zone_name: 'General', reason: 'OK',
    membership: { managed: true, valid_until: '2026-12-08', sessions_remaining: 7 } };
  const entry = accessPresentation(event);
  assert.equal(entry.title, 'Entrada registrada');
  assert.equal(entry.initials, 'AP');
  assert.equal(entry.color, '#2e7d4f');
  assert.match(entry.detail, /General · Acceso autorizado/);
  assert.equal(entry.membership, 'Plan vigente hasta 2026-12-08 · 7 sesiones disponibles');
  assert.equal(feedbackSound(event), 'entry');
  const exit = { ...event, direction: 'exit' };
  assert.equal(accessPresentation(exit).title, 'Salida registrada');
  assert.equal(feedbackSound(exit), 'exit');
  const denied = { ...event, allowed: 0, reason: 'MEMBERSHIP_REQUIRED' };
  assert.equal(accessPresentation(denied).title, 'Acceso denegado');
  assert.equal(accessPresentation(denied).color, '#b3261e');
  assert.ok(!accessPresentation(denied).detail.includes('MEMBERSHIP_REQUIRED'));
  assert.equal(feedbackSound(denied), 'denied');
  assert.equal(feedbackTiming.enter + feedbackTiming.hold + feedbackTiming.exit, feedbackTiming.total);
  assert.equal(feedbackTiming.total, 4000);
});
