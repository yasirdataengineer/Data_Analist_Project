const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../app');
const { Store } = require('../lib/store');
const { validateInitData, signBotPayload } = require('../lib/telegram');
const { minutesBetween } = require('../lib/dates');
const { overtimePay } = require('../lib/payroll');

const BOT_TOKEN = '123456:TEST';
const WA_SECRET = 'wa-app-secret';
const WA_BUSINESS = '6281100000000';

// Outbound Telegram / WhatsApp calls are captured instead of hitting the network.
const outbox = [];
const realFetch = global.fetch;
global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.startsWith('https://api.telegram.org/') || u.startsWith('https://graph.facebook.com/')) {
    const channel = u.includes('telegram') ? 'telegram' : 'whatsapp';
    outbox.push({ channel, method: u.split('/').pop(), body: JSON.parse(opts.body || '{}') });
    return new Response(JSON.stringify({ ok: true, result: true, messages: [{ id: 'wamid.x' }] }), { status: 200 });
  }
  return realFetch(url, opts);
};
const sentTo = (channel, to) => outbox.filter((m) => m.channel === channel && String(m.body.to ?? m.body.chat_id) === String(to));
const OWNER = { id: 1, first_name: 'Pak', last_name: 'yasir' };

function signInitData(user, authDate = Math.floor(Date.now() / 1000)) {
  const params = new URLSearchParams({ auth_date: String(authDate), user: JSON.stringify(user), query_id: 'q1' });
  const dcs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  params.set('hash', crypto.createHmac('sha256', secret).update(dcs).digest('hex'));
  return params.toString();
}

let server, base, tmp;
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tjp-'));
  const config = {
    appName: 'TJP-EJS One Hub',
    botToken: BOT_TOKEN,
    notifyChatId: '',
    ownerIds: ['1'],
    sessionSecret: 'test-secret',
    devLogin: false,
    botUsername: 'tjp_onehub_bot',
    ownerPhones: [],
    whatsapp: {
      enabled: true,
      token: 'wa-token',
      phoneNumberId: '1234567890',
      businessNumber: WA_BUSINESS,
      verifyToken: 'verify-me',
      appSecret: WA_SECRET,
      apiVersion: 'v22.0',
      notifyTemplate: 'onehub_notifikasi',
      templateLang: 'id',
    },
    uploadDir: path.join(tmp, 'uploads'),
  };
  const app = createApp(config, new Store(path.join(tmp, 'db.json')));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function login(user) {
  const res = await fetch(`${base}/auth/telegram`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ initData: signInitData(user) }),
  });
  assert.strictEqual(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

const post = (url, cookie, body) =>
  fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
const postForm = (url, cookie, fields, files = {}) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, name] of Object.entries(files)) fd.append(k, new Blob([Buffer.from('89504e47', 'hex')], { type: 'image/png' }), name);
  return fetch(base + url, { method: 'POST', redirect: 'manual', headers: { cookie }, body: fd });
};
const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: { cookie } });
const html = async (url, cookie) => (await get(url, cookie)).text();
const idFrom = (text, re) => text.match(re)[1];
const UUID = '([0-9a-f-]{36})';

// Logs a user in and has the owner grant them a role.
async function member(tg, role, company = 'TJP') {
  const owner = await login(OWNER);
  const cookie = await login(tg);
  const res = await post('/pengguna', owner, { userId: String(tg.id), role, company });
  assert.strictEqual(res.status, 302);
  return cookie;
}

// --- Unit -------------------------------------------------------------------

test('validateInitData accepts genuine data and rejects tampering/expiry', () => {
  const data = signInitData({ id: 1, first_name: 'Yasir' });
  assert.strictEqual(validateInitData(data, BOT_TOKEN).first_name, 'Yasir');
  assert.strictEqual(validateInitData(data.replace('Yasir', 'Mallory'), BOT_TOKEN), null);
  assert.strictEqual(validateInitData(data, '999:OTHER'), null);
  assert.strictEqual(validateInitData(signInitData({ id: 1 }, 1000), BOT_TOKEN), null);
});

