// Sistem Proc & Res: pengajuan operasional, pembelian barang, kebutuhan lainnya, dan laporan PIC.
// Flow: diajukan (pending) -> disetujui/ditolak (admin) -> PIC melaporkan realisasi -> selesai.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');
const { rupiah } = require('../lib/dates');

const TYPES = {
  operasional: 'Operasional',
  pembelian: 'Pembelian barang',
  lainnya: 'Kebutuhan lainnya',
};
const STATUS = {
  pending: 'Menunggu persetujuan',
  approved: 'Disetujui · menunggu laporan',
  rejected: 'Ditolak',
  done: 'Selesai',
};

const toNumber = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const list = (v) => [].concat(v ?? []);

module.exports = ({ store, upload, config, isAdmin }) => {
  const router = express.Router();

  const userName = (id) => store.find('users', (u) => u.id === id)?.name || '-';
  const projectName = (id) => {
    const p = id && store.find('projects', (x) => x.id === id);
    return p ? `${p.code ? p.code + ' · ' : ''}${p.name}` : null;
  };
  const decorate = (r) => ({ ...r, userName: userName(r.userId), projectName: projectName(r.projectId) });
  const nextNumber = () => {
    const year = new Date().getFullYear();
    const n = store.filter('procRequests', (r) => r.number?.startsWith(`PR-${year}-`)).length + 1;
    return `PR-${year}-${String(n).padStart(4, '0')}`;
  };

  router.use((req, res, next) => {
    res.locals.TYPES = TYPES;
    res.locals.STATUS = STATUS;
    next();
  });

  router.get('/', (req, res) => {
    const admin = isAdmin(req.user);
    const scope = admin && req.query.scope !== 'saya' ? 'semua' : 'saya';
    const status = STATUS[req.query.status] ? req.query.status : '';
    const rows = store
      .filter('procRequests', (r) => (scope === 'semua' || r.userId === req.user.id) && (!status || r.status === status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(decorate);
    const mine = store.filter('procRequests', (r) => r.userId === req.user.id);
    res.render('procurement/index', {
      rows,
      viewScope: scope,
      status,
      counts: {
        pending: admin ? store.filter('procRequests', (r) => r.status === 'pending').length : mine.filter((r) => r.status === 'pending').length,
        toReport: mine.filter((r) => r.status === 'approved').length,
      },
    });
  });

  router.get('/baru', (req, res) => {
    const type = TYPES[req.query.jenis] ? req.query.jenis : 'pembelian';
    res.render('procurement/form', { type, projects: store.all('projects') });
  });

  router.post('/', (req, res) => {
    const type = req.body.type;
    if (!TYPES[type]) throw badRequest('Jenis pengajuan tidak valid.');
    if (!req.body.title?.trim()) throw badRequest('Judul pengajuan wajib diisi.');

    const names = list(req.body.itemName);
    const qtys = list(req.body.itemQty);
    const units = list(req.body.itemUnit);
    const prices = list(req.body.itemPrice);
    const items = names
      .map((name, i) => ({ name: String(name).trim(), qty: Number(qtys[i]) || 1, unit: String(units[i] || '').trim(), price: toNumber(prices[i]) }))
      .filter((it) => it.name);
    if (!items.length) throw badRequest('Isi minimal satu item.');
    const total = items.reduce((s, it) => s + it.qty * it.price, 0);

    const r = store.insert('procRequests', {
      number: nextNumber(),
      userId: req.user.id,
      type,
      title: req.body.title.trim(),
      projectId: req.body.projectId || null,
      neededBy: req.body.neededBy || null,
      notes: (req.body.notes || '').trim(),
      items,
      total,
      status: 'pending',
    });
    notify(
      config,
      config.notifyChatId,
      `🛒 ${r.number} · ${TYPES[type]}\n<b>${r.title}</b> — ${rupiah(total)}\nDiajukan oleh ${req.user.name}`
    );
    res.redirect(`/proc/${r.id}?ok=Pengajuan terkirim`);
  });

  const load = (req) => store.find('procRequests', (r) => r.id === req.params.id);
  const canView = (req, r) => r.userId === req.user.id || isAdmin(req.user);

  router.get('/:id', (req, res, next) => {
    const r = load(req);
    if (!r || !canView(req, r)) return next();
    res.render('procurement/show', { r: decorate(r), decidedByName: r.decidedBy ? userName(r.decidedBy) : null });
  });

  router.post('/:id/:action(approve|reject)', (req, res, next) => {
    if (!isAdmin(req.user)) throw badRequest('Hanya admin yang bisa menyetujui pengajuan.');
    const r = load(req);
    if (!r) return next();
    if (r.status !== 'pending') throw badRequest('Pengajuan ini sudah diproses.');
    const status = req.params.action === 'approve' ? 'approved' : 'rejected';
    const approvedAmount = status === 'approved' ? toNumber(req.body.approvedAmount) || r.total : 0;
    store.update('procRequests', r.id, {
      status,
      approvedAmount,
      decisionNote: (req.body.note || '').trim(),
      decidedBy: req.user.id,
      decidedAt: new Date().toISOString(),
    });
    notify(
      config,
      r.userId,
      `${r.number} ${status === 'approved' ? `✅ disetujui ${rupiah(approvedAmount)}` : '❌ ditolak'} oleh ${req.user.name}${req.body.note ? `\n${req.body.note}` : ''}`
    );
    res.redirect(`/proc/${r.id}?ok=Pengajuan diproses`);
  });

  // Laporan PIC: realisasi biaya + bukti/nota.
  router.post('/:id/laporan', upload.array('receipts', 8), (req, res, next) => {
    const r = load(req);
    if (!r) return next();
    if (r.userId !== req.user.id && !isAdmin(req.user)) throw badRequest('Hanya pengaju atau admin yang bisa melapor.');
    if (r.status !== 'approved') throw badRequest('Laporan hanya untuk pengajuan yang sudah disetujui.');
    const actual = toNumber(req.body.actualAmount);
    if (!actual) throw badRequest('Nominal realisasi wajib diisi.');
    const receipts = (req.files || []).map((f) => `/uploads/${f.filename}`);
    if (!receipts.length) throw badRequest('Lampirkan minimal satu foto nota/bukti.');
    const report = {
      actualAmount: actual,
      balance: (r.approvedAmount || r.total) - actual,
      note: (req.body.note || '').trim(),
      receipts,
      reportedBy: req.user.id,
      reportedAt: new Date().toISOString(),
    };
    store.update('procRequests', r.id, { status: 'done', report });
    notify(
      config,
      config.notifyChatId,
      `🧾 Laporan ${r.number} oleh ${req.user.name}: realisasi ${rupiah(actual)} (${report.balance >= 0 ? 'sisa' : 'kurang'} ${rupiah(Math.abs(report.balance))})`
    );
    res.redirect(`/proc/${r.id}?ok=Laporan tersimpan`);
  });

  return router;
};
