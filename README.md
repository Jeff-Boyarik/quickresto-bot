# Quick Resto Telegram Bot

Агент для управления складом кофейни через Telegram.

## Быстрый старт на Railway

1. Создай бота в Telegram через @BotFather → скопируй токен
2. Зарегистрируйся на railway.app (бесплатно)
3. New Project → Deploy from GitHub repo (или загрузи папку)
4. В разделе Variables добавь переменные из .env.example
5. Готово — бот работает 24/7

## Переменные окружения

| Переменная | Описание |
|---|---|
| TELEGRAM_TOKEN | Токен от @BotFather |
| ANTHROPIC_API_KEY | Ключ API Anthropic |
| QR_LAYER | Поддомен Quick Resto (ng909) |
| QR_LOGIN | Логин API Quick Resto |
| QR_PASSWORD | Пароль API Quick Resto |
| ALLOWED_USER_IDS | ID пользователей через запятую (пусто = все) |

## Команды бота

- /start — начать работу
- /reset — очистить историю диалога
- /help — справка

## Примеры команд

- "покажи накладные за эту неделю"
- "создай приходную накладную от поставщика Иванов"
- "перемести кофе со склада на склад"
- "список поставщиков"
- "остатки на складе"
