const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createApp } = require('../app');
const { Store } = require('../lib/store');
const { validateInitData } = require('../lib/telegram');
const { minutesBetween } = require('../lib/dates');

const BOT_TOKEN = '123456:TEST';

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
    adminIds: ['900'],
    sessionSecret: 'test-secret',
    devLogin: false,
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
const get = (url, cookie) => fetch(base + url, { redirect: 'manual', headers: { cookie } });

test('validateInitData accepts genuine data and rejects tampering/expiry', () => {
  const data = signInitData({ id: 1, first_name: 'Yasir' });
  assert.strictEqual(validateInitData(data, BOT_TOKEN).first_name, 'Yasir');
  assert.strictEqual(validateInitData(data.replace('Yasir', 'Mallory'), BOT_TOKEN), null);
  assert.strictEqual(validateInitData(data, '999:OTHER'), null);
  assert.strictEqual(validateInitData(signInitData({ id: 1 }, 1000), BOT_TOKEN), null);
});

test('minutesBetween handles crossing midnight', () => {
  assert.strictEqual(minutesBetween('17:00', '20:30'), 210);
  assert.strictEqual(minutesBetween('22:00', '02:00'), 240);
});

test('unauthenticated users are sent to login; bad initData is rejected', async () => {
  const res = await get('/', '');
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.get('location'), '/login');
  const bad = await fetch(`${base}/auth/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"initData":"hash=00"}' });
  assert.strictEqual(bad.status, 401);
});

test('hub shows both systems and the Telegram user name', async () => {
  const cookie = await login({ id: 100, first_name: 'Pak', last_name: 'yasir' });
  const html = await (await get('/', cookie)).text();
  assert.match(html, /Pak yasir/);
  assert.match(html, /Monitoring Progres/);
  assert.match(html, /Sistem Absensi/);
});

test('progress: PIC can update, other users cannot, history is recorded', async () => {
  const pic = await login({ id: 100, first_name: 'Pak', last_name: 'yasir' });
  const other = await login({ id: 200, first_name: 'Budi' });

  const created = await post('/progres', pic, { code: 'C006', name: 'UPS MCS Bitung', location: 'Bitung' });
  assert.strictEqual(created.status, 302);
  const projectUrl = created.headers.get('location').split('?')[0];

  assert.strictEqual((await post(`${projectUrl}/update`, pic, { progress: '45', note: 'Terminasi kabel' })).status, 302);
  assert.strictEqual((await post(`${projectUrl}/update`, other, { progress: '90' })).status, 400);
  assert.strictEqual((await post(`${projectUrl}/update`, pic, { progress: '150' })).status, 400);

  const html = await (await get(projectUrl, pic)).text();
  assert.match(html, /45%/);
  assert.match(html, /0% → 45%/);
  assert.match(html, /Terminasi kabel/);
  assert.match(await (await get('/progres', other)).text(), /UPS MCS Bitung/);
});

test('attendance: check-in once, then check-out once', async () => {
  const cookie = await login({ id: 300, first_name: 'Sari' });
  assert.strictEqual((await post('/absensi/pulang', cookie, {})).status, 400);
  assert.strictEqual((await post('/absensi/masuk', cookie, { lat: '1.44', lng: '125.18' })).status, 302);
  assert.strictEqual((await post('/absensi/masuk', cookie, {})).status, 400);
  assert.strictEqual((await post('/absensi/pulang', cookie, {})).status, 302);
  assert.match(await (await get('/absensi', cookie)).text(), /Absensi hari ini lengkap/);
});

test('work plan feeds the daily report checklist', async () => {
  const cookie = await login({ id: 300, first_name: 'Sari' });
  await post('/absensi/rencana', cookie, { tasks: 'Cek grounding\nPasang battery rack' });
  const html = await (await get('/absensi/laporan', cookie)).text();
  assert.match(html, /Cek grounding/);
  assert.match(html, /Pasang battery rack/);
  assert.strictEqual((await post('/absensi/laporan', cookie, { summary: 'Selesai', done: 'Cek grounding' })).status, 302);
  assert.match(await (await get('/absensi', cookie)).text(), /Sudah dikirim/);
});

test('overtime: only admins can approve, and only once', async () => {
  const staff = await login({ id: 300, first_name: 'Sari' });
  const admin = await login({ id: 900, first_name: 'Admin' });
  await post('/absensi/lembur', staff, { date: '2026-10-04', start: '17:00', end: '21:00', reason: 'Commissioning UPS' });

  const adminHtml = await (await get('/absensi/lembur', admin)).text();
  const id = adminHtml.match(/\/absensi\/lembur\/([0-9a-f-]{36})\/approve/)[1];

  assert.strictEqual((await post(`/absensi/lembur/${id}/approve`, staff, {})).status, 400);
  assert.strictEqual((await post(`/absensi/lembur/${id}/approve`, admin, {})).status, 302);
  assert.strictEqual((await post(`/absensi/lembur/${id}/reject`, admin, {})).status, 400);
  assert.match(await (await get('/absensi/lembur', staff)).text(), /Disetujui/);
});

test('overtimePay follows Kemnaker workday multipliers', () => {
  const { overtimePay } = require('../lib/payroll');
  assert.strictEqual(overtimePay(60, 10000), 15000);
  assert.strictEqual(overtimePay(180, 10000), 55000); // 1.5 + 2 + 2 hours
  assert.strictEqual(overtimePay(30, 10000), 7500);
});

test('payroll: salary + approved overtime + kasbon roll into the slip, finalisation locks the month', async () => {
  const admin = await login({ id: 900, first_name: 'Admin' });
  const staff = await login({ id: 400, first_name: 'Rudi' });
  const month = '2026-09';

  assert.strictEqual((await post('/payroll/gaji/400', staff, { base: '3460000' })).status, 400);
  assert.strictEqual((await post('/payroll/gaji/400', admin, { base: '3.460.000', allowance: '500000' })).status, 302);

  // 2h approved overtime: hourly 20.000 -> 1.5*20k + 2*20k = 70.000
  await post('/absensi/lembur', staff, { date: `${month}-10`, start: '17:00', end: '19:00', reason: 'Testing panel' });
  let html = await (await get('/absensi/lembur', admin)).text();
  let id = html.match(/\/absensi\/lembur\/([0-9a-f-]{36})\/approve/)[1];
  await post(`/absensi/lembur/${id}/approve`, admin, {});

  // Correct it to 3h: 1.5 + 2 + 2 = 5.5 * 20k = 110.000
  html = await (await get('/payroll/koreksi', staff)).text();
  const otId = html.match(/<option value="([0-9a-f-]{36})">/)[1];
  await post('/payroll/koreksi', staff, { overtimeId: otId, start: '17:00', end: '20:00', reason: 'Jam pulang salah' });
  html = await (await get('/payroll/koreksi', admin)).text();
  id = html.match(/\/payroll\/koreksi\/([0-9a-f-]{36})\/approve/)[1];
  assert.strictEqual((await post(`/payroll/koreksi/${id}/approve`, admin, {})).status, 302);

  await post('/payroll/kasbon', staff, { amount: '250.000', deductMonth: month, reason: 'Keperluan keluarga' });
  html = await (await get('/payroll/kasbon', admin)).text();
  id = html.match(/\/payroll\/kasbon\/([0-9a-f-]{36})\/approve/)[1];
  await post(`/payroll/kasbon/${id}/approve`, admin, {});

  // 3.460.000 + 500.000 + 110.000 - 250.000 = 3.820.000
  html = await (await get(`/payroll?bulan=${month}`, staff)).text();
  assert.match(html, /Rp 3\.820\.000/);
  assert.match(html, /koreksi/);

  assert.strictEqual((await get('/payroll/rekap', staff)).status, 400);
  assert.strictEqual((await post('/payroll/rekap/finalisasi', admin, { bulan: month, userId: '400' })).status, 302);
  assert.match(await (await get(`/payroll?bulan=${month}`, staff)).text(), /Final/);
  assert.strictEqual((await post('/payroll/kasbon', staff, { amount: '100000', deductMonth: month, reason: 'x' })).status, 400);
});

test('proc & res: request -> approve -> PIC report with receipt', async () => {
  const staff = await login({ id: 500, first_name: 'Dewi' });
  const admin = await login({ id: 900, first_name: 'Admin' });
  const other = await login({ id: 501, first_name: 'Eko' });

  const body = new URLSearchParams([
    ['type', 'pembelian'], ['title', 'Kabel NYY'],
    ['itemName', 'Kabel NYY 4x16'], ['itemQty', '50'], ['itemUnit', 'm'], ['itemPrice', '120.000'],
    ['itemName', 'Skun'], ['itemQty', '8'], ['itemUnit', 'pcs'], ['itemPrice', '15000'],
    ['itemName', ''], ['itemQty', '1'], ['itemUnit', ''], ['itemPrice', ''],
  ]);
  const created = await fetch(`${base}/proc`, { method: 'POST', redirect: 'manual', headers: { cookie: staff, 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  assert.strictEqual(created.status, 302);
  const url = created.headers.get('location').split('?')[0];

  let html = await (await get(url, staff)).text();
  assert.match(html, /PR-\d{4}-0001/);
  assert.match(html, /Rp 6\.120\.000/); // 50*120k + 8*15k
  assert.strictEqual((await get(url, other)).status, 404);

  assert.strictEqual((await post(`${url}/approve`, staff, {})).status, 400);
  assert.strictEqual((await post(`${url}/approve`, admin, { approvedAmount: '6000000' })).status, 302);

  const fd = new FormData();
  fd.set('actualAmount', '5.800.000');
  assert.strictEqual((await fetch(`${base}${url}/laporan`, { method: 'POST', redirect: 'manual', headers: { cookie: staff }, body: fd })).status, 400);
  fd.append('receipts', new Blob([Buffer.from('89504e47', 'hex')], { type: 'image/png' }), 'nota.png');
  assert.strictEqual((await fetch(`${base}${url}/laporan`, { method: 'POST', redirect: 'manual', headers: { cookie: staff }, body: fd })).status, 302);

  html = await (await get(url, staff)).text();
  assert.match(html, /Selesai/);
  assert.match(html, /Sisa dana/);
  assert.match(html, /Rp 200\.000/);
});
