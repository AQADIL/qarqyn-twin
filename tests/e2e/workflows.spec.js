import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test.beforeEach(async ({}, info) => {
  const server = JSON.parse(process.env.QARQYN_E2E_SERVERS)[info.project.name];
  process.env.QARQYN_E2E_ORIGIN = server.origin;
  process.env.QARQYN_E2E_USERNAME = server.username;
  process.env.QARQYN_E2E_PASSWORD = server.password;
});

async function login(
  page,
  username = process.env.QARQYN_E2E_USERNAME,
  password = process.env.QARQYN_E2E_PASSWORD
) {
  await page.goto(`${process.env.QARQYN_E2E_ORIGIN}/#/app/overview`);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Логин', { exact: true }).fill(username);
  await dialog.getByLabel('Пароль', { exact: true }).fill(password);
  await dialog.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Пульс производства', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.workspace-main .loading')).toHaveCount(0);
}
async function navigate(page, name) {
  await page
    .getByRole('navigation', { name: 'Разделы приложения' })
    .getByRole('link', { name, exact: true })
    .click();
}

test('login, persistent theme and logout work through the production UI', async ({ page }) => {
  await login(page);
  await expect(page.locator('.account')).toContainText(process.env.QARQYN_E2E_USERNAME);
  await page.getByRole('button', { name: 'Включить светлую тему' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(
    page.getByRole('heading', { name: 'Пульс производства', exact: true })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Включить космическую тему' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  const logout = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/auth/logout') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await logout;
  await expect(page).toHaveURL(/\/$|\/#$/);
  await page.goto(`${process.env.QARQYN_E2E_ORIGIN}/#/app/overview`);
  await expect(page.getByRole('heading', { name: 'Откройте производство' })).toBeVisible();
});

test('mobile navigation traps focus, supports Escape and closes after navigation', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const menu = page.getByRole('button', { name: 'Открыть меню', exact: true });
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.sidebar')).toHaveAttribute('inert', '');
  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.workspace')).toHaveAttribute('inert', '');
  await expect
    .poll(() =>
      page.locator('.sidebar').evaluate((element) => ({
        inert: element.inert,
        visibility: getComputedStyle(element).visibility,
        active: document.activeElement?.outerHTML
      }))
    )
    .toMatchObject({
      inert: false,
      visibility: 'visible',
      active: expect.stringContaining('sidebar-close')
    });
  const close = page.locator('.sidebar').getByRole('button', { name: 'Закрыть меню', exact: true });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  await menu.click();
  await navigate(page, 'Данные');
  await expect(
    page.getByRole('heading', { name: 'Данные производства', exact: true })
  ).toBeVisible();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)
  ).toBe(true);
});

test('dataset copy, competing edits, immutable history, restore and delete are integrated', async ({
  page,
  context
}) => {
  await login(page);
  await navigate(page, 'Данные');
  await page.getByRole('button', { name: 'Создать копию', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Параметры', exact: true })).toBeVisible();
  const copyUrl = page.url();
  const second = await context.newPage();
  await second.goto(copyUrl);
  await second.getByRole('button', { name: 'Параметры', exact: true }).click();
  await page.getByRole('button', { name: 'Параметры', exact: true }).click();
  const name = `Browser test ${randomBytes(4).toString('hex')}`;
  await page.getByRole('dialog').getByLabel('Название', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await second
    .getByRole('dialog')
    .getByLabel('Название', { exact: true })
    .fill('Stale browser change');
  await second.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(second.getByRole('alert')).toContainText('Данные изменились');
  await second.close();
  await page.reload();
  await expect(page.locator('.dataset-banner')).toContainText(name);
  await page.getByRole('button', { name: 'История версий', exact: true }).click();
  const history = page.getByRole('dialog', { name: 'История данных' });
  await history
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: '1', exact: true }) })
    .getByRole('button', { name: 'Открыть снимок' })
    .click();
  await history.getByRole('button', { name: 'Восстановить эту версию', exact: true }).click();
  await history.getByRole('button', { name: 'Восстановить данные', exact: true }).click();
  await expect(history).not.toBeVisible();
  await expect(page.locator('.dataset-banner')).toContainText('версия 3');
  await expect(page.locator('.dataset-banner')).not.toContainText(name);
  await page.getByRole('button', { name: 'Удалить набор данных', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.getByText('Исходный набор защищён', { exact: true })).toBeVisible();
});