test('date and overtime helpers', () => {
  assert.strictEqual(minutesBetween('17:00', '20:30'), 210);
  assert.strictEqual(minutesBetween('22:00', '02:00'), 240);
  assert.strictEqual(overtimePay(60, 10000), 15000);
  assert.strictEqual(overtimePay(180, 10000), 55000);
});

// --- Access -----------------------------------------------------------------

test('new Telegram users wait for access; owner from env gets everything', async () => {
  assert.strictEqual((await get('/', '')).headers.get('location'), '/login');
  const stranger = await login({ id: 77, first_name: 'Baru' });
  const res = await get('/', stranger);
  assert.strictEqual(res.status, 403);
  assert.match(await res.text(), /Akses belum aktif/);

  const owner = await login(OWNER);
  const hub = await html('/', owner);
  assert.match(hub, /Pak yasir/);
  for (const title of ['Monitoring Progres', 'Sistem Absensi', 'Sistem Payroll', 'Sistem Proc &amp; Res', 'Lap Pettycash', 'Approval &amp; Bukti Transfer', 'Cash Flow Project', 'User Admin / Management']) {
    assert.ok(hub.includes(title), `owner hub missing ${title}`);
  }
});

test('hub and routes follow role rules (admin has no Absensi, management is read-only)', async () => {
  const admin = await member({ id: 10, first_name: 'Indah', username: 'ind_puspita' }, 'admin');
  const mgmt = await member({ id: 11, first_name: 'Manajer' }, 'management');
  const staff = await member({ id: 12, first_name: 'Rizfa' }, 'karyawan');

  const adminHub = await html('/', admin);
  assert.ok(!adminHub.includes('Sistem Absensi'));
  assert.ok(adminHub.includes('Sistem Payroll') && adminHub.includes('User Admin / Management'));
  assert.strictEqual((await get('/absensi', admin)).status, 403);

  const mgmtHub = await html('/', mgmt);
  assert.ok(mgmtHub.includes('Lap Pettycash') && !mgmtHub.includes('User Admin'));
  assert.strictEqual((await get('/absensi', mgmt)).headers.get('location'), '/absensi/tim');
  assert.strictEqual((await get('/kas/tambah-saldo', mgmt)).status, 403);

  const staffHub = await html('/', staff);
  assert.ok(staffHub.includes('Sistem Absensi') && !staffHub.includes('Lap Pettycash'));
  assert.strictEqual((await get('/kas', staff)).status, 403);
});

test('only the owner can change roles; admin can add karyawan only', async () => {
  const admin = await member({ id: 20, first_name: 'Admin2' }, 'admin');
  await login({ id: 21, first_name: 'Calon' });
  assert.strictEqual((await post('/pengguna', admin, { userId: '21', role: 'management', company: 'EJS' })).status, 400);
  assert.strictEqual((await post('/pengguna', admin, { userId: '21', role: 'karyawan', company: 'EJS' })).status, 302);
  assert.strictEqual((await post('/pengguna/10', admin, { role: 'karyawan' })).status, 400); // another admin
  assert.strictEqual((await post('/pengguna/1', admin, { active: '0' })).status, 400); // owner
  assert.match(await html('/pengguna', admin), /EJS · |EJS<\/p>/);
});

// --- Monitoring Progres -----------------------------------------------------

test('progres: owner assigns, PIC reports, owner evaluates Closed', async () => {
  const owner = await login(OWNER);
  const pic = await member({ id: 30, first_name: 'Budi' }, 'karyawan');
  const other = await member({ id: 31, first_name: 'Eko' }, 'karyawan');

  assert.strictEqual((await post('/progres', pic, { title: 'x', picId: '30' })).status, 403);
  const created = await post('/progres', owner, { title: 'Instalasi battery rack', picId: '30' });
  const url = created.headers.get('location').split('?')[0];

  assert.strictEqual((await get(url, other)).status, 404);
  assert.strictEqual((await postForm(`${url}/update`, pic, { progress: '60' })).status, 400); // needs result or issue
  assert.strictEqual((await postForm(`${url}/update`, pic, { progress: '100', result: 'Rack terpasang' }, { photos: 'a.png' })).status, 302);
  assert.strictEqual((await post(`${url}/evaluasi`, owner, { status: 'closed', note: 'OK' })).status, 302);
  assert.strictEqual((await postForm(`${url}/update`, pic, { progress: '90', result: 'x' })).status, 400);

  const page = await html('/progres?f=done', owner);
  assert.match(page, /Instalasi battery rack/);
  assert.match(page, /100% \/ ditutup<\/span><b>1/);
  assert.match(await html(url, pic), /Evaluasi: Closed/);
});

