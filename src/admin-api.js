import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.ADMIN_DATA_DIR || 'data');
const STATE_FILE = path.join(DATA_DIR, 'admin-config.json');
const AUDIT_FILE = path.join(DATA_DIR, 'admin-audit.json');
const SESSION_COOKIE = 'hendy_admin_session';
const SERVICE_API_KEY = (process.env.SERVICE_API_KEY || '').trim();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
let metricsProvider = () => ({});

const envMaxVideoMb = Number.parseInt(process.env.MAX_VIDEO_MB || '20', 10);
const DEFAULT_STATE = {
  maintenance: { enabled: false, message: 'Hệ thống đang bảo trì, vui lòng quay lại sau.' },
  settings: { defaultSubtitleMode: 'ask', maxVideoMb: Number.isFinite(envMaxVideoMb) && envMaxVideoMb > 0 ? envMaxVideoMb : 20, subtitleEnabled: true, autoDetectLanguage: true },
  connectors: {
    coreApi: { id: 'core-api', name: 'Core Backend API', url: process.env.CORE_BACKEND_URL || 'https://telegram-mini-app.ngogiaidy56.workers.dev', healthPath: '/api/health', enabled: true }
  },
  updatedAt: new Date().toISOString()
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return clone(fallback); }
}
let state = loadJson(STATE_FILE, DEFAULT_STATE);
state.maintenance ||= clone(DEFAULT_STATE.maintenance);
state.settings ||= clone(DEFAULT_STATE.settings);
state.connectors ||= clone(DEFAULT_STATE.connectors);
let auditEntries = loadJson(AUDIT_FILE, []);
if (!Array.isArray(auditEntries)) auditEntries = [];

function persistState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}
function audit(action, details = {}, actor = 'admin-panel') {
  auditEntries.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), actor, action, details });
  auditEntries = auditEntries.slice(0, 200);
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${AUDIT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(auditEntries, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, AUDIT_FILE);
  } catch (error) { console.error('Admin audit could not be persisted:', error.message); }
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extraHeaders });
  res.end(JSON.stringify(body));
}
async function bodyJson(req, limit = 64 * 1024) {
  let data = '';
  for await (const chunk of req) {
    data += chunk.toString('utf8');
    if (Buffer.byteLength(data) > limit) throw Object.assign(new Error('Request too large'), { statusCode: 413 });
  }
  try { return JSON.parse(data || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}
function cookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const piece of raw.split(';')) {
    const [key, ...rest] = piece.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
function secureCookie(req) {
  return process.env.NODE_ENV === 'production' || req.headers['x-forwarded-proto'] === 'https';
}
function cookieHeader(req, token, maxAge) {
  const pieces = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (secureCookie(req)) pieces.push('Secure');
  return pieces.join('; ');
}
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Non-browser clients may omit Origin; they still need valid admin auth for protected actions.
  try { return new URL(origin).host === String(req.headers.host || '').toLowerCase(); } catch { return false; }
}
function getSession(req) {
  const token = cookie(req, SESSION_COOKIE);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) { sessions.delete(token); return null; }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}
function equalsSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const ah = crypto.createHash('sha256').update(a).digest();
  const bh = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ah, bh);
}
function requirePasswordConfigured(res) {
  if ((process.env.ADMIN_PANEL_PASSWORD || '').length < 12) {
    json(res, 503, { ok: false, error: 'Admin dashboard chưa được bật. Hãy đặt ADMIN_PANEL_PASSWORD dài tối thiểu 12 ký tự trong Render Environment.' });
    return false;
  }
  return true;
}
function getOverview() {
  const m = metricsProvider() || {};
  const mem = process.memoryUsage();
  return {
    ok: true,
    service: { name: 'HENDY Cybertech', status: 'operational', uptimeSeconds: Math.floor(process.uptime()), nodeVersion: process.version, environment: process.env.NODE_ENV || 'development' },
    bot: { tokenConfigured: Boolean(process.env.BOT_TOKEN), adminIdsConfigured: Boolean(process.env.ADMIN_IDS || process.env.ADMIN_ID), webhookSecretConfigured: Boolean(process.env.WEBHOOK_SECRET_TOKEN), webhookBaseConfigured: Boolean(process.env.WEBHOOK_URL || process.env.RENDER_EXTERNAL_URL), internalServiceKeyConfigured: Boolean(SERVICE_API_KEY) },
    metrics: { ...m, memoryRssMb: Math.round(mem.rss / 1024 / 1024), heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024) },
    maintenance: clone(state.maintenance), settings: clone(state.settings), updatedAt: state.updatedAt
  };
}

