import { readFileSync, writeFileSync } from 'node:fs';
const defaults = readFileSync('.env.example', 'utf8')
  .split(/\r?\n/)
  .filter((line) => line.startsWith('AI_') && !line.startsWith('AI_API_KEY='));
let content = readFileSync('.env', 'utf8');
for (const line of defaults) {
  const key = line.split('=')[0],
    expression = new RegExp(`^${key}=.*$`, 'm');
  content = expression.test(content)
    ? content.replace(expression, line)
    : `${content.trimEnd()}\n${line}\n`;
}
writeFileSync('.env', content, { mode: 0o600 });
console.log(
  'AI settings updated from .env.example. Existing API key preserved; no credential printed.'
);
