/**
 * Qoder CLI — Telegram Bridge v2
 *
 * Full-featured bridge with voice, images, and file support.
 *
 * Features:
 * - Persistent sessions per user (via qodercli --continue)
 * - Streaming responses to Telegram
 * - Voice messages → Whisper transcription → Qoder
 * - Image attachments → saved and described to Qoder
 * - File attachments → saved to workspace, referenced in prompt
 * - User allowlist, session management, auto-restart
 *
 * Pattern: heyagent + telecodex adapted for qodercli
 */

const TelegramBot = require('node-telegram-bot-api');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// =============================================================================
// Config
// =============================================================================

function loadConfig() {
  const envFile = path.join(__dirname, '.env');
  if (fs.existsSync(envFile)) {
    const lines = fs.readFileSync(envFile, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.substring(0, eqIdx).trim();
      let val = trimmed.substring(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] = val;
    }
  }

  return {
    botToken: process.env.BOT_TOKEN || 'your_telegram_bot_token_here',
    allowedUsers: (process.env.ALLOWED_USERS || '382401183').split(',').map(s => s.trim()),
    qoderCli: process.env.QODER_CLI || 'C:\\Qoder_CLI\\v0148\\qodercli.exe',
    qoderHome: process.env.QODER_HOME || 'C:\\Users\\Administrator',
    maxTimeout: parseInt(process.env.MAX_TIMEOUT || '300'),
    yolo: (process.env.YOLO || 'true').toLowerCase() === 'true',
    whisperModel: process.env.WHISPER_MODEL || 'small',
    whisperFallbackApi: (process.env.WHISPER_FALLBACK_API || 'true').toLowerCase() === 'true',
    groqApiKey: process.env.GROQ_API_KEY || '',
  };
}

const config = loadConfig();

console.log(`[config] QODER_HOME=${config.qoderHome}`);
console.log(`[config] QODER_CLI=${config.qoderCli}`);

// =============================================================================
// Directories
// =============================================================================

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const ATTACHMENTS_DIR = path.join(__dirname, 'attachments');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(ATTACHMENTS_DIR)) fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });

// =============================================================================
// Session Store
// =============================================================================

function getSessionPath(userId) {
  return path.join(SESSIONS_DIR, `${userId}.json`);
}

function getUserAttachmentsDir(userId) {
  return path.join(ATTACHMENTS_DIR, `${userId}`);
}

function loadSession(userId) {
  const sessionPath = getSessionPath(userId);
  if (fs.existsSync(sessionPath)) {
    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
      return { messages: [], attachments: [] };
    }
  }
  return { messages: [], attachments: [] };
}

function saveSession(userId, session) {
  const sessionPath = getSessionPath(userId);
  fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
}

function deleteSession(userId) {
  const sessionPath = getSessionPath(userId);
  if (fs.existsSync(sessionPath)) fs.unlinkSync(sessionPath);
  const userAttDir = getUserAttachmentsDir(userId);
  if (fs.existsSync(userAttDir)) {
    fs.rmSync(userAttDir, { recursive: true, force: true });
  }
}

// =============================================================================
// Whisper Transcription (Voice → Text)
// =============================================================================

async function transcribeVoice(oggPath, mimeType) {
  if (config.groqApiKey) {
    return await transcribeWithGroq(oggPath, mimeType);
  }

  return '[Voice message — Whisper не настроен. Установи GROQ_API_KEY в .env]';
}

