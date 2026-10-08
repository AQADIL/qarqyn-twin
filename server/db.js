import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { datasetSchema, parse } from './schema.js';

export const digest = (v) => createHash('sha256').update(v).digest('hex');
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, value) {
  const [salt, expected] = value.split(':');
  return timingSafeEqual(Buffer.from(expected, 'hex'), scryptSync(password, salt, 64));
}
export function openDatabase(path, config) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
  if (!db.prepare('SELECT id FROM users WHERE username=?').get(config.adminUsername))
    db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(
      'owner',
      config.adminUsername,
      hashPassword(config.adminPassword),
      'admin'
    );
  if (!db.prepare('SELECT id FROM datasets WHERE id=?').get('allur')) {
    const source = parse(
      datasetSchema,
      JSON.parse(readFileSync(new URL('../data/allur.json', import.meta.url), 'utf8'))
    );
    db.prepare(
      'INSERT INTO datasets (id,name,payload,owner_id,seed,created_at) VALUES (?,?,?,?,1,?)'
    ).run('allur', source.name, JSON.stringify(source), 'owner', new Date().toISOString());
  }
  return db;
}
