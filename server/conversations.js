import { randomUUID } from 'node:crypto';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { transaction } from './db.js';
import { fail, parse, versionSchema } from './schema.js';

export function mountConversations(app, { db, config, assistant, dataset, writer, audit, page }) {
  const running = new Map();
  const serialize = (row) => ({
    id: row.id,
    datasetId: row.dataset_id,
    title: row.title,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
  function owned(req, id) {
    const row = db
      .prepare('SELECT * FROM conversations WHERE id=? AND owner_id=?')
      .get(id, req.user.id);
    if (!row) fail(404, 'Разговор не найден');
    dataset(req, row.dataset_id);
    return row;
  }
  app.get('/api/conversations', (req, res) => {
    const id = parse(z.string().min(1).max(64), req.query.datasetId);
    dataset(req, id);
    const q = req.query.q ? parse(z.string().trim().max(160), req.query.q) : '';
    res.json(
      page(
        req,
        'SELECT * FROM conversations WHERE owner_id=? AND dataset_id=? AND instr(fold_text(title),fold_text(?))>0 ORDER BY updated_at DESC,id DESC',
        [req.user.id, id, q],
        serialize
      )
    );
  });
  app.post('/api/conversations', (req, res) => {
    writer(req);
    const body = parse(
      z
        .object({
          datasetId: z.string().min(1).max(64),
          title: z.string().trim().min(1).max(120).default('Новый разговор')
        })
        .strict(),
      req.body
    );
    dataset(req, body.datasetId);
    const id = randomUUID(),
      now = new Date().toISOString();
    transaction(db, () => {
      db.prepare(
        'INSERT INTO conversations(id,dataset_id,owner_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?)'
      ).run(id, body.datasetId, req.user.id, body.title, now, now);
      audit(req.user, 'conversation.create', id);
    });
    res.status(201).json(serialize(db.prepare('SELECT * FROM conversations WHERE id=?').get(id)));
  });
  app.get('/api/conversations/:id', (req, res) => {
    const row = owned(req, req.params.id);
    const messages = db
      .prepare('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY rowid')
      .all(row.id)
      .map((message) => ({
        id: message.id,
        role: message.role,
        state: message.state,
        requestId: message.request_id,
        createdAt: message.created_at,
        updatedAt: message.updated_at,
        ...JSON.parse(message.payload)
      }));
    res.json({ ...serialize(row), messages });
  });
  app.patch('/api/conversations/:id', (req, res) => {
    writer(req);
    const row = owned(req, req.params.id);
    const body = parse(
      z.object({ version: versionSchema, title: z.string().trim().min(1).max(120) }).strict(),
      req.body
    );
    transaction(db, () => {
      if (
        !db
          .prepare(
            'UPDATE conversations SET title=?,version=version+1,updated_at=? WHERE id=? AND version=?'
          )
          .run(body.title, new Date().toISOString(), row.id, body.version).changes
      )
        fail(409, 'Разговор изменился. Обновите историю.');
      audit(req.user, 'conversation.update', row.id);
    });
    res.json(serialize(db.prepare('SELECT * FROM conversations WHERE id=?').get(row.id)));
  });
  app.delete('/api/conversations/:id', (req, res) => {
    writer(req);
    const row = owned(req, req.params.id);
    const body = parse(z.object({ version: versionSchema }).strict(), req.body);
    if (running.has(row.id)) fail(409, 'Сначала остановите текущий ответ.');
    transaction(db, () => {
      if (
        !db.prepare('DELETE FROM conversations WHERE id=? AND version=?').run(row.id, body.version)
          .changes
      )
        fail(409, 'Разговор изменился. Обновите историю.');
      audit(req.user, 'conversation.delete', row.id);
    });
    res.json({ ok: true });
  });
  app.post('/api/conversations/:id/cancel', (req, res) => {
    writer(req);
    const row = owned(req, req.params.id);
    const request = running.get(row.id);
    request?.controller.abort();
    res.json({ ok: true, cancelled: Boolean(request), requestId: request?.requestId || null });
  });
  app.post(
    '/api/assistant/stream',
    rateLimit({
      windowMs: 60000,
      limit: config.testing ? 10000 : 3,
      message: { error: 'Лимит помощника: 3 запроса в минуту' }
    }),
    async (req, res) => {
      writer(req);
      const body = parse(
        z
          .object({
            conversationId: z.string().min(1).max(64),
            question: z.string().trim().min(3).max(1200),
            expectedDatasetVersion: versionSchema
          })
          .strict(),
        req.body
      );
      const thread = owned(req, body.conversationId),
        d = dataset(req, thread.dataset_id);
      if (d.version !== body.expectedDatasetVersion)
        fail(409, 'Данные изменились. Обновите набор перед вопросом.');
      if (!assistant.available()) fail(503, 'Внешний ИИ не подключён.');
      if (running.has(thread.id)) fail(409, 'Ответ уже готовится.');
      const prior = db
        .prepare(
          "SELECT role,payload,request_id FROM chat_messages WHERE conversation_id=? AND state='completed' ORDER BY rowid"
        )
        .all(thread.id);
      if (
        db.prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE conversation_id=?').get(thread.id)
          .n >= 200
      )
        fail(409, 'В этом разговоре уже 100 вопросов. Начните новый разговор.');
      const history = [];
      for (let index = 0; index < prior.length - 1; index++) {
        const left = prior[index],
          right = prior[index + 1];
        if (
          left.role === 'user' &&
          right.role === 'assistant' &&
          left.request_id === right.request_id
        )
          history.push({
            question: JSON.parse(left.payload).question,
            summary: JSON.parse(right.payload).answer.summary
          });
      }
      const requestId = randomUUID(),
        messageId = randomUUID(),
        controller = new AbortController(),
        now = new Date().toISOString();
      transaction(db, () => {
        db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?,?)').run(
          randomUUID(),
          thread.id,
          requestId,
          'user',
          'completed',
          JSON.stringify({ question: body.question, datasetVersion: d.version }),
          now,
          now
        );
        db.prepare('INSERT INTO chat_messages VALUES (?,?,?,?,?,?,?,?)').run(
          messageId,
          thread.id,
          requestId,
          'assistant',
          'pending',
          '{}',
          now,
          now
        );
        db.prepare('UPDATE conversations SET updated_at=?,version=version+1 WHERE id=?').run(
          now,
          thread.id
        );
        audit(req.user, 'assistant.start', thread.id, requestId);
      });
      running.set(thread.id, { controller, requestId });
      res
        .status(200)
        .set({
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'X-Accel-Buffering': 'no',
          Connection: 'keep-alive'
        });
      res.flushHeaders();
      const send = (event, data) => {
        if (!res.destroyed && !res.writableEnded)
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const heartbeat = setInterval(() => {
        if (!res.destroyed) res.write(': keep-alive\n\n');
      }, 15000);
      try {
        send('status', { state: 'processing', requestId });
        const answer = await assistant.ask({
          data: d.data,
          datasetId: d.id,
          datasetVersion: d.version,
          question: body.question,
          history: history.slice(-6),
          userId: req.user.id,
          signal: controller.signal,
          requestId
        });
        controller.signal.throwIfAborted();
        transaction(db, () => {
          if (
            !db
              .prepare(
                "UPDATE chat_messages SET state='completed',payload=?,updated_at=? WHERE id=? AND state='pending'"
              )
              .run(JSON.stringify({ answer }), new Date().toISOString(), messageId).changes
          )
            fail(409, 'Разговор был удалён.');
          db.prepare('UPDATE conversations SET updated_at=?,version=version+1 WHERE id=?').run(
            new Date().toISOString(),
            thread.id
          );
          audit(req.user, 'assistant.complete', thread.id, requestId);
        });
        send('answer', answer);
      } catch (error) {
        const cancelled = controller.signal.aborted;
        const message = cancelled
          ? 'Ответ остановлен. Возможный расход сохранён для сверки.'
          : error.status
            ? error.message
            : 'Не удалось сохранить ответ. Обновите историю.';
        try {
          transaction(db, () => {
            db.prepare(
              "UPDATE chat_messages SET state=?,payload=?,updated_at=? WHERE id=? AND state='pending'"
            ).run(
              cancelled ? 'cancelled' : 'failed',
              JSON.stringify({ error: message }),
              new Date().toISOString(),
              messageId
            );
            audit(
              req.user,
              cancelled ? 'assistant.cancel' : 'assistant.fail',
              thread.id,
              requestId
            );
          });
        } catch {
          if (!config.testing)
            console.error(JSON.stringify({ event: 'assistant.persistence_failure', requestId }));
        }
        send('error', { error: message, status: cancelled ? 499 : error.status || 500, requestId });
      } finally {
        clearInterval(heartbeat);
        running.delete(thread.id);
        res.end();
      }
    }
  );
}
