const TelegramBot = require('node-telegram-bot-api');
const Anthropic = require('@anthropic-ai/sdk');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const QR_LOGIN = process.env.QR_LOGIN || 'ng909';
const QR_PASSWORD = process.env.QR_PASSWORD || 'mhRrTEzV';
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

function getSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Ты — агент для управления складом кофейни через Quick Resto API. Отвечай кратко, по делу, на русском языке. Используй эмодзи умеренно для удобства чтения в Telegram.

АВТОРИЗАЦИЯ: каждый запрос к API — заголовок Authorization: "Basic ${QR_AUTH}"
BASE URL: ${QR_BASE}

ДОСТУПНЫЕ ОПЕРАЦИИ:

1. Склады: GET /platform/online/api/read?moduleName=warehouse.storehouse
2. Поставщики: GET /platform/online/api/read?moduleName=contractor.supplier
3. Ингредиенты: GET /platform/online/api/read?moduleName=warehouse.nomenclature&count=100
4. Приходные накладные (список): GET /platform/online/api/read?moduleName=warehouse.incomingInvoice&count=20
   Фильтр по дате: &filter=[{"field":"createDate","filterType":"dateRange","value":"ДАТА-T00:00:00","value2":"ДАТА-T23:59:59"}]
5. Создать приходную накладную:
   POST /platform/online/api/create?moduleName=warehouse.incomingInvoice
   Body: {"contractor":{"id":ID},"storehouse":{"id":ID},"comment":"...","items":[{"nomenclature":{"id":ID},"amount":ЧИСЛО,"unitPrice":ЦЕНА}]}
6. Провести накладную:
   POST /platform/online/api/moduleFunction?moduleName=warehouse.incomingInvoice&funcName=conduct
   Body: {"id": ID}
7. Перемещения (список): GET /platform/online/api/read?moduleName=warehouse.internalTransfer&count=20
8. Создать перемещение:
   POST /platform/online/api/create?moduleName=warehouse.internalTransfer
   Body: {"storehouseFrom":{"id":ID},"storehouseTo":{"id":ID},"items":[{"nomenclature":{"id":ID},"amount":ЧИСЛО}]}
9. Провести перемещение:
   POST /platform/online/api/moduleFunction?moduleName=warehouse.internalTransfer&funcName=conduct
   Body: {"id": ID}

ПРАВИЛА:
- Делай реальные HTTP-запросы к API через fetch (Node 18+).
- Если нужны id — сначала получи их через список.
- При создании документа сначала уточни все данные у пользователя.
- Перед проведением (conduct) ВСЕГДА предупреди что операция необратима и жди подтверждения.
- Показывай данные читаемо, для списков используй нумерацию.
- Сегодня: ${today}.
- Если API вернул ошибку — объясни и предложи решение.`;
}

async function callClaude(userId, userMessage) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role: 'user', content: userMessage });
  if (history.length > 20) history.splice(0, 2);

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    system: getSystemPrompt(),
    messages: history,
  });

  const reply = response.content.map(b => b.text || '').join('');
  history.push({ role: 'assistant', content: reply });
  return reply;
}

function isAllowed(userId) {
  if (ALLOWED_USER_IDS.length === 0) return true;
  return ALLOWED_USER_IDS.includes(userId);
}

bot.onText(/\/start/, (msg) => {
  if (!isAllowed(msg.from.id)) { bot.sendMessage(msg.chat.id, 'Нет доступа.'); return; }
  conversations.delete(msg.from.id);
  bot.sendMessage(msg.chat.id,
    `☕ *Агент склада — Quick Resto*\n\nПодключён к ${QR_LAYER}.quickresto.ru\n\nЧто умею:\n• Просматривать приходные накладные\n• Создавать и проводить накладные\n• Управлять внутренними перемещениями\n• Показывать склады, поставщиков, ингредиенты\n\nПросто напиши что нужно, например:\n_"покажи накладные за эту неделю"_\n_"создай приходную накладную от Иванов"_`,
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
