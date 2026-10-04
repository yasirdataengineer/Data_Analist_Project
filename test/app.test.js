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
const { overtimePay } = require('../lib/payroll');

const BOT_TOKEN = '123456:TEST';
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
