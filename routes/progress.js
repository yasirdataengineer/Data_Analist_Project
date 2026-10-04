// Monitoring Progres: project percentage, latest photos, and PIC update history.
const express = require('express');
const { notify } = require('../lib/telegram');
const { badRequest } = require('../lib/errors');

module.exports = ({ store, upload, config, isAdmin }) => {
  const router = express.Router();

  const userName = (id) => store.find('users', (u) => u.id === id)?.name || '-';

  const summarize = (project) => {
    const updates = store
      .filter('progressUpdates', (u) => u.projectId === project.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latestPhoto = updates.flatMap((u) => u.photos || [])[0] || null;
    return { ...project, picName: userName(project.picId), updates, latestPhoto, lastUpdate: updates[0] || null };
  };

  router.get('/', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const projects = store
      .all('projects')
      .filter((p) => !q || `${p.code} ${p.name} ${p.location}`.toLowerCase().includes(q))
      .map(summarize)
      .sort((a, b) => (b.lastUpdate?.createdAt || b.createdAt).localeCompare(a.lastUpdate?.createdAt || a.createdAt));
    const avg = projects.length ? Math.round(projects.reduce((s, p) => s + p.progress, 0) / projects.length) : 0;
    res.render('progress/index', { projects, avg, q: req.query.q || '' });
  });

  router.get('/baru', (req, res) => res.render('progress/form', { users: store.all('users') }));

  router.post('/', (req, res) => {
    const { code, name, location, picId, target } = req.body;
    if (!name?.trim()) throw badRequest('Nama proyek wajib diisi.');
    const project = store.insert('projects', {
      code: (code || '').trim(),
      name: name.trim(),
      location: (location || '').trim(),
      picId: picId || req.user.id,
      target: target || null,
      progress: 0,
      createdBy: req.user.id,
    });
    res.redirect(`/progres/${project.id}?ok=Proyek dibuat`);
  });

  router.get('/:id', (req, res, next) => {
    const project = store.find('projects', (p) => p.id === req.params.id);
    if (!project) return next();
    const p = summarize(project);
    const history = p.updates.map((u) => ({ ...u, authorName: userName(u.authorId) }));
    const photos = p.updates.flatMap((u) => (u.photos || []).map((src) => ({ src, at: u.createdAt })));
    res.render('progress/show', { project: p, history, photos });
  });

  router.post('/:id/update', upload.array('photos', 6), (req, res, next) => {
    const project = store.find('projects', (p) => p.id === req.params.id);
    if (!project) return next();
    if (project.picId !== req.user.id && !isAdmin(req.user)) throw badRequest('Hanya PIC atau admin yang bisa update.');

    const progress = Number(req.body.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) throw badRequest('Persentase harus 0–100.');
    const photos = (req.files || []).map((f) => `/uploads/${f.filename}`);

    store.insert('progressUpdates', {
      projectId: project.id,
      authorId: req.user.id,
      from: project.progress,
      to: Math.round(progress),
      note: (req.body.note || '').trim(),
      photos,
    });
    store.update('projects', project.id, { progress: Math.round(progress) });

    notify(
      config,
      config.notifyChatId,
      `📈 <b>${project.name}</b>: ${project.progress}% → ${Math.round(progress)}%\nPIC: ${req.user.name}${req.body.note ? `\n${req.body.note}` : ''}`
    );
    res.redirect(`/progres/${project.id}?ok=Progres tersimpan`);
  });

  return router;
};
