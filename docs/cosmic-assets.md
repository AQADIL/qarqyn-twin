# Космические иллюстрации QARQYN

Семь самостоятельных растровых изображений созданы встроенным `image_gen` с `transparent_background: true`. Пользовательские API-ключи и CLI генерации не использовались. Это художественная тема интерфейса, не фотографии оборудования и не данные о производстве Allur.

## Подключаемые ресурсы

| Изображение     | Файлы в public                                           | Содержание                                                        |
| --------------- | -------------------------------------------------------- | ----------------------------------------------------------------- |
| Главная         | `cosmic-hero.webp`, `cosmic-hero-768.webp`               | Сборочный ангар с надписью QARQYN и ракета на стартовом комплексе |
| Склад           | `cosmic-warehouse-384.webp`, `cosmic-warehouse-768.webp` | Секции корпуса, обтекатели и компоненты на стеллажах              |
| Сварка          | `cosmic-welding-384.webp`, `cosmic-welding-768.webp`     | Роботы соединяют цилиндрический корпус                            |
| Покрытие        | `cosmic-painting-384.webp`, `cosmic-painting-768.webp`   | Нанесение теплозащитного покрытия                                 |
| Сборка          | `cosmic-assembly-384.webp`, `cosmic-assembly-768.webp`   | Собранная ракета на горизонтальных ложементах                     |
| Контроль        | `cosmic-quality-384.webp`, `cosmic-quality-768.webp`     | Измерительная станция ракетного двигателя                         |
| Готовое изделие | `cosmic-finished-384.webp`, `cosmic-finished-768.webp`   | Вертикальная ракета и башня обслуживания                          |

Станции квадратные. Главная — 1536×1024 и уменьшенный вариант 768×512. Pillow использован только для изменения размера и кодирования WebP, альфа-канал сохранён; ручное рисование, удаление фона скриптом и CSS-заглушки не применялись. Проверены размеры и прозрачность: альфа углов 0–1 из 255, прозрачное окружение сохранено. Все семь сюжетов осмотрены визуально.

Исходные PNG скопированы в локальную рабочую папку `work/cosmic-assets` текущего задания, вне публичного репозитория. Встроенные оригиналы сохранены в `$CODEX_HOME/generated_images/01a11b6d-d4af-76d2-9433-0b01c30dfb36/`:

| Ресурс           | Исходный файл встроенного генератора            |
| ---------------- | ----------------------------------------------- |
| cosmic-hero      | `exec-525058c3-4e0e-4682-8828-6a6fc1508a35.png` |
| cosmic-warehouse | `exec-2faef46d-04df-4178-9967-f14bdd40424e.png` |
| cosmic-welding   | `exec-af51b39a-4cd7-41da-b224-1161aa44f288.png` |
| cosmic-painting  | `exec-b57b3927-1b84-4c55-94d7-fde816cc6559.png` |
| cosmic-assembly  | `exec-8c80d8a5-5e9f-45e7-80f4-9ea3fd1fab58.png` |
| cosmic-quality   | `exec-87d1a0a4-47dd-4be7-b579-bf3cad39ef45.png` |
| cosmic-finished  | `exec-53fc360d-33e2-4dfb-9cdb-4484ab011473.png` |

## Промпт главного изображения

```text
Use case: stylized-concept.
Asset type: wide transparent hero cutout for QARQYN cosmic night interface.
Primary request: a breathtaking refined industrial miniature rocket assembly and launch complex, a real-looking civilian orbital launch vehicle with slender brushed-silver body and warm ivory nose. The finished rocket is upright beside a delicately engineered open gantry on the right, while on the left an open roofless precision assembly hangar contains another horizontal fuselage and a few small ivory/silver robotic arms and gold service rails. One coherent connected engineered facility, not a collection of icons.
Composition: wide landscape canvas, orthographic isometric 30-degree elevated front-left view, entire complex visible, generous 8% fully transparent margin. Rocket and hangar integrated on one shallow charcoal physical platform, detailed enough for a large hero but simple readable silhouette.
Materials: brushed aluminium silver, warm ivory ceramic, satin charcoal and very restrained champagne-gold fasteners and rails. Fine white rim lighting and clean bright studio illumination make every silhouette edge legible when placed on pure black. Luxury aerospace architecture render, believable precision mechanics.
Text (verbatim): "QARQYN" in modest engraved dark uppercase lettering on one silver hangar fascia, spelled Q-A-R-Q-Y-N, no other text.
Background: genuine alpha transparency outside physical structures. No surrounding floor or sky, no stars, no black rectangle, no checkerboard drawing, no atmospheric glow, no people, no flags, no other logos, no watermark, no weapons, no plume or flames. This is a civilian space launch vehicle assembly site.
```