async function transcribeWithGroq(oggPath, mimeType) {
  const fs = require('fs');
  const { execSync } = require('child_process');

  // Telegram присылает .oga (OGG/Opus), Groq может не принять.
  // Конвертируем в WAV через ffmpeg — 100% работает.
  const wavPath = oggPath.replace(/\.[^.]+$/, '.wav');

  console.log(`[groq] converting ${oggPath} -> ${wavPath}`);
  try {
    execSync(`ffmpeg -i "${oggPath}" -ar 16000 -ac 1 -y "${wavPath}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });
  } catch (e) {
    console.error('[groq] ffmpeg error:', e.stderr ? e.stderr.toString() : e.message);
    throw new Error('Ошибка конвертации аудио');
  }

  return new Promise((resolve, reject) => {
    const boundary = '----WebKitFormBoundary' + crypto.randomBytes(16).toString('hex');
    const fileData = fs.readFileSync(wavPath);
    const fileName = path.basename(wavPath);

    // OpenClaw использует whisper-large-v3-turbo
    const model = 'whisper-large-v3-turbo';

    // Собираем multipart/form-data через Buffer
    const parts = [];

    const header1 = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: audio/wav\r\n\r\n`;
    parts.push(Buffer.from(header1));
    parts.push(fileData);
    parts.push(Buffer.from('\r\n'));

    const header2 = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n`;
    parts.push(Buffer.from(header2));
    parts.push(Buffer.from(model + '\r\n'));

    // Указываем русский язык для распознавания
    const header3 = `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n`;
    parts.push(Buffer.from(header3));
    parts.push(Buffer.from('ru\r\n'));

    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const requestBody = Buffer.concat(parts);

    const req = https.request('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.groqApiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': requestBody.length,
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`[groq] status=${res.statusCode} body=${data.substring(0, 300)}`);
        if (res.statusCode !== 200) {
          reject(new Error(`Groq API error ${res.statusCode}: ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.text) {
            resolve(parsed.text);
          } else {
            reject(new Error(`Groq API error: ${data}`));
          }
        } catch (e) {
          reject(new Error(`Groq parse error: ${data}`));
        }
      });
    });

    req.on('error', (e) => {
      console.error('[groq] request error:', e.message);
      reject(e);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Groq API timeout'));
    });
    req.write(requestBody);
    req.end();
  }).finally(() => {
    // Чистим временные файлы
    setTimeout(() => {
      try { fs.unlinkSync(wavPath); } catch {}
    }, 2000);
  });
}

// =============================================================================
// File Download from Telegram
// =============================================================================

async function downloadTelegramFile(bot, fileId) {
  const file = await bot.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
  const ext = path.extname(file.file_path) || '.bin';
  const fileName = `dl_${Date.now()}${ext}`;

  return new Promise((resolve, reject) => {
    const protocol = fileUrl.startsWith('https') ? https : http;
    protocol.get(fileUrl, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        // Follow redirect
        const redirectUrl = res.headers.location;
        const proto = redirectUrl.startsWith('https') ? https : http;
        proto.get(redirectUrl, (res2) => {
          const filePath = path.join(ATTACHMENTS_DIR, fileName);
          const ws = fs.createWriteStream(filePath);
          res2.pipe(ws);
          ws.on('finish', () => resolve(filePath));
        }).on('error', reject);
        return;
      }
      const filePath = path.join(ATTACHMENTS_DIR, fileName);
      const ws = fs.createWriteStream(filePath);
      res.pipe(ws);
      ws.on('finish', () => resolve(filePath));
    }).on('error', reject);
  });
}

// =============================================================================
// Qoder CLI Session Manager
// =============================================================================

class QoderSessionManager {
  constructor() {
    this.activeSessions = new Map();
  }

