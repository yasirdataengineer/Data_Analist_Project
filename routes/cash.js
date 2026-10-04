// Petty Cash & Cash Flow Project: Lap Pettycash, Approval & Transfer, Cash Flow Project.
const express = require('express');
const { badRequest } = require('../lib/errors');
const { todayKey, monthKey, rupiah } = require('../lib/dates');
const { SOURCES, pettySummary, outstanding, projectCashflow, projectMovements } = require('../lib/finance');
const { STATUS, decorateRequest } = require('../lib/requests');

const TABS = ['petty', 'approval', 'cashflow'];
const toNumber = (v) => Number(String(v ?? '').replace(/[^\d]/g, '')) || 0;
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || '');

module.exports = ({ store, config, need, notifier }) => {
  const router = express.Router();

  // ?periode=YYYY-MM, or "semua" for all time. Defaults to this month.
  const pickPeriod = (q) => (q === 'semua' ? null : /^\d{4}-\d{2}$/.test(q || '') ? q : monthKey());
  const refundable = () =>
    store
      .filter('procRequests', (r) => r.status === 'closed' && outstanding(store, r) > 0)
      .map((r) => decorateRequest(store, r));

  router.get('/', (req, res) => {
    const tab = TABS.includes(req.query.tab) ? req.query.tab : 'petty';
    const period = pickPeriod(req.query.periode);
    const locals = { tab, period, STATUS, SOURCES, pendingTransfers: store.filter('procRequests', (r) => r.status === 'approved').length };

    if (tab === 'petty') {
      const summary = pettySummary(store, period);
      const reqLabel = (id) => store.find('procRequests', (r) => r.id === id)?.number || '';
      Object.assign(locals, { summary, rows: summary.rows.map((e) => ({ ...e, requestNumber: reqLabel(e.requestId) })), refundable: refundable() });
    } else if (tab === 'approval') {
      const order = ['pending', 'approved', 'transferred', 'closed', 'rejected'];
      const rows = store
        .all('procRequests')
        .filter((r) => ['pending', 'approved'].includes(r.status) || !period || r.createdAt.startsWith(period) || (r.transfers || []).some((t) => t.date.startsWith(period)))
        .sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || b.createdAt.localeCompare(a.createdAt))
        .map((r) => decorateRequest(store, r));
      Object.assign(locals, { rows });
    } else {
      const projectId = req.query.project || '';
      const project = projectId && store.find('projects', (p) => p.id === projectId);
      Object.assign(locals, {
        flows: projectCashflow(store, period),
        projects: store.all('projects'),
        project,
        movements: project ? projectMovements(store, project.id, period) : [],
      });
    }
    res.render('cash/index', locals);
  });

  // --- Petty Cash -----------------------------------------------------------

  const entryForm = (type) => (req, res) => {
    const view = { opening: 'Input saldo awal', topup: 'Tambah saldo', refund: 'Catat pengembalian sisa' }[type];
    res.render('cash/entry', { type, heading: view, today: todayKey(), query: req.query, refundable: type === 'refund' ? refundable() : [] });
  };
  router.get('/saldo-awal', need('kas.manage'), entryForm('opening'));
  router.get('/tambah-saldo', need('kas.manage'), entryForm('topup'));
  router.get('/pengembalian', need('kas.manage'), entryForm('refund'));

  router.post('/entry', need('kas.manage'), (req, res) => {
    const type = req.body.type;
    if (!['opening', 'topup', 'refund'].includes(type)) throw badRequest('Jenis transaksi tidak valid.');
    const amount = toNumber(req.body.amount);
    if (!amount) throw badRequest('Nominal wajib diisi.');
    if (!isDate(req.body.date)) throw badRequest('Tanggal wajib diisi.');
    const doc = { type, amount, date: req.body.date, note: (req.body.note || '').trim(), by: req.user.id };

    if (type === 'opening' && pettySummary(store, null).hasOpening) throw badRequest('Saldo awal sudah diinput.');
    if (type === 'refund') {
      const r = store.find('procRequests', (x) => x.id === req.body.requestId);
      if (!r) throw badRequest('Pilih pengajuan yang dikembalikan sisanya.');
      const left = outstanding(store, r);
      if (left <= 0) throw badRequest('Pengajuan ini tidak punya sisa dana.');
      if (amount > left) throw badRequest(`Pengembalian melebihi sisa dana (${rupiah(left)}).`);
      doc.requestId = r.id;
    }
    store.insert('pettyEntries', doc);
    notifier.group(`🏦 Petty Cash: ${{ opening: 'saldo awal', topup: 'tambah saldo', refund: 'pengembalian sisa' }[type]} ${rupiah(amount)}`);
    res.redirect(`/kas?tab=petty&ok=Tersimpan`);
  });

  // --- Cash Flow Project ----------------------------------------------------

  router.get('/project', need('kas.manage'), (req, res) => res.render('cash/project', {}));

  router.post('/project', need('kas.manage'), (req, res) => {
    const code = (req.body.code || '').trim().toUpperCase();
    const name = (req.body.name || '').trim();
    if (!code || !name) throw badRequest('Kode dan nama project wajib diisi.');
    if (store.find('projects', (p) => p.code === code)) throw badRequest(`Kode ${code} sudah dipakai.`);
    const p = store.insert('projects', {
      code,
      name,
      client: (req.body.client || '').trim(),
      contractValue: toNumber(req.body.contractValue) || null,
      createdBy: req.user.id,
    });
    res.redirect(`/kas?tab=cashflow&periode=semua&project=${p.id}&ok=Project ${code} dibuat`);
  });

  router.get('/penerimaan', need('kas.manage'), (req, res) => {
    res.render('cash/receipt', { projects: store.all('projects'), today: todayKey(), selected: req.query.project || '' });
  });

  router.post('/penerimaan', need('kas.manage'), (req, res) => {
    const p = store.find('projects', (x) => x.id === req.body.projectId);
    if (!p) throw badRequest('Pilih project.');
    const amount = toNumber(req.body.amount);
    if (!amount) throw badRequest('Nominal wajib diisi.');
    if (!isDate(req.body.date)) throw badRequest('Tanggal wajib diisi.');
    store.insert('projectReceipts', { projectId: p.id, amount, date: req.body.date, note: (req.body.note || '').trim(), by: req.user.id });
    res.redirect(`/kas?tab=cashflow&periode=${req.body.date.slice(0, 7)}&project=${p.id}&ok=Penerimaan tercatat`);
  });

  return router;
};
