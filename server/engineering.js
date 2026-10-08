import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rateLimit } from 'express-rate-limit';
import { parse, fail, versionSchema, incidentSchema } from './schema.js';
import { digest, transaction } from './db.js';
import { validateForecast } from './forecast-validation.js';
import { flowSchema, simulateFlow } from './flow.js';
import { actionPlanSchema, evaluateActionPlan } from './action-plan.js';

const identifier = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const stored = (row) => ({
  ...JSON.parse(row.payload),
  id: row.id,
  datasetId: row.dataset_id,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

export function mountEngineering(app, db, { dataset, writer, audit, config }) {
  const calculationLimit = rateLimit({
    windowMs: 60_000,
    limit: config.testing ? 10000 : 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Слишком много расчётов. Повторите через минуту.' }
  });
  const validationCache = new Map();
  app.get('/api/forecast-validation/:id', calculationLimit, (req, res) => {
    const source = dataset(req, parse(identifier, req.params.id));
    const key = `${source.id}:${source.version}`;
    if (!validationCache.has(key)) {
      if (validationCache.size >= 24) validationCache.delete(validationCache.keys().next().value);
      validationCache.set(key, validateForecast(source.data));
    }
    res.json({ ...validationCache.get(key), datasetId: source.id, datasetVersion: source.version });
  });

  const definitions = [
    {
      kind: 'flow',
      path: 'flow-studies',
      evaluatePath: 'flow-simulate',
      schema: flowSchema,
      evaluate: simulateFlow
    },
    {
      kind: 'action',
      path: 'action-plans',
      evaluatePath: 'action-plan/evaluate',
      schema: actionPlanSchema,
      evaluate: evaluateActionPlan
    }
  ];

  function checkVersion(source, expected) {
    if (source.version !== expected)
      fail(409, 'Исходные данные изменились. Пересчитайте по текущей версии.');
  }
  function findStudy(req, id, kind, write = false) {
    const row = db
      .prepare('SELECT * FROM engineering_studies WHERE id=? AND kind=?')
      .get(parse(identifier, id), kind);
    if (!row) fail(404, 'Расчёт не найден');
    dataset(req, row.dataset_id);
    if (req.user.role !== 'admin' && row.owner_id !== req.user.id) fail(404, 'Расчёт не найден');
    if (write) writer(req);
    return row;
  }

  for (const definition of definitions) {
    const { kind, path, schema, evaluate, evaluatePath } = definition;
    const saveSchema = z
      .object({
        name: z.string().trim().min(1).max(100),
        input: schema,
        expectedDatasetVersion: versionSchema
      })
      .strict();
    function calculate(req, body) {
      const source = dataset(req, body.input.datasetId);
      checkVersion(source, body.expectedDatasetVersion);
      checkVersion(source, body.input.expectedDatasetVersion);
      return {
        source,
        payload: {
          name: body.name,
          input: body.input,
          result: evaluate(source.data, body.input),
          datasetVersion: source.version,
          sourceHash: digest(source.payload)
        }
      };
    }
    app.post(`/api/${evaluatePath}`, calculationLimit, (req, res) => {
      const input = parse(schema, req.body);
      const source = dataset(req, input.datasetId);
      checkVersion(source, input.expectedDatasetVersion);
      res.json({ ...evaluate(source.data, input), datasetVersion: source.version });
    });
    app.get(`/api/${path}`, (req, res) => {
      const source = dataset(req, parse(identifier, req.query.datasetId));
      const { page, pageSize } = parse(
        z.object({
          page: z.coerce.number().int().min(1).max(100000).default(1),
          pageSize: z.coerce.number().int().min(1).max(50).default(20)
        }),
        req.query
      );
      const parameters = [source.id, kind];
      let where = 'dataset_id=? AND kind=?';
      if (req.user.role !== 'admin') {
        where += ' AND owner_id=?';
        parameters.push(req.user.id);
      }
      const total = db
        .prepare(`SELECT COUNT(*) AS total FROM engineering_studies WHERE ${where}`)
        .get(...parameters).total;
      const items = db
        .prepare(
          `SELECT * FROM engineering_studies WHERE ${where} ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?`
        )
        .all(...parameters, pageSize, (page - 1) * pageSize)
        .map(stored);
      res.json({ items, total, page, pageSize });
    });
    app.get(`/api/${path}/:id`, (req, res) => {
      const row = findStudy(req, req.params.id, kind);
      const result = stored(row);
      const snapshot = db
        .prepare('SELECT payload FROM dataset_versions WHERE dataset_id=? AND version=?')
        .get(row.dataset_id, result.datasetVersion);
      res.json({
        ...result,
        datasetSnapshot: snapshot
          ? {
              id: row.dataset_id,
              version: result.datasetVersion,
              data: JSON.parse(snapshot.payload)
            }
          : null
      });
    });
    app.post(`/api/${path}`, calculationLimit, (req, res) => {
      writer(req);
      const body = parse(saveSchema, req.body);
      const { source, payload } = calculate(req, body);
      const count = db
        .prepare(
          'SELECT COUNT(*) AS total FROM engineering_studies WHERE owner_id=? AND dataset_id=? AND kind=?'
        )
        .get(req.user.id, source.id, kind).total;
      if (count >= 100)
        fail(
          409,
          'Для этого набора сохранено 100 расчётов. Удалите ненужные перед сохранением нового.'
        );
      const id = randomUUID(),
        now = new Date().toISOString();
      transaction(db, () => {
        db.prepare(
          'INSERT INTO engineering_studies(id,dataset_id,owner_id,kind,payload,created_at,updated_at) VALUES (?,?,?,?,?,?,?)'
        ).run(id, source.id, req.user.id, kind, JSON.stringify(payload), now, now);
        audit(req.user, `${kind}.create`, id, body.name);
      });
      res.status(201).json(stored(findStudy(req, id, kind)));
    });
    app.put(`/api/${path}/:id`, calculationLimit, (req, res) => {
      const row = findStudy(req, req.params.id, kind, true);
      const body = parse(z.object({ version: versionSchema, data: saveSchema }).strict(), req.body);
      if (row.version !== body.version)
        fail(409, 'Расчёт изменён другим запросом. Обновите список.');
      if (row.dataset_id !== body.data.input.datasetId)
        fail(422, 'Нельзя перемещать расчёт между наборами.');
      const { payload } = calculate(req, body.data);
      transaction(db, () => {
        const update = db
          .prepare(
            'UPDATE engineering_studies SET payload=?,version=version+1,updated_at=? WHERE id=? AND version=?'
          )
          .run(JSON.stringify(payload), new Date().toISOString(), row.id, body.version);
        if (!update.changes) fail(409, 'Расчёт изменился. Обновите список.');
        audit(req.user, `${kind}.update`, row.id, body.data.name);
      });
      res.json(stored(findStudy(req, row.id, kind)));
    });
    app.delete(`/api/${path}/:id`, (req, res) => {
      const row = findStudy(req, req.params.id, kind, true);
      const { version } = parse(z.object({ version: versionSchema }).strict(), req.body);
      transaction(db, () => {
        if (
          !db
            .prepare('DELETE FROM engineering_studies WHERE id=? AND version=?')
            .run(row.id, version).changes
        )
          fail(409, 'Расчёт изменился. Обновите список.');
        audit(req.user, `${kind}.delete`, row.id);
      });
      res.json({ ok: true });
    });
  }

  app.post('/api/action-plans/:id/tasks', (req, res) => {
    const row = findStudy(req, req.params.id, 'action', true);
    const body = parse(
      z.object({ version: versionSchema, expectedDatasetVersion: versionSchema }).strict(),
      req.body
    );
    if (body.version !== row.version) fail(409, 'План изменился. Обновите список.');
    const source = dataset(req, row.dataset_id),
      plan = stored(row);
    checkVersion(source, body.expectedDatasetVersion);
    checkVersion(source, plan.datasetVersion);
    const result = evaluateActionPlan(source.data, plan.input);
    if (result.readiness.status !== 'ready')
      fail(
        422,
        'Подтвердите мероприятия, ответственных, расходы и способ проверки перед передачей в работу.'
      );
    const previous = db
      .prepare(
        'SELECT incident_ids FROM engineering_dispatches WHERE study_id=? AND study_version=?'
      )
      .get(row.id, row.version);
    if (previous) {
      const ids = JSON.parse(previous.incident_ids);
      const rows = ids.map((id) => db.prepare('SELECT * FROM incidents WHERE id=?').get(id));
      if (
        rows.some(
          (item) =>
            !item ||
            item.dataset_id !== row.dataset_id ||
            (req.user.role !== 'admin' && item.owner_id !== req.user.id)
        )
      )
        fail(
          409,
          'Часть переданных задач удалена или недоступна. Проверьте журнал действий и сохраните новую версию плана, если требуется повторная передача.'
        );
      return res.json({ items: rows.map(stored), count: rows.length, alreadyCreated: true });
    }
    const now = new Date().toISOString(),
      created = [];
    transaction(db, () => {
      for (const action of result.actions) {
        const description = [
          `План: ${plan.name}; версия ${row.version}; данные v${plan.datasetVersion}.`,
          `Источник: ${action.eventId}. Оборудование: ${action.equipment}. Причина: ${action.reason}.`,
          `Мероприятие: ${action.mechanism}`,
          `Основание: ${action.evidence}`,
          `Проверка результата: ${action.validationMethod}`,
          `Ожидаемое восстановление: ${action.expectedRecoveredMinutes} мин. Это оценка инженера.`,
          `Разовые затраты: ${action.oneOffCost} ₸; регулярные за период: ${action.recurringCostPerPeriod} ₸.`
        ].join('\n');
        if (description.length > 3000)
          fail(
            422,
            'Описание мероприятия слишком длинное для задачи. Сократите основание или метод проверки.'
          );
        const payload = parse(incidentSchema, {
          datasetId: row.dataset_id,
          stageId: action.stageId,
          title: action.title,
          description,
          priority: 'normal',
          status: 'open',
          assignee: action.owner,
          dueDate: action.dueDate,
          resolutionNote: ''
        });
        const id = randomUUID();
        db.prepare(
          'INSERT INTO incidents(id,dataset_id,owner_id,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)'
        ).run(id, row.dataset_id, row.owner_id, JSON.stringify(payload), now, now);
        audit(req.user, 'incidents.create', id, `Из плана ${row.id} v${row.version}`);
        created.push(id);
      }
      db.prepare('INSERT INTO engineering_dispatches VALUES (?,?,?,?)').run(
        row.id,
        row.version,
        JSON.stringify(created),
        now
      );
      audit(req.user, 'action.dispatch', row.id, `${created.length} мероприятий передано в работу`);
    });
    res
      .status(201)
      .json({
        items: created.map((id) =>
          stored(db.prepare('SELECT * FROM incidents WHERE id=?').get(id))
        ),
        count: created.length,
        alreadyCreated: false
      });
  });
}
