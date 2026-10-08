import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import express from 'express';
import { openDatabase } from './db.js';
import { createApp } from './app.js';

const required = [
  'HOST',
  'PORT',
  'APP_ORIGIN',
  'DATABASE_PATH',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD'
];
for (const name of required)
  if (!process.env[name]) throw new Error(`Missing ${name}. Run npm run setup or configure .env.`);
if (process.env.ADMIN_PASSWORD.length < 16)
  throw new Error('ADMIN_PASSWORD must contain at least 16 characters.');
const origin = new URL(process.env.APP_ORIGIN);
const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const production = process.argv.includes('--production');
if (
  production &&
  origin.protocol !== 'https:' &&
  !['127.0.0.1', 'localhost'].includes(origin.hostname)
)
  throw new Error('Production deployments require an HTTPS APP_ORIGIN.');
const config = {
  production,
  origin: origin.origin,
  secure: origin.protocol === 'https:',
  adminUsername: process.env.ADMIN_USERNAME,
  adminPassword: process.env.ADMIN_PASSWORD,
  sessionMs: Math.min(24, Math.max(1, Number(process.env.SESSION_HOURS) || 8)) * 3600000,
  aiUrl: process.env.AI_BASE_URL,
  aiModel: process.env.AI_MODEL,
  aiKey: process.env.AI_API_KEY,
  aiTimeout: Math.min(180000, Math.max(1000, Number(process.env.AI_TIMEOUT_MS) || 90000)),
  aiReasoning: process.env.AI_REASONING,
  aiMaxOutput: Number(process.env.AI_MAX_OUTPUT_TOKENS),
  aiBudget: Number(process.env.AI_BUDGET_USD),
  aiInputPrice: Number(process.env.AI_INPUT_PRICE_PER_MILLION),
  aiOutputPrice: Number(process.env.AI_OUTPUT_PRICE_PER_MILLION)
};
if (config.aiUrl && !config.aiUrl.startsWith('https://'))
  throw new Error('AI_BASE_URL must use HTTPS.');
if (
  config.aiKey &&
  (!['low', 'medium', 'high', 'xhigh', 'max'].includes(config.aiReasoning) ||
    ![config.aiInputPrice, config.aiOutputPrice, config.aiBudget].every(Number.isFinite) ||
    !Number.isInteger(config.aiMaxOutput) ||
    config.aiMaxOutput < 1000 ||
    config.aiMaxOutput > 25000 ||
    !(config.aiInputPrice > 0 && config.aiOutputPrice > 0 && config.aiBudget > 0))
)
  throw new Error('Configure valid AI reasoning, output limit, budget and token prices in .env.');
const db = openDatabase(resolve(process.env.DATABASE_PATH), config),
  app = createApp(db, config),
  server = createServer(app);
let vite;
if (production) {
  app.use(express.static(resolve('dist'), { index: false, dotfiles: 'deny' }));
  app.get('/{*path}', (req, res) => res.sendFile(resolve('dist/index.html')));
} else {
  const { createServer: createViteServer } = await import('vite');
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: 'custom'
  });
  app.use(vite.middlewares);
  app.get('/{*path}', async (req, res, next) => {
    try {
      const html = await readFile(resolve('index.html'), 'utf8');
      res.type('html').send(await vite.transformIndexHtml(req.originalUrl, html));
    } catch (error) {
      next(error);
    }
  });
}
server.listen(port, process.env.HOST, () => console.log(`QARQYN running at ${origin.origin}`));
async function shutdown() {
  await vite?.close();
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
