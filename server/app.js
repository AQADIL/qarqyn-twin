import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { analyze, simulate, optimize, planTarget } from './analytics.js';
import { digest, checkPassword, hashPassword } from './db.js';
import { assistantHistorySchema, createAssistant } from './ai.js';
import {
  parse,
  fail,
  datasetSchema,
  simulationSchema,
  targetPlanSchema,
  scenarioSchema,
  incidentSchema,
  loginSchema,
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
  const assistant = createAssistant(db, config);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
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
  app.post('/api/auth/login', authLimit, (req, res) => {
    const body = parse(loginSchema, req.body);
    const user = db.prepare('SELECT * FROM users WHERE username=?').get(body.username);
    const valid = checkPassword(body.password, user?.password_hash || dummyHash);
    if (!user || !valid) return res.status(401).json({ error: 'Неверный логин или пароль' });
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
        : db.prepare('SELECT id,username,role FROM users WHERE id=?').get(session.user_id);
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
    db.prepare(
      'INSERT INTO audit(actor,action,entity_id,detail,created_at) VALUES (?,?,?,?,?)'
    ).run(user.username, action, entity, detail, new Date().toISOString());
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
  app.post('/api/datasets', (req, res) => {
    writer(req);
    const data = importedSource(parse(datasetSchema, req.body));
    const id = randomUUID();
    db.prepare('INSERT INTO datasets(id,name,payload,owner_id,created_at) VALUES (?,?,?,?,?)').run(
      id,
      data.name,
      JSON.stringify(data),
      req.user.id,
      new Date().toISOString()
    );
    audit(req.user, 'dataset.create', id, data.name);
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
    if (incidents.some((r) => !stageIds.has(JSON.parse(r.payload).stageId)))
      fail(
        422,
        'Нельзя удалить участок, на который ссылаются события. Сначала перенесите или удалите эти события.'
      );
    body.data = importedSource(body.data);
    const change = db
      .prepare('UPDATE datasets SET name=?,payload=?,version=version+1 WHERE id=? AND version=?')
      .run(body.data.name, JSON.stringify(body.data), req.params.id, body.version);
    if (!change.changes) fail(409, 'Данные изменились. Обновите страницу перед сохранением.');
    audit(req.user, 'dataset.update', req.params.id);
    res.json({ id: req.params.id, version: body.version + 1 });
  });
  app.delete('/api/datasets/:id', (req, res) => {
    dataset(req, req.params.id, true);
    const { version } = parse(z.object({ version: versionSchema }).strict(), req.body);
    const result = db
      .prepare('DELETE FROM datasets WHERE id=? AND version=?')
      .run(req.params.id, version);
    if (!result.changes) fail(409, 'Данные изменились. Обновите страницу.');
    audit(req.user, 'dataset.delete', req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/analysis/:id', (req, res) => {
    const d = dataset(req, req.params.id);
    const date = req.query.date ? parse(dateSchema, req.query.date) : null;
    res.json({ ...analyze(d.data, date), datasetId: d.id, version: d.version, name: d.name });
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
          observationHours: z.number().min(1).max(24).default(8)
        })
        .strict(),
      req.body
    );
    res.json(
      optimize(dataset(req, body.datasetId).data, body.hours, body.observationHours).map((r) => ({
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
      const rows =
        req.user.role === 'admin'
          ? db
              .prepare(
                `SELECT * FROM ${table} WHERE dataset_id=? ORDER BY created_at DESC LIMIT 200`
              )
              .all(id)
          : db
              .prepare(
                `SELECT * FROM ${table} WHERE dataset_id=? AND owner_id=? ORDER BY created_at DESC LIMIT 200`
              )
              .all(id, req.user.id);
      res.json(rows.map(entityJson));
    });
    function prepare(req, body) {
      const datasetId = table === 'incidents' ? body.datasetId : body.input.datasetId;
      const d = dataset(req, datasetId);
      if (
        table === 'scenarios' &&
        body.expectedDatasetVersion !== undefined &&
        body.expectedDatasetVersion !== d.version
      )
        fail(409, 'Набор данных изменился. Пересчитайте сценарий перед сохранением.');
      if (table === 'incidents' && !d.data.stages.some((s) => s.id === body.stageId))
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
      db.prepare(
        `INSERT INTO ${table}(id,dataset_id,owner_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)`
      ).run(id, datasetId, req.user.id, JSON.stringify(payload), now, now);
      audit(req.user, `${table}.create`, id, table === 'incidents' ? body.title : body.name);
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
      const result = db
        .prepare(
          `UPDATE ${table} SET payload=?,version=version+1,updated_at=? WHERE id=? AND version=?`
        )
        .run(JSON.stringify(payload), new Date().toISOString(), old.id, version);
      if (!result.changes) fail(409, 'Запись изменена другим запросом. Обновите страницу.');
      audit(req.user, `${table}.update`, old.id);
      res.json(entityJson(db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(old.id)));
    });
    app.delete(`/api/${table}/:id`, (req, res) => {
      const old = editableEntity(req, table, req.params.id);
      const { version } = parse(z.object({ version: versionSchema }).strict(), req.body);
      if (!db.prepare(`DELETE FROM ${table} WHERE id=? AND version=?`).run(old.id, version).changes)
        fail(409, 'Запись изменилась. Обновите страницу.');
      audit(req.user, `${table}.delete`, old.id);
      res.json({ ok: true });
    });
  }
  app.get('/api/audit', (req, res) => {
    if (req.user.role !== 'admin') fail(403, 'Журнал доступен администратору');
    res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all());
  });
  app.get('/api/export/:id', (req, res) => {
    const d = dataset(req, req.params.id),
      a = analyze(d.data);
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
      const answer = await assistant.ask({
        data: d.data,
        datasetId: d.id,
        datasetVersion: d.version,
        question: body.question,
        history: body.history,
        userId: req.user.id
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
  app.use((err, req, res, next) => {
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
        : status === 413
          ? 'Файл превышает лимит 2 МБ'
          : status === 400
            ? 'Некорректный JSON'
            : status === 504
              ? 'Истекло время ожидания ИИ'
              : err.message;
    if (status === 500) console.error('Request failed:', err.name);
    res.status(status).json({ error: message });
  });
  return app;
}
