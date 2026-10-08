import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analyze, simulate, optimize, planTarget } from './analytics.js';
import {
  digest,
  checkPassword,
  hashPassword,
  transaction,
  writeAudit,
  recordDatasetVersion
} from './db.js';
import { createOperations } from './operations.js';
import { mountConversations } from './conversations.js';
import { assistantHistorySchema, createAssistant } from './ai.js';
import { forecast } from './forecast.js';
import { evaluateImpact, impactSchema } from './impact.js';
import { evaluatePilot, pilotSchema } from './pilot.js';
import {
  parse,
  fail,
  datasetSchema,
  simulationSchema,
  targetPlanSchema,
  scenarioSchema,
  incidentSchema,
  loginSchema,
  ownerCredentialsSchema,
  versionSchema,
  dateSchema
} from './schema.js';

const writeRoles = new Set(['admin', 'editor']);
const mutation = (req) => !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
const escapeCsv = (value) =>
  '"' +
  String(value ?? '')
    .replace(/^(?:[\u0000-\u0020]*[=+@-]|[\t\r\n])/, "'$&")
    .replaceAll('"', '""') +
  '"';

function importedSource(data) {
  const { sha256, ...source } = data.source;
  const normalized = { ...data, source: { ...source, kind: 'user-import' } };
  return {
    ...normalized,
    source: { ...normalized.source, sha256: digest(JSON.stringify(normalized)) }
  };
}

