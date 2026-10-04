// Money rules shared by Proc & Res, Lap Pettycash and Cash Flow Project.
//
// - Only transfers paid from Petty Cash reduce the petty cash balance; transfers from
//   Rekening Induk TJP are still counted in the project's cash flow.
// - Arus kas proyek = penerimaan proyek − transfer pengeluaran proyek + pengembalian sisa.
// - Penerimaan proyek does not top up Petty Cash; a top-up is recorded separately ("Tambah saldo").

const SOURCES = { petty: 'Petty Cash', induk: 'Rekening Induk TJP' };

const sum = (xs, f = (x) => x) => xs.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const inPeriod = (date, period) => !period || (date || '').startsWith(period);

function transferred(r) {
  return sum(r.transfers || [], (t) => t.amount);
}

function refunded(store, r) {
  return sum(store.filter('pettyEntries', (e) => e.type === 'refund' && e.requestId === r.id), (e) => e.amount);
}

// Positive: money the requester still has to return. Negative: the company still owes them.
function outstanding(store, r) {
  if (!r.report) return 0;
  return transferred(r) - r.report.actualAmount - refunded(store, r);
}

// Signed petty cash movements, oldest first.
function pettyLedger(store) {
  const rows = store.all('pettyEntries').map((e) => ({
    id: e.id,
    date: e.date,
    type: e.type,
    amount: Number(e.amount),
    note: e.note || '',
    requestId: e.requestId || null,
    at: e.createdAt,
  }));
  for (const r of store.all('procRequests')) {
    for (const t of r.transfers || []) {
      if (t.source !== 'petty') continue;
      rows.push({ id: t.id, date: t.date, type: 'transfer', amount: -Number(t.amount), note: r.description, requestId: r.id, at: t.at });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || (a.at || '').localeCompare(b.at || ''));
}

function pettySummary(store, period) {
  const ledger = pettyLedger(store);
  const rows = ledger.filter((e) => inPeriod(e.date, period));
  return {
    balance: sum(ledger, (e) => e.amount),
    in: sum(rows.filter((e) => e.amount > 0), (e) => e.amount),
    out: -sum(rows.filter((e) => e.amount < 0), (e) => e.amount),
    hasOpening: ledger.some((e) => e.type === 'opening'),
    rows: rows.reverse(),
  };
}

// Per-project receipts, transfers out and refunds for a period (null = all time).
function projectMovements(store, projectId, period) {
  const rows = [];
  for (const rc of store.filter('projectReceipts', (x) => x.projectId === projectId && inPeriod(x.date, period))) {
    rows.push({ date: rc.date, kind: 'receipt', amount: Number(rc.amount), note: rc.note || 'Penerimaan project' });
  }
  for (const r of store.filter('procRequests', (x) => x.projectId === projectId)) {
    for (const t of r.transfers || []) {
      if (inPeriod(t.date, period)) rows.push({ date: t.date, kind: 'transfer', amount: -Number(t.amount), note: r.description, requestId: r.id, source: t.source });
    }
    for (const e of store.filter('pettyEntries', (x) => x.type === 'refund' && x.requestId === r.id && inPeriod(x.date, period))) {
      rows.push({ date: e.date, kind: 'refund', amount: Number(e.amount), note: `Pengembalian sisa · ${r.number}`, requestId: r.id });
    }
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

function projectCashflow(store, period) {
  return store.all('projects').map((p) => {
    const rows = projectMovements(store, p.id, period);
    const receipts = sum(rows.filter((r) => r.kind === 'receipt'), (r) => r.amount);
    const expenses = -sum(rows.filter((r) => r.kind === 'transfer'), (r) => r.amount);
    const refunds = sum(rows.filter((r) => r.kind === 'refund'), (r) => r.amount);
    return { project: p, receipts, expenses, refunds, net: receipts - expenses + refunds };
  });
}

module.exports = { SOURCES, sum, inPeriod, transferred, refunded, outstanding, pettyLedger, pettySummary, projectMovements, projectCashflow };
