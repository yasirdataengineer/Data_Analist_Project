// Sistem Proc & Res: pengajuan & laporan dana.
// Flow: diajukan -> disetujui pemilik -> ditransfer (bukti + sumber dana) -> laporan PIC + foto bukti -> Laporan Close.
const crypto = require('crypto');
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');
const { todayKey, rupiah } = require('../lib/dates');
const { SOURCES, transferred, outstanding, pettySummary } = require('../lib/finance');
const { STATUS, decorateRequest } = require('../lib/requests');

const toNumber = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

module.exports = ({ store, upload, config, need }) => {
  const router = express.Router();

  const userName = (id) => store.find('users', (u) => u.id === id)?.name || '-';

  const decorate = (r) => decorateRequest(store, r);
  const nextNumber = () => {
    const year = todayKey().slice(0, 4);
    const n = store.filter('procRequests', (r) => r.number?.startsWith(`PR-${year}-`)).length + 1;
    return `PR-${year}-${String(n).padStart(4, '0')}`;
  };

  router.use((req, res, next) => {
    res.locals.STATUS = STATUS;
    res.locals.SOURCES = SOURCES;
    next();
  });

  router.get('/', (req, res) => {
    const all = req.can('proc.viewAll');
    const scope = all && req.query.scope !== 'saya' ? 'semua' : 'saya';
    const status = STATUS[req.query.status] ? req.query.status : '';
    const base = store.filter('procRequests', (r) => scope === 'semua' || r.userId === req.user.id);
    res.render('procurement/index', {
      rows: base
        .filter((r) => !status || r.status === status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(decorate),
      viewScope: scope,
      status,
      counts: {
        pending: base.filter((r) => r.status === 'pending').length,
        openReports: base.filter((r) => ['approved', 'transferred'].includes(r.status)).length,
      },
    });
  });

  // --- Buat pengajuan -------------------------------------------------------

  router.get('/baru', need('proc.request'), (req, res) => {
    res.render('procurement/form', {
      types: store.filter('procTypes', (t) => t.active),
      categories: store.filter('procCategories', (c) => c.active),
      projects: store.all('projects'),
    });
  });

  router.post('/', need('proc.request'), upload.array('attachments', 4), (req, res) => {
    const type = store.find('procTypes', (t) => t.id === req.body.typeId && t.active);
    const category = store.find('procCategories', (c) => c.id === req.body.categoryId && c.active);
    if (!type) throw badRequest('Pilih jenis pengajuan.');
    if (!category) throw badRequest('Pilih kategori tujuan.');
    const project = req.body.projectId ? store.find('projects', (p) => p.id === req.body.projectId) : null;
    if (category.requiresProject && !project) throw badRequest(`Kategori ${category.name} wajib memilih project.`);
    const amount = toNumber(req.body.amount);
    if (!amount) throw badRequest('Nominal wajib diisi.');
    const description = (req.body.description || '').trim();
    if (!description) throw badRequest('Keperluan wajib diisi.');

    const r = store.insert('procRequests', {
      number: nextNumber(),
      userId: req.user.id,
      typeId: type.id,
      categoryId: category.id,
      projectId: project?.id || null,
      amount,
      description,
      notes: (req.body.notes || '').trim(),
      neededBy: isDate(req.body.neededBy) ? req.body.neededBy : null,
      attachments: (req.files || []).map((f) => `/uploads/${f.filename}`),
      transfers: [],
      status: 'pending',
    });
    const owners = store.filter('users', (u) => u.role === 'owner' && u.active);
    const text = `🛒 ${r.number} · Pengajuan ${type.name.toLowerCase()} ${rupiah(amount)}\n${req.user.name}${project ? ` — ${project.code}` : ''}\n${description}`;
    owners.forEach((o) => notify(config, o.id, text));
    notify(config, config.notifyChatId, text);
    res.redirect(`/proc/${r.id}?ok=Pengajuan terkirim`);
  });

  // --- Kelola jenis & kategori ----------------------------------------------

  const listEditor = (collection, view, label) => {
    router.get(`/${view}`, need('proc.configure'), (req, res) => {
      res.render('procurement/options', { collection, view, label, rows: store.all(collection) });
    });
    router.post(`/${view}`, need('proc.configure'), (req, res) => {
      const name = (req.body.name || '').trim();
      if (!name) throw badRequest('Nama wajib diisi.');
      if (store.find(collection, (x) => x.name.toLowerCase() === name.toLowerCase())) throw badRequest(`${label} "${name}" sudah ada.`);
      const doc = { name, active: true };
      if (collection === 'procCategories') doc.requiresProject = req.body.requiresProject === '1';
      store.insert(collection, doc);
      res.redirect(`/proc/${view}?ok=${encodeURIComponent(name)} ditambahkan`);
    });
    router.post(`/${view}/:id`, need('proc.configure'), (req, res, next) => {
      const row = store.find(collection, (x) => x.id === req.params.id);
      if (!row) return next();
      const patch = {};
      if (req.body.name?.trim()) patch.name = req.body.name.trim();
      if (req.body.active !== undefined) patch.active = req.body.active === '1';
      if (collection === 'procCategories' && req.body.requiresProject !== undefined) patch.requiresProject = req.body.requiresProject === '1';
      store.update(collection, row.id, patch);
      res.redirect(`/proc/${view}?ok=Tersimpan`);
    });
  };
  listEditor('procTypes', 'jenis', 'Jenis pengajuan');
  listEditor('procCategories', 'kategori', 'Kategori tujuan');

  // --- Detail & alur ---------------------------------------------------------

  const load = (req) => {
    const r = store.find('procRequests', (x) => x.id === req.params.id);
    return r && (r.userId === req.user.id || req.can('proc.viewAll')) ? r : null;
  };

  router.get('/:id', (req, res, next) => {
    const r = load(req);
    if (!r) return next();
    res.render('procurement/show', {
      r: decorate(r),
      transfers: (r.transfers || []).map((t) => ({ ...t, byName: userName(t.by) })),
      approverName: r.approval ? userName(r.approval.by) : null,
      pettyBalance: pettySummary(store, null).balance,
      today: todayKey(),
    });
  });

  router.post('/:id/:action(approve|reject)', need('proc.approve'), (req, res, next) => {
    const r = load(req);
    if (!r) return next();
    if (r.status !== 'pending') throw badRequest('Pengajuan ini sudah diproses.');
    const approve = req.params.action === 'approve';
    const amount = approve ? toNumber(req.body.amount) || r.amount : 0;
    store.update('procRequests', r.id, {
      status: approve ? 'approved' : 'rejected',
      approval: { by: req.user.id, at: new Date().toISOString(), amount, note: (req.body.note || '').trim() },
    });
    notify(config, r.userId, `${r.number} ${approve ? `✅ disetujui ${rupiah(amount)}, menunggu transfer` : '❌ ditolak'}${req.body.note ? `\n${req.body.note}` : ''}`);
    const ok = `ok=Pengajuan ${approve ? 'disetujui' : 'ditolak'}`;
    res.redirect(req.body.back === 'approval' ? `/kas?tab=approval&${ok}` : `/proc/${r.id}?${ok}`);
  });

  // Transfer + bukti. Also used to pay a shortfall after the report shows the requester overspent.
  router.post('/:id/transfer', need('kas.manage'), upload.single('proof'), (req, res, next) => {
    const r = load(req);
    if (!r) return next();
    const shortfall = r.status === 'closed' && outstanding(store, r) < 0;
    if (r.status !== 'approved' && r.status !== 'transferred' && !shortfall) throw badRequest('Pengajuan ini belum disetujui atau sudah selesai.');
    const amount = toNumber(req.body.amount);
    if (!amount) throw badRequest('Nominal transfer wajib diisi.');
    if (!isDate(req.body.date)) throw badRequest('Tanggal transfer wajib diisi.');
    if (!SOURCES[req.body.source]) throw badRequest('Pilih sumber pembayaran.');
    if (!req.file) throw badRequest('Lampirkan bukti transfer.');
    if (req.body.source === 'petty') {
      const balance = pettySummary(store, null).balance;
      if (amount > balance) throw badRequest(`Saldo Petty Cash tidak cukup (${rupiah(balance)}).`);
    }
    const transfer = {
      id: crypto.randomUUID(),
      amount,
      date: req.body.date,
      source: req.body.source,
      proof: `/uploads/${req.file.filename}`,
      note: (req.body.note || '').trim(),
      by: req.user.id,
      at: new Date().toISOString(),
    };
    store.update('procRequests', r.id, {
      transfers: [...(r.transfers || []), transfer],
      status: r.status === 'closed' ? 'closed' : 'transferred',
    });
    notify(config, r.userId, `💸 ${r.number}: dana ${rupiah(amount)} sudah ditransfer (${SOURCES[transfer.source]}). Setelah dipakai, tutup dengan laporan dan foto bukti.`);
    res.redirect(`/proc/${r.id}?ok=Transfer tercatat`);
  });

  router.post('/:id/laporan', upload.array('photos', 8), (req, res, next) => {
    const r = load(req);
    if (!r) return next();
    if (r.userId !== req.user.id) throw badRequest('Hanya pengaju yang bisa membuat laporan.');
    if (r.status !== 'transferred') throw badRequest('Laporan dibuat setelah dana ditransfer.');
    const actual = toNumber(req.body.actualAmount);
    if (!actual) throw badRequest('Nominal terpakai wajib diisi.');
    const photos = (req.files || []).map((f) => `/uploads/${f.filename}`);
    if (!photos.length) throw badRequest('Lampirkan minimal satu foto bukti.');
    store.update('procRequests', r.id, {
      status: 'closed',
      report: { actualAmount: actual, note: (req.body.note || '').trim(), photos, by: req.user.id, at: new Date().toISOString() },
    });
    const diff = transferred(r) - actual;
    notify(
      config,
      config.notifyChatId,
      `🧾 Laporan Close ${r.number} · ${req.user.name}: terpakai ${rupiah(actual)}${diff ? ` (${diff > 0 ? 'sisa' : 'kurang'} ${rupiah(Math.abs(diff))})` : ''}`
    );
    res.redirect(`/proc/${r.id}?ok=Laporan ditutup`);
  });

  return router;
};
