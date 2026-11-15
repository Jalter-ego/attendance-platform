import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { requestLog } from '../src/lib/request-log.js';

function appWith(lines) {
  const app = express();
  app.use(requestLog({ log: (line) => lines.push(line) }));
  app.use(express.json());
  app.put('/api/v1/plans/:code', (req, res) => {
    req.user = { id: '3b56b03c-07c7-4339-ae6e-10aac98bb93c' }; // lo haría requireSession
    res.json({ ok: true });
  });
  app.get('/api/v1/private', (_req, res) => res.status(401).json({ error: 'no' }));
  return app;
}

test('una línea por petición: hora, método, ruta, estado, duración y usuario', async () => {
  const lines = [];
  await request(appWith(lines)).put('/api/v1/plans/basic').send({ name: 'Básico' }).expect(200);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^\d{4}-\d{2}-\d{2}T[\d:.]+Z PUT \/api\/v1\/plans\/basic 200 \d+ms user=3b56b03c-07c7-4339-ae6e-10aac98bb93c$/,
  );
});

test('nunca registra query string, cuerpo ni cookies', async () => {
  const lines = [];
  await request(appWith(lines))
    .put('/api/v1/plans/basic?token=secreto-en-query')
    .set('Cookie', 'platform_session=cookie-secreta')
    .send({ password: 'contraseña-secreta' })
    .expect(200);
  assert.doesNotMatch(lines[0], /secreto-en-query|cookie-secreta|contraseña-secreta|\?/);
});

test('registra también las respuestas de error, sin usuario si no hay sesión', async () => {
  const lines = [];
  await request(appWith(lines)).get('/api/v1/private').expect(401);
  assert.match(lines[0], / GET \/api\/v1\/private 401 \d+ms$/);
});