// --- Absensi & Payroll ------------------------------------------------------

test('absensi: check-in/out once each; management sees team report', async () => {
  const staff = await member({ id: 40, first_name: 'Sari' }, 'karyawan');
  const mgmt = await member({ id: 41, first_name: 'Mgmt' }, 'management');
  assert.strictEqual((await post('/absensi/pulang', staff, {})).status, 400);
  assert.strictEqual((await post('/absensi/masuk', staff, { lat: '1.44', lng: '125.18' })).status, 302);
  assert.strictEqual((await post('/absensi/masuk', staff, {})).status, 400);
  await post('/absensi/rencana', staff, { tasks: 'Cek grounding' });
  assert.strictEqual((await post('/absensi/pulang', staff, {})).status, 302);
  const team = await html('/absensi/tim', mgmt);
  assert.match(team, /Sari/);
  assert.match(team, /Lengkap/);
  assert.match(team, /Cek grounding/);
});

test('payroll: overtime approved by admin, corrected, kasbon deducted; finalisation locks month', async () => {
  const admin = await member({ id: 50, first_name: 'AdminPay' }, 'admin');
  const staff = await member({ id: 51, first_name: 'Rudi' }, 'karyawan');
  const month = '2026-09';

  assert.strictEqual((await post('/payroll/gaji/51', staff, { base: '1' })).status, 400);
  assert.strictEqual((await post('/payroll/gaji/51', admin, { base: '3.460.000', allowance: '500000' })).status, 302);

  await post('/absensi/lembur', staff, { date: `${month}-10`, start: '17:00', end: '19:00', reason: 'Testing panel' });
  let id = idFrom(await html('/payroll/lembur', admin), new RegExp(`/payroll/lembur/${UUID}/approve`));
  assert.strictEqual((await post(`/payroll/lembur/${id}/approve`, staff, {})).status, 400);
  await post(`/payroll/lembur/${id}/approve`, admin, {});

  const otId = idFrom(await html('/payroll/koreksi', staff), new RegExp(`<option value="${UUID}">`));
  await post('/payroll/koreksi', staff, { overtimeId: otId, start: '17:00', end: '20:00', reason: 'Jam pulang salah' });
  id = idFrom(await html('/payroll/koreksi', admin), new RegExp(`/payroll/koreksi/${UUID}/approve`));
  await post(`/payroll/koreksi/${id}/approve`, admin, {});

  await post('/payroll/kasbon', staff, { amount: '250.000', deductMonth: month, reason: 'Keluarga' });
  id = idFrom(await html('/payroll/kasbon', admin), new RegExp(`/payroll/kasbon/${UUID}/approve`));
  await post(`/payroll/kasbon/${id}/approve`, admin, {});

  // 3.460.000 + 500.000 + 3h overtime at 20.000/h (5.5x = 110.000) - 250.000
  assert.match(await html(`/payroll?bulan=${month}`, staff), /Rp 3\.820\.000/);
  assert.strictEqual((await get('/payroll', admin)).headers.get('location'), '/payroll/rekap');
  assert.strictEqual((await post('/payroll/rekap/finalisasi', admin, { bulan: month, userId: '51' })).status, 302);
  assert.match(await html(`/payroll?bulan=${month}`, staff), /Final/);
  assert.strictEqual((await post('/payroll/kasbon', staff, { amount: '1000', deductMonth: month, reason: 'x' })).status, 400);
});

