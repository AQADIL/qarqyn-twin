import readExcelFile from 'read-excel-file/web-worker';

self.onmessage = async ({ data: file }) => {
  try {
    const workbook = await readExcelFile(file);
    if (workbook.length > 30)
      throw new Error('В книге больше 30 листов. Выделите нужные листы в отдельный файл.');
    const sheets = workbook.map((sheet) => {
      if (sheet.data.length > 2001 || sheet.data.some((row) => row.length > 80))
        throw new Error('Лимит листа: 2000 строк данных и 80 колонок.');
      return {
        name: sheet.sheet,
        rows: sheet.data.map((row) =>
          row.map((value) =>
            value instanceof Date
              ? value.toISOString().slice(0, 10)
              : value == null
                ? ''
                : String(value)
          )
        )
      };
    });
    self.postMessage({ sheets });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
