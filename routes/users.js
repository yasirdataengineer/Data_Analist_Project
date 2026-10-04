// User Admin / Management: add Telegram-registered employees, change roles, grant or revoke access.
// Admins may add and revoke karyawan; roles and anything touching other roles stay with the owner.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');
const { ROLES, COMPANIES } = require('../lib/access');

module.exports = ({ store, config }) => {
  const router = express.Router();

  const isOwnerFromEnv = (u) => config.ownerIds.includes(u.id);
  // What the current user may set another user's role to.
  const assignableRoles = (req) => (req.can('users.roles') ? Object.keys(ROLES) : ['karyawan']);
  const canEdit = (req, target) => {
    if (target.id === req.user.id || isOwnerFromEnv(target)) return false;
    return req.can('users.roles') || (target.role === 'karyawan' || !target.role);
  };

  router.get('/', (req, res) => {
    const users = store.all('users');
    const order = Object.keys(ROLES);
    res.render('users/index', {
      active: users.filter((u) => u.active).sort((a, b) => order.indexOf(a.role) - order.indexOf(b.role) || a.name.localeCompare(b.name)),
      revoked: users.filter((u) => !u.active && u.role),
      pending: users.filter((u) => !u.active && !u.role),
      canEdit: (u) => canEdit(req, u),
      assignable: assignableRoles(req),
      COMPANIES,
    });
  });

  router.get('/tambah', (req, res) => {
    res.render('users/add', {
      candidates: store.filter('users', (u) => !u.active).sort((a, b) => (b.lastSeenAt || '').localeCompare(a.lastSeenAt || '')),
      assignable: assignableRoles(req),
      COMPANIES,
    });
  });

  const applyAccess = (req, target, { role, company, active }) => {
    if (!canEdit(req, target)) throw badRequest('Anda tidak bisa mengubah akses pengguna ini.');
    if (role !== undefined && !assignableRoles(req).includes(role)) throw badRequest('Peran tidak valid atau hanya bisa diubah pemilik.');
    if (company !== undefined && !COMPANIES.includes(company)) throw badRequest('Perusahaan tidak valid.');
    const patch = {};
    if (role !== undefined) patch.role = role;
    if (company !== undefined) patch.company = company;
    if (active !== undefined) patch.active = active;
    return store.update('users', target.id, patch);
  };

  router.post('/', (req, res) => {
    const target = store.find('users', (u) => u.id === req.body.userId);
    if (!target) throw badRequest('Pilih karyawan yang sudah membuka bot.');
    const updated = applyAccess(req, target, { role: req.body.role, company: req.body.company, active: true });
    notify(config, updated.id, `✅ Akses TJP-EJS One Hub Anda sudah aktif sebagai <b>${ROLES[updated.role]}</b>.`);
    res.redirect(`/pengguna?ok=${encodeURIComponent(updated.name)} ditambahkan`);
  });

  router.post('/:id', (req, res, next) => {
    const target = store.find('users', (u) => u.id === req.params.id);
    if (!target) return next();
    const patch = {};
    if (req.body.role) patch.role = req.body.role;
    if (req.body.company) patch.company = req.body.company;
    if (req.body.active === '0') patch.active = false;
    if (req.body.active === '1') patch.active = true;
    const updated = applyAccess(req, target, patch);
    if (patch.active === false) notify(config, updated.id, 'Akses TJP-EJS One Hub Anda telah dicabut.');
    res.redirect(`/pengguna?ok=${encodeURIComponent(updated.name)} diperbarui`);
  });

  return router;
};
