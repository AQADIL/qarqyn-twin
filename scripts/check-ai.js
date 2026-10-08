import { writeFileSync } from 'node:fs';
const origin = process.env.APP_ORIGIN;
if (!origin || !process.env.ADMIN_PASSWORD) throw new Error('Load local environment first.');
const auth = await fetch(`${origin}/api/auth/login`, {
  method: 'POST',
  headers: { Origin: origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD
  })
});
if (!auth.ok) throw new Error(`Local sign in failed: ${auth.status}`);
const session = await auth.json(),
  cookie = auth.headers.get('set-cookie').split(';')[0];
const started = Date.now();
try {
  const response = await fetch(`${origin}/api/assistant`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': session.csrf
    },
    body: JSON.stringify({
      datasetId: 'allur',
      question:
        'Сравни эффект улучшения сварки и окраски. Какое действие проверять первым? Предложи один сценарий и укажи ограничения исходных данных.'
    }),
    signal: AbortSignal.timeout(100000)
  });
  const answer = await response.json();
  writeFileSync(
    'runtime/ai-check.json',
    JSON.stringify(
      { status: response.status, elapsedSeconds: (Date.now() - started) / 1000, answer },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      status: response.status,
      elapsedSeconds: (Date.now() - started) / 1000,
      model: answer.provider,
      usage: answer.usage,
      observations: answer.observations?.length,
      proposedScenario: Boolean(answer.proposal),
      error: answer.error
    })
  );
} finally {
  await fetch(`${origin}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: cookie,
      'X-CSRF-Token': session.csrf
    },
    body: '{}'
  });
}
