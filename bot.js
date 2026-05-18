const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const QR_LOGIN = process.env.QR_LOGIN || 'ng909';
const QR_PASSWORD = process.env.QR_PASSWORD || '';
const QR_LAYER = process.env.QR_LAYER || 'ng909';
const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim()))
  : [];

if (!TELEGRAM_TOKEN || !ANTHROPIC_API_KEY) {
  console.error('Ошибка: нужны переменные TELEGRAM_TOKEN и ANTHROPIC_API_KEY');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const QR_AUTH = Buffer.from(`${QR_LOGIN}:${QR_PASSWORD}`).toString('base64');
const QR_BASE = `https://${QR_LAYER}.quickresto.ru`;
const conversations = new Map();

async function qrRequest(path, method = 'POST', body = {}) {
  try {
    const url = QR_BASE + path;
    const resp = await axios.post(url, body || {}, {
      headers: {
        'Authorization': 'Basic ' + QR_AUTH,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    return { ok: true, data: resp.data };
  } catch (e) {
    const status = e.response ? e.response.status : 'network error';
    const data = e.response ? e.response.data : e.message;
    return { ok: false, status, data };
  }
}

function getSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Ты — агент для управления складом кофейни. У тебя есть функция qrRequest для запросов к Quick Resto API. Отвечай кратко на русском, используй эмодзи умеренно.

ВАЖНО: ты работаешь в Node.js среде. Для запросов к API используй ТОЛЬКО встроенную функцию qrRequest(path, method, body) которая уже настроена с авторизацией. НЕ используй fetch напрямую, НЕ объясняй как делать запросы — просто делай их через qrRequest и показывай результат.

BASE URL уже настроен: ${QR_BASE}

1. Склады: GET /platform/online/api/list?moduleName=warehouse.storehouse&className=ru.edgex.quickresto.modules.warehouse.storehouse.Storehouse
2. Поставщики: GET /platform/online/api/list?moduleName=contractor.supplier&className=ru.edgex.quickresto.modules.contractor.Contractor
3. Ингредиенты: GET /platform/online/api/list?moduleName=warehouse.nomenclature&className=ru.edgex.quickresto.modules.warehouse.nomenclature.Nomenclature&count=100
4. Приходные накладные: GET /platform/online/api/list?moduleName=warehouse.incomingInvoice&className=ru.edgex.quickresto.modules.warehouse.incomingInvoice.IncomingInvoice&count=20
5. Создать приходную накладную: POST /platform/online/api/create?moduleName=warehouse.incomingInvoice&className=ru.edgex.quickresto.modules.warehouse.incomingInvoice.IncomingInvoice
6. Провести накладную: POST /platform/online/api/moduleFunction?moduleName=warehouse.incomingInvoice&funcName=conduct
7. Перемещения: GET /platform/online/api/list?moduleName=warehouse.internalTransfer&className=ru.edgex.quickresto.modules.warehouse.internalTransfer.InternalTransfer&count=20
8. Создать перемещение: POST /platform/online/api/create?moduleName=warehouse.internalTransfer&className=ru.edgex.quickresto.modules.warehouse.internalTransfer.InternalTransfer
9. Провести перемещение: POST /platform/online/api/moduleFunction?moduleName=warehouse.internalTransfer&funcName=conduct

ПРАВИЛА:
- Всегда вызывай qrRequest и показывай реальные данные из ответа.
- Если нужны id — сначала получи их через список.
- Перед проведением (conduct) предупреди что необратимо и жди подтверждения.
- Сегодня: ${today}.`;
}

async function callClaude(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);

  const toolResult = await runAgentLoop(userMessage, history);
  return toolResult;
}

async function runAgentLoop(userMessage, history) {
  history.push({ role: 'user', content: userMessage });
  if (history.length > 30) history.splice(0, 2);

  const tools = [{
    name: 'qr_request',
    description: 'Выполняет HTTP запрос к Quick Resto API',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'URL path начиная с /platform/...' },
        method: { type: 'string', enum: ['GET', 'POST'], default: 'GET' },
        body: { type: 'object', description: 'Тело запроса для POST' }
      },
      required: ['path']
    }
  }];

  let messages = [...history];

  while (true) {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 2000,
      system: getSystemPrompt(),
      tools,
      messages,
    });

    if (response.stop_reason === 'end_turn') {
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      history.push({ role: 'assistant', content: response.content });
      return text;
    }

    if (response.stop_reason === 'tool_use') {
      history.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type === 'tool_use') {
          console.log(`Вызов API: ${block.input.method || 'GET'} ${block.input.path}`);
          try {
            const result = await qrRequest(block.input.path, block.input.method || 'GET', block.input.body || null);
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: JSON.stringify(result)
            });
          } catch(e) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: 'Ошибка: ' + e.message
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });
      history.push({ role: 'user', content: toolResults });
    } else {
      const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
      return text || 'Нет ответа';
    }
  }
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

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `*Команды:*\n/start — начать\n/reset — очистить историю\n/help — справка\n\n*Примеры:*\n• покажи склады\n• накладные за сегодня\n• создай приходную накладную\n• внутреннее перемещение`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', async (msg) => {
  if (!msg.text || msg.text.startsWith('/')) return;
  if (!isAllowed(msg.from.id)) { bot.sendMessage(msg.chat.id, 'Нет доступа.'); return; }

  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(()=>{}), 4000);
  bot.sendChatAction(chatId, 'typing').catch(()=>{});

  try {
    const reply = await callClaude(userId, msg.text);
    clearInterval(typing);
    const chunks = reply.match(/[\s\S]{1,4000}/g) || [reply];
    for (const chunk of chunks) {
      await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' })
        .catch(() => bot.sendMessage(chatId, chunk));
    }
  } catch(err) {
    clearInterval(typing);
    console.error('Ошибка:', err.message);
    bot.sendMessage(chatId, 'Ошибка: ' + err.message);
  }
});

bot.on('polling_error', err => console.error('Polling error:', err.message));
console.log(`Бот запущен. Слой: ${QR_LAYER}.quickresto.ru`);