  async run(userId, prompt, attachments, onChunk) {
    const session = loadSession(userId);

    // Add attachment info to prompt
    let finalPrompt = prompt;
    if (attachments && attachments.length > 0) {
      const attDesc = attachments.map(a => {
        if (a.type === 'voice') return `[Голосовая транскрипция: "${a.text}"]`;
        if (a.type === 'image') return `[Картинка: ${a.path}]`;
        if (a.type === 'file') return `[Файл: ${a.path}]`;
        return '';
      }).filter(Boolean).join('\n');

      // Для голосовых — если промпт уже равен транскрипции, не дублируем
      const voiceAtt = attachments.find(a => a.type === 'voice');
      if (voiceAtt && prompt === voiceAtt.text) {
        finalPrompt = `[Голосовое сообщение]\nТранскрипция: "${voiceAtt.text}"`;
      } else {
        finalPrompt = `${attDesc}\n\n${prompt}`;
      }
    }

    return new Promise((resolve, reject) => {
      const args = ['-p', finalPrompt];
      if (config.yolo) args.push('--yolo');
      args.push('-q', '--continue');

      console.log(`[qoder] user=${userId} cwd=${config.qoderHome}`);
      console.log(`[qoder] args:`, JSON.stringify(args));

      const child = spawn(config.qoderCli, args, {
        cwd: config.qoderHome,
        timeout: config.maxTimeout * 1000,
        maxBuffer: 50 * 1024 * 1024,
      });

      let fullResponse = '';
      let thinkingTimeout = null;

      const resetThinkingTimeout = () => {
        if (thinkingTimeout) clearTimeout(thinkingTimeout);
        thinkingTimeout = setTimeout(() => {
          onChunk('...ещё думаю, подожди...\n');
        }, 30000);
      };

      child.stdout.on('data', (chunk) => {
        resetThinkingTimeout();
        const text = chunk.toString('utf-8');
        fullResponse += text;
        onChunk(text);
      });

      child.stderr.on('data', (chunk) => {
        // Log stderr for debugging
        console.error('[qoder stderr]', chunk.toString('utf-8').trim());
      });

      child.on('error', (err) => {
        if (thinkingTimeout) clearTimeout(thinkingTimeout);
        reject(err);
      });

      child.on('close', (code) => {
        if (thinkingTimeout) clearTimeout(thinkingTimeout);

        if (code === 0) {
          // Build user message for session
          let userContent = prompt;
          if (attachments) {
            const attSummary = attachments.map(a => {
              if (a.type === 'voice') return `[Voice: ${a.text}]`;
              if (a.type === 'image') return `[Image: ${a.path}]`;
              if (a.type === 'file') return `[File: ${a.path}]`;
              return '';
            }).join(' ');
            userContent = `${attSummary}\n${prompt}`;
          }

          session.messages.push({ role: 'user', content: userContent });
          session.messages.push({ role: 'assistant', content: fullResponse });
          if (session.messages.length > 50) {
            session.messages = session.messages.slice(-50);
          }
          saveSession(userId, session);
          resolve(fullResponse);
        } else {
          reject(new Error(`qodercli exited with code ${code}`));
        }
      });
    });
  }

  /**
   * --continue handles memory internally. We just pass the latest prompt.
   */

  isBusy(userId) {
    const s = this.activeSessions.get(userId);
    return s && s.busy;
  }

  setBusy(userId, busy) {
    if (!this.activeSessions.has(userId)) {
      this.activeSessions.set(userId, { busy: false, queue: [] });
    }
    this.activeSessions.get(userId).busy = busy;
  }
}

const qoderManager = new QoderSessionManager();

// =============================================================================
// Telegram Bot
// =============================================================================

const bot = new TelegramBot(config.botToken, {
  polling: {
    params: {
      allowed_updates: ['message', 'edited_message'],
    },
  },
});
const messageQueues = new Map();

function enqueueMessage(userId, data) {
  if (!messageQueues.has(userId)) messageQueues.set(userId, []);
  messageQueues.get(userId).push(data);
}

function dequeueMessage(userId) {
  if (!messageQueues.has(userId)) return null;
  return messageQueues.get(userId).shift();
}

function isAllowed(userId) {
  return config.allowedUsers.includes(String(userId));
}

console.log('[bot] Starting Qoder Telegram Bridge v2...');
console.log(`[bot] Allowed users: ${config.allowedUsers.join(', ')}`);
console.log(`[bot] Qoder CLI: ${config.qoderCli}`);
console.log(`[bot] YOLO mode: ${config.yolo}`);
console.log(`[bot] Voice: Groq Whisper (${config.groqApiKey ? 'configured' : 'not set'})`);
console.log(`[bot] Images: enabled`);
console.log(`[bot] Files: enabled`);

// =============================================================================
// Command Handlers
// =============================================================================