// --- Proc & Res, Petty Cash, Cash Flow --------------------------------------

test('proc & res: owner approves, admin transfers from petty cash, PIC closes, sisa returned; cash flow adds up', async () => {
  const owner = await login(OWNER);
  const admin = await member({ id: 60, first_name: 'AdminKas' }, 'admin');
  const staff = await member({ id: 61, first_name: 'Muhammad', last_name: 'Rizfa' }, 'karyawan');

  // Project + petty cash opening balance
  const proj = await post('/kas/project', admin, { code: 'dt001', name: 'Data Center SMX' });
  const projectId = proj.headers.get('location').match(/project=([0-9a-f-]{36})/)[1];
  assert.strictEqual((await post('/kas/entry', admin, { type: 'opening', amount: '1.500.000', date: '2026-10-01' })).status, 302);
  assert.strictEqual((await post('/kas/entry', admin, { type: 'opening', amount: '1', date: '2026-10-01' })).status, 400);
  await post('/kas/penerimaan', admin, { projectId, amount: '10.000.000', date: '2026-10-02', note: 'DP' });

  // Request
  const form = await html('/proc/baru', staff);
  const typeId = idFrom(form, new RegExp(`<option value="${UUID}">Operasional`));
  const projectCat = idFrom(form, new RegExp(`<option value="${UUID}" data-project="1">Project`));
  assert.strictEqual((await postForm('/proc', staff, { typeId, categoryId: projectCat, amount: '200000', description: 'BBM+ tol' })).status, 400); // project required
  const created = await postForm('/proc', staff, { typeId, categoryId: projectCat, projectId, amount: '200.000', description: 'BBM+ tol' });
  const url = created.headers.get('location').split('?')[0];
  assert.match(await html(url, staff), /Pengajuan operasional · Rp 200\.000/);

  // Only the owner approves; admin transfers with proof
  assert.strictEqual((await post(`${url}/approve`, admin, {})).status, 403);
  assert.strictEqual((await post(`${url}/approve`, owner, { amount: '200000' })).status, 302);
  assert.strictEqual((await postForm(`${url}/transfer`, admin, { amount: '200000', date: '2026-10-03', source: 'petty' })).status, 400); // no proof
  assert.strictEqual((await postForm(`${url}/transfer`, admin, { amount: '9000000', date: '2026-10-03', source: 'petty' }, { proof: 'tf.png' })).status, 400); // over balance
  assert.strictEqual((await postForm(`${url}/transfer`, admin, { amount: '200.000', date: '2026-10-03', source: 'petty' }, { proof: 'tf.png' })).status, 302);

  // PIC closes with report: used 180k -> 20k sisa
  assert.strictEqual((await postForm(`${url}/laporan`, admin, { actualAmount: '180000' }, { photos: 'n.png' })).status, 400); // not the requester
  assert.strictEqual((await postForm(`${url}/laporan`, staff, { actualAmount: '180.000' }, { photos: 'n.png' })).status, 302);
  assert.match(await html(url, staff), /Laporan Close/);

  let petty = await html('/kas?tab=petty&periode=2026-10', admin);
  assert.match(petty, /Rp 1\.300\.000/); // 1.5M - 200k

  const reqId = url.split('/').pop();
  assert.strictEqual((await post('/kas/entry', admin, { type: 'refund', requestId: reqId, amount: '30000', date: '2026-10-04' })).status, 400); // > sisa
  assert.strictEqual((await post('/kas/entry', admin, { type: 'refund', requestId: reqId, amount: '20.000', date: '2026-10-04' })).status, 302);
  petty = await html('/kas?tab=petty&periode=2026-10', admin);
  assert.match(petty, /Rp 1\.320\.000/);

  // Cash flow: 10.000.000 - 200.000 + 20.000
  const flow = await html(`/kas?tab=cashflow&periode=semua&project=${projectId}`, owner);
  assert.match(flow, /DT001 — Data Center SMX/);
  assert.match(flow, /Rp 9\.820\.000/);

  // Management can view but not act
  const mgmt = await member({ id: 62, first_name: 'Mgmt2' }, 'management');
  assert.match(await html('/kas?tab=approval&periode=semua', mgmt), /BBM\+ tol/);
  assert.strictEqual((await post('/kas/entry', mgmt, { type: 'topup', amount: '1', date: '2026-10-04' })).status, 403);
});