test('incident create, update, search and delete persist real API records', async ({ page }) => {
  await login(page);
  await navigate(page, /^Отклонения/);
  await page.getByRole('button', { name: 'Создать задачу', exact: true }).click();
  const title = `Контроль ${randomBytes(4).toString('hex')}`;
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название', { exact: true }).fill(title);
  await dialog.getByLabel('Ответственный', { exact: true }).fill('Тестовый инженер');
  await dialog
    .getByLabel('Описание и основание', { exact: true })
    .fill('Проверка браузерного CRUD на временной базе.');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByLabel('Поиск задач').fill(title.toUpperCase());
  const card = page.locator('.task-list article').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Изменить', exact: true }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Статус', exact: true }).selectOption('resolved');
  await dialog
    .getByLabel('Фактический результат проверки', { exact: true })
    .fill('Запись сохранена и прочитана браузерным тестом.');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await page.getByLabel('Поиск задач').fill(title);
  await expect(card).toContainText('Решено');
  await card.getByRole('button', { name: `Удалить задачу ${title}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(card).not.toBeVisible();
});

test('pilot uses observed data and unconfigured AI clearly disables sending', async ({ page }) => {
  await login(page);
  await navigate(page, /^Риски и эффект/);
  await page.getByRole('tab', { name: 'Проверка результата', exact: true }).click();
  await page.getByRole('button', { name: 'Сравнить фактические результаты', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Нужна проверка сопоставимости', exact: true })
  ).toBeVisible();
  await expect(page.locator('.pilot-results tbody tr')).toHaveCount(4);
  await navigate(page, 'Помощник AI');
  await expect(page.getByLabel('Сообщение помощнику')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Отправить сообщение', exact: true })
  ).toBeDisabled();
  await expect(
    page.getByText('Помощник не подключён. Проверьте настройки сервера.', { exact: true })
  ).toBeVisible();
});

test('admin can create an account and suspend access through the UI', async ({ page }) => {
  await login(page);
  await navigate(page, 'Управление');
  await page.getByRole('button', { name: 'Команда', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить участника', exact: true }).click();
  const username = `viewer-${randomBytes(4).toString('hex')}`;
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Логин', { exact: true }).fill(username);
  await dialog
    .getByLabel('Пароль · от 16 символов', { exact: true })
    .fill(randomBytes(24).toString('hex'));
  await dialog.getByRole('combobox', { name: 'Роль', exact: true }).selectOption('viewer');
  await dialog.getByRole('button', { name: 'Сохранить доступ', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const row = page
    .getByRole('row')
    .filter({ has: page.getByRole('cell', { name: username, exact: true }) });
  await expect(row).toContainText('Наблюдатель');
  await row.getByRole('button', { name: 'Приостановить', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Подтвердить', exact: true }).click();
  await expect(row).toContainText('Приостановлен');
});

test('XLSX worker preview validates real spreadsheet rows before creating a dataset', async ({
  page
}) => {
  await login(page);
  await navigate(page, 'Данные');
  await page
    .getByLabel('Импортировать JSON, CSV или XLSX')
    .setInputFiles(fileURLToPath(new URL('./fixtures/plans.xlsx', import.meta.url)));
  const dialog = page.getByRole('dialog', { name: 'Проверка импорта' });
  await dialog.getByRole('combobox', { name: 'Категория', exact: true }).selectOption('plans');
  await expect(
    dialog.getByRole('cell', { name: 'Synthetic browser fixture', exact: true })
  ).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Создать набор', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Проверить на сервере', exact: true }).click();
  await expect(
    dialog.getByText('Проверка структуры и связей пройдена. Можно создать набор.', { exact: true })
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Создать набор', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('tab', { name: /План моделей/ }).click();
  await expect(
    page.getByRole('cell', { name: 'Synthetic browser fixture', exact: true })
  ).toBeVisible();
  await expect(page.getByRole('cell', { name: '17', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Удалить набор данных', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.getByText('Исходный набор защищён', { exact: true })).toBeVisible();
});

test('Lab explains missing date evidence, saves scenarios and opens their source snapshots', async ({
  page
}) => {
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('Interface failure'))
      failures.push(message.text());
  });
  await login(page);
  await navigate(page, 'Сценарии');
  await expect(
    page.getByRole('heading', { name: 'Что изменит выпуск?', exact: true })
  ).toBeVisible();
  await expect(page.locator('.intervention')).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Сохранить сценарий', exact: true })).toBeEnabled();
  await page
    .getByRole('combobox', { name: 'Наблюдения для расчёта', exact: true })
    .selectOption({ index: 1 });
  await expect(page.getByRole('alert')).toContainText('отсутствует журнал простоев');
  await expect(page.getByRole('button', { name: 'Сохранить сценарий', exact: true })).toHaveCount(
    0
  );
  await page
    .getByRole('combobox', { name: 'Наблюдения для расчёта', exact: true })
    .selectOption('');
  await expect(page.getByRole('button', { name: 'Сохранить сценарий', exact: true })).toBeEnabled();
  const optimized = page.waitForResponse(
    (response) => response.url().endsWith('/api/optimize') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Сравнить точки влияния', exact: true }).click();
  expect((await optimized).status()).toBe(200);
  await page.getByRole('button', { name: 'Сохранить сценарий', exact: true }).click();
  const name = `Scenario ${randomBytes(4).toString('hex')}`;
  await page.getByRole('dialog').getByLabel('Название', { exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  const row = page.locator('.saved-scenarios article').filter({ hasText: name });
  await row.getByRole('button', { name: 'Открыть снимок', exact: true }).click();
  const snapshot = page.getByRole('dialog', { name });
  await expect(
    snapshot.getByRole('button', { name: 'Скачать исходные записи снимка', exact: true })
  ).toBeVisible();
  await snapshot.getByRole('button', { name: 'Сравнить с текущей версией', exact: true }).click();
  await expect(
    snapshot.getByRole('columnheader', { name: 'Пересчёт v1', exact: true })
  ).toBeVisible();
  await snapshot.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await row.getByRole('button', { name: `Удалить ${name}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(row).not.toBeVisible();
  expect(failures).toEqual([]);
});

