import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { analyze, planTarget } from '../server/analytics.js';
import { evaluateImpact } from '../server/impact.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = path.join(root, 'docs', 'submission');
const data = JSON.parse(await fs.readFile(path.join(root, 'data', 'allur.json'), 'utf8'));
const analysis = analyze(data);
const request = { datasetId: 'allur', hours: 8, observationHours: 8, targetGoodOutput: 109 };
const plan = planTarget(data, request);
const impact = evaluateImpact(data, {
  ...request,
  expectedDatasetVersion: 1,
  realizationPct: 50,
  periods: 1
});
if (
  !plan.achievable ||
  plan.interventions.length !== 1 ||
  plan.interventions[0].stageId !== 'welding'
) {
  throw new Error(
    'The source data no longer supports the presentation scenario; review its narrative.'
  );
}
const format = (value, digits = 1) =>
  new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(value);
const facts = {
  DEFECTS: format(analysis.totals.defects, 0),
  DOWNTIME: format(analysis.totals.downtimeMinutes, 0),
  BASELINE: format(plan.baselineGoodOutput),
  TARGET: format(request.targetGoodOutput),
  RECOVERY: format(plan.totalRecoverMinutes, 2),
  HALF: format(impact.realizedOutput),
  BASE_WIDTH: (plan.baselineGoodOutput / 110) * 100,
  HALF_WIDTH: (impact.realizedOutput / 110) * 100,
  TARGET_WIDTH: (request.targetGoodOutput / 110) * 100
};

const mime = {
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2'
};
async function embed(relative) {
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(root + path.sep)) throw new Error('Asset outside repository');
  return `data:${mime[path.extname(filename)]};base64,${(await fs.readFile(filename)).toString('base64')}`;
}
const fontRules = [];
const ranges = {
  latin: 'U+0000-00FF,U+2000-206F',
  'latin-ext': 'U+0100-02FF',
  cyrillic: 'U+0400-045F,U+0490-0491,U+2116',
  'cyrillic-ext': 'U+0460-052F,U+1C80-1C8A,U+2DE0-2DFF,U+A640-A69F'
};
for (const weight of [400, 500, 600])
  for (const [subset, range] of Object.entries(ranges)) {
    const src = await embed(
      `node_modules/@fontsource/ibm-plex-sans/files/ibm-plex-sans-${subset}-${weight}-normal.woff2`
    );
    fontRules.push(
      `@font-face{font-family:'Plex';font-style:normal;font-weight:${weight};font-display:block;src:url('${src}') format('woff2');unicode-range:${range}}`
    );
  }
let html = await fs.readFile(path.join(folder, 'presentation.template.html'), 'utf8');
html = html.replace('{{FONT_FACES}}', fontRules.join('\n'));
html = html.replaceAll(
  '{{BRAND}}',
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path fill="currentColor" d="M2 2h23v23H2zm6 6v11h11V8z" fill-rule="evenodd"/><path d="m17 17 13 13" stroke="currentColor" stroke-width="5"/></svg>'
);
const matches = [...html.matchAll(/\{\{ASSET:([^}]+)\}\}/g)];
for (const match of matches) html = html.replaceAll(match[0], await embed(match[1]));
for (const [key, value] of Object.entries(facts))
  html = html.replaceAll(`{{${key}}}`, String(value));
if (/\{\{[^}]+\}\}/.test(html)) throw new Error('Unresolved presentation fields');
const htmlPath = path.join(folder, 'QARQYN-pitch.html');
const pdfPath = path.join(folder, 'QARQYN-pitch.pdf');
await fs.writeFile(htmlPath, html);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 900 },
    reducedMotion: 'reduce'
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((image) => image.decode()));
  });
  await page.emulateMedia({ media: 'print' });
  const layout = await page.evaluate(() =>
    [...document.querySelectorAll('.slide')].map((slide) => ({
      name: slide.getAttribute('aria-label'),
      overflow: [
        ...slide.querySelectorAll(
          'h1,h2,h3,p,.authors,.foot,.time,.plan-metrics,.losses,.confidence,.repo'
        )
      ]
        .filter((element) => {
          const a = element.getBoundingClientRect(),
            b = slide.getBoundingClientRect();
          return (
            a.right > b.right + 1 ||
            a.bottom > b.bottom + 1 ||
            a.left < b.left - 1 ||
            a.top < b.top - 1
          );
        })
        .map((element) => element.className || element.tagName)
    }))
  );
  if (layout.some((slide) => slide.overflow.length) || errors.length)
    throw new Error(JSON.stringify({ layout, errors }));
  await page.pdf({
    path: pdfPath,
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: false,
    tagged: true
  });
  console.log(JSON.stringify({ htmlPath, pdfPath, slides: layout.length, layout }));
} finally {
  await browser.close();
}