test('proc types and categories are configurable', async () => {
  const admin = await member({ id: 70, first_name: 'AdminCfg' }, 'admin');
  assert.strictEqual((await post('/proc/jenis', admin, { name: 'Sewa alat' })).status, 302);
  assert.strictEqual((await post('/proc/jenis', admin, { name: 'sewa alat' })).status, 400);
  assert.strictEqual((await post('/proc/kategori', admin, { name: 'Workshop', requiresProject: '1' })).status, 302);
  const form = await html('/proc/baru', admin);
  assert.match(form, /Sewa alat/);
  assert.match(form, /data-project="1">Workshop/);
});

// --- PWA & Masuk dengan Telegram ---------------------------------------------

test('PWA: manifest, service worker and install tags are served', async () => {
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.strictEqual(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
  const sw = await fetch(`${base}/sw.js`);
  assert.strictEqual(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  const login = await html('/login', '');
  assert.match(login, /rel="manifest"/);
  assert.match(login, /Masuk dengan Telegram/);
  assert.strictEqual((await fetch(`${base}/public/offline.html`)).status, 200);
});

const botCall = (path, payload, token = BOT_TOKEN) =>
  fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(signBotPayload(token, payload)) });

async function startBotLogin() {
  const res = await fetch(`${base}/auth/bot/start`, { method: 'POST' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const token = data.link.match(/start=login_([0-9a-f]{32})$/)[1];
  assert.ok(data.link.startsWith('https://t.me/tjp_onehub_bot?start=login_'));
  return { ...data, token, cookie: res.headers.get('set-cookie').split(';')[0] };
}

test('bot login: code shown by the bot, confirmed in Telegram, browser gets a session', async () => {
  const { token, code, cookie } = await startBotLogin();
  const status = async (c) => (await (await get('/auth/bot/status', c)).json()).status;
  assert.strictEqual(await status(cookie), 'pending');

  // Forged requests from anything other than the bot are rejected.
  assert.strictEqual((await botCall('/auth/bot/confirm', { token, approve: true, user: { id: 1 } }, '999:FAKE')).status, 401);
  const lookup = await (await botCall('/auth/bot/lookup', { token })).json();
  assert.strictEqual(lookup.code, code);

  const confirm = await (await botCall('/auth/bot/confirm', { token, approve: true, user: { id: 1, first_name: 'Pak', last_name: 'yasir', username: 'yasir' } })).json();
  assert.strictEqual(confirm.active, true);

  // Another browser can't take over the confirmed request.
  assert.strictEqual(await status(''), 'expired');

  const res = await get('/auth/bot/status', cookie);
  assert.strictEqual((await res.json()).status, 'confirmed');
  const session = res.headers.get('set-cookie').split(/,(?=\s*\w+=)/).find((c) => c.trim().startsWith('tjp_sid=')).split(';')[0].trim();
  assert.match(await html('/', session), /Pak yasir/);

  // One-shot: the same request can't be used twice.
  assert.strictEqual(await status(cookie), 'expired');
  assert.strictEqual((await botCall('/auth/bot/confirm', { token, approve: true, user: { id: 1 } })).status, 404);
});

test('bot login: "Bukan saya" denies; new users land on the pending page', async () => {
  let r = await startBotLogin();
  await botCall('/auth/bot/confirm', { token: r.token, approve: false, user: { id: 99, first_name: 'X' } });
  assert.strictEqual((await (await get('/auth/bot/status', r.cookie)).json()).status, 'denied');

  r = await startBotLogin();
  const confirm = await (await botCall('/auth/bot/confirm', { token: r.token, approve: true, user: { id: 98, first_name: 'Karyawan', last_name: 'Baru' } })).json();
  assert.strictEqual(confirm.active, false);
  const res = await get('/auth/bot/status', r.cookie);
  const session = res.headers.get('set-cookie').split(/,(?=\s*\w+=)/).find((c) => c.trim().startsWith('tjp_sid=')).split(';')[0].trim();
  const page = await get('/', session);
  assert.strictEqual(page.status, 403);
  assert.match(await page.text(), /Akses belum aktif/);
});

// --- WhatsApp -----------------------------------------------------------------

const { normalizePhone, templateParam } = require('../lib/whatsapp');

function waWebhook(messages, { secret = WA_SECRET, contacts = [] } = {}) {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { contacts, messages } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return realFetch(`${base}/webhooks/whatsapp`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sig }, body });
}
const waText = (from, text, name = '') => waWebhook([{ from, id: 'm' + Math.random(), type: 'text', text: { body: text } }], { contacts: [{ wa_id: from, profile: { name } }] });
const waButton = (from, id) => waWebhook([{ from, id: 'b' + Math.random(), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title: 'x' } } }]);
const sessionFrom = (res) => res.headers.get('set-cookie').split(/,(?=\s*\w+=)/).find((c) => c.trim().startsWith('tjp_sid=')).split(';')[0].trim();
const tick = () => new Promise((r) => setTimeout(r, 20));