const endpointCatalog = [
  { method: 'GET', path: '/api/health', area: 'health', auth: 'public', description: 'Health check Render' },
  { method: 'GET', path: '/api/v1/public/status', area: 'platform', auth: 'public', description: 'Trạng thái nền tảng và bảo trì' },
  { method: 'GET', path: '/api/v1/internal/status', area: 'service-api', auth: 'service token', description: 'Health/state cho service-to-service module' },
  { method: 'GET', path: '/api/v1/internal/config', area: 'service-api', auth: 'service token', description: 'Cấu hình vận hành đã lọc cho module nội bộ' },
  { method: 'POST', path: '/api/v1/internal/events', area: 'service-api', auth: 'service token', description: 'Gửi sự kiện module vào audit log' },
  { method: 'POST', path: '/api/v1/admin/auth/login', area: 'auth', auth: 'password', description: 'Đăng nhập Admin Dashboard' },
  { method: 'POST', path: '/api/v1/admin/auth/logout', area: 'auth', auth: 'session', description: 'Đăng xuất dashboard' },
  { method: 'GET', path: '/api/v1/admin/session', area: 'auth', auth: 'session', description: 'Kiểm tra phiên đăng nhập' },
  { method: 'GET', path: '/api/v1/admin/overview', area: 'monitoring', auth: 'session', description: 'Tổng quan bot, runtime, memory' },
  { method: 'GET', path: '/api/v1/admin/settings', area: 'settings', auth: 'session', description: 'Đọc cấu hình bot/Vietsub' },
  { method: 'PUT', path: '/api/v1/admin/settings', area: 'settings', auth: 'session', description: 'Lưu cấu hình bot/Vietsub' },
  { method: 'GET', path: '/api/v1/admin/maintenance', area: 'maintenance', auth: 'session', description: 'Đọc chế độ bảo trì' },
  { method: 'PUT', path: '/api/v1/admin/maintenance', area: 'maintenance', auth: 'session', description: 'Bật/tắt bảo trì' },
  { method: 'GET', path: '/api/v1/admin/connectors', area: 'connectors', auth: 'session', description: 'Danh sách tích hợp API' },
  { method: 'POST', path: '/api/v1/admin/connectors/core-api/test', area: 'connectors', auth: 'session', description: 'Kiểm tra Core Backend đã cấu hình' },
  { method: 'GET', path: '/api/v1/admin/audit', area: 'audit', auth: 'session', description: 'Nhật ký thay đổi quản trị' },
  { method: 'GET', path: '/api/v1/admin/api-catalog', area: 'developer', auth: 'session', description: 'Danh mục API tách module' }
];

export function getAdminState() { return state; }
export function setAdminMetricsProvider(provider) { metricsProvider = typeof provider === 'function' ? provider : () => ({}); }

