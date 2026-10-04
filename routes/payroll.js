// Sistem Payroll: penggajian, rekap bulanan, koreksi lembur, kasbon.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');
const { todayKey, monthKey, minutesBetween, rupiah, formatMonth } = require('../lib/dates');
const { payslipFor } = require('../lib/payroll');

const MONTH_RE = /^\d{4}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

module.exports = ({ store, config, isAdmin }) => {
  const router = express.Router();

  const userName = (id) => store.find('users', (u) => u.id === id)?.name || '-';
  const pickMonth = (q) => (MONTH_RE.test(q || '') ? q : monthKey());
  const finalized = (userId, month) => store.find('payrolls', (p) => p.userId === userId && p.month === month);
  const requireAdmin = (req) => {
    if (!isAdmin(req.user)) throw badRequest('Hanya admin yang bisa melakukan ini.');
  };
  // Once a month is paid out, its inputs are frozen.
  const assertOpen = (userId, month) => {
    if (finalized(userId, month)) throw badRequest(`Payroll ${formatMonth(month)} sudah difinalisasi.`);
  };

  // --- Slip gaji (own) ------------------------------------------------------

  router.get('/', (req, res) => {
    const month = pickMonth(req.query.bulan);
    const paid = finalized(req.user.id, month);
    const uid = req.user.id;
    res.render('payroll/index', {
      month,
      slip: paid ? paid.slip : payslipFor(store, uid, month),
      paid,
      pendingCash: store.filter('cashAdvances', (c) => c.userId === uid && c.status === 'pending').length,
      pendingCorr: store.filter('overtimeCorrections', (c) => c.userId === uid && c.status === 'pending').length,
      approvals: isAdmin(req.user)
        ? store.filter('cashAdvances', (c) => c.status === 'pending').length +
          store.filter('overtimeCorrections', (c) => c.status === 'pending').length
        : 0,
    });
  });

  // --- Rekap bulanan (admin) ------------------------------------------------

  router.get('/rekap', (req, res) => {
    requireAdmin(req);
    const month = pickMonth(req.query.bulan);
    const rows = store.all('users').map((u) => {
      const paid = finalized(u.id, month);
      return { user: u, paid, slip: paid ? paid.slip : payslipFor(store, u.id, month) };
    });
    const total = rows.reduce((s, r) => s + r.slip.net, 0);
    res.render('payroll/recap', { month, rows, total });
  });

  router.post('/rekap/finalisasi', (req, res) => {
    requireAdmin(req);
    const month = pickMonth(req.body.bulan);
    const ids = [].concat(req.body.userId || []);
    if (!ids.length) throw badRequest('Pilih minimal satu karyawan.');
    let count = 0;
    for (const userId of ids) {
      if (finalized(userId, month)) continue;
      const slip = payslipFor(store, userId, month);
      if (!slip.configured) continue;
      store.insert('payrolls', { userId, month, slip, finalizedBy: req.user.id });
      notify(config, userId, `💰 Slip gaji ${formatMonth(month)} sudah terbit. Total diterima: <b>${rupiah(slip.net)}</b>`);
      count++;
    }
    res.redirect(`/payroll/rekap?bulan=${month}&ok=${count} slip difinalisasi`);
  });

  // --- Pengaturan gaji (admin) ----------------------------------------------

  router.get('/gaji', (req, res) => {
    requireAdmin(req);
    const rows = store.all('users').map((u) => ({ user: u, salary: store.find('salaries', (s) => s.userId === u.id) || {} }));
    res.render('payroll/salary', { rows });
  });

  router.post('/gaji/:userId', (req, res, next) => {
    requireAdmin(req);
    const user = store.find('users', (u) => u.id === req.params.userId);
    if (!user) return next();
    const num = (v) => {
      const n = Number(String(v || '0').replace(/[^\d]/g, ''));
      if (!Number.isFinite(n)) throw badRequest('Nominal tidak valid.');
      return n;
    };
    const doc = {
      position: (req.body.position || '').trim(),
      base: num(req.body.base),
      allowance: num(req.body.allowance),
      deduction: num(req.body.deduction),
      overtimeRate: num(req.body.overtimeRate) || null,
    };
    const existing = store.find('salaries', (s) => s.userId === user.id);
    if (existing) store.update('salaries', existing.id, doc);
    else store.insert('salaries', { userId: user.id, ...doc });
    res.redirect(`/payroll/gaji?ok=Gaji ${user.name} tersimpan`);
  });

  // --- Kasbon ---------------------------------------------------------------

  router.get('/kasbon', (req, res) => {
    const mine = store.filter('cashAdvances', (c) => c.userId === req.user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pending = isAdmin(req.user)
      ? store.filter('cashAdvances', (c) => c.status === 'pending').map((c) => ({ ...c, userName: userName(c.userId) }))
      : [];
    res.render('payroll/cash', { mine, pending, month: monthKey() });
  });

  router.post('/kasbon', (req, res) => {
    const amount = Number(String(req.body.amount || '').replace(/[^\d]/g, ''));
    if (!amount || amount <= 0) throw badRequest('Nominal kasbon wajib diisi.');
    if (!req.body.reason?.trim()) throw badRequest('Keperluan kasbon wajib diisi.');
    const deductMonth = pickMonth(req.body.deductMonth);
    assertOpen(req.user.id, deductMonth);
    store.insert('cashAdvances', { userId: req.user.id, amount, reason: req.body.reason.trim(), deductMonth, status: 'pending' });
    notify(config, config.notifyChatId, `💵 Kasbon ${req.user.name}: ${rupiah(amount)} (potong ${formatMonth(deductMonth)})\n${req.body.reason.trim()}`);
    res.redirect('/payroll/kasbon?ok=Pengajuan kasbon terkirim');
  });

  router.post('/kasbon/:id/:action(approve|reject)', (req, res, next) => {
    requireAdmin(req);
    const c = store.find('cashAdvances', (x) => x.id === req.params.id);
    if (!c) return next();
    if (c.status !== 'pending') throw badRequest('Pengajuan ini sudah diproses.');
    assertOpen(c.userId, c.deductMonth);
    const status = req.params.action === 'approve' ? 'approved' : 'rejected';
    store.update('cashAdvances', c.id, { status, decidedBy: req.user.id, decidedAt: new Date().toISOString() });
    notify(config, c.userId, `Kasbon ${rupiah(c.amount)} ${status === 'approved' ? '✅ disetujui' : '❌ ditolak'} oleh ${req.user.name}`);
    res.redirect('/payroll/kasbon?ok=Kasbon diproses');
  });

  // --- Koreksi lembur -------------------------------------------------------

  router.get('/koreksi', (req, res) => {
    const uid = req.user.id;
    const myOvertime = store.filter('overtime', (o) => o.userId === uid && o.status === 'approved').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
    const mine = store.filter('overtimeCorrections', (c) => c.userId === uid).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const pending = isAdmin(req.user)
      ? store.filter('overtimeCorrections', (c) => c.status === 'pending').map((c) => ({
          ...c,
          userName: userName(c.userId),
          original: c.overtimeId ? store.find('overtime', (o) => o.id === c.overtimeId) : null,
        }))
      : [];
    res.render('payroll/correction', { myOvertime, mine, pending, today: todayKey() });
  });

  router.post('/koreksi', (req, res) => {
    const { overtimeId, date, start, end, reason } = req.body;
    if (!TIME_RE.test(start || '') || !TIME_RE.test(end || '')) throw badRequest('Jam mulai dan selesai wajib diisi.');
    if (!reason?.trim()) throw badRequest('Alasan koreksi wajib diisi.');
    let targetDate = date;
    if (overtimeId) {
      const ot = store.find('overtime', (o) => o.id === overtimeId && o.userId === req.user.id && o.status === 'approved');
      if (!ot) throw badRequest('Data lembur tidak ditemukan.');
      targetDate = ot.date;
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      throw badRequest('Tanggal wajib diisi untuk lembur yang belum tercatat.');
    }
    assertOpen(req.user.id, targetDate.slice(0, 7));
    store.insert('overtimeCorrections', {
      userId: req.user.id,
      overtimeId: overtimeId || null,
      date: targetDate,
      start,
      end,
      minutes: minutesBetween(start, end),
      reason: reason.trim(),
      status: 'pending',
    });
    notify(config, config.notifyChatId, `🛠️ Koreksi lembur ${req.user.name} ${targetDate} → ${start}–${end}\n${reason.trim()}`);
    res.redirect('/payroll/koreksi?ok=Koreksi lembur terkirim');
  });

  router.post('/koreksi/:id/:action(approve|reject)', (req, res, next) => {
    requireAdmin(req);
    const c = store.find('overtimeCorrections', (x) => x.id === req.params.id);
    if (!c) return next();
    if (c.status !== 'pending') throw badRequest('Koreksi ini sudah diproses.');
    assertOpen(c.userId, c.date.slice(0, 7));
    const status = req.params.action === 'approve' ? 'approved' : 'rejected';

    if (status === 'approved') {
      const ot = c.overtimeId && store.find('overtime', (o) => o.id === c.overtimeId);
      if (ot) {
        store.update('overtime', ot.id, {
          start: c.start,
          end: c.end,
          minutes: c.minutes,
          correctedFrom: ot.correctedFrom || { start: ot.start, end: ot.end, minutes: ot.minutes },
          correctionId: c.id,
        });
      } else {
        // Overtime that was worked but never recorded.
        store.insert('overtime', {
          userId: c.userId,
          date: c.date,
          start: c.start,
          end: c.end,
          minutes: c.minutes,
          reason: `Koreksi: ${c.reason}`,
          status: 'approved',
          correctedFrom: { start: null, end: null, minutes: 0 },
          correctionId: c.id,
          decidedBy: req.user.id,
          decidedAt: new Date().toISOString(),
        });
      }
    }
    store.update('overtimeCorrections', c.id, { status, decidedBy: req.user.id, decidedAt: new Date().toISOString() });
    notify(config, c.userId, `Koreksi lembur ${c.date} ${c.start}–${c.end} ${status === 'approved' ? '✅ disetujui' : '❌ ditolak'} oleh ${req.user.name}`);
    res.redirect('/payroll/koreksi?ok=Koreksi diproses');
  });

  return router;
};