async function startWa(cookie = '', purpose = 'login') {
  const res = await realFetch(`${base}/auth/bot/start`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'whatsapp', purpose }) });
  const data = await res.json();
  assert.strictEqual(res.status, 200, data.error);
  const text = decodeURIComponent(data.link.split('?text=')[1]);
  return { ...data, text, cookie: res.headers.get('set-cookie').split(';')[0] };
}

// Sends the prefilled message, then taps the button the bot replied with.
async function confirmOnWhatsApp(from, text, name, tap = 'y') {
  outbox.length = 0;
  assert.strictEqual((await waText(from, text, name)).status, 200);
  await tick();
  const prompt = sentTo('whatsapp', from).find((m) => m.body.type === 'interactive');
  assert.ok(prompt, 'bot should reply with confirmation buttons');
  const btn = prompt.body.interactive.action.buttons.find((b) => b.reply.id.startsWith(`lg:${tap}:`));
  outbox.length = 0;
  await waButton(from, btn.reply.id);
  await tick();
  return prompt;
}

test('whatsapp helpers', () => {
  assert.strictEqual(normalizePhone('0812-3456-7890'), '6281234567890');
  assert.strictEqual(normalizePhone('+62 812 3456 7890'), '6281234567890');
  assert.strictEqual(normalizePhone('123'), null);
  assert.strictEqual(templateParam('<b>Halo</b>\nbaris 2'), 'Halo · baris 2');
});

test('whatsapp webhook: verification handshake and signature check', async () => {
  const ok = await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42`);
  assert.strictEqual(await ok.text(), '42');
  assert.strictEqual((await realFetch(`${base}/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=42`)).status, 403);
  assert.strictEqual((await waWebhook([], { secret: 'wrong' })).status, 401);
});

test('whatsapp login: MASUK message, code shown, "Ya, ini saya" logs the browser in as a pending user', async () => {
  const phone = '6281299990001';
  const r = await startWa();
  assert.ok(r.link.startsWith(`https://wa.me/${WA_BUSINESS}?text=`));
  assert.match(r.text, /^MASUK [A-Z2-9]{8}$/);

  const prompt = await confirmOnWhatsApp(phone, r.text, 'Andi Lapangan');
  assert.match(prompt.body.interactive.body.text, new RegExp(`\\*${r.code}\\*`));
  assert.match(sentTo('whatsapp', phone)[0].body.text.body, /menunggu persetujuan/);

  const status = await get('/auth/bot/status', r.cookie);
  assert.strictEqual((await status.json()).status, 'confirmed');
  const page = await get('/', sessionFrom(status));
  assert.strictEqual(page.status, 403);
  assert.match(await page.text(), /Akses belum aktif/);

  // Reusing the message, or tapping from a different number, does nothing.
  outbox.length = 0;
  await waText(phone, r.text);
  await tick();
  assert.match(sentTo('whatsapp', phone)[0].body.text.body, /kedaluwarsa/);
});