export async function handleAdminApi(req, res, url) {
  if (!url.pathname.startsWith('/api/v1/')) return false;
  if (req.method === 'OPTIONS') {
    json(res, 204, {}, { 'Allow': 'GET,POST,PUT,OPTIONS' });
    return true;
  }
  const pathName = url.pathname;

  if (req.method === 'GET' && pathName === '/api/v1/public/status') {
    json(res, 200, { ok: true, service: 'HENDY Cybertech', status: state.maintenance.enabled ? 'maintenance' : 'operational', maintenance: clone(state.maintenance), updatedAt: state.updatedAt });
    return true;
  }

  // Machine-to-machine endpoints use a separate shared service key, never an Admin cookie/token.
  if (pathName.startsWith('/api/v1/internal/')) {
    const auth = String(req.headers.authorization || '');
    const supplied = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!SERVICE_API_KEY) { json(res, 503, { ok: false, error: 'SERVICE_API_KEY chưa được cấu hình.' }); return true; }
    if (!equalsSecret(supplied, SERVICE_API_KEY)) { json(res, 401, { ok: false, error: 'Service token không hợp lệ.' }); return true; }
    if (req.method === 'GET' && pathName === '/api/v1/internal/status') {
      json(res, 200, { ok: true, service: 'HENDY Cybertech', status: state.maintenance.enabled ? 'maintenance' : 'operational', maintenanceEnabled: Boolean(state.maintenance.enabled), updatedAt: state.updatedAt, uptimeSeconds: Math.floor(process.uptime()) });
      return true;
    }
    if (req.method === 'GET' && pathName === '/api/v1/internal/config') {
      json(res, 200, { ok: true, config: { ...clone(state.settings), maintenanceEnabled: Boolean(state.maintenance.enabled), maintenanceMessage: state.maintenance.message } });
      return true;
    }
    if (req.method === 'POST' && pathName === '/api/v1/internal/events') {
      try {
        const body = await bodyJson(req, 16 * 1024);
        const eventName = String(body.event || '').trim().slice(0, 80);
        if (!/^[a-zA-Z0-9_.:-]+$/.test(eventName)) { json(res, 400, { ok: false, error: 'Tên event không hợp lệ.' }); return true; }
        const actor = String(req.headers['x-service-name'] || 'internal-module').replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 60) || 'internal-module';
        const details = body.details && typeof body.details === 'object' ? body.details : {};
        audit(`module_event:${eventName}`, details, actor);
        json(res, 202, { ok: true, accepted: true });
      } catch (error) { json(res, error.statusCode || 400, { ok: false, error: error.message }); }
      return true;
    }
    json(res, 404, { ok: false, error: 'Internal API endpoint không tồn tại.' });
    return true;
  }

  if (req.method === 'POST' && pathName === '/api/v1/admin/auth/login') {
    if (!sameOrigin(req)) { json(res, 403, { ok: false, error: 'Origin không hợp lệ.' }); return true; }
    if (!requirePasswordConfigured(res)) return true;
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
    const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) { json(res, 429, { ok: false, error: 'Quá nhiều lần đăng nhập sai. Thử lại sau 15 phút.' }); return true; }
    try {
      const body = await bodyJson(req, 8 * 1024);
      if (!equalsSecret(String(body.password || ''), process.env.ADMIN_PANEL_PASSWORD)) {
        attempt.count += 1;
        if (attempt.count >= 6) { attempt.count = 0; attempt.blockedUntil = Date.now() + 15 * 60 * 1000; }
        loginAttempts.set(ip, attempt);
        audit('login_failed', { ip });
        json(res, 401, { ok: false, error: 'Mật khẩu không đúng.' });
        return true;
      }
      loginAttempts.delete(ip);
      const token = crypto.randomBytes(32).toString('hex');
      const session = { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, ip };
      sessions.set(token, session);
      audit('login_success', { ip });
      json(res, 200, { ok: true, expiresInSeconds: SESSION_TTL_MS / 1000 }, { 'Set-Cookie': cookieHeader(req, token, SESSION_TTL_MS / 1000) });
    } catch (error) { json(res, error.statusCode || 400, { ok: false, error: error.message }); }
    return true;
  }

  if (req.method === 'POST' && pathName === '/api/v1/admin/auth/logout') {
    const token = cookie(req, SESSION_COOKIE);
    if (token) sessions.delete(token);
    json(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(req, '', 0) });
    return true;
  }

  if (req.method === 'GET' && pathName === '/api/v1/admin/session') {
    if (!requirePasswordConfigured(res)) return true;
    const session = getSession(req);
    json(res, 200, { ok: true, authenticated: Boolean(session), expiresAt: session ? new Date(session.expiresAt).toISOString() : null });
    return true;
  }

  const session = getSession(req);
  if (!session) { json(res, 401, { ok: false, error: 'Bạn cần đăng nhập Admin Dashboard.' }); return true; }
  if (!sameOrigin(req)) { json(res, 403, { ok: false, error: 'Origin không hợp lệ.' }); return true; }

  if (req.method === 'GET' && pathName === '/api/v1/admin/overview') {
    json(res, 200, getOverview()); return true;
  }
  if (req.method === 'GET' && pathName === '/api/v1/admin/settings') {
    json(res, 200, { ok: true, settings: clone(state.settings) }); return true;
  }
  if (req.method === 'PUT' && pathName === '/api/v1/admin/settings') {
    try {
      const body = await bodyJson(req);
      const input = body.settings || body;
      const allowedModes = new Set(['ask', 'original', 'vietnamese', 'burn-vietnamese']);
      if (input.defaultSubtitleMode !== undefined && !allowedModes.has(input.defaultSubtitleMode)) { json(res, 400, { ok: false, error: 'defaultSubtitleMode không hợp lệ.' }); return true; }
      if (input.maxVideoMb !== undefined && (!Number.isInteger(input.maxVideoMb) || input.maxVideoMb < 1 || input.maxVideoMb > 2000)) { json(res, 400, { ok: false, error: 'maxVideoMb phải là số nguyên từ 1 đến 2000.' }); return true; }
      const prev = clone(state.settings);
      for (const key of ['defaultSubtitleMode', 'maxVideoMb', 'subtitleEnabled']) {
        if (input[key] !== undefined) {
          if (['subtitleEnabled'].includes(key) && typeof input[key] !== 'boolean') { json(res, 400, { ok: false, error: `${key} phải là true/false.` }); return true; }
          state.settings[key] = input[key];
        }
      }
      state.updatedAt = new Date().toISOString(); persistState(); audit('settings_updated', { before: prev, after: state.settings });
      json(res, 200, { ok: true, settings: clone(state.settings) });
    } catch (error) { json(res, error.statusCode || 400, { ok: false, error: error.message }); }
    return true;
  }
  if (req.method === 'GET' && pathName === '/api/v1/admin/maintenance') {
    json(res, 200, { ok: true, maintenance: clone(state.maintenance) }); return true;
  }
  if (req.method === 'PUT' && pathName === '/api/v1/admin/maintenance') {
    try {
      const body = await bodyJson(req);
      if (typeof body.enabled !== 'boolean') { json(res, 400, { ok: false, error: 'enabled phải là true/false.' }); return true; }
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 500) : state.maintenance.message;
      const before = clone(state.maintenance);
      state.maintenance = { enabled: body.enabled, message: message || DEFAULT_STATE.maintenance.message, changedAt: new Date().toISOString() };
      state.updatedAt = new Date().toISOString(); persistState(); audit('maintenance_changed', { before, after: state.maintenance });
      json(res, 200, { ok: true, maintenance: clone(state.maintenance) });
    } catch (error) { json(res, error.statusCode || 400, { ok: false, error: error.message }); }
    return true;
  }
  if (req.method === 'GET' && pathName === '/api/v1/admin/connectors') {
    const connectors = Object.values(state.connectors).map((item) => ({ ...item, url: item.url ? item.url.replace(/([?&](?:token|key|secret|password)=)[^&]+/ig, '$1[redacted]') : '' }));
    json(res, 200, { ok: true, connectors }); return true;
  }
  if (req.method === 'POST' && pathName === '/api/v1/admin/connectors/core-api/test') {
    const connector = state.connectors.coreApi;
    if (!connector?.url) { json(res, 200, { ok: true, connected: false, message: 'Chưa đặt CORE_BACKEND_URL.' }); return true; }
    try {
      const base = new URL(connector.url);
      if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Chỉ hỗ trợ HTTP/HTTPS');
      const target = new URL(connector.healthPath || '/api/health', base);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const started = Date.now();
      const response = await fetch(target, { signal: controller.signal, headers: { accept: 'application/json,text/plain' } }).finally(() => clearTimeout(timer));
      const sample = (await response.text()).slice(0, 250);
      json(res, 200, { ok: true, connected: response.ok, statusCode: response.status, latencyMs: Date.now() - started, message: response.ok ? 'Core API phản hồi thành công.' : 'Core API trả về lỗi HTTP.', sample });
    } catch (error) { json(res, 200, { ok: true, connected: false, message: String(error.message || 'Không kết nối được').slice(0, 200) }); }
    audit('connector_tested', { connectorId: 'core-api' });
    return true;
  }
  if (req.method === 'GET' && pathName === '/api/v1/admin/audit') {
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 50)));
    json(res, 200, { ok: true, entries: auditEntries.slice(0, limit) }); return true;
  }
  if (req.method === 'GET' && pathName === '/api/v1/admin/api-catalog') {
    json(res, 200, { ok: true, version: 'v1', architecture: 'Modular API', endpoints: endpointCatalog }); return true;
  }

  json(res, 404, { ok: false, error: 'API endpoint không tồn tại.' });
  return true;
}
