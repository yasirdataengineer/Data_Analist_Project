// Presentation helpers for procurement requests, shared by /proc and /kas.
const { rupiah } = require('./dates');
const { transferred, outstanding } = require('./finance');

const STATUS = {
  pending: 'Menunggu persetujuan',
  approved: 'Disetujui · menunggu transfer',
  transferred: 'Ditransfer · menunggu laporan',
  closed: 'Laporan Close',
  rejected: 'Ditolak',
};

function decorateRequest(store, r) {
  const byId = (collection, id) => (id ? store.find(collection, (x) => x.id === id) : null);
  const project = byId('projects', r.projectId);
  const type = byId('procTypes', r.typeId);
  return {
    ...r,
    userName: byId('users', r.userId)?.name || '-',
    typeName: type?.name || '-',
    categoryName: byId('procCategories', r.categoryId)?.name || '-',
    projectLabel: project ? `${project.code} — ${project.name}` : null,
    headline: `Pengajuan ${(type?.name || '').toLowerCase()} · ${rupiah(r.amount)}`,
    transferredTotal: transferred(r),
    outstanding: outstanding(store, r),
  };
}

module.exports = { STATUS, decorateRequest };
