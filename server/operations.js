import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { dirname, resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { transaction, writeAudit } from './db.js';
import { fail } from './schema.js';

const backupPattern = /^qarqyn-[\dT_-]+-[a-f0-9-]+\.sqlite$/;
export function verifyDatabase(path) {
  const check = new DatabaseSync(path, { readOnly: true });
  try {
    const results = check.prepare('PRAGMA integrity_check').all();
    if (results.length !== 1 || Object.values(results[0])[0] !== 'ok')
      throw new Error('Database integrity check failed.');
    if (
      !check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='datasets'").get()
    )
      throw new Error('Not a QARQYN database.');
    return { valid: true, schemaVersion: check.prepare('PRAGMA user_version').get().user_version };
  } finally {
    check.close();
  }
}

export function snapshotDatabase(db, destination) {
  const path = resolve(destination);
  if (existsSync(path))
    throw new Error('Destination already exists; existing databases are never overwritten.');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.partial`;
  try {
    db.prepare('VACUUM INTO ?').run(temporary);
    verifyDatabase(temporary);
    renameSync(temporary, path);
    return {
      name: basename(path),
      bytes: statSync(path).size,
      createdAt: new Date().toISOString()
    };
  } catch (error) {
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}

export function createOperations(db, config, assistant) {
  const file = db
    .prepare('PRAGMA database_list')
    .all()
    .find((row) => row.name === 'main')?.file;
  const folder = config.backupDir
    ? resolve(config.backupDir)
    : file
      ? resolve(dirname(file), 'backups')
      : null;
  const retention = {
    auditDays: config.auditRetentionDays || 0,
    chatDays: config.chatRetentionDays || 0,
    backupKeepCount: config.backupKeepCount || 0
  };
  function backups() {
    if (!folder || !existsSync(folder)) return [];
    return readdirSync(folder)
      .filter((name) => backupPattern.test(name))
      .map((name) => {
        const info = statSync(resolve(folder, name));
        return { name, bytes: info.size, createdAt: info.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  }
  function ready() {
    try {
      db.prepare('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1').get();
      if (config.clientBuildPath && !existsSync(config.clientBuildPath)) return false;
      db.exec('SAVEPOINT readiness_probe');
      try {
        db.prepare(
          'UPDATE schema_migrations SET applied_at=applied_at WHERE version=(SELECT MAX(version) FROM schema_migrations)'
        ).run();
      } finally {
        db.exec('ROLLBACK TO readiness_probe; RELEASE readiness_probe');
      }
      return true;
    } catch {
      return false;
    }
  }
  function unresolved() {
    return db
      .prepare(
        "SELECT id,user_id AS userId,model,state,cost_usd AS reservedUsd,created_at AS createdAt FROM ai_usage WHERE state IN ('reserved','uncertain') ORDER BY created_at DESC"
      )
      .all()
      .map((row) => ({ ...row, active: assistant.isActive(row.id) }));
  }
  function status() {
    const list = backups();
    return {
      database: {
        ready: ready(),
        journalMode: db.prepare('PRAGMA journal_mode').get().journal_mode,
        schemaVersion: db.prepare('PRAGMA user_version').get().user_version,
        bytes: file && existsSync(file) ? statSync(file).size : 0
      },
      runtime: {
        nodeVersion: process.version,
        uptimeSeconds: Math.floor(process.uptime()),
        production: Boolean(config.production),
        proxyConfigured: Boolean(config.trustProxy?.length)
      },
      backups: {
        enabled: Boolean(folder),
        count: list.length,
        latestAt: list[0]?.createdAt || null
      },
      retention,
      ai: {
        available: assistant.available(),
        budget: assistant.budget(),
        unresolvedReservations: unresolved().length
      },
      restoreMode: 'offline-cli'
    };
  }
  function backup(actor) {
    if (!folder) fail(409, 'Резервная копия недоступна для базы в памяти.');
    const name = `qarqyn-${new Date().toISOString().replace(/[:.Z]/g, '_')}-${randomUUID()}.sqlite`;
    const result = snapshotDatabase(db, resolve(folder, name));
    try {
      writeAudit(db, actor, 'database.backup', name);
    } catch (error) {
      unlinkSync(resolve(folder, name));
      throw error;
    }
    return { ok: true, ...result };
  }
  function retain(actor) {
    const removed = transaction(db, () => {
      const result = {
        sessions: Number(
          db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()).changes
        ),
        audit: 0,
        conversations: 0,
        backups: 0
      };
      if (retention.auditDays > 0)
        result.audit = Number(
          db
            .prepare('DELETE FROM audit WHERE created_at<?')
            .run(new Date(Date.now() - retention.auditDays * 86400000).toISOString()).changes
        );
      if (retention.chatDays > 0)
        result.conversations = Number(
          db
            .prepare(
              "DELETE FROM conversations WHERE updated_at<? AND NOT EXISTS (SELECT 1 FROM chat_messages WHERE conversation_id=conversations.id AND state='pending')"
            )
            .run(new Date(Date.now() - retention.chatDays * 86400000).toISOString()).changes
        );
      writeAudit(db, actor, 'database.retention.records', 'system', JSON.stringify(result));
      return result;
    });
    if (retention.backupKeepCount > 0)
      for (const item of backups().slice(retention.backupKeepCount)) {
        writeAudit(db, actor, 'database.retention.backup_requested', item.name);
        try {
          unlinkSync(resolve(folder, item.name));
          removed.backups++;
          writeAudit(db, actor, 'database.retention.backup_deleted', item.name);
        } catch (error) {
          writeAudit(
            db,
            actor,
            'database.retention.backup_failed',
            item.name,
            JSON.stringify({ removedBackups: removed.backups, code: error.code || 'audit_failure' })
          );
          fail(
            500,
            `Не удалось завершить очистку резервных копий. Удалено: ${removed.backups}. Подробности в журнале.`
          );
        }
      }
    writeAudit(db, actor, 'database.retention.complete', 'system', JSON.stringify(removed));
    return removed;
  }
  function reconcile(id, body, actor) {
    if (assistant.isActive(id)) fail(409, 'Запрос ещё выполняется.');
    return transaction(db, () => {
      const entry = db
        .prepare("SELECT * FROM ai_usage WHERE id=? AND state IN ('reserved','uncertain')")
        .get(id);
      if (!entry) fail(409, 'Резерв уже сверён или не найден.');
      const cost = body.outcome === 'not_charged' ? 0 : body.costUsd;
      if (!Number.isFinite(cost) || cost < 0 || cost > 1000)
        fail(422, 'Укажите подтверждённую стоимость от 0 до 1000 USD.');
      db.prepare('INSERT INTO ai_reconciliations VALUES (?,?,?,?,?,?)').run(
        id,
        actor,
        body.outcome,
        body.note,
        entry.cost_usd,
        new Date().toISOString()
      );
      db.prepare("UPDATE ai_usage SET state='reconciled',cost_usd=? WHERE id=?").run(cost, id);
      writeAudit(
        db,
        actor,
        'assistant.reconcile',
        id,
        JSON.stringify({ outcome: body.outcome, costUsd: cost, note: body.note })
      );
      return { ok: true, budget: assistant.budget() };
    });
  }
  return { ready, status, backups, backup, retain, unresolved, reconcile };
}
