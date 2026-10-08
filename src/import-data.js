export function parseDelimited(source) {
  const text = source.replace(/^\uFEFF/, '');
  const counts = new Map([
    [';', 0],
    ['\t', 0],
    [',', 0]
  ]);
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (inQuotes && text[index + 1] === '"') index++;
      else inQuotes = !inQuotes;
    } else if (!inQuotes) {
      if (char === '\r' || char === '\n') break;
      if (counts.has(char)) counts.set(char, counts.get(char) + 1);
    }
  }
  const delimiter = [...counts].sort((left, right) => right[1] - left[1])[0][0];
  const rows = [];
  let row = [],
    field = '',
    quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      if (quoted && text[index + 1] === '"') {
        field += '"';
        index++;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(field);
      field = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index++;
      row.push(field);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (quoted) throw new Error('В CSV не закрыта кавычка. Проверьте последнюю строку.');
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

export async function readImportFile(file) {
  if (file.size > 2 * 1024 * 1024) throw new Error('Файл не должен превышать 2 МБ.');
  if (/\.json$/i.test(file.name)) {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || Array.isArray(data))
      throw new Error('JSON должен содержать объект набора данных.');
    return { data };
  }
  if (/\.csv$/i.test(file.name)) {
    const rows = parseDelimited(await file.text());
    if (rows.length > 2001 || rows.some((row) => row.length > 80))
      throw new Error('В CSV допускаются до 2000 строк данных и 80 колонок.');
    return { sheets: [{ name: file.name, rows }] };
  }
  if (!/\.xlsx$/i.test(file.name)) throw new Error('Поддерживаются JSON, CSV и XLSX.');
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsx-worker.js', import.meta.url), { type: 'module' });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Чтение XLSX превысило 15 секунд. Уменьшите файл.'));
    }, 15000);
    worker.onmessage = ({ data }) => {
      clearTimeout(timer);
      worker.terminate();
      if (data.error) reject(new Error(data.error));
      else resolve(data);
    };
    worker.onerror = () => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error('Не удалось прочитать XLSX. Сохраните файл заново или используйте CSV.'));
    };
    worker.postMessage(file);
  });
}
