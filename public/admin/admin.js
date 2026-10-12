const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = { overview: null, settings: null, maintenance: null, apiCatalog: null, section: 'overview' };
let toastTimer;
function toast(message, isError = false) {
  const el = $('#toast'); el.textContent = message; el.classList.toggle('error', isError); el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}
async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Accept': 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
  let payload; try { payload = await response.json(); } catch { payload = { error: `HTTP ${response.status}` }; }
  if (!response.ok) { const error = new Error(payload.error || `HTTP ${response.status}`); error.status = response.status; throw error; }
  return payload;
}
function showLogin() { $('#login-view').classList.remove('hidden'); $('#app-view').classList.add('hidden'); }
function showApp() { $('#login-view').classList.add('hidden'); $('#app-view').classList.remove('hidden'); }
const titles = { overview: 'Tổng quan hệ thống', maintenance: 'Bảo trì & vận hành', vietsub: 'Bot & Vietsub', connectors: 'API & tích hợp', developer: 'API Explorer', audit: 'Nhật ký hoạt động' };
function gotoSection(name) {
  if (!titles[name]) return; state.section = name;
  $$('.content-section').forEach(el => el.classList.toggle('active', el.id === `section-${name}`));
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.section === name));
  $('#page-title').textContent = titles[name]; $('#breadcrumb-current').textContent = titles[name];
  if (name === 'audit') loadAudit().catch(showApiError);
  if (name === 'developer') loadApiCatalog().catch(showApiError);
  if (name === 'connectors') loadConnectors().catch(showApiError);
}
function showApiError(error) { if (error.status === 401) { showLogin(); return; } toast(error.message || 'Có lỗi kết nối API.', true); }
function fmtDuration(seconds = 0) { const s = Math.max(0, Number(seconds) || 0); const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function statusTag(ok, yes = 'ONLINE', no = 'CHECK') { return `<span class="state-tag ${ok ? 'success' : 'warning'}">${escapeHtml(ok ? yes : no)}</span>`; }
function renderOverview(data) {
  state.overview = data;
  $('#metric-uptime').textContent = fmtDuration(data.service?.uptimeSeconds);
  $('#metric-users').textContent = (data.metrics?.registeredUsers ?? 0).toLocaleString('vi-VN');
  $('#metric-jobs').textContent = (data.metrics?.activeSubtitleJobs ?? 0).toLocaleString('vi-VN');
  $('#metric-pending').textContent = `${data.metrics?.pendingVideos ?? 0} video chờ`;
  $('#metric-memory').textContent = `${data.metrics?.memoryRssMb ?? 0} MB`;
  $('#metric-heap').textContent = `Heap ${data.metrics?.heapUsedMb ?? 0} MB`;
  const rss = data.metrics?.memoryRssMb || 0; $('#memory-meter').style.width = `${Math.min(100, Math.round(rss / 512 * 100))}%`;
  const maintenance = data.maintenance?.enabled;
  $('#global-status').textContent = maintenance ? 'Đang bảo trì' : 'Đang hoạt động';
  $('#global-banner').classList.toggle('hidden', !maintenance);
  $('#global-banner').textContent = maintenance ? `🛠️ CHẾ ĐỘ BẢO TRÌ ĐANG BẬT — ${data.maintenance?.message || ''}` : '';
  $('#last-updated').textContent = `Cập nhật ${new Date().toLocaleTimeString('vi-VN')}`;
  const checks = [
    ['HTTP / Admin API', 'Dashboard và API v1', true, 'READY'],
    ['Telegram Bot token', 'Token chỉ đọc trạng thái cấu hình', data.bot?.tokenConfigured, data.bot?.tokenConfigured ? 'CONFIGURED' : 'MISSING'],
    ['Webhook security', 'Webhook secret đã được đặt', data.bot?.webhookSecretConfigured, data.bot?.webhookSecretConfigured ? 'CONFIGURED' : 'MISSING'],
    ['Internal API key', 'Khóa cho kết nối service-to-service', data.bot?.internalServiceKeyConfigured, data.bot?.internalServiceKeyConfigured ? 'CONFIGURED' : 'MISSING'],
    ['Vietsub pipeline', 'Whisper.cpp / Argos / FFmpeg', data.metrics?.subtitleEnabled !== false, data.metrics?.subtitleEnabled === false ? 'DISABLED' : 'ENABLED']
  ];
  $('#health-list').innerHTML = checks.map(([name, desc, ok, tag], i) => `<div class="health-row"><div class="health-symbol">${['◈','↯','⌁','⎈','CC'][i]}</div><div><b>${escapeHtml(name)}</b><small>${escapeHtml(desc)}</small></div>${statusTag(ok, tag, tag)}</div>`).join('');
  $('#maintenance-toggle').checked = Boolean(data.maintenance?.enabled);
  $('#maintenance-heading').textContent = maintenance ? 'Đang bật chế độ bảo trì' : 'Hệ thống đang hoạt động';
  $('#maintenance-description').textContent = maintenance ? 'Người dùng thường bị chặn; Admin vẫn có thể truy cập.' : 'Người dùng có thể sử dụng bot bình thường.';
  $('#maintenance-message').value = data.maintenance?.message || 'Hệ thống đang bảo trì, vui lòng quay lại sau.';
  $('#current-time').textContent = new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}
async function refreshOverview() { const data = await api('/api/v1/admin/overview'); renderOverview(data); }
async function loadSettings() {
  const data = await api('/api/v1/admin/settings'); state.settings = data.settings;
  $('#default-subtitle-mode').value = data.settings.defaultSubtitleMode || 'ask';
  $('#max-video-mb').value = data.settings.maxVideoMb || 20;
  $('#subtitle-enabled').checked = data.settings.subtitleEnabled !== false;
}
async function loadMaintenance() {
  const data = await api('/api/v1/admin/maintenance'); state.maintenance = data.maintenance;
  $('#maintenance-toggle').checked = Boolean(data.maintenance.enabled);
  $('#maintenance-message').value = data.maintenance.message || 'Hệ thống đang bảo trì, vui lòng quay lại sau.';
  $('#maintenance-heading').textContent = data.maintenance.enabled ? 'Đang bật chế độ bảo trì' : 'Hệ thống đang hoạt động';
  $('#maintenance-description').textContent = data.maintenance.enabled ? 'Người dùng thường bị chặn; Admin vẫn có thể truy cập.' : 'Người dùng có thể sử dụng bot bình thường.';
}
async function loadConnectors() {
  const data = await api('/api/v1/admin/connectors');
  $('#connector-list').innerHTML = (data.connectors || []).map(conn => `<article class="panel connector-card"><div class="connector-top"><div><p class="eyebrow">CONNECTOR · ${escapeHtml(conn.id)}</p><h3>${escapeHtml(conn.name)}</h3><p class="muted">${escapeHtml(conn.url || 'Chưa cấu hình URL backend')}</p></div>${statusTag(Boolean(conn.enabled), conn.enabled ? 'CONFIGURED' : 'NOT SET', 'NOT SET')}</div><div class="connector-code">Health path: ${escapeHtml(conn.healthPath || '/api/health')}</div><button class="btn btn-ghost test-connector" data-connector="${escapeHtml(conn.id)}">↯ Kiểm tra kết nối</button><p class="connector-result muted" id="connector-result-${escapeHtml(conn.id)}"></p></article>`).join('') || '<article class="panel">Chưa có connector được cấu hình.</article>';
  $$('.test-connector').forEach(btn => btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Đang kiểm tra…';
    try { const result = await api('/api/v1/admin/connectors/core-api/test', { method: 'POST', body: '{}' }); $(`#connector-result-${btn.dataset.connector}`).textContent = `${result.connected ? '✅' : '⚠️'} ${result.message}${result.statusCode ? ` · HTTP ${result.statusCode}` : ''}${result.latencyMs ? ` · ${result.latencyMs} ms` : ''}`; toast(result.message, !result.connected); }
    catch (error) { showApiError(error); } finally { btn.disabled = false; btn.textContent = '↯ Kiểm tra kết nối'; }
  }));
}
async function loadApiCatalog() {
  const data = await api('/api/v1/admin/api-catalog'); state.apiCatalog = data;
  $('#api-table').innerHTML = data.endpoints.map(endpoint => `<tr><td><span class="method ${endpoint.method.toLowerCase()}">${escapeHtml(endpoint.method)}</span></td><td><code>${escapeHtml(endpoint.path)}</code></td><td>${escapeHtml(endpoint.area)}</td><td>${escapeHtml(endpoint.auth)}</td><td>${escapeHtml(endpoint.description)}</td></tr>`).join('');
}
async function loadAudit() {
  const data = await api('/api/v1/admin/audit?limit=50');
  $('#audit-table').innerHTML = data.entries.length ? data.entries.map(entry => `<tr><td>${escapeHtml(new Date(entry.at).toLocaleString('vi-VN'))}</td><td><code>${escapeHtml(entry.action)}</code></td><td>${escapeHtml(entry.actor)}</td><td>${escapeHtml(JSON.stringify(entry.details || {}))}</td></tr>`).join('') : '<tr><td colspan="4">Chưa có hoạt động được ghi nhận.</td></tr>';
}
async function loadAll() { await Promise.all([refreshOverview(), loadSettings(), loadMaintenance()]); }
async function verifySession() {
  try { const session = await api('/api/v1/admin/session'); if (!session.authenticated) return showLogin(); showApp(); await loadAll(); }
  catch (error) { if (error.status === 503) { showLogin(); $('#login-error').textContent = error.message; } else if (error.status === 401) showLogin(); else showApiError(error); }
}
$('#login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('#login-error').textContent = '';
  const password = $('#admin-password').value;
  try { await api('/api/v1/admin/auth/login', { method: 'POST', body: JSON.stringify({ password }) }); $('#admin-password').value = ''; showApp(); await loadAll(); await loadConnectors(); toast('Đăng nhập thành công.'); }
  catch (error) { $('#login-error').textContent = error.message; }
});
$('#logout-button').addEventListener('click', async () => { try { await api('/api/v1/admin/auth/logout', { method: 'POST', body: '{}' }); } catch {} showLogin(); toast('Đã đăng xuất.'); });
$('#navigation').addEventListener('click', event => { const button = event.target.closest('[data-section]'); if (button) gotoSection(button.dataset.section); });
document.addEventListener('click', event => { const button = event.target.closest('[data-goto]'); if (button) gotoSection(button.dataset.goto); });
$('#refresh-button').addEventListener('click', async () => { try { await loadAll(); toast('Đã làm mới dữ liệu.'); } catch (error) { showApiError(error); } });
$('#refresh-audit').addEventListener('click', () => loadAudit().then(() => toast('Đã làm mới nhật ký.')).catch(showApiError));
async function saveMaintenance() {
  const enabled = $('#maintenance-toggle').checked, message = $('#maintenance-message').value.trim();
  try { const result = await api('/api/v1/admin/maintenance', { method: 'PUT', body: JSON.stringify({ enabled, message }) }); state.maintenance = result.maintenance; await refreshOverview(); await loadMaintenance(); toast(enabled ? 'Đã bật chế độ bảo trì.' : 'Đã tắt chế độ bảo trì.'); }
  catch (error) { showApiError(error); }
}
$('#save-maintenance').addEventListener('click', saveMaintenance);
$('#maintenance-toggle').addEventListener('change', () => saveMaintenance());
$('#save-settings').addEventListener('click', async () => {
  const status = $('#settings-status'); status.textContent = 'Đang lưu…';
  try { const settings = { defaultSubtitleMode: $('#default-subtitle-mode').value, maxVideoMb: Number($('#max-video-mb').value), subtitleEnabled: $('#subtitle-enabled').checked }; const result = await api('/api/v1/admin/settings', { method: 'PUT', body: JSON.stringify({ settings }) }); state.settings = result.settings; status.textContent = 'Đã lưu thành công.'; await refreshOverview(); toast('Đã lưu cấu hình Vietsub.'); }
  catch (error) { status.textContent = error.message; showApiError(error); }
});
$('#copy-api-catalog').addEventListener('click', async () => { try { if (!state.apiCatalog) await loadApiCatalog(); await navigator.clipboard.writeText(JSON.stringify(state.apiCatalog, null, 2)); toast('Đã copy API catalog JSON.'); } catch { toast('Không thể copy. Hãy mở API Explorer sau đó thử lại.', true); } });
setInterval(() => { if (!$('#app-view').classList.contains('hidden') && state.section === 'overview') refreshOverview().catch(error => { if (error.status === 401) showLogin(); }); }, 30000);
verifySession();
