// Sistem Absensi: check-in/out, rencana pekerjaan, laporan progres, pengajuan lembur.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');
const { todayKey, minutesBetween } = require('../lib/dates');

module.exports = ({ store, upload, config, need }) => {
  const router = express.Router();

  // Management/owner only see the team report; personal attendance is for karyawan.
  router.use((req, res, next) => {
    if (req.path.startsWith('/tim')) return next();
    if (req.can('attendance.self')) return next();
    res.redirect('/absensi/tim');
  });

  const todayRecord = (userId) => store.find('attendance', (a) => a.userId === userId && a.date === todayKey());
  const location = (body) =>
    body.lat && body.lng ? { lat: Number(body.lat), lng: Number(body.lng), accuracy: Number(body.accuracy) || null } : null;

  router.get('/', (req, res) => {
    const uid = req.user.id;
    const today = todayKey();
    res.render('attendance/index', {
      today,
      record: todayRecord(uid),
      plan: store.find('workPlans', (p) => p.userId === uid && p.date === today),
      report: store.find('dailyReports', (r) => r.userId === uid && r.date === today),
      pendingOvertime: store.filter('overtime', (o) => o.userId === uid && o.status === 'pending').length,
    });
  });

  // --- Check-in / check-out -------------------------------------------------

  router.post('/masuk', upload.single('selfie'), (req, res) => {
    if (todayRecord(req.user.id)) throw badRequest('Anda sudah absen masuk hari ini.');
    store.insert('attendance', {
      userId: req.user.id,
      date: todayKey(),
      checkIn: new Date().toISOString(),
      checkInLocation: location(req.body),
      checkInPhoto: req.file ? `/uploads/${req.file.filename}` : null,
      checkOut: null,
    });
    notify(config, config.notifyChatId, `🟢 ${req.user.name} absen masuk`);
    res.redirect('/absensi?ok=Absen masuk tercatat');
  });

  router.post('/pulang', upload.single('selfie'), (req, res) => {
    const record = todayRecord(req.user.id);
    if (!record) throw badRequest('Belum absen masuk hari ini.');
    if (record.checkOut) throw badRequest('Anda sudah absen pulang hari ini.');
    store.update('attendance', record.id, {
      checkOut: new Date().toISOString(),
      checkOutLocation: location(req.body),
      checkOutPhoto: req.file ? `/uploads/${req.file.filename}` : null,
    });
    notify(config, config.notifyChatId, `🔴 ${req.user.name} absen pulang`);
    res.redirect('/absensi?ok=Absen pulang tercatat');
  });

  // --- Rencana pekerjaan ----------------------------------------------------

  router.get('/rencana', (req, res) => {
    const date = req.query.date || todayKey();
    const plan = store.find('workPlans', (p) => p.userId === req.user.id && p.date === date);
    res.render('attendance/plan', { date, plan, projects: store.all('projects') });
  });

  router.post('/rencana', (req, res) => {
    const date = req.body.date || todayKey();
    const tasks = String(req.body.tasks || '')
      .split('\n')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tasks.length) throw badRequest('Isi minimal satu pekerjaan.');
    const existing = store.find('workPlans', (p) => p.userId === req.user.id && p.date === date);
    const doc = { tasks, projectId: req.body.projectId || null };
    if (existing) store.update('workPlans', existing.id, doc);
    else store.insert('workPlans', { userId: req.user.id, date, ...doc });
    res.redirect('/absensi?ok=Rencana pekerjaan tersimpan');
  });

  // --- Laporan progres harian -----------------------------------------------

  router.get('/laporan', (req, res) => {
    const date = todayKey();
    res.render('attendance/report', {
      date,
      plan: store.find('workPlans', (p) => p.userId === req.user.id && p.date === date),
      report: store.find('dailyReports', (r) => r.userId === req.user.id && r.date === date),
    });
  });

  router.post('/laporan', upload.array('photos', 6), (req, res) => {
    const summary = (req.body.summary || '').trim();
    if (!summary) throw badRequest('Ringkasan laporan wajib diisi.');
    const date = todayKey();
    const done = [].concat(req.body.done || []);
    const photos = (req.files || []).map((f) => `/uploads/${f.filename}`);
    const existing = store.find('dailyReports', (r) => r.userId === req.user.id && r.date === date);
    if (existing) {
      store.update('dailyReports', existing.id, { summary, done, issues: req.body.issues || '', photos: [...existing.photos, ...photos] });
    } else {
      store.insert('dailyReports', { userId: req.user.id, date, summary, done, issues: req.body.issues || '', photos });
    }
    notify(config, config.notifyChatId, `📝 Laporan harian ${req.user.name}:\n${summary}`);
    res.redirect('/absensi?ok=Laporan terkirim');
  });

  // --- Pengajuan lembur -----------------------------------------------------

  router.get('/lembur', (req, res) => {
    const mine = store.filter('overtime', (o) => o.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    res.render('attendance/overtime', { mine, today: todayKey() });
  });

  router.post('/lembur', (req, res) => {
    const { date, start, end, reason } = req.body;
    if (!date || !/^\d{2}:\d{2}$/.test(start || '') || !/^\d{2}:\d{2}$/.test(end || '')) throw badRequest('Tanggal dan jam wajib diisi.');
    if (!reason?.trim()) throw badRequest('Alasan lembur wajib diisi.');
    const ot = store.insert('overtime', {
      userId: req.user.id,
      date,
      start,
      end,
      minutes: minutesBetween(start, end),
      reason: reason.trim(),
      status: 'pending',
    });
    notify(config, config.notifyChatId, `⏱️ Pengajuan lembur ${req.user.name} ${date} ${start}–${end} (${(ot.minutes / 60).toFixed(1)} jam)\n${ot.reason}`);
    res.redirect('/absensi/lembur?ok=Pengajuan lembur terkirim');
  });

  // --- Riwayat --------------------------------------------------------------

  router.get('/riwayat', (req, res) => {
    const rows = store.filter('attendance', (a) => a.userId === req.user.id).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 60);
    res.render('attendance/history', { rows });
  });

  // --- Laporan tim (owner / management) -------------------------------------

  router.get('/tim', need('attendance.report'), (req, res) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayKey();
    const rows = store
      .filter('users', (u) => u.active && u.role === 'karyawan')
      .map((u) => ({
        user: u,
        record: store.find('attendance', (a) => a.userId === u.id && a.date === date),
        plan: store.find('workPlans', (p) => p.userId === u.id && p.date === date),
        report: store.find('dailyReports', (r) => r.userId === u.id && r.date === date),
        overtime: store.filter('overtime', (o) => o.userId === u.id && o.date === date && o.status !== 'rejected'),
      }))
      .sort((a, b) => a.user.name.localeCompare(b.user.name));
    res.render('attendance/team', { date, rows, present: rows.filter((r) => r.record).length });
  });

  return router;
};