## Общая часть промпта шести станций

Для каждой станции выполнен отдельный вызов. Полный промпт — общая часть ниже плюс соответствующий Subject.

```text
Use case: stylized-concept.
Asset type: standalone transparent cutout for QARQYN aerospace manufacturing interface, viewed at small sizes on pure black.
Style: exceptionally refined high-end industrial product visualization, physically plausible engineered miniature diorama, precise orthographic isometric camera at 30-degree elevation looking from front-left. Photoreal brushed silver aluminium, warm ivory ceramic, sparse champagne-gold connectors and rails, charcoal structural bases. Crisp fine white edge illumination, soft studio key lighting, strong material readability against black when composited. No colored glow.
Composition: one self-contained station, square canvas, completely visible including base, 10% transparent breathing room on every side, no cropping. Cohesive art direction across a six-station rocket manufacturing sequence.
Background: true alpha transparency everywhere outside the physical object; no environment, sky, stars, room, rectangle, ground plane, checkerboard drawing or vignette. Small physical stand/platform is allowed. No labels, UI, arrows, captions, humans, flags, launch flames, missiles, weapons, brand logos, watermark.
```

### warehouse

```text
Subject: rocket components depot. Three elegant low silver racks hold neatly ordered cylindrical fuselage sections, ivory nose-cone shells and compact golden fuel-system hardware; a small silver industrial parts trolley beside them. Clear warehouse function. Rocket parts, no cars. Avoid excessive tiny clutter.
```

### welding

```text
Subject: precision fuselage welding station. A long cylindrical silver civilian rocket fuselage lies horizontally on two charcoal cradles, with an open circular end showing thin internal ribs. Two sculptural ivory industrial robot arms with gold joints reach to a circular join line; a tiny realistic warm welding point, not a glowing cloud. Overhead slim silver structural gantry and disciplined cable routing. No car shapes.
```

### painting

```text
Subject: thermal-protection coating station. A short smooth silver rocket upper-stage module with warm ivory ceramic-coated nose rests horizontally on two precise cradles. One refined ivory robot arm with gold joints holds a small coating applicator beside the module, and a second compact inspection carriage travels on a silver gantry. Show a visually clear transition between silver metal and clean ivory thermal-protection coating, engineered panel seams, clean meticulous finish. No spray clouds, no smoke, no scene background.
```

### assembly

```text
Subject: final spacecraft assembly station. One beautiful fully integrated long civilian orbital launch vehicle lies horizontally on three low dark cradles, slender silver cylindrical fuselage, elegant ivory aerodynamic nose at the left, visibly detailed compact rocket-engine bell at the right, narrow champagne-gold interface rings, small restrained fins. Two small mechanical service manipulators connect fine hardware around the rear engine. Open engineering assembly platform with silver rails, no enclosing room, strong clean rocket silhouette, show entire nose and engine, no cropping.
```

### quality

```text
Subject: precise aerospace inspection station. A highly detailed silver rocket engine module with one broad ribbed bell nozzle, metallic plumbing and sparse golden connectors is held tilted horizontally on a compact dark mounting cradle. A slim silver rectangular metrology gantry with ivory optical sensor head spans the module, and a small ivory robotic measuring arm reaches near the nozzle. Clean organized technical composition, unmistakeable engine quality inspection, no hologram, no lasers, no glowing screen, no labels.
```

### finished

```text
Subject: finished civilian orbital launch vehicle on a compact launch stand. Elegant tall slender brushed-silver rocket upright, rounded warm ivory payload fairing, subtle panel seams and narrow gold interface rings, four small understated metallic fins around the base. A slim silver service tower with two narrow fold-away maintenance platforms stands slightly behind it, enough mechanical detail to communicate launch readiness. Engine bells visible below the rocket over a small open stand. No firing, no smoke, no exhaust, no horizon. The finished rocket silhouette must be extremely clear at thumbnail size, entire tip and base visible. Tall subject arranged within the same square canvas as other stations.
```

## Выбор версии

Для главной дополнительно проверены два варианта: редактирование фона и повторная генерация более компактной сцены. В интерфейс выбран исходный подробный комплекс с правильной надписью QARQYN. У видимого в некоторых превью серого окружения проверен альфа-канал: оно полностью прозрачно. Сравнивать вид на чёрном фоне нужно с корректной альфа-композицией, а не только по скрытым RGB-значениям PNG.