export function createApp(db, config) {
  const app = express();
  const assistant = createAssistant(db, config, config.aiFetcher);
  const operations = createOperations(db, config, assistant);
  app.locals.operations = operations;
  app.disable('x-powered-by');
  app.set('env', config.production ? 'production' : 'development');
  app.set('trust proxy', config.trustProxy?.length ? config.trustProxy : false);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set('X-Request-ID', req.requestId);
    const started = performance.now();
    res.on('finish', () => {
      if (!config.testing)
        (config.logger || console.log)(
          JSON.stringify({
            event: 'http.request',
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(performance.now() - started)
          })
        );
    });
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: config.production ? ["'self'"] : ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: config.production
            ? ["'self'"]
            : ["'self'", config.origin.replace(/^http/, 'ws')],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.secure ? [] : null
        }
      },
      strictTransportSecurity: config.secure ? undefined : false
    })
  );
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const expectedHost = new URL(config.origin).host;
    if (req.headers.host !== expectedHost && !config.testing)
      return res.status(421).json({ error: 'Недопустимый хост запроса' });
    if (mutation(req)) {
      if (req.get('origin') !== config.origin)
        return res.status(403).json({ error: 'Источник запроса не разрешён' });
      if (!req.is('application/json'))
        return res.status(415).json({ error: 'Требуется application/json' });
    }
    next();
  });
  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.testing ? 10000 : 240,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Слишком много запросов. Повторите через минуту.' }
    })
  );
  app.use(express.json({ limit: '2mb', strict: true }));
  const authLimit = rateLimit({
    windowMs: 15 * 60_000,
    limit: config.testing ? 10000 : 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Слишком много попыток входа. Повторите через 15 минут.' }
  });
  const dummyHash = hashPassword(randomBytes(32).toString('hex'));
  const cookieOptions = { httpOnly: true, sameSite: 'strict', secure: config.secure, path: '/' };
  function startSession(res, user) {
    const token = randomBytes(32).toString('base64url'),
      csrf = randomBytes(32).toString('base64url');
    db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    db.prepare('INSERT INTO sessions VALUES (?,?,?,?)').run(
      digest(token),
      user.id,
      csrf,
      Date.now() + config.sessionMs
    );
    res.cookie('qarqyn_session', token, { ...cookieOptions, maxAge: config.sessionMs });
    return { user, csrf };
  }
  app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
  app.get('/api/health/live', (req, res) => res.json({ status: 'alive' }));
  app.get('/api/health/ready', (req, res) => {
    const ready = operations.ready();
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'unavailable' });
  });
  app.post('/api/auth/login', authLimit, (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = db
      .prepare(
        'SELECT users.*,COALESCE(user_settings.disabled,0) AS disabled FROM users LEFT JOIN user_settings ON users.id=user_settings.user_id WHERE username=?'
      )
      .get(body.username);
    const valid = checkPassword(body.password, user?.password_hash || dummyHash);
    if (!user || !valid || user.disabled)
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    res.json(startSession(res, { id: user.id, username: user.username, role: user.role }));
  });
  app.post('/api/auth/demo', authLimit, (req, res) =>
    res.json(startSession(res, { id: 'demo', username: 'Гость', role: 'viewer' }))
  );
  app.use('/api', (req, res, next) => {
    const match = (req.headers.cookie || '').match(
      /(?:^|;\s*)qarqyn_session=([A-Za-z0-9_-]{43})(?:;|$)/
    );
    const session =
      match &&
      db
        .prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?')
        .get(digest(match[1]), Date.now());
    if (!session) return res.status(401).json({ error: 'Войдите в рабочее пространство' });
    const user =
      session.user_id === 'demo'
        ? { id: 'demo', username: 'Гость', role: 'viewer' }
        : db
            .prepare(
              'SELECT id,username,role FROM users WHERE id=? AND NOT EXISTS (SELECT 1 FROM user_settings WHERE user_id=users.id AND disabled=1)'
            )
            .get(session.user_id);
    if (!user) return res.status(401).json({ error: 'Сессия завершена' });
    if (mutation(req) && req.get('x-csrf-token') !== session.csrf)
      return res
        .status(403)
        .json({ error: 'Проверка безопасности не пройдена. Обновите страницу.' });
    req.user = user;
    req.session = session;
    next();
  });
  app.get('/api/session', (req, res) =>
    res.json({
      user: req.user,
      csrf: req.session.csrf,
      aiAvailable: assistant.available(),
      ai: writeRoles.has(req.user.role) ? assistant.budget() : null
    })
  );
  app.post('/api/auth/logout', (req, res) => {
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(req.session.token_hash);
    res.clearCookie('qarqyn_session', cookieOptions);
    res.json({ ok: true });
  });
  function audit(user, action, entity, detail = '') {
    writeAudit(db, user.username, action, entity, detail);
  }
  function admin(req) {
    if (req.user.role !== 'admin') fail(403, 'Нужен доступ администратора');
  }
  function page(req, sql, params = [], map = (row) => row) {
    const paged = req.query.page !== undefined || req.query.pageSize !== undefined;
    const values = parse(
      z.object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        pageSize: z.coerce
          .number()
          .int()
          .min(1)
          .max(200)
          .default(paged ? 50 : 200)
      }),
      req.query
    );
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM (${sql})`).get(...params).total);
    const items = db
      .prepare(`${sql} LIMIT ? OFFSET ?`)
      .all(...params, values.pageSize, (values.page - 1) * values.pageSize)
      .map(map);
    return paged ? { items, total, ...values } : items;
  }
  function writer(req) {
    if (!writeRoles.has(req.user.role)) fail(403, 'Для изменения данных нужен доступ редактора');
  }
  function dataset(req, id, write = false) {
    const d = db.prepare('SELECT * FROM datasets WHERE id=?').get(id);
    if (!d || (!d.seed && req.user.role !== 'admin' && d.owner_id !== req.user.id))
      fail(404, 'Набор данных не найден');
    if (write) {
      writer(req);
      if (d.seed) fail(409, 'Исходный набор защищён. Создайте рабочую копию.');
    }
    return { ...d, data: JSON.parse(d.payload) };
  }
  function editableEntity(req, table, id) {
    const entity = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!entity) fail(404, 'Запись не найдена');
    dataset(req, entity.dataset_id);
    writer(req);
    if (entity.owner_id !== req.user.id && req.user.role !== 'admin')
      fail(404, 'Запись не найдена');
    return entity;
  }
  const entityJson = (r) => ({
    id: r.id,
    datasetId: r.dataset_id,
    ...JSON.parse(r.payload),
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  });
  app.get('/api/datasets', (req, res) => {
    const rows =
      req.user.role === 'admin'
        ? db
            .prepare('SELECT id,name,version,seed,created_at FROM datasets ORDER BY created_at')
            .all()
        : db
            .prepare(
              'SELECT id,name,version,seed,created_at FROM datasets WHERE seed=1 OR owner_id=? ORDER BY created_at'
            )
            .all(req.user.id);
    res.json(rows);
  });
  app.get('/api/datasets/:id', (req, res) => {
    const d = dataset(req, req.params.id);
    res.json({ id: d.id, version: d.version, seed: d.seed, data: d.data });
  });
  app.post('/api/datasets/validate', (req, res) => {
    writer(req);
    const candidate = datasetSchema.safeParse(req.body?.data);
    if (!candidate.success)
      return res
        .status(422)
        .json({
          error: 'Исправьте ошибки в наборе данных',
          issues: candidate.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message
          }))
        });
    res.json({
      valid: true,
      summary: Object.fromEntries(
        ['production', 'quality', 'downtime', 'plans'].map((key) => [
          key,
          candidate.data[key].length
        ])
      )
    });
  });
  app.post('/api/datasets', (req, res) => {
    writer(req);
    const data = importedSource(parse(datasetSchema, req.body));
    const id = randomUUID();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO datasets(id,name,payload,owner_id,created_at) VALUES (?,?,?,?,?)'
      ).run(id, data.name, JSON.stringify(data), req.user.id, new Date().toISOString());
      audit(req.user, 'dataset.create', id, data.name);
      recordDatasetVersion(db, id, req.user.username);
    });
    res.status(201).json({ id, version: 1 });
  });
  app.put('/api/datasets/:id', (req, res) => {
    dataset(req, req.params.id, true);
    const body = parse(
      z.object({ version: versionSchema, data: datasetSchema }).strict(),
      req.body
    );
    const stageIds = new Set(body.data.stages.map((s) => s.id));
    const incidents = db
      .prepare('SELECT payload FROM incidents WHERE dataset_id=?')
      .all(req.params.id);
    if (
      incidents.some((r) => {
        const stageId = JSON.parse(r.payload).stageId;
        return stageId !== null && !stageIds.has(stageId);
      })
    )
      fail(
        422,
        'Нельзя удалить участок, на который ссылаются события. Сначала перенесите или удалите эти события.'
      );
    body.data = importedSource(body.data);
    transaction(db, () => {
      const change = db
        .prepare('UPDATE datasets SET name=?,payload=?,version=version+1 WHERE id=? AND version=?')
        .run(body.data.name, JSON.stringify(body.data), req.params.id, body.version);
      if (!change.changes) fail(409, 'Данные изменились. Обновите страницу перед сохранением.');
      audit(req.user, 'dataset.update', req.params.id);
      recordDatasetVersion(db, req.params.id, req.user.username);
    });
    res.json({ id: req.params.id, version: body.version + 1 });
  });
  app.delete('/api/datasets/:id', (req, res) => {
    dataset(req, req.params.id, true);
    const { version } = parse(z.object({ version: versionSchema }).strict(), req.body);
    transaction(db, () => {
      const result = db
        .prepare('DELETE FROM datasets WHERE id=? AND version=?')
        .run(req.params.id, version);
      if (!result.changes) fail(409, 'Данные изменились. Обновите страницу.');
      audit(req.user, 'dataset.delete', req.params.id);
    });
    res.json({ ok: true });
  });
  app.get('/api/datasets/:id/versions', (req, res) => {
    dataset(req, req.params.id);
    res.json(
      page(
        req,
        'SELECT version,name,created_at AS createdAt,actor FROM dataset_versions WHERE dataset_id=? ORDER BY version DESC',
        [req.params.id]
      )
    );
  });
  app.get('/api/datasets/:id/versions/:version', (req, res) => {
    dataset(req, req.params.id);
    const version = parse(z.coerce.number().int().positive(), req.params.version);
    const row = db
      .prepare('SELECT * FROM dataset_versions WHERE dataset_id=? AND version=?')
      .get(req.params.id, version);
    if (!row) fail(404, 'Версия не найдена');
    res.json({
      id: req.params.id,
      version,
      data: JSON.parse(row.payload),
      snapshot: true,
      createdAt: row.created_at
    });
  });
  app.post('/api/datasets/:id/restore', (req, res) => {
    const current = dataset(req, req.params.id, true);
    const body = parse(
      z.object({ version: versionSchema, restoreVersion: versionSchema }).strict(),
      req.body
    );
    if (body.version !== current.version) fail(409, 'Данные изменились. Обновите страницу.');
    const row = db
      .prepare('SELECT * FROM dataset_versions WHERE dataset_id=? AND version=?')
      .get(current.id, body.restoreVersion);
    if (!row) fail(404, 'Версия не найдена');
    const data = parse(datasetSchema, JSON.parse(row.payload));
    const stages = new Set(data.stages.map((s) => s.id));
    if (
      db
        .prepare('SELECT payload FROM incidents WHERE dataset_id=?')
        .all(current.id)
        .some((r) => {
          const s = JSON.parse(r.payload).stageId;
          return s !== null && !stages.has(s);
        })
    )
      fail(422, 'Историческая версия удалит участок, на который ссылаются события.');
    transaction(db, () => {
      const result = db
        .prepare('UPDATE datasets SET name=?,payload=?,version=version+1 WHERE id=? AND version=?')
        .run(data.name, JSON.stringify(data), current.id, body.version);
      if (!result.changes) fail(409, 'Данные изменились.');
      recordDatasetVersion(db, current.id, req.user.username);
      audit(
        req.user,
        'dataset.restore',
        current.id,
        `Версия ${body.restoreVersion} восстановлена как ${body.version + 1}`
      );
    });
    res.json({ id: current.id, version: body.version + 1 });
  });
  app.get('/api/analysis/:id', (req, res) => {
    const d = dataset(req, req.params.id);
    const date = req.query.date ? parse(dateSchema, req.query.date) : null;
    res.json({ ...analyze(d.data, date), datasetId: d.id, version: d.version, name: d.name });
  });
  const forecastCache = new Map();
  app.get('/api/forecast/:id', (req, res) => {
    const d = dataset(req, req.params.id);
    const key = `${d.id}:${d.version}`;
    if (!forecastCache.has(key)) {
      if (forecastCache.size >= 24) forecastCache.delete(forecastCache.keys().next().value);
      forecastCache.set(key, forecast(d.data));
    }
    res.json({ ...forecastCache.get(key), datasetId: d.id, datasetVersion: d.version });
  });
  app.post('/api/impact', (req, res) => {
    const input = parse(impactSchema, req.body);
    const d = dataset(req, input.datasetId);
    if (input.expectedDatasetVersion !== d.version)
      fail(409, 'Данные изменились. Обновите расчёт для текущей версии.');
    res.json({ ...evaluateImpact(d.data, input), datasetVersion: d.version });
  });
  app.post('/api/pilot', (req, res) => {
    const input = parse(pilotSchema, req.body),
      d = dataset(req, input.datasetId);
    if (input.expectedDatasetVersion !== d.version)
      fail(409, 'Данные изменились. Обновите расчёт.');
    res.json({ ...evaluatePilot(d.data, input), datasetVersion: d.version });
  });
  app.post('/api/simulate', (req, res) => {
    const input = parse(simulationSchema, req.body);
    const d = dataset(req, input.datasetId);
    res.json({ ...simulate(d.data, input), datasetVersion: d.version });
  });
  app.post('/api/optimize', (req, res) => {
    const body = parse(
      z
        .object({
          datasetId: z.string().max(64),
          hours: z.number().min(1).max(744),
          observationHours: z.number().min(1).max(24).default(8),
          date: dateSchema.optional()
        })
        .strict(),
      req.body
    );
    res.json(
      optimize(dataset(req, body.datasetId).data, body.hours, body.observationHours, body.date).map((r) => ({
        ...r,
        input: { ...r.input, datasetId: body.datasetId }
      }))
    );
  });
  app.post(
    '/api/plan-target',
    rateLimit({
      windowMs: 60_000,
      limit: config.testing ? 10000 : 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { error: 'Лимит обратного планирования: 30 расчётов в минуту' }
    }),
    (req, res) => {
      const body = parse(targetPlanSchema, req.body);
      const d = dataset(req, body.datasetId);
      res.json({ ...planTarget(d.data, body), datasetVersion: d.version });
    }
  );
  for (const table of ['incidents', 'scenarios']) {
    const schema = table === 'incidents' ? incidentSchema : scenarioSchema;
    app.get(`/api/${table}`, (req, res) => {
      const id = parse(z.string().min(1).max(64), req.query.datasetId);
      dataset(req, id);
      const params = [id];
      let where = 'dataset_id=?';
      if (req.user.role !== 'admin') {
        where += ' AND owner_id=?';
        params.push(req.user.id);
      }
      if (table === 'incidents' && req.query.status && req.query.status !== 'all') {
        where += " AND json_extract(payload,'$.status')=?";
        params.push(parse(z.enum(['open', 'investigating', 'resolved']), req.query.status));
      }
      if (req.query.q) {
        const q = parse(z.string().trim().max(160), req.query.q);
        where +=
          table === 'incidents'
            ? " AND instr(fold_text(json_extract(payload,'$.title') || ' ' || json_extract(payload,'$.description')),fold_text(?))>0"
            : " AND instr(fold_text(json_extract(payload,'$.name') || ' ' || json_extract(payload,'$.note')),fold_text(?))>0";
        params.push(q);
      }
      res.json(
        page(
          req,
          `SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC,id DESC`,
          params,
          entityJson
        )
      );
    });
    app.get(`/api/${table}/:id`, (req, res) => {
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(req.params.id);
      if (!row) fail(404, 'Запись не найдена');
      dataset(req, row.dataset_id);
      if (req.user.role !== 'admin' && row.owner_id !== req.user.id) fail(404, 'Запись не найдена');
      const result = entityJson(row);
      if (table === 'scenarios') {
        const source = db
          .prepare('SELECT payload FROM dataset_versions WHERE dataset_id=? AND version=?')
          .get(row.dataset_id, result.datasetVersion);
        result.datasetSnapshot = source
          ? { id: row.dataset_id, version: result.datasetVersion, data: JSON.parse(source.payload) }
          : null;
      }
      res.json(result);
    });
    function prepare(req, body) {
      const datasetId = table === 'incidents' ? body.datasetId : body.input.datasetId;
      const d = dataset(req, datasetId);
      if (table === 'scenarios' && body.expectedDatasetVersion !== d.version)
        fail(409, 'Набор данных изменился. Пересчитайте сценарий перед сохранением.');
      if (
        table === 'incidents' &&
        body.stageId !== null &&
        !d.data.stages.some((s) => s.id === body.stageId)
      )
        fail(422, 'Неизвестный участок');
      const payload =
        table === 'scenarios'
          ? {
              ...body,
              result: simulate(d.data, body.input),
              datasetVersion: d.version,
              sourceHash: digest(d.payload)
            }
          : body;
      return { datasetId, payload };
    }
    app.post(`/api/${table}`, (req, res) => {
      writer(req);
      const body = parse(schema, req.body);
      const { datasetId, payload } = prepare(req, body);
      const id = randomUUID(),
        now = new Date().toISOString();
      transaction(db, () => {
        db.prepare(
          `INSERT INTO ${table}(id,dataset_id,owner_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)`
        ).run(id, datasetId, req.user.id, JSON.stringify(payload), now, now);
        audit(req.user, `${table}.create`, id, table === 'incidents' ? body.title : body.name);
      });
      res.status(201).json(entityJson(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)));
    });
    app.put(`/api/${table}/:id`, (req, res) => {
      const old = editableEntity(req, table, req.params.id);
      const { version, data } = parse(
        z.object({ version: versionSchema, data: schema }).strict(),
        req.body
      );
      const { datasetId, payload } = prepare(req, data);
      if (datasetId !== old.dataset_id) fail(422, 'Нельзя перемещать запись между наборами');
      transaction(db, () => {
        const result = db
          .prepare(
            `UPDATE ${table} SET payload=?,version=version+1,updated_at=? WHERE id=? AND version=?`
          )
          .run(JSON.stringify(payload), new Date().toISOString(), old.id, version);
        if (!result.changes) fail(409, 'Запись изменена другим запросом. Обновите страницу.');
        audit(req.user, `${table}.update`, old.id);
      });
      res.json(entityJson(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(old.id)));
    });
    app.delete(`/api/${table}/:id`, (req, res) => {
      const old = editableEntity(req, table, req.params.id);
      const { version } = parse(z.object({ version: versionSchema }).strict(), req.body);
      transaction(db, () => {
        if (
          !db.prepare(`DELETE FROM ${table} WHERE id=? AND version=?`).run(old.id, version).changes
        )
          fail(409, 'Запись изменилась. Обновите страницу.');
        audit(req.user, `${table}.delete`, old.id);
      });
      res.json({ ok: true });
    });
  }
  app.get('/api/audit', (req, res) => {
    if (req.user.role !== 'admin') fail(403, 'Журнал доступен администратору');
    res.json(page(req, 'SELECT * FROM audit ORDER BY id DESC'));
  });
  const userJson = (row) => ({
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: Boolean(row.disabled),
    isOwner: row.id === 'owner'
  });
  app.get('/api/users', (req, res) => {
    admin(req);
    res.json(
      db
        .prepare(
          'SELECT users.*,COALESCE(user_settings.disabled,0) AS disabled FROM users LEFT JOIN user_settings ON users.id=user_settings.user_id ORDER BY username'
        )
        .all()
        .map(userJson)
    );
  });
  app.post('/api/users', (req, res) => {
    admin(req);
    const body = parse(
      ownerCredentialsSchema.extend({ role: z.enum(['editor', 'viewer']) }).strict(),
      req.body
    );
    if (db.prepare('SELECT id FROM users WHERE username=?').get(body.username))
      fail(409, 'Логин уже используется.');
    const id = randomUUID();
    const hash = hashPassword(body.password);
    transaction(db, () => {
      db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(id, body.username, hash, body.role);
      audit(req.user, 'user.create', id, body.username);
    });
    res.status(201).json(userJson({ id, username: body.username, role: body.role, disabled: 0 }));
  });
  app.patch('/api/users/:id', (req, res) => {
    admin(req);
    if (req.params.id === 'owner')
      fail(409, 'Учётная запись владельца управляется настройками сервера.');
    const body = parse(
      ownerCredentialsSchema
        .partial()
        .extend({ role: z.enum(['editor', 'viewer']).optional(), disabled: z.boolean().optional() })
        .strict()
        .refine((value) => Object.keys(value).length > 0),
      req.body
    );
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
    if (!user) fail(404, 'Пользователь не найден');
    if (user.id === req.user.id && (body.disabled || (body.role && body.role !== 'admin')))
      fail(409, 'Нельзя отключить или понизить собственный доступ.');
    if (
      body.username &&
      db.prepare('SELECT id FROM users WHERE username=? AND id<>?').get(body.username, user.id)
    )
      fail(409, 'Логин уже используется.');
    const hash = body.password ? hashPassword(body.password) : user.password_hash;
    transaction(db, () => {
      db.prepare('UPDATE users SET username=?,password_hash=?,role=? WHERE id=?').run(
        body.username ?? user.username,
        hash,
        body.role ?? user.role,
        user.id
      );
      if (body.disabled !== undefined)
        db.prepare(
          'INSERT INTO user_settings(user_id,disabled) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET disabled=excluded.disabled'
        ).run(user.id, Number(body.disabled));
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      audit(req.user, 'user.update', user.id, JSON.stringify({ fields: Object.keys(body) }));
    });
    res.json({ ok: true });
  });
  app.get('/api/operations', (req, res) => {
    admin(req);
    res.json(operations.status());
  });
  app.get('/api/operations/backups', (req, res) => {
    admin(req);
    res.json(operations.backups());
  });
  app.post('/api/operations/backup', (req, res) => {
    admin(req);
    res.json(operations.backup(req.user.username));
  });
  app.post('/api/operations/retention', (req, res) => {
    admin(req);
    parse(z.object({ confirm: z.literal(true) }).strict(), req.body);
    res.json(operations.retain(req.user.username));
  });
  app.get('/api/ai/reservations', (req, res) => {
    admin(req);
    res.json(operations.unresolved());
  });
  app.post('/api/ai/reservations/:id/reconcile', (req, res) => {
    admin(req);
    const body = parse(
      z
        .object({
          outcome: z.enum(['not_charged', 'charged']),
          costUsd: z.number().min(0).max(1000).optional(),
          note: z.string().trim().min(5).max(800)
        })
        .strict(),
      req.body
    );
    res.json(operations.reconcile(req.params.id, body, req.user.username));
  });
  app.get('/api/export/:id', (req, res) => {
    const d = dataset(req, req.params.id),
      a = analyze(d.data, req.query.date ? parse(dateSchema, req.query.date) : null);
    const rows = [
      ['Участок', 'План', 'Факт', 'Брак операций', 'Доля брака, %', 'Простой, мин'],
      ...a.stages
        .filter((s) => s.observations)
        .map((s) => [s.name, s.plan, s.actual, s.defects, s.defectPct, s.downtimeMinutes])
    ];
    res
      .attachment('qarqyn-report.csv')
      .type('text/csv')
      .send('\ufeff' + rows.map((r) => r.map(escapeCsv).join(';')).join('\r\n'));
  });
  mountConversations(app, { db, config, assistant, dataset, writer, audit, page });
  app.post(
    '/api/assistant',
    rateLimit({
      windowMs: 60_000,
      limit: config.testing ? 10000 : 3,
      message: { error: 'Лимит помощника: 3 запроса в минуту' }
    }),
    async (req, res) => {
      const body = parse(
        z
          .object({
            datasetId: z.string().max(64),
            question: z.string().trim().min(3).max(1200),
            history: assistantHistorySchema.optional()
          })
          .strict(),
        req.body
      );
      const d = dataset(req, body.datasetId);
      if (!assistant.available())
        fail(503, 'Внешний ИИ не подключён. Аналитика и сценарии работают локально.');
      if (!writeRoles.has(req.user.role))
        fail(
          403,
          'Внешний ИИ доступен редактору: запрос передаёт производственные записи и сводку настроенному провайдеру.'
        );
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const answer = await assistant.ask({
        data: d.data,
        datasetId: d.id,
        datasetVersion: d.version,
        question: body.question,
        history: body.history,
        userId: req.user.id,
        signal: controller.signal
      });
      audit(
        req.user,
        'assistant.request',
        d.id,
        `Модель ${answer.provider}; запрос ${answer.requestId}`
      );
      res.json(answer);
    }
  );
  app.use('/api', (req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
  app.use(errorHandler(config));
  return app;
}
export function errorHandler(config = {}) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status =
      err.type === 'entity.too.large'
        ? 413
        : err instanceof SyntaxError && 'body' in err
          ? 400
          : err.name === 'TimeoutError'
            ? 504
            : err.status || 500;
    const message =
      status === 500
        ? 'Внутренняя ошибка. Повторите запрос.'
        : err.code
          ? 'Запрошенный ресурс недоступен.'
          : status === 413
            ? 'Файл превышает лимит 2 МБ'
            : status === 400
              ? 'Некорректный JSON'
              : status === 504
                ? 'Истекло время ожидания ИИ'
                : err.message;
    if (status >= 500 && !config.testing)
      (config.logger || console.error)(
        JSON.stringify({ event: 'http.error', requestId: req.requestId, status, name: err.name })
      );
    res.status(status).json({ error: message });
  };
}
