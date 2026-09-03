'use strict';

// Additive migrations for databases created before the current admin bundle.
// Never rebuild tables or replace existing user/content values.
const columns = {
  users: {
    email: 'TEXT', email_verified: 'INTEGER DEFAULT 0', avatar: 'TEXT',
    profile_url: 'TEXT', trade_link: 'TEXT', last_login_at: 'TEXT'
  },
  series: {
    sortOrder: 'INTEGER DEFAULT 0', description: 'TEXT', image: 'TEXT',
    titleImage: 'TEXT', isLimited: 'INTEGER DEFAULT 0', isSecret: 'INTEGER DEFAULT 0'
  }
};

async function ensureColumns({ all, run }, table) {
  const required = columns[table];
  if (!required) throw new Error('Unknown compatibility schema: ' + table);
  const read = async () => new Set((await all(`PRAGMA table_info(${table})`)).map(c => c.name.toLowerCase()));
  const existing = await read();
  if (!existing.size) throw new Error(`Missing base table: ${table}`);
  for (const [name, definition] of Object.entries(required)) {
    if (existing.has(name.toLowerCase())) continue;
    try {
      await run(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      // The website or another admin process may finish the same additive
      // migration while this connection waits for SQLite's schema lock.
      if (!/duplicate column name/i.test(error.message) || !(await read()).has(name.toLowerCase())) throw error;
    }
    existing.add(name.toLowerCase());
  }
}

module.exports = { ensureColumns };
