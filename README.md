# Qoder CLI — Telegram Bridge

> Полноценный мост между Telegram и Qoder CLI с поддержкой голосовых сообщений, изображений и файлов.

## Обзор

Telegram-бот, который даёт удалённый доступ к Qoder CLI со смартфона. Каждый запрос обрабатывается настоящим Qoder CLI с полным доступом к файловой системе, bash, поиску и MCP-серверам.

**Архитектура:** heyagent-паттерн — бот запускает qodercli.exe как subprocess, стримит ответ обратно в Telegram.

## Возможности

| Тип | Как использовать | Что происходит |
|-----|-----------------|----------------|
| Текст | Отправить сообщение | Прямой запрос к Qoder CLI |
| Голосовое | Записать голосовое | Whisper транскрипция (ru) → Qoder |
| Фото | Отправить изображение | Скачивается → Qoder анализирует |
| Файл | Отправить документ | Скачивается → Qoder читает/правит |

## Быстрый старт

### Требования

- Windows Server (10/11/Server 2019+)
- Node.js 18+
- Qoder CLI установлен
- Telegram Bot Token (от [@BotFather](https://t.me/BotFather))
- Groq API Key (для голосовых, опционально) — [console.groq.com/keys](https://console.groq.com/keys)
- ffmpeg (для конвертации аудио, для голосовых)

### Установка

```bash
# 1. Перейти в директорию
cd C:\Qoder_CLI\qoder-telegram-bridge

# 2. Установить зависимости
npm install

# 3. Настроить .env
copy .env.example .env
# Отредактировать .env — вставить BOT_TOKEN и GROQ_API_KEY

# 4. Запустить
start.bat
```

### Настройка .env

```env
BOT_TOKEN=8736164805:AAEvYoXcuv2n1B0fmy6y1k5ZP7TTLsJtph0
ALLOWED_USERS=382401183
QODER_CLI=C:\Qoder_CLI\v0148\qodercli.exe
QODER_HOME=C:\Qoder_CLI
MAX_TIMEOUT=300
YOLO=true
GROQ_API_KEY=gsk_xxx
WHISPER_MODEL=large-v3-turbo
WHISPER_FALLBACK_API=true
```

| Параметр | Описание | По умолчанию |
|----------|----------|-------------|
| `BOT_TOKEN` | Токен Telegram бота | обязательно |
| `ALLOWED_USERS` | ID пользователей через запятую | `382401183` |
| `QODER_CLI` | Путь к qodercli.exe | `C:\Qoder_CLI\v0148\qodercli.exe` |
| `QODER_HOME` | Рабочая директория Qoder | `C:\Qoder_CLI` |
| `MAX_TIMEOUT` | Макс. время запроса (сек) | `300` |
| `YOLO` | Авто-выполнение команд | `true` |
| `GROQ_API_KEY` | Ключ для Whisper транскрипции | опционально |

### Автозапуск при загрузке

```bash
# Установка в планировщик задач Windows
schtasks.exe /Create /TN "QoderTelegramBridge" /TR "C:\Qoder_CLI\qoder-telegram-bridge\start.bat" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
```

Бот запускается автоматически при старте сервера и работает 24/7.

## Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Приветствие и список возможностей |
| `/help` | Подробная справка |
| `/new` | Новая сессия (очистить контекст) |
| `/sessions` | Статус сессии |
| `/ping` | Проверка связи |

## Архитектура

```
Telegram ──polling──> bridge.js ──spawn──> qodercli.exe --continue --yolo
                    │                       │
                    │  стрим stdout         │  файлы, bash, поиск, MCP
                    │<──────────────────────│
                    │
                    └──editMsg──> Telegram (ответ пользователю)
```

### Компоненты

- **bridge.js** — основной процесс, Telegram bot + менеджер сессий
- **qodercli.exe** — Qoder CLI, запускается как subprocess на каждый запрос
- **sessions/** — JSON файлы с историей сообщений
- **attachments/** — скачанные из Telegram файлы
- **start.bat** — обёртка с авто-рестартом при краше

### Как работает память

1. **Qoder CLI `--continue`** — сам помнит историю через `.qoder` директорию
2. **sessions/*.json** — дополнительная история для отладки
3. Каждая сессия привязана к userId пользователя Telegram

### Почему qodercli работает из C:\Qoder_CLI

Qoder CLI ищет `.qoder` директорию в рабочей директории. Если запустить из другой папки — ошибка "project path not exists". Поэтому `QODER_HOME=C:\Qoder_CLI` и `cwd` в spawn указан правильно.

## Голосовые сообщения

Конвейер обработки голосовых:

1. Telegram присылает OGG/Opus (`.oga`)
2. Скачивается в `attachments/`
3. **ffmpeg** конвертирует OGG Opus → WAV (16kHz, mono)
4. **Groq Whisper API** (`whisper-large-v3-turbo`) транскрибирует с `language=ru`
5. Текст отправляется как запрос к Qoder CLI

Без ffmpeg Groq API может вернуть ошибку 400, т.к. не принимает `.oga` формат.

## Решение проблем

### "qodercli exited with code 1"
Убедитесь что `QODER_HOME=C:\Qoder_CLI` и бот запущен из этой директории.

### "Ошибка транскрипции"
Проверьте: 1) установлен ffmpeg, 2) GROQ_API_KEY в .env верный.

### Бот не отвечает
Проверьте: 1) BOT_TOKEN верный, 2) процесс bridge.js запущен, 3) ваш ID в ALLOWED_USERS.

### 401 Unauthorized
Неверный или неполный BOT_TOKEN. Возьмите полный токен у @BotFather.

## Зависимости

| Пакет | Версия | Назначение |
|-------|--------|------------|
| node-telegram-bot-api | ^0.66.0 | Telegram Bot API (polling) |

## Структура проекта

```
qoder-telegram-bridge/
├── bridge.js           # Основной код бота
├── package.json        # Зависимости
├── .env                # Конфигурация (не коммитить!)
├── .env.example        # Пример конфигурации
├── .gitignore          # Игнорируемые файлы
├── start.bat           # Авто-рестарт обёртка
├── sessions/           # Файлы сессий (git ignore)
├── attachments/        # Скачанные файлы (git ignore)
└── README.md           # Документация
```

## Лицензия

MIT
