import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

process.env.ADMIN_PANEL_PASSWORD = 'Unit-Test-Admin-Password-123456';
process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'hendy-admin-api-'));
process.env.SERVICE_API_KEY = 'Unit-Test-Service-Key-123456789';
process.env.NODE_ENV = 'test';
const { handleAdminApi } = await import('../src/admin-api.js');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (await handleAdminApi(req, res, url)) return;
  res.writeHead(404); res.end();
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
async function request(url, options = {}) {
  const response = await fetch(`${base}${url}`, options);
  let body = {};
  try { body = await response.json(); } catch {}
  return { response, body };
}

test('Admin API authentication, settings, maintenance and API catalog', async (t) => {
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(process.env.ADMIN_DATA_DIR, { recursive: true, force: true });
  });

  const pub = await request('/api/v1/public/status');
  assert.equal(pub.response.status, 200);
  assert.equal(pub.body.status, 'operational');

  const noServiceAuth = await request('/api/v1/internal/config');
  assert.equal(noServiceAuth.response.status, 401);
  const serviceConfig = await request('/api/v1/internal/config', { headers: { authorization: `Bearer ${process.env.SERVICE_API_KEY}` } });
  assert.equal(serviceConfig.response.status, 200);
  assert.ok('defaultSubtitleMode' in serviceConfig.body.config);
  const serviceEvent = await request('/api/v1/internal/events', {
    method: 'POST', headers: { authorization: `Bearer ${process.env.SERVICE_API_KEY}`, 'x-service-name': 'test-worker', 'content-type': 'application/json' },
    body: JSON.stringify({ event: 'job.completed', details: { sample: true } })
  });
  assert.equal(serviceEvent.response.status, 202);

  const blocked = await request('/api/v1/admin/overview');
  assert.equal(blocked.response.status, 401);

  const badLogin = await request('/api/v1/admin/auth/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password' })
  });
  assert.equal(badLogin.response.status, 401);

  const login = await request('/api/v1/admin/auth/login', {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.ADMIN_PANEL_PASSWORD })
  });
  assert.equal(login.response.status, 200);
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);

  const headers = { cookie, origin: base };
  const overview = await request('/api/v1/admin/overview', { headers });
  assert.equal(overview.response.status, 200);
  assert.ok('uptimeSeconds' in overview.body.service);

  const settings = await request('/api/v1/admin/settings', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { defaultSubtitleMode: 'vietnamese', maxVideoMb: 32, subtitleEnabled: true } })
  });
  assert.equal(settings.response.status, 200);
  assert.equal(settings.body.settings.maxVideoMb, 32);

  const invalidSettings = await request('/api/v1/admin/settings', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { maxVideoMb: 0 } })
  });
  assert.equal(invalidSettings.response.status, 400);

  const maintenance = await request('/api/v1/admin/maintenance', {
    method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, message: 'Test maintenance' })
  });
  assert.equal(maintenance.response.status, 200);
  const publicMaintenance = await request('/api/v1/public/status');
  assert.equal(publicMaintenance.body.status, 'maintenance');

  const catalog = await request('/api/v1/admin/api-catalog', { headers });
  assert.equal(catalog.response.status, 200);
  assert.ok(catalog.body.endpoints.some((item) => item.path === '/api/v1/admin/maintenance'));
});