test('whatsapp: "Bukan saya" denies; a button from another number is ignored', async () => {
  let r = await startWa();
  await confirmOnWhatsApp('6281299990002', r.text, 'X', 'n');
  assert.strictEqual((await (await get('/auth/bot/status', r.cookie)).json()).status, 'denied');

  r = await startWa();
  outbox.length = 0;
  await waText('6281299990003', r.text, 'Asli');
  await tick();
  const btn = sentTo('whatsapp', '6281299990003')[0].body.interactive.action.buttons[0].reply.id;
  await waButton('6281299990004', btn); // attacker's number
  await tick();
  assert.strictEqual((await (await get('/auth/bot/status', r.cookie)).json()).status, 'pending');
});

test('whatsapp: link a number from Profil, then log in with WhatsApp to the same account and get WA notifications', async () => {
  const owner = await login(OWNER);
  const staffTg = { id: 90, first_name: 'Dimas' };
  const staff = await member(staffTg, 'karyawan');
  const phone = '6281299990090';

  const r = await startWa(staff, 'link');
  assert.match(r.text, /^HUBUNGKAN /);
  await confirmOnWhatsApp(phone, r.text, 'Dimas WA');
  assert.match(sentTo('whatsapp', phone)[0].body.text.body, /terhubung ke akun Dimas/);
  assert.strictEqual((await (await get('/auth/bot/status', r.cookie)).json()).status, 'linked');
  assert.match(await html('/profil', staff), /\+6281299990090/);

  // Another account can't claim the same number.
  const other = await member({ id: 91, first_name: 'Lain' }, 'karyawan');
  const r2 = await startWa(other, 'link');
  await confirmOnWhatsApp(phone, r2.text, 'X');
  assert.match(sentTo('whatsapp', phone)[0].body.text.body, /sudah terhubung ke akun lain/);

  // WhatsApp login lands on the existing Telegram account.
  const r3 = await startWa();
  await confirmOnWhatsApp(phone, r3.text, 'Dimas WA');
  const waSession = sessionFrom(await get('/auth/bot/status', r3.cookie));
  assert.match(await html('/', waSession), /Dimas/);
  assert.match(await html('/', waSession), /Sistem Absensi/);

  // Notifications now go to both Telegram and WhatsApp (template)...
  outbox.length = 0;
  await post('/progres', owner, { title: 'Cek panel MDP', picId: '90' });
  await tick();
  const waMsg = sentTo('whatsapp', phone).find((m) => m.body.type === 'template');
  assert.strictEqual(waMsg.body.template.name, 'onehub_notifikasi');
  assert.match(waMsg.body.template.components[0].parameters[0].text, /Penugasan baru.*Cek panel MDP/);
  assert.ok(!/[\n<]/.test(waMsg.body.template.components[0].parameters[0].text));
  assert.strictEqual(sentTo('telegram', '90').length, 1);

  // ...until the user turns WhatsApp off.
  await post('/profil/notifikasi', staff, { telegram: '1' });
  outbox.length = 0;
  await post('/progres', owner, { title: 'Cek panel SDP', picId: '90' });
  await tick();
  assert.strictEqual(sentTo('whatsapp', phone).length, 0);
  assert.strictEqual(sentTo('telegram', '90').length, 1);
});

test('admin can set an employee WhatsApp number; duplicates rejected', async () => {
  const admin = await member({ id: 95, first_name: 'AdminWA' }, 'admin');
  await member({ id: 96, first_name: 'Teknisi' }, 'karyawan');
  assert.strictEqual((await post('/pengguna/96', admin, { phone: '0812-9999-0096' })).status, 302);
  assert.match(await html('/pengguna', admin), /WA \+6281299990096/);
  assert.strictEqual((await post('/pengguna/96', admin, { phone: '081299990090' })).status, 400); // Dimas's number
  assert.strictEqual((await post('/pengguna/96', admin, { phone: 'abc' })).status, 400);
});