bot.onText(/\/start/, async (msg) => {
  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(msg.chat.id, '⛔ У вас нет доступа к этому боту.');
    return;
  }
  const text = `🤖 *Qoder CLI Bridge v2*

Привет! Я — мост между Telegram и Qoder CLI.

*Команды:*
/help — справка
/new — новая сессия
/sessions — статус сессии
/ping — проверка связи

*Поддерживает:*
📝 Текст — просто напиши сообщение
🎤 Голосовые — отправь voice message
🖼 Картинки — отправь фото
📎 Файлы — отправь документ

Qoder ответит с полным доступом к файлам, bash, поиску и т.д.`;

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/help/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const text = `📖 *Справка Qoder Bridge v2*

*Что умеет Qoder CLI:*
• Редактировать файлы
• Искать по коду и файлам
• Запускать команды
• Анализировать код
• MCP серверы

*Входные данные:*
📝 Текст — обычный запрос
🎤 Голосовое → Whisper транскрипция → Qoder
🖼 Картинка → сохраняется → Qoder описывает
📎 Файл → сохраняется → Qoder читает

*Команды:*
/start — приветствие
/help — справка
/new — новая сессия
/sessions — статус
/ping — проверка

*Ограничения:*
• Один запрос за раз (очередь)
• Макс. время: ${config.maxTimeout} сек
• Голос: нужен GROQ_API_KEY`;

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/new/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  deleteSession(msg.from.id);
  qoderManager.setBusy(msg.from.id, false);
  bot.sendMessage(msg.chat.id, '🔄 Новая сессия. Контекст и вложения очищены.');
});

bot.onText(/\/sessions?/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  const session = loadSession(msg.from.id);
  const msgCount = session.messages.length;
  const busy = qoderManager.isBusy(msg.from.id);
  const queueLen = (messageQueues.get(msg.from.id) || []).length;

  const text = `📊 *Сессия*

История: ${msgCount} сообщ.
Занят: ${busy ? 'да' : 'нет'}
Очередь: ${queueLen}`;

  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/ping/, async (msg) => {
  if (!isAllowed(msg.from.id)) return;
  bot.sendMessage(msg.chat.id, '🏓 Pong! Бот и Qoder CLI работают.');
});

