const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const QR_LOGIN = process.env.QR_LOGIN || 'ng909';
const QR_PASSWORD = process.env.QR_PASSWORD || '';
const QR_LAYER = process.env.QR_LAYER || 'ng909';
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

function qrRequest(path, body) {
  return new Promise((resolve) => {
    const postData = JSON.stringify(body || {});
    
    let fullPath = path;
    if (body && body.moduleName) {
      const params = new URLSearchParams();
      params.set('moduleName', body.moduleName);
      if (body.className) params.set('className', body.className);
      if (body.count) params.set('count', body.count);
      if (body.funcName) params.set('funcName', body.funcName);
      fullPath = path + '?' + params.toString();
    }

    const url = new URL(QR_BASE + fullPath);
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
          resolve({ ok: res.statusCode < 400, status: res.statusCode, data: data });
        }
      });
    });
    req.on('error', (e) => resolve({ ok: false, status: 'network_error', data: e.message }));
    req.write(postData);
    req.end();
  });
}

function getSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Ты — агент для управления складом кофейни через Quick Resto API.
BASE URL: ${QR_BASE}
Сегодня: ${today}

У тебя есть инструмент qr_api для запросов к API. Используй ТОЛЬКО его, никогда не описывай запросы.

ВАЖНО: Quick Resto принимает ТОЛЬКО POST запросы с телом JSON, даже для чтения данных.

ENDPOINTS (все POST):
1. Склады: /platform/online/api/list
   body: {"moduleName":"warehouse.storehouse","className":"ru.edgex.quickresto.modules.warehouse.storehouse.Storehouse"}

2. Поставщики: /platform/online/api/list
   body: {"moduleName":"contractor.supplier","className":"ru.edgex.quickresto.modules.contractor.Contractor"}

3. Ингредиенты: /platform/online/api/list
   body: {"moduleName":"warehouse.nomenclature","className":"ru.edgex.quickresto.modules.warehouse.nomenclature.Nomenclature","count":100}

4. Приходные накладные: /platform/online/api/list
   body: {"moduleName":"warehouse.incomingInvoice","className":"ru.edgex.quickresto.modules.warehouse.incomingInvoice.IncomingInvoice","count":20}

5. Создать приходную накладную: /platform/online/api/create
   body: {"moduleName":"warehouse.incomingInvoice","className":"ru.edgex.quickresto.modules.warehouse.incomingInvoice.IncomingInvoice","contractor":{"id":ID},"storehouse":{"id":ID},"comment":"...","items":[{"nomenclature":{"id":ID},"amount":N,"unitPrice":N}]}

6. Провести накладную: /platform/online/api/moduleFunction
   body: {"moduleName":"warehouse.incomingInvoice","funcName":"conduct","id":ID}

7. Перемещения: /platform/online/api/list
   body: {"moduleName":"warehouse.internalTransfer","className":"ru.edgex.quickresto.modules.warehouse.internalTransfer.InternalTransfer","count":20}

8. Создать перемещение: /platform/online/api/create
   body: {"moduleName":"warehouse.internalTransfer","className":"ru.edgex.quickresto.modules.warehouse.internalTransfer.InternalTransfer","storehouseFrom":{"id":ID},"storehouseTo":{"id":ID},"items":[{"nomenclature":{"id":ID},"amount":N}]}

9. Провести перемещение: /platform/online/api/moduleFunction
   body: {"moduleName":"warehouse.internalTransfer","funcName":"conduct","id":ID}

ПРАВИЛА:
- Всегда выполняй реальные запросы, никогда не описывай их.
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
    description: 'Выполнить POST запрос к Quick Resto API. Все запросы — POST, параметры передаются в body.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Путь, например /platform/online/api/list' },
        body: { type: 'object', description: 'Тело запроса JSON' }
      },
      required: ['path', 'body']
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
          console.log(`QR API: POST ${block.input.path}`, JSON.stringify(block.input.body));
          const result = await qrRequest(block.input.path, block.input.body);
          console.log(`QR API response: ${result.status}`, JSON.stringify(result.data).slice(0, 200));
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
