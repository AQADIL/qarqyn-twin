import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { datasetSchema, ownerCredentialsSchema, parse } from './schema.js';

export const digest = (v) => createHash('sha256').update(v).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, value) {
  const [salt, expected] = value.split(':');
  if (!salt || !/^[a-f0-9]{128}$/.test(expected || '')) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(password, salt, 64));
}
export function transaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
export function writeAudit(db, actor, action, entity, detail = '') {
  db.prepare('INSERT INTO audit(actor,action,entity_id,detail,created_at) VALUES (?,?,?,?,?)').run(
    actor,
    action,
    entity,
    detail,
    new Date().toISOString()
  );
}
export function recordDatasetVersion(db, id, actor) {
  const row = db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
  db.prepare(
    'INSERT OR IGNORE INTO dataset_versions(dataset_id,version,name,payload,actor,created_at) VALUES (?,?,?,?,?,?)'
  ).run(row.id, row.version, row.name, row.payload, actor, new Date().toISOString());
}
function migrate(db) {
  const migrations = [
    `CREATE TABLE IF NOT EXISTS user_settings(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)));
     CREATE TABLE IF NOT EXISTS dataset_versions(dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,version INTEGER NOT NULL,name TEXT NOT NULL,payload TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(dataset_id,version));
     INSERT OR IGNORE INTO dataset_versions SELECT id,version,name,payload,'migration',created_at FROM datasets;`,
    `CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,title TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS chat_messages(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,request_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),state TEXT NOT NULL CHECK(state IN ('pending','completed','failed','cancelled')),payload TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
     CREATE INDEX IF NOT EXISTS conversation_owner_dataset ON conversations(owner_id,dataset_id,updated_at);
     CREATE INDEX IF NOT EXISTS message_conversation ON chat_messages(conversation_id,created_at);
     CREATE TABLE IF NOT EXISTS ai_reconciliations(request_id TEXT PRIMARY KEY REFERENCES ai_usage(id),actor TEXT NOT NULL,outcome TEXT NOT NULL,note TEXT NOT NULL,previous_cost REAL NOT NULL,created_at TEXT NOT NULL);`,
    `CREATE TABLE engineering_studies(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,owner_id TEXT NOT NULL REFERENCES users(id),kind TEXT NOT NULL CHECK(kind IN ('flow','action')),payload TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
     CREATE INDEX engineering_study_owner ON engineering_studies(dataset_id,owner_id,kind);
     CREATE TABLE engineering_dispatches(study_id TEXT NOT NULL REFERENCES engineering_studies(id) ON DELETE CASCADE,study_version INTEGER NOT NULL,incident_ids TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(study_id,study_version));`
  ];
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)'
  );
  const current = db
    .prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations')
    .get().version;
  if (current > migrations.length)
    throw new Error('Database schema is newer than this application.');
  for (let index = current; index < migrations.length; index++)
    transaction(db, () => {
      db.exec(migrations[index]);
      db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(
        index + 1,
        new Date().toISOString()
      );
      db.exec(`PRAGMA user_version=${index + 1}`);
    });
}
export function openDatabase(path, config) {
  const credentials = parse(ownerCredentialsSchema, {
    username: config.adminUsername,
    password: config.adminPassword
  });
  config.adminUsername = credentials.username;
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.function('fold_text', { deterministic: true }, (value) =>
    String(value ?? '').toLocaleLowerCase('ru-RU')
  );
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')));
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS datasets (id TEXT PRIMARY KEY, name TEXT NOT NULL, payload TEXT NOT NULL, owner_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, seed INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS incidents (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS scenarios (id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE, owner_id TEXT NOT NULL, payload TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, entity_id TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ai_usage (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, model TEXT NOT NULL, state TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER, cost_usd REAL NOT NULL, created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);
    CREATE INDEX IF NOT EXISTS incident_dataset ON incidents(dataset_id);
    CREATE INDEX IF NOT EXISTS scenario_dataset ON scenarios(dataset_id);`);
  migrate(db);
  const owner = db.prepare("SELECT * FROM users WHERE id='owner'").get();
  const sameUsername = db
    .prepare('SELECT id FROM users WHERE username=?')
    .get(config.adminUsername);
  if (sameUsername && sameUsername.id !== 'owner') {
    db.close();
    throw new Error('ADMIN_USERNAME is already assigned to another account.');
  }
  if (!owner) {
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
      'owner',
      config.adminUsername,
      hashPassword(config.adminPassword),
      'admin'
    );
  } else if (
    owner.username !== config.adminUsername ||
    !checkPassword(config.adminPassword, owner.password_hash) ||
    owner.role !== 'admin'
  ) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare("UPDATE users SET username=?,password_hash=?,role='admin' WHERE id='owner'").run(
        config.adminUsername,
        hashPassword(config.adminPassword)
      );
      db.prepare("DELETE FROM sessions WHERE user_id='owner'").run();
      db.prepare(
        'INSERT INTO audit(actor,action,entity_id,detail,created_at) VALUES (?,?,?,?,?)'
      ).run(
        'system',
        'owner.credentials_changed',
        'owner',
        'Configured owner credentials updated; existing sessions revoked.',
        new Date().toISOString()
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
  }
  if (!db.prepare('SELECT id FROM datasets WHERE id=?').get('allur')) {
    const source = parse(
      datasetSchema,
      JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'))
    );
    db.prepare(
      'INSERT INTO datasets (id,name,payload,owner_id,seed,created_at) VALUES (?,?,?,?,1,?)'
    ).run('allur', source.name, JSON.stringify(source), 'owner', new Date().toISOString());
  }
  recordDatasetVersion(db, 'allur', 'system');
  db.prepare(
    "UPDATE chat_messages SET state='failed',payload=?,updated_at=? WHERE state='pending'"
  ).run(
    JSON.stringify({
      error: 'Сервер перезапущен до завершения ответа. Возможный расход сохранён для сверки.'
    }),
    new Date().toISOString()
  );
  return db;
}
