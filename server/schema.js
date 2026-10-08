import { z } from 'zod';

const text = (max = 160) => z.string().trim().min(1).max(max);
const number = (max = 1000000) => z.number().finite().min(0).max(max);
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Некорректная дата');
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const row = { id, date: dateSchema, stageId: id };
export const datasetSchema = z
  .object({
    name: text(100),
    source: z
      .object({
        name: text(180),
        kind: text(40),
        sha256: z.string().max(64).optional(),
        description: text(1200)
      })
      .strict(),
    targets: z
      .object({
        monthlyOutput: number().int().positive(),
        maxDefectPct: number(100),
        maxDowntimeMinutes: number(1440),
        targetOeePct: number(100),
        shiftsPerDay: z.number().int().min(1).max(3),
        hoursPerShift: z.number().min(1).max(24)
      })
      .strict(),
    stages: z
      .array(
        z
          .object({ id, name: text(80), kind: z.enum(['buffer', 'production', 'inspection']) })
          .strict()
      )
      .min(1)
      .max(30),
    production: z
      .array(
        z
          .object({
            ...row,
            line: text(100),
            plan: number().int(),
            actual: number().int(),
            runtimeHours: number(24).positive(),
            utilizationPct: number(100)
          })
          .strict()
      )
      .min(1)
      .max(2000),
    downtime: z
      .array(
        z
          .object({
            ...row,
            equipment: text(100),
            reason: text(500),
            minutes: number(1440).positive()
          })
          .strict()
      )
      .max(2000),
    plans: z.array(z.object({ id, model: text(100), quantity: number().int() }).strict()).max(200),
    quality: z
      .array(
        z
          .object({
            ...row,
            produced: number().int().positive(),
            defects: number().int(),
            reportedPct: number(100).optional()
          })
          .strict()
          .refine((r) => r.defects <= r.produced, 'Брак не может превышать выпуск')
      )
      .max(2000)
  })
  .strict()
  .superRefine((data, ctx) => {
    const ids = new Set(data.stages.map((s) => s.id));
    const productionIds = new Set(
      data.stages.filter((s) => s.kind === 'production').map((s) => s.id)
    );
    if (!productionIds.size)
      ctx.addIssue({
        code: 'custom',
        path: ['stages'],
        message: 'Нужен хотя бы один производственный участок'
      });
    if (ids.size !== data.stages.length)
      ctx.addIssue({ code: 'custom', message: 'Повторяются ID участков' });
    const recordIds = new Set();
    for (const key of ['production', 'quality', 'downtime', 'plans']) {
      for (const record of data[key]) {
        if (recordIds.has(record.id))
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'ID записи должен быть уникальным во всём наборе'
          });
        recordIds.add(record.id);
        if (record.stageId && !ids.has(record.stageId))
          ctx.addIssue({ code: 'custom', path: [key], message: 'Неизвестный участок' });
        if (key === 'production' && !productionIds.has(record.stageId))
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Выпуск должен относиться к производственному участку'
          });
        if (key === 'production' && !Number.isFinite((record.actual / record.runtimeHours) * 744))
          ctx.addIssue({
            code: 'custom',
            path: [key],
            message: 'Время работы слишком мало для устойчивого расчёта'
          });
      }
    }
    for (const s of data.stages.filter((s) => s.kind === 'production')) {
      if (!data.production.some((r) => r.stageId === s.id))
        ctx.addIssue({ code: 'custom', message: `Нет наблюдений для ${s.name}` });
    }
  });

export const simulationSchema = z
  .object({
    datasetId: id,
    hours: z.number().min(1).max(744),
    observationHours: z.number().min(1).max(24).default(8),
    interventions: z
      .array(
        z
          .object({ stageId: id, recoverMinutes: number(480), defectPct: number(100).nullable() })
          .strict()
      )
      .max(30)
  })
  .strict()
  .superRefine((v, ctx) => {
    if (new Set(v.interventions.map((x) => x.stageId)).size !== v.interventions.length)
      ctx.addIssue({ code: 'custom', message: 'Изменения участка указаны дважды' });
  });
export const scenarioSchema = z
  .object({ name: text(100), note: z.string().trim().max(2000), input: simulationSchema })
  .strict();
export const targetPlanSchema = z
  .object({
    datasetId: id,
    hours: z.number().min(1).max(744),
    observationHours: z.number().min(1).max(24).default(8),
    targetGoodOutput: z.number().positive().max(1000000)
  })
  .strict();
export const incidentSchema = z
  .object({
    datasetId: id,
    stageId: id,
    title: text(180),
    description: z.string().trim().max(3000),
    priority: z.enum(['normal', 'high', 'critical']),
    status: z.enum(['open', 'investigating', 'resolved'])
  })
  .strict();
export const loginSchema = z
  .object({ username: text(80), password: z.string().min(1).max(256) })
  .strict();
export const versionSchema = z.number().int().positive();
export function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const error = new Error(
      result.error.issues
        .slice(0, 5)
        .map((x) => `${x.path.join('.')}: ${x.message}`)
        .join('; ')
    );
    error.status = 422;
    throw error;
  }
  return result.data;
}
export function fail(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
