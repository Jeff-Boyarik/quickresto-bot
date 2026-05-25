// ============================================================
//  SALVADOR COFFEE — Единая конфигурация + Supabase-клиент
//  Подключать во всех HTML ПЕРВЫМ скриптом:
//    <script src="config.js"></script>
// ============================================================

// ─── Supabase ────────────────────────────────────────────────
const SUPABASE_URL = 'https://qymebczybupdekrxinao.supabase.co';
const SUPABASE_KEY = 'sb_publishable_69Fj0grgX4-mp0NnxOhqxg_K8UQCtV8';

// ─── Основной конфиг ─────────────────────────────────────────
const SALVADOR_CONFIG = {
    cafes: [
        { id: 'naymushina',  name: 'Наймушина 20'  },
        { id: 'sovetskaya',  name: 'Советская 2'   },
        { id: 'metallurgov', name: 'Металлургов 8'  }
    ],
    defaultRoles: [
        'Бариста',
        'Старший бариста',
        'Шеф-бариста',
        'Администратор'
    ],
    hashSalt: 'salvador_coffee_2025'
};

SALVADOR_CONFIG.cafeNames = Object.fromEntries(
    SALVADOR_CONFIG.cafes.map(c => [c.id, c.name])
);

// ─── SHA-256 хэш пароля ──────────────────────────────────────
async function salHash(password) {
    const data = new TextEncoder().encode(password + SALVADOR_CONFIG.hashSalt);
    const buf  = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Экранирование HTML ──────────────────────────────────────
function escHtml(text) {
    if (text === null || text === undefined) return '';
    const d = document.createElement('div');
    d.textContent = String(text);
    return d.innerHTML;
}

// ─── Текущий пользователь (сессия в localStorage) ──────────
function getCurrentUser() {
    try { return JSON.parse(localStorage.getItem('currentUser') || 'null'); }
    catch { return null; }
}

function setCurrentUser(user) {
    const safe = { ...user };
    delete safe.password_hash;
    localStorage.setItem('currentUser', JSON.stringify(safe));
}

function clearCurrentUser() {
    localStorage.removeItem('currentUser');
}

function requireAuth() {
    const u = getCurrentUser();
    if (!u) window.location.href = 'login.html';
    return u;
}

function isAdmin(user) {
    return user?.role === 'Администратор' || user?.role === 'admin';
}

// ============================================================
//  SUPABASE API — тонкий клиент без сторонней библиотеки
// ============================================================
const db = (() => {
    // Используем прокси через Vercel Edge чтобы обойти блокировку Supabase
    const PROXY = '/api/proxy';
    const DIRECT = `${SUPABASE_URL}/rest/v1`;
    const HEADERS = {
        'apikey':          SUPABASE_KEY,
        'Authorization':   `Bearer ${SUPABASE_KEY}`,
        'Content-Type':    'application/json',
        'Prefer':          'return=representation',
        'Accept-Profile':  'public',
        'Content-Profile': 'public'
    };

    function buildUrl(path) {
        // Если открыто локально (не через Vercel) — используем прямой URL
        if (location.hostname === '127.0.0.1' || location.hostname === 'localhost') {
            return DIRECT + path;
        }
        // Через прокси: /api/proxy?path=/rest/v1/table&filter=...
        const [base, qs] = path.split('?');
        return PROXY + '?path=/rest/v1' + base + (qs ? '&' + qs : '');
    }

    async function req(method, path, body) {
        try {
            const res = await fetch(buildUrl(path), {
                method,
                headers: HEADERS,
                body: body ? JSON.stringify(body) : undefined
            });
            const text = await res.text();
            const data = text ? JSON.parse(text) : null;
            if (!res.ok) return { data: null, error: data?.message || `HTTP ${res.status}` };
            return { data, error: null };
        } catch (e) {
            return { data: null, error: e.message };
        }
    }

    // SELECT — query это строка PostgREST-фильтров: 'cafe_id=eq.naymushina&status=eq.pending'
    async function select(table, query = '', columns = '*') {
        const qs = `?select=${columns}` + (query ? `&${query}` : '');
        return req('GET', `/${table}${qs}`);
    }

    // SELECT одной строки
    async function selectOne(table, query = '', columns = '*') {
        const { data, error } = await select(table, query + '&limit=1', columns);
        return { data: data?.[0] ?? null, error };
    }

    // INSERT — row это объект или массив объектов
    async function insert(table, row) {
        const { data, error } = await req('POST', `/${table}`, row);
        // Вернуть первый элемент если вставляли одну строку
        const result = Array.isArray(data) && !Array.isArray(row) ? data[0] : data;
        return { data: result, error };
    }

    // UPDATE — query: 'id=eq.42'
    async function update(table, query, patch) {
        return req('PATCH', `/${table}?${query}`, patch);
    }

    // DELETE
    async function del(table, query) {
        return req('DELETE', `/${table}?${query}`);
    }

    // UPSERT
    async function upsert(table, row, onConflict = 'id') {
        const res = await fetch(buildUrl(`/${table}?on_conflict=${onConflict}`), {
            method: 'POST',
            headers: { ...HEADERS, 'Prefer': 'return=representation,resolution=merge-duplicates' },
            body: JSON.stringify(row)
        });
        const text = await res.text();
        const data = text ? JSON.parse(text) : null;
        if (!res.ok) return { data: null, error: data?.message || `HTTP ${res.status}` };
        return { data: Array.isArray(data) ? data[0] : data, error: null };
    }

    return { select, selectOne, insert, update, del, upsert };
})();
