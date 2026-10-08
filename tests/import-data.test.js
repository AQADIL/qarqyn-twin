import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, readImportFile } from '../src/import-data.js';

test('CSV preserves quoted delimiters, multiline notes and escaped quotes', () => {
  assert.deepEqual(
    parseDelimited(
      '\uFEFFid;"Описание, причина, проверка";minutes\r\nD1;"Сбой;\nдатчик ""А""";12,5\r\n'
    ),
    [
      ['id', 'Описание, причина, проверка', 'minutes'],
      ['D1', 'Сбой;\nдатчик "А"', '12,5']
    ]
  );
});

test('CSV handles tab and comma separators and rejects unfinished quotes', () => {
  assert.deepEqual(parseDelimited('id,date\nP1,2026-10-01'), [
    ['id', 'date'],
    ['P1', '2026-10-01']
  ]);
  assert.deepEqual(parseDelimited('id\tminutes\nD1\t0'), [
    ['id', 'minutes'],
    ['D1', '0']
  ]);
  assert.throws(() => parseDelimited('id;reason\nD1;"unfinished'), /кавычка/);
});

test('import rejects oversized files and scalar JSON without invoking a parser worker', async () => {
  await assert.rejects(readImportFile({ name: 'large.csv', size: 2 * 1024 * 1024 + 1 }), /2 МБ/);
  for (const invalid of ['null', '[]', '42', '"text"'])
    await assert.rejects(readImportFile(new File([invalid], 'dataset.json')), /объект набора/);
  await assert.rejects(readImportFile(new File(['x'], 'legacy.xls')), /JSON, CSV и XLSX/);
});

test('CSV import preserves strings for explicit mapping and enforces record limit', async () => {
  const result = await readImportFile(new File(['id;minutes\nD1;0'], 'events.csv'));
  assert.deepEqual(result.sheets[0].rows, [
    ['id', 'minutes'],
    ['D1', '0']
  ]);
  const excessive = `id;minutes\n${Array.from({ length: 2001 }, (_, index) => `D${index};0`).join('\n')}`;
  await assert.rejects(readImportFile(new File([excessive], 'events.csv')), /2000 строк/);
});