test('mobile scrolling seeks the actual assembly video without playback controls', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${process.env.QARQYN_E2E_ORIGIN}/#assembly`);
  const video = page.locator('#assembly video');
  await expect(video).toBeVisible();
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  const metadata = await video.evaluate((element) => ({
    duration: element.duration,
    controls: element.controls,
    error: element.error?.message || null
  }));
  expect(metadata.error).toBeNull();
  expect(metadata.controls).toBe(false);
  expect(metadata.duration).toBeCloseTo(10, 1);
  for (const progress of [0.2, 0.8, 0.4]) {
    await page.locator('#assembly').evaluate((section, position) => {
      const start = section.getBoundingClientRect().top + window.scrollY;
      const distance = section.offsetHeight - window.innerHeight;
      window.scrollTo({ top: start + distance * position, behavior: 'instant' });
    }, progress);
    await expect
      .poll(() => video.evaluate((element) => element.currentTime))
      .toBeCloseTo(progress * metadata.duration, 0);
    await expect.poll(() => video.evaluate((element) => element.seeking)).toBe(false);
  }
  expect(await video.evaluate((element) => element.paused)).toBe(true);
  expect(await video.evaluate((element) => element.controls)).toBe(false);
});

test('target plan keeps its context through effect and concrete interventions', async ({
  page
}) => {
  await login(page);
  await navigate(page, /^План выпуска/);
  await page.getByRole('spinbutton', { name: /Нужный годный выпуск/ }).fill('109');
  await page.getByRole('button', { name: 'Найти путь к цели', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Цель достижима в модели', exact: true })
  ).toBeVisible();
  await expect(page.locator('.target-result')).toContainText('11,06');
  await page.getByRole('button', { name: 'Оценить эффект', exact: true }).click();
  await page.getByRole('slider', { name: 'Реализация плана, процентов', exact: true }).fill('50');
  await expect(page.getByText('При реализации 50%', { exact: true })).toBeVisible();
  await expect(page.getByText('107,7 шт.', { exact: true })).toBeVisible();
  await navigate(page, /^План выпуска/);
  await page.getByRole('spinbutton', { name: /Нужный годный выпуск/ }).fill('109');
  await page.getByRole('button', { name: 'Найти путь к цели', exact: true }).click();
  await page.getByRole('button', { name: 'Обосновать мероприятия', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Мероприятия', exact: true })).toBeVisible();
  await expect(page.getByLabel(/^Целевой выпуск за выбранный горизонт/)).toHaveValue('109');
  await expect(
    page
      .locator('.action-plan-event')
      .filter({ hasText: 'Плановое ТО' })
      .getByRole('button', { name: 'Защищено' })
  ).toBeDisabled();
});

test('forecast validation refuses invented accuracy on the organizer history', async ({ page }) => {
  await login(page);
  await navigate(page, /^Риски и эффект/);
  await page.getByRole('tab', { name: 'Проверка прогноза', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Прогноз должен обыграть простую базу.', exact: true })
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Независимая проверка прогноза', exact: true })
  ).toContainText('Нужны данные');
  await expect(
    page.getByRole('table', { name: 'Ошибки методов на контрольном отрезке' })
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Скачать проверку' })).toBeEnabled();
});

test('flow simulation preserves parts and saves reusable assumptions without opening evidence', async ({
  page
}) => {
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await login(page);
  await navigate(page, /^Поток линии/);
  await page.getByRole('button', { name: 'Задать простую линию', exact: true }).click();
  await page.getByLabel(/^Деталей на входе, шт\./).fill('10');
  await page.getByRole('checkbox', { name: /Я проверил параметры сценария/ }).check();
  const calculated = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/flow-simulate') && response.request().method() === 'POST'
  );
  await page.getByRole('button', { name: 'Рассчитать поток', exact: true }).click();
  const response = await calculated;
  expect(response.status()).toBe(200);
  const result = await response.json();
  expect(result.completed).toBe(10);
  expect(result.conservation.difference).toBe(0);
  await expect(page.getByRole('heading', { name: 'Куда пришёл поток', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const name = `Flow ${randomBytes(4).toString('hex')}`;
  await page.getByLabel('Название модели', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Сохранить модель', exact: true }).click();
  const saved = page.locator('.flow-saved li').filter({ hasText: name });
  await expect(saved).toBeVisible();
  await saved.getByRole('button', { name: 'Загрузить условия', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: /Я проверил параметры сценария/ })
  ).not.toBeChecked();
  expect(failures).toEqual([]);
});

test('confirmed intervention creates a traceable assigned task without duplicate dispatch', async ({
  page
}) => {
  await login(page);
  await navigate(page, /^Мероприятия/);
  const event = page
    .locator('.action-plan-event')
    .filter({ has: page.getByRole('button', { name: 'Исходная запись D1', exact: true }) });
  await event.getByRole('button', { name: 'Добавить работу', exact: true }).click();
  const title = `Engineering ${randomBytes(4).toString('hex')}`;
  await page.getByLabel('Какую работу выполнить', { exact: true }).fill(title);
  await page.getByLabel('Ответственный', { exact: true }).fill('Synthetic test engineer');
  await page.getByLabel('Срок выполнения', { exact: true }).fill('2026-10-16');
  await page
    .getByLabel('Как работа устраняет причину', { exact: true })
    .fill('Controlled browser fixture, not a real maintenance prescription.');
  await page
    .getByLabel(/^На чём основана оценка минут/)
    .fill('Synthetic test evidence for UI validation.');
  await page.getByLabel(/^Вернуть из этой остановки, мин/).fill('2');
  await page.getByLabel(/^Уверенность инженера, %/).fill('75');
  await page.getByLabel(/^Разовые затраты, ₸/).fill('0');
  await page.getByLabel(/^Затраты за расчётный период, ₸/).fill('0');
  await page
    .getByLabel('Как подтвердим фактический результат', { exact: true })
    .fill('Compare observed comparable shifts.');
  await page.getByRole('checkbox', { name: /Инженер проверил причину/ }).check();
  await page.getByRole('button', { name: 'Проверить план и эффект', exact: true }).click();
  await page.getByLabel('Название плана', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Сохранить план', exact: true }).click();
  const saved = page.locator('.action-plan-saved-row').filter({ hasText: title });
  await expect(saved).toBeVisible();
  await saved.getByRole('button', { name: 'Создать задачи', exact: true }).click();
  await saved.getByRole('button', { name: 'Создать задачи', exact: true }).click();
  await navigate(page, /^Отклонения/);
  await page.getByLabel('Поиск задач').fill(title);
  const card = page.locator('.task-list article').filter({ hasText: title });
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Synthetic test engineer');
  await expect(card).toContainText('D1');
});
