const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const QR_LOGIN = process.env.QR_LOGIN || 'ng909';
const QR_PASSWORD = process.env.QR_PASSWORD || '';
const QR_LAYER = process.env.QR_LAYER || 'ng909';
const QR_JSESSIONID = process.env.QR_JSESSIONID || '';
const QR_REMEMBER_ME = process.env.QR_REMEMBER_ME || '';
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('Ошибка: нужны TELEGRAM_TOKEN и ANTHROPIC_API_KEY');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const QR_AUTH = Buffer.from(`${QR_LOGIN}:${QR_PASSWORD}`).toString('base64');
const QR_BASE = `https://${QR_LAYER}.quickresto.ru`;
const conversations = new Map();

const SESSION_COOKIE = `JSESSIONID=${QR_JSESSIONID}; SPRING_SECURITY_REMEMBER_ME_COOKIE=${QR_REMEMBER_ME}`;

function qrGet(path) {
  return new Promise((resolve) => {
    const url = new URL(QR_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': SESSION_COOKIE,
        'Referer': `https://${QR_LAYER}.quickresto.ru/`
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: data.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 'network_error', data: e.message }));
    req.setTimeout(25000, () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout', data: 'Сервер не ответил за 25 секунд' });
    });
    req.end();
  });
}

function qrPost(path, body) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body || {});
    const url = new URL(QR_BASE + path);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + QR_AUTH,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: JSON.parse(data) });
        } catch(e) {
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: data.slice(0, 500) });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 'network_error', data: e.message }));
    req.setTimeout(25000, () => {
      req.destroy();
      resolve({ ok: false, status: 'timeout', data: 'Сервер не ответил за 25 секунд' });
    });
    req.write(postData);
    req.end();
  });
}

function getSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Ты — агент для управления складом кофейни через Quick Resto API.
BASE URL: ${QR_BASE}
Сегодня: ${today}

У тебя есть инструмент qr_api. Всегда выполняй реальные запросы через него.

ENDPOINTS:

=== ЧТЕНИЕ (GET через /platform/data/) ===

1. Склады:
   method: GET
   path: /platform/data/warehouse.store/select?count=100

2. Поставщики:
   method: GET
   path: /platform/data/warehouse.providers/select?count=100

3. Ингредиенты:
   method: GET
   path: /platform/data/warehouse.nomenclature/select?count=200

4. Приходные накладные за последние 30 дней:
   method: GET
   path: /platform/data/warehouse.documents.incoming/select?mode=previous30Days&start=0&count=50&sortField%5BD%5D=invoiceDate&sortOrder%5BD%5D=desc&businessDayOffsetInMs=25200000&timeZone=-480

5. Приходные накладные за сегодня:
   method: GET
   path: /platform/data/warehouse.documents.incoming/select?mode=today&start=0&count=50&sortField%5BD%5D=invoiceDate&sortOrder%5BD%5D=desc&businessDayOffsetInMs=25200000&timeZone=-480

6. Одна накладная по id:
   method: GET
   path: /platform/data/warehouse.documents.incoming/select?objectId=ID

7. Перемещения за последние 30 дней:
   method: GET
   path: /platform/data/warehouse.documents.exchange/select?mode=previous30Days&start=0&count=50&sortField%5BD%5D=invoiceDate&sortOrder%5BD%5D=desc&businessDayOffsetInMs=25200000&timeZone=-480

8. Перемещения за сегодня:
   method: GET
   path: /platform/data/warehouse.documents.exchange/select?mode=today&start=0&count=50

=== СОЗДАНИЕ И ПРОВЕДЕНИЕ (POST через /platform/online/api/) ===

9. Создать приходную накладную:
   method: POST
   path: /platform/online/api/create?moduleName=warehouse.documents.incoming&className=ru.edgex.quickresto.modules.warehouse.documents.incoming.IncomingInvoice
   body: {"contractor":{"id":ID},"store":{"id":ID},"invoiceDate":"${today}T00:00:00","items":[{"nomenclature":{"id":ID},"amount":N,"unitPrice":N}]}

