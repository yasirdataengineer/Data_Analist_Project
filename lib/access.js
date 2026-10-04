// Roles and what each may do. Mirrors the rules shown on the User Admin page:
// - Admin: Payroll, Proc & Res, Petty Cash, Cash Flow Project, user management. No Sistem Absensi.
// - Management: read-only reports for absensi, progres, pengajuan, Petty Cash, arus kas proyek.
// - Approving pengajuan, changing user roles and bot settings stay with the owner (pemilik).

const ROLES = {
  owner: 'Pemilik',
  admin: 'Admin',
  management: 'Management',
  karyawan: 'Karyawan',
};

const COMPANIES = ['TJP', 'EJS'];

const PERMISSIONS = {
  'progress.view': ['owner', 'management', 'karyawan'],
  'progress.viewAll': ['owner', 'management'],
  'progress.assign': ['owner'],

  'attendance.self': ['karyawan'],
  'attendance.report': ['owner', 'management'],

  'payroll.self': ['karyawan'],
  'payroll.manage': ['owner', 'admin'],

  'proc.request': ['owner', 'admin', 'karyawan'],
  'proc.viewAll': ['owner', 'admin', 'management'],
  'proc.approve': ['owner'],
  'proc.configure': ['owner', 'admin'],

  'kas.view': ['owner', 'admin', 'management'],
  'kas.manage': ['owner', 'admin'],

  'users.manage': ['owner', 'admin'],
  'users.roles': ['owner'],
};

function can(user, permission) {
  if (!user || !user.active) return false;
  const allowed = PERMISSIONS[permission];
  if (!allowed) throw new Error(`Unknown permission: ${permission}`);
  return allowed.includes(user.role);
}

module.exports = { ROLES, COMPANIES, PERMISSIONS, can };