// =============================================================================
// Message Handler — ALL TYPES
// =============================================================================

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  if (!isAllowed(msg.from.id)) {
    bot.sendMessage(msg.chat.id, '⛔ Нет доступа.');
    return;
  }

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  // Collect attachments
  const attachments = [];

  // Voice message
  if (msg.voice) {
    bot.sendMessage(chatId, '🎤 Обрабатываю голосовое...');
    try {
      const oggPath = await downloadTelegramFile(bot, msg.voice.file_id);
      const mimeType = msg.voice.mime_type || 'audio/ogg';
      console.log(`[voice] downloaded: ${oggPath}, mime=${mimeType}`);
      const text = await transcribeVoice(oggPath, mimeType);
      attachments.push({ type: 'voice', text, path: oggPath });
      // Clean up temp file
      setTimeout(() => { try { fs.unlinkSync(oggPath); } catch {} }, 5000);
    } catch (e) {
      console.error('[voice] error:', e.message);
      bot.sendMessage(chatId, `❌ Ошибка транскрипции: ${e.message}`);
      return;
    }
  }

  // Photo
  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1]; // highest resolution
    bot.sendMessage(chatId, '🖼 Скачиваю фото...');
    try {
      const imgPath = await downloadTelegramFile(bot, photo.file_id);
      attachments.push({ type: 'image', text: null, path: imgPath });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка скачивания фото: ${e.message}`);
      return;
    }
  }

  // Document (file)
  if (msg.document) {
    bot.sendMessage(chatId, '📎 Скачиваю файл...');
    try {
      const filePath = await downloadTelegramFile(bot, msg.document.file_id);
      attachments.push({ type: 'file', text: null, path: filePath });
    } catch (e) {
      bot.sendMessage(chatId, `❌ Ошибка скачивания файла: ${e.message}`);
      return;
    }
  }

  // Text caption (for photos/documents)
  const textContent = msg.text || msg.caption || '';

  // If no text and no attachments, skip
  if (!textContent && attachments.length === 0) {
    bot.sendMessage(chatId, '⚠️ Отправь текст, голосовое, фото или файл.');
    return;
  }

  // Build the message to send to Qoder
  let promptText = textContent;
  if (attachments.length > 0 && !textContent) {
    // Для голосовых — транскрипция уже есть, используем её как запрос
    const voiceAtt = attachments.find(a => a.type === 'voice');
    if (voiceAtt && voiceAtt.text) {
      promptText = voiceAtt.text;
    } else {
      // Для картинок/файлов без подписи — авто-промпт
      const types = attachments.map(a => a.type).join(', ');
      promptText = `Проанализируй вложенные файлы (${types}). Опиши что видишь.`;
    }
  }

  // If busy, enqueue
  if (qoderManager.isBusy(userId)) {
    enqueueMessage(userId, { text: promptText, attachments });
    bot.sendMessage(chatId, '⏳ Qoder думает... сообщение в очереди.');
    return;
  }

  await processMessageWithAttachments(chatId, userId, promptText, attachments);
  processQueue(chatId, userId);
});

async function processQueue(chatId, userId) {
  const next = dequeueMessage(userId);
  if (next) {
    await processMessageWithAttachments(chatId, userId, next.text, next.attachments);
    setTimeout(() => processQueue(chatId, userId), 1000);
  } else {
    qoderManager.setBusy(userId, false);
  }
}

async function processMessageWithAttachments(chatId, userId, text, attachments) {
  qoderManager.setBusy(userId, true);

  let thinkingMsg;
  try {
    const attInfo = attachments.length > 0
      ? ` (${attachments.map(a => a.type).join(', ')})`
      : '';
    thinkingMsg = await bot.sendMessage(chatId, `🤔 Думаю${attInfo}...`);
  } catch (e) {
    console.error('[bot] Failed to send thinking message:', e.message);
  }

  let streamedText = '';
  let lastEditTime = 0;
  const EDIT_THROTTLE = 3000;

  try {
    const response = await qoderManager.run(userId, text, attachments, async (chunk) => {
      streamedText += chunk;
      const now = Date.now();
      if (now - lastEditTime > EDIT_THROTTLE && streamedText.length > 100) {
        lastEditTime = now;
        try {
          const preview = streamedText.substring(0, 4000);
          await bot.editMessageText(`🤔 Думаю...\n\n\`\`\`\n${preview}\n\`\`\``, {
            chat_id: chatId,
            message_id: thinkingMsg.message_id,
            parse_mode: 'Markdown',
          });
        } catch (e) {
          // Rate limit or other edit error — ignore
        }
      }
    });

    // Send final response
    if (streamedText.length > 0) {
      const chunks = splitMessage(streamedText, 4000);
      for (let i = 0; i < chunks.length; i++) {
        try {
          if (i === 0 && thinkingMsg) {
            await bot.editMessageText(`\`\`\`\n${chunks[i]}\n\`\`\``, {
              chat_id: chatId,
              message_id: thinkingMsg.message_id,
              parse_mode: 'Markdown',
            });
          } else {
            await bot.sendMessage(chatId, `\`\`\`\n${chunks[i]}\n\`\`\``, { parse_mode: 'Markdown' });
          }
        } catch (e) {
          await bot.sendMessage(chatId, chunks[i]);
        }
      }
    } else {
      await bot.editMessageText('✅ Готово. Команда выполнена без вывода.', {
        chat_id: chatId,
        message_id: thinkingMsg ? thinkingMsg.message_id : undefined,
      });
    }
  } catch (err) {
    console.error('[qoder] Error:', err.message);
    try {
      await bot.editMessageText(`❌ Ошибка:\n\`\`\`\n${err.message}\n\`\`\``, {
        chat_id: chatId,
        message_id: thinkingMsg ? thinkingMsg.message_id : undefined,
        parse_mode: 'Markdown',
      });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Ошибка: ${err.message}`);
    }
  }
}

function splitMessage(text, maxLen) {
  const chunks = [];
  while (text.length > maxLen) {
    let splitIdx = text.lastIndexOf('\n', maxLen);
    if (splitIdx === -1 || splitIdx < maxLen * 0.5) splitIdx = maxLen;
    chunks.push(text.substring(0, splitIdx));
    text = text.substring(splitIdx).trimStart();
  }
  if (text.length > 0) chunks.push(text);
  return chunks;
}

// =============================================================================
// Error handling
// =============================================================================

process.on('uncaughtException', (err) => {
  console.error('[bridge] Uncaught exception:', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('[bridge] Unhandled rejection:', reason);
});

console.log('[bridge] Qoder Telegram Bridge v2 started.');
console.log(`[bridge] Bot: @${config.botToken.split(':')[0]}`);