10. Провести накладную:
    method: POST
    path: /platform/online/api/moduleFunction?moduleName=warehouse.documents.incoming&funcName=conduct
    body: {"id":ID}

11. Создать перемещение:
    method: POST
    path: /platform/online/api/create?moduleName=warehouse.documents.exchange&className=ru.edgex.quickresto.modules.warehouse.documents.exchange.Exchange
    body: {"storeFrom":{"id":ID},"storeTo":{"id":ID},"invoiceDate":"${today}T00:00:00","items":[{"nomenclature":{"id":ID},"amount":N}]}

12. Провести перемещение:
    method: POST
    path: /platform/online/api/moduleFunction?moduleName=warehouse.documents.exchange&funcName=conduct
    body: {"id":ID}

ПРАВИЛА:
- Для чтения используй GET через /platform/data/
- Для создания и проведения используй POST через /platform/online/api/
- Если нужны id — сначала получи через список.
- Перед проведением документа предупреди что необратимо и жди подтверждения.
- Отвечай кратко на русском. Используй эмодзи умеренно.`;
}

async function callClaude(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, 2);

  const tools = [{
    name: 'qr_api',
    description: 'Выполнить запрос к Quick Resto API. GET для чтения данных, POST для создания/проведения документов.',
    input_schema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST'] },
        path: { type: 'string', description: 'Путь запроса включая query параметры' },
        body: { type: 'object', description: 'Тело для POST запросов' }
      },
      required: ['method', 'path']
    }
  }];

  let messages = [...history];
  let finalReply = '';

  for (let i = 0; i < 6; i++) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1500,
      system: getSystemPrompt(),
      tools,
      messages
    });

    if (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });
      const toolResults = [];
      for (const block of assistantContent) {
        if (block.type === 'tool_use') {
          const { method, path, body } = block.input;
          console.log(`QR API: ${method} ${path}`);
          const result = method === 'GET'
            ? await qrGet(path)
            : await qrPost(path, body || {});
          console.log(`QR API response: ${result.status}`, JSON.stringify(result.data).slice(0, 300));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: JSON.stringify(result)
          });
        }
      }
      messages.push({ role: 'user', content: toolResults });
    } else {
      finalReply = response.content.map(b => b.text || '').join('');
      break;
    }
  }

  if (!finalReply) finalReply = 'Не удалось получить ответ. Попробуй ещё раз.';
  history.push({ role: 'assistant', content: finalReply });
  return finalReply;
}

function isAllowed(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(userId);
}

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) { bot.sendMessage(msg.chat.id, 'Нет доступа.'); return; }
  conversations.delete(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `☕ *Агент склада — Quick Resto*\n\nПодключён к ${QR_LAYER}.quickresto.ru\n\nЧто умею:\n• Просматривать приходные накладные\n• Создавать и проводить накладные\n• Управлять внутренними перемещениями\n• Показывать склады, поставщиков, ингредиенты\n\nПросто напиши что нужно!`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/reset/, (msg) => {
  conversations.delete(msg.from.id);
  bot.sendMessage(msg.chat.id, 'История диалога очищена.');
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAllowed(msg.from.id)) { bot.sendMessage(msg.chat.id, 'Нет доступа.'); return; }

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4000);
  bot.sendChatAction(chatId, 'typing').catch(() => {});

  try {
    const reply = await callClaude(userId, msg.text);
    clearInterval(typing);
    const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' })
        .catch(() => bot.sendMessage(chatId, chunk));
    }
  } catch (err) {
    clearInterval(typing);
    console.error('Ошибка:', err.message);
    bot.sendMessage(chatId, 'Ошибка: ' + err.message);
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));
console.log(`Бот запущен. Слой: ${QR_LAYER}.quickresto.ru`);
