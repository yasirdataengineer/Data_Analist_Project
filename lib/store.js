// Simple JSON-file store. Good enough for a small team; swap for a real DB later.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const EMPTY = () => ({
  users: [],
  projects: [],
  assignments: [],
  assignmentUpdates: [],
  attendance: [],
  workPlans: [],
  dailyReports: [],
  overtime: [],
  salaries: [],
  overtimeCorrections: [],
  cashAdvances: [],
  payrolls: [],
  procRequests: [],
  procTypes: [],
  procCategories: [],
  pettyEntries: [],
  projectReceipts: [],
});

class Store {
  constructor(file) {
    this.file = file;
    this.data = EMPTY();
    if (file && fs.existsSync(file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  all(collection) {
    return this.data[collection];
  }

  find(collection, predicate) {
    return this.data[collection].find(predicate);
  }

  filter(collection, predicate) {
    return this.data[collection].filter(predicate);
  }

  insert(collection, doc) {
    const row = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...doc };
    this.data[collection].push(row);
    this.save();
    return row;
  }

  update(collection, id, patch) {
    const row = this.data[collection].find((r) => r.id === id);
    if (!row) return null;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
    this.save();
    return row;
  }

  // Anyone who opens the Mini App gets a record; access stays off until the owner/admin adds them.
  upsertUser(tgUser) {
    const id = String(tgUser.id);
    const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || tgUser.username || id;
    const now = new Date().toISOString();
    let user = this.find('users', (u) => u.id === id);
    if (user) {
      Object.assign(user, { name, username: tgUser.username || null, lastSeenAt: now });
    } else {
      user = { id, name, username: tgUser.username || null, role: null, company: null, active: false, createdAt: now, lastSeenAt: now };
      this.data.users.push(user);
    }
    this.save();
    return user;
  }
}

module.exports = { Store };
