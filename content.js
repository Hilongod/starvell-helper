// ===== Starvell Helper — BUILD 2026-07-07-tickets =====
console.log("%c[Starvell Helper] BUILD 2026-07-07-tickets загружен","color:#7c5cfc;font-weight:bold");
// =====================================================
//  Starvell Helper — content.js
// =====================================================

// ── Если мы на /starvell-helper — инжектим дашборд ──
if (location.pathname === '/starvell-helper') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectHelperPage);
  } else {
    injectHelperPage();
  }
}

let autoBoostInterval = null;
let boostIntervalMs = 30 * 60 * 1000;

// ─── Загружаем настройки при старте ─────────────────
chrome.storage.local.get(['autoBoost', 'boostInterval', 'customBg', 'bgUrl', 'bgOpacity'], (data) => {
  if (data.autoBoost) startAutoBoost(data.boostInterval || 30);
  if (data.customBg && data.bgUrl) applyBackground(data.bgUrl, data.bgOpacity ?? 1);
});

// ─── Перехватываем fetch сайта чтобы запомнить параметры bump ──
let lastBumpPayload = null;

chrome.storage.local.get(['lastBumpPayload'], (data) => {
  if (data.lastBumpPayload) {
    lastBumpPayload = data.lastBumpPayload;
    console.log('[Starvell Helper] Восстановлен lastBumpPayload:', lastBumpPayload);
  }
});

const originalFetch = window.fetch;
window.fetch = function(...args) {
  const promise = originalFetch.apply(this, args);
  // Обрабатываем ответ асинхронно, не блокируя основной поток
  promise.then(async response => {
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      const options = args[1];
      if (url && url.includes('/api/offers/bump') && options?.method === 'POST') {
        const body = JSON.parse(options.body);
        if (body.gameId && body.categoryIds?.length > 0) {
          lastBumpPayload = body;
          await chrome.storage.local.set({ lastBumpPayload: body });
          console.log('[Starvell Helper] Перехвачен bump, запомнили:', body);
        }
      }
    } catch(e) {}
  }).catch(() => {});
  return promise;
};

// ─── Слушаем команды от popup ────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'TOGGLE_AUTO_BOOST':
      if (msg.enabled) {
        startAutoBoost(msg.interval);
        sendResponse({ ok: true, status: 'started' });
      } else {
        stopAutoBoost();
        sendResponse({ ok: true, status: 'stopped' });
      }
      break;
    case 'BOOST_NOW':
      boostAllLots()
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(err => sendResponse({ ok: false, error: String(err && err.message || err) }));
      return true;
    case 'APPLY_BG':
      applyBackground(msg.url, msg.opacity);
      sendResponse({ ok: true });
      break;
    case 'REMOVE_BG':
      removeBackground();
      sendResponse({ ok: true });
      break;
    case 'GET_STATUS':
      sendResponse({ running: autoBoostInterval !== null, url: location.href, knownPayload: !!lastBumpPayload });
      break;
  }
});

// =====================================================
//  ФУНКЦИЯ 1 — Автоподнятие лотов
// =====================================================

function startAutoBoost(intervalMinutes) {
  stopAutoBoost();
  boostIntervalMs = (intervalMinutes || 30) * 60 * 1000;
  // За расписание отвечает ТОЛЬКО alarm в background (шлёт BOOST_NOW).
  // Локальный setInterval здесь дублировал бы поднятие на каждой вкладке → 429.
  autoBoostInterval = 'managed-by-alarm';
  console.log('[Starvell Helper] Автоподнятие запущено (расписание в background), интервал:', intervalMinutes, 'мин');
}

function stopAutoBoost() {
  if (autoBoostInterval) {
    if (typeof autoBoostInterval === 'number') clearInterval(autoBoostInterval);
    autoBoostInterval = null;
  }
}

// ─── Узнать username текущего пользователя ───
function getCurrentUsername() {
  // 1) из __NEXT_DATA__ (если есть)
  const nd = document.getElementById('__NEXT_DATA__');
  if (nd) {
    try {
      const data = JSON.parse(nd.textContent);
      const pp = data.props?.pageProps || {};
      const u = pp.user?.username
             || pp.bff?.user?.username
             || pp.foreignProfileUser?.username;
      if (u) return u;
    } catch (e) {}
  }
  // 2) запасной вариант — из URL вида /profile/<username> или /<username>
  const m = location.pathname.match(/\/profile\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  return null;
}
 
// ─── Получить buildId (нужен для пути _next/data) ───
async function fetchBuildId() {
  const nd = document.getElementById('__NEXT_DATA__');
  if (nd) {
    try {
      const data = JSON.parse(nd.textContent);
      if (data.buildId) return data.buildId;
    } catch (e) {}
  }
  // подстраховка: тянем главную и выдёргиваем buildId из inline-скрипта
  const html = await originalFetch(window.location.origin, { credentials: 'include' }).then(r => r.text());
  const match = html.match(/"buildId":"(.*?)"/);
  if (match) return match[1];
  throw new Error('buildId not found');
}
 
// ─── ЧТЕНИЕ ЛОТОВ: /profile/{username}.json ───
// Возвращает массив категорий: [{ categoryId, gameId, gameName, offersCount }]
async function fetchAllActiveCategories() {
  let username = getCurrentUsername();
  if (!username) {
    addLog('error', 'Не удалось определить username — открой свою страницу профиля.');
    return [];
  }
  // Сайт хранит username как "HILONGOD", но канонический URL профиля — в нижнем
  // регистре (/profile/hilongod). Если слать как есть, сервер отвечает 308-редиректом
  // с пустым pageProps. Поэтому нормализуем в нижний регистр.
  username = username.toLowerCase();

  const buildId = await fetchBuildId();

  // Загружаем профиль, при необходимости следуем за внутренним N_REDIRECT Next.js
  async function loadProfileJson(uname, depth = 0) {
    const url = `${location.origin}/_next/data/${buildId}/profile/`
              + `${encodeURIComponent(uname)}.json?username=${encodeURIComponent(uname)}`;
    const resp = await originalFetch(url, {
      credentials: 'include',
      headers: { 'x-nextjs-data': '1' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    // Next.js может вернуть { pageProps: { __N_REDIRECT: "/profile/xxx" } }
    const redirect = json?.pageProps?.__N_REDIRECT;
    if (redirect && depth < 2) {
      const m = redirect.match(/\/profile\/([^/?#]+)/i);
      if (m) {
        const target = decodeURIComponent(m[1]);
        if (target.toLowerCase() !== uname.toLowerCase()) {
          return loadProfileJson(target.toLowerCase(), depth + 1);
        }
      }
    }
    return json;
  }

  let data;
  try {
    data = await loadProfileJson(username);
  } catch (e) {
    addLog('error', `Не удалось загрузить профиль: ${e.message}`);
    return [];
  }
 
  const pp = data.pageProps || {};
  // userProfileOffers лежит и наверху, и в bff — берём первый непустой
  const categories = (Array.isArray(pp.userProfileOffers) && pp.userProfileOffers.length)
      ? pp.userProfileOffers
      : (pp.bff?.userProfileOffers || []);
 
  const result = [];
  for (const cat of categories) {
    const categoryId = cat.id;
    const gameId     = cat.gameId ?? cat.game?.id;
    const offersCnt  = Array.isArray(cat.offers) ? cat.offers.length : 0;
    // поднимаем только категории, где реально есть офферы
    if (!categoryId || !gameId || offersCnt === 0) continue;
    result.push({
      categoryId,
      gameId,
      gameName: cat.game?.name || String(gameId),
      offersCount: offersCnt
    });
  }
 
  addLog('info', `Профиль загружен: категорий с лотами — ${result.length}.`);
  return result;
}
 
// ─── Группировка: gameId -> [categoryIds] (как делает сайт) ───
function groupByGame(categories) {
  const map = new Map(); // gameId -> { gameName, categoryIds:Set }
  for (const c of categories) {
    if (!map.has(c.gameId)) map.set(c.gameId, { gameName: c.gameName, categoryIds: new Set() });
    map.get(c.gameId).categoryIds.add(c.categoryId);
  }
  return [...map.entries()].map(([gameId, v]) => ({
    gameId,
    gameName: v.gameName,
    categoryIds: [...v.categoryIds]
  }));
}

async function sendBump(gameId, categoryIds) {
  const body = JSON.stringify({ gameId, categoryIds });
  console.log('[Starvell Helper] Отправляем bump:', body);
  try {
    const resp = await originalFetch('/api/offers/bump', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body
    });
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      const waitSec = retryAfter ? parseInt(retryAfter) : 90;
      console.warn(`[Starvell Helper] 429 — ждём ${waitSec}с...`);
      await sleep(waitSec * 1000);
      const retry = await originalFetch('/api/offers/bump', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body
      });
      const retryJson = await retry.json().catch(() => ({}));
      return { ok: retry.ok, status: retry.status, body: retryJson, retried: true };
    }
    const json = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body: json };
  } catch (e) {
    console.error('[Starvell Helper] Ошибка fetch:', e);
    return { ok: false, status: 0 };
  }
}

// ─── ГЛАВНАЯ: поднять все игры (по одному bump на игру) ───
let boostInProgress = false;

async function boostAllLots() {
  // Защита от наложения: два BOOST_NOW внахлёст удвоили бы запросы → 429.
  if (boostInProgress) {
    console.log('[Starvell Helper] boostAllLots уже выполняется — пропускаю');
    return { count: 0, failed: 0, rateLimit: false, skipped: true };
  }
  boostInProgress = true;
  try {
    return await _boostAllLotsInner();
  } finally {
    boostInProgress = false;
  }
}

async function _boostAllLotsInner() {
  const categories = await fetchAllActiveCategories();
  if (!categories.length) {
    const msg = '⚠ Активных лотов не найдено. Открой свою страницу профиля и попробуй снова.';
    addLog('error', msg);
    chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
    return { count: 0, failed: 1, rateLimit: false };
  }
 
  const games = groupByGame(categories);
  addLog('info', `Поднимаю ${games.length} игр(ы), всего категорий: ${categories.length}.`);
 
  let successCount = 0, failCount = 0, rateLimited = false;
 
  for (let i = 0; i < games.length; i++) {
    const { gameId, gameName, categoryIds } = games[i];
    addLog('info', `${gameName} (id ${gameId}): ${categoryIds.length} категорий...`);
 
    const result = await sendBumpWithRetry(gameId, categoryIds);
 
    if (result.status === 429) {
      rateLimited = true;
      addLog('warn', `Rate limit на «${gameName}» — пауза 60с и один повтор.`);
      await sleep(60000);
      const retry = await sendBumpWithRetry(gameId, categoryIds);
      if (retry.ok) { successCount++; addLog('ok', `✅ ${gameName} поднята (после паузы).`); }
      else { failCount++; addLog('error', `❌ ${gameName}: ${retry.status}.`); }
    } else if (result.ok) {
      successCount++;
      addLog('ok', `✅ ${gameName} поднята (${categoryIds.length} кат.).`);
    } else {
      failCount++;
      addLog('error', `❌ Ошибка ${result.status} для «${gameName}».`);
    }
 
    if (i < games.length - 1) await sleep(2500); // пауза между играми против 429
  }
 
  const msg = successCount
    ? `✅ Поднято игр: ${successCount} из ${games.length}.`
    : `⚠ Не удалось поднять ни одной игры.`;
  chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
  addLog(successCount ? 'ok' : 'warn', msg);
 
  return { count: successCount, failed: failCount, rateLimit: rateLimited };
}
 

// Вспомогательная функция с повторной попыткой при 429
async function sendBumpWithRetry(gameId, categoryIds, retryCount = 0) {
  const result = await sendBump(gameId, categoryIds);
  if (result.status === 429 && retryCount < 2) {
    const retryAfter = result.headers?.get('Retry-After') || 90;
    addLog('warn', `429, ждём ${retryAfter} сек перед повтором...`);
    await sleep(retryAfter * 1000);
    return sendBumpWithRetry(gameId, categoryIds, retryCount + 1);
  }
  return result;
}

// Обновлённая sendBump, возвращающая объект с ok, status, headers
async function sendBump(gameId, categoryIds) {
  const body = JSON.stringify({ gameId, categoryIds });
  console.log('[Starvell Helper] Отправляем bump:', body);
  try {
    const resp = await originalFetch('/api/offers/bump', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body
    });
    let json = {};
    try { json = await resp.json(); } catch(e) {}
    return {
      ok: resp.ok,
      status: resp.status,
      body: json,
      headers: resp.headers
    };
  } catch (e) {
    console.error('[Starvell Helper] Ошибка fetch:', e);
    return { ok: false, status: 0 };
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Лог событий ─────────────────────────────────────
// Хранится в chrome.storage.local (ключ shLog).
// background.js очищает его при onStartup — имитация сессии.
const MAX_LOG = 200;

function addLog(type, text) {
  const entry = { type, text, time: new Date().toLocaleTimeString('ru-RU') };
  chrome.storage.local.get(['shLog'], (data) => {
    const log = data.shLog || [];
    log.unshift(entry);
    if (log.length > MAX_LOG) log.length = MAX_LOG;
    chrome.storage.local.set({ shLog: log }, () => {
      renderLogIfOpen();
    });
  });
}

function renderLogIfOpen() {
  const logList = document.getElementById('sh-log-list');
  if (logList) renderLog(logList);
}

function renderLog(container) {
  chrome.storage.local.get(['shLog'], (data) => {
    const log = data.shLog || [];
    if (!log.length) {
      container.innerHTML = '<div class="sh-log-empty">Пока нет событий</div>';
      return;
    }
    container.innerHTML = log.map(e => `
      <div class="sh-log-row sh-log-${e.type}">
        <span class="sh-log-time">${e.time}</span>
        <span class="sh-log-text">${e.text}</span>
      </div>
    `).join('');
  });
}

// =====================================================
//  ФУНКЦИЯ 2 — Кастомный фон
// =====================================================

const BG_OVERLAY_ID = 'starvell-helper-bg';
const BG_STYLE_ID   = 'starvell-helper-bg-style';

function applyBackground(imageUrl, opacity = 0.15) {
  removeBackground();
  const overlay = document.createElement('div');
  overlay.id = BG_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: -1;
    background-image: url("${imageUrl}");
    background-size: cover; background-position: center top;
    background-repeat: no-repeat; background-attachment: fixed;
    opacity: ${opacity}; pointer-events: none;
  `;
  document.documentElement.appendChild(overlay);
  const style = document.createElement('style');
  style.id = BG_STYLE_ID;
  style.textContent = `
    html { background: #0a0a0f !important; }
    body { background: transparent !important; }
    [class*="layout_container__"] { background: transparent !important; }
    [class*="layout_content_wide__"],
    [class*="layout_content__"],
    [class*="layout_footer__"] { background: rgb(28, 28, 30) !important; }
  `;
  document.head.appendChild(style);
}

function removeBackground() {
  document.getElementById(BG_OVERLAY_ID)?.remove();
  document.getElementById(BG_STYLE_ID)?.remove();
}

// =====================================================
//  ФУНКЦИЯ 3 — Страница /starvell-helper (Дашборд)
// =====================================================

function injectHelperPage() {
  document.body.style.display = 'none';

  const style = document.createElement('style');
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    #sh-page {
      display: flex; flex-direction: column; min-height: 100vh;
      background: #0a0a12; color: #e8e8f0;
      font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px;
    }
    #sh-topbar {
      height: 56px;
      background: linear-gradient(90deg, #13122a 0%, #1a1835 100%);
      border-bottom: 1px solid #2a2845;
      display: flex; align-items: center; padding: 0 24px; gap: 14px;
      flex-shrink: 0; position: sticky; top: 0; z-index: 100;
    }
    #sh-topbar-logo {
      width: 34px; height: 34px;
      background: linear-gradient(135deg, #7c5cfc, #5a3fd0);
      border-radius: 9px; display: flex; align-items: center; justify-content: center;
      font-size: 17px; font-weight: 800; color: #fff; flex-shrink: 0;
    }
    #sh-topbar-name { font-size: 16px; font-weight: 700; letter-spacing: 0.2px; }
    #sh-topbar-badge {
      font-size: 10px; background: rgba(124,92,252,0.2); color: #a07cff;
      border: 1px solid rgba(124,92,252,0.35); border-radius: 20px; padding: 2px 9px; margin-left: 4px;
    }
    #sh-topbar-back {
      margin-left: auto; background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
      color: #aaa; font-size: 13px; padding: 6px 14px; cursor: pointer;
      text-decoration: none; transition: background 0.15s, color 0.15s;
    }
    #sh-topbar-back:hover { background: rgba(124,92,252,0.15); color: #a07cff; border-color: rgba(124,92,252,0.3); }
    #sh-body { display: flex; flex: 1; overflow: hidden; }
    #sh-sidebar {
      width: 220px; flex-shrink: 0; background: #0f0f1e;
      border-right: 1px solid #1e1e35; padding: 16px 10px;
      display: flex; flex-direction: column; gap: 4px; overflow-y: auto;
    }
    .sh-nav-section {
      font-size: 10px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 1px; color: #44445a; padding: 10px 10px 4px;
    }
    .sh-nav-item {
      display: flex; align-items: center; gap: 10px;
      padding: 9px 12px; border-radius: 8px; cursor: pointer;
      color: #8888aa; font-size: 13px; font-weight: 500;
      transition: background 0.15s, color 0.15s; user-select: none;
    }
    .sh-nav-item:hover { background: rgba(124,92,252,0.1); color: #c8c8e8; }
    .sh-nav-item.active { background: rgba(124,92,252,0.18); color: #e0d4ff; font-weight: 600; }
    .sh-nav-icon { font-size: 16px; width: 20px; text-align: center; flex-shrink: 0; }
    #sh-main { flex: 1; overflow-y: auto; padding: 28px 32px; }
    .sh-page-header { margin-bottom: 24px; }
    .sh-page-title { font-size: 22px; font-weight: 700; margin-bottom: 4px; }
    .sh-page-sub { color: #8888aa; font-size: 13px; }
    .sh-card {
      background: #13131f; border: 1px solid #1e1e30;
      border-radius: 14px; padding: 20px 22px; margin-bottom: 16px;
    }
    .sh-card-title {
      font-size: 13px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.7px; color: #8888aa; margin-bottom: 16px;
    }
    .sh-toggle-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .sh-toggle-label { font-size: 14px; font-weight: 500; }
    .sh-toggle-desc { font-size: 12px; color: #8888aa; margin-top: 3px; }
    .sh-switch { position: relative; display: inline-block; width: 42px; height: 23px; }
    .sh-switch input { opacity: 0; width: 0; height: 0; }
    .sh-slider {
      position: absolute; inset: 0; background: #28283a;
      border-radius: 23px; cursor: pointer; transition: 0.25s;
    }
    .sh-slider::before {
      content: ''; position: absolute; left: 3px; top: 3px;
      width: 17px; height: 17px; background: #fff; border-radius: 50%; transition: 0.25s;
    }
    .sh-switch input:checked + .sh-slider { background: #7c5cfc; }
    .sh-switch input:checked + .sh-slider::before { transform: translateX(19px); }
    .sh-status-row {
      display: flex; align-items: center; gap: 10px;
      background: #0f0f1e; border: 1px solid #1e1e35;
      border-radius: 10px; padding: 10px 14px; margin-bottom: 14px; font-size: 13px;
    }
    .sh-dot { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; background: #44445a; }
    .sh-dot.active { background: #4caf82; box-shadow: 0 0 6px #4caf82; }
    .sh-dot.inactive { background: #f25c5c; }
    .sh-select, .sh-input {
      background: #0f0f1e; color: #e8e8f0;
      border: 1px solid #2a2845; border-radius: 8px;
      padding: 8px 12px; font-size: 13px; outline: none; transition: border-color 0.2s;
    }
    .sh-select:focus, .sh-input:focus { border-color: #7c5cfc; }
    .sh-input { width: 100%; margin-bottom: 10px; }
    .sh-field-row { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .sh-field-row label { color: #8888aa; font-size: 13px; min-width: 120px; }
    .sh-btn {
      border: none; border-radius: 9px; font-size: 13px; font-weight: 600;
      cursor: pointer; transition: 0.18s; padding: 9px 18px;
    }
    .sh-btn-primary { background: linear-gradient(135deg, #7c5cfc, #5a3fd0); color: #fff; }
    .sh-btn-primary:hover { filter: brightness(1.15); }
    .sh-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }
    .sh-btn-secondary { background: #1a1a28; border: 1px solid #2a2845; color: #c8c8e8; }
    .sh-btn-secondary:hover { border-color: #7c5cfc; color: #a07cff; }
    .sh-btn-danger { background: rgba(242,92,92,0.1); border: 1px solid rgba(242,92,92,0.3); color: #f25c5c; }
    .sh-btn-danger:hover { background: rgba(242,92,92,0.2); }
    .sh-btn-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
    .sh-range-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
    .sh-range-row label { font-size: 13px; color: #8888aa; width: 90px; flex-shrink: 0; }
    .sh-range-row input[type=range] { flex: 1; accent-color: #7c5cfc; }
    .sh-range-val { font-size: 13px; color: #a07cff; width: 36px; text-align: right; }
    .sh-presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .sh-preset {
      padding: 6px 12px; border: 1px solid #2a2845;
      border-radius: 7px; background: #0f0f1e; color: #c8c8e8;
      font-size: 12px; cursor: pointer; transition: 0.15s;
    }
    .sh-preset:hover { border-color: #7c5cfc; color: #a07cff; }
    .sh-feedback { font-size: 12px; padding: 7px 12px; border-radius: 7px; margin-top: 10px; display: none; }
    .sh-feedback.ok  { display: block; background: rgba(76,175,130,0.12); color: #4caf82; border: 1px solid rgba(76,175,130,0.25); }
    .sh-feedback.err { display: block; background: rgba(242,92,92,0.12); color: #f25c5c; border: 1px solid rgba(242,92,92,0.25); }
    #sh-log-list { max-height: 320px; overflow-y: auto; }
    .sh-log-empty { color: #44445a; font-size: 13px; text-align: center; padding: 24px 0; }
    .sh-log-row {
      display: flex; gap: 10px; align-items: flex-start;
      padding: 8px 0; border-bottom: 1px solid #1a1a28; font-size: 12px; line-height: 1.4;
    }
    .sh-log-time { color: #44445a; flex-shrink: 0; padding-top: 1px; }
    .sh-log-row.sh-log-ok    .sh-log-text { color: #4caf82; }
    .sh-log-row.sh-log-warn  .sh-log-text { color: #e8a03c; }
    .sh-log-row.sh-log-error .sh-log-text { color: #f25c5c; }
    .sh-hint {
      background: rgba(124,92,252,0.08); border: 1px solid rgba(124,92,252,0.2);
      border-radius: 9px; padding: 12px 14px; font-size: 13px;
      color: #a07cff; line-height: 1.5; margin-bottom: 14px;
    }
    .sh-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 16px; }
    .sh-stat { background: #0f0f1e; border: 1px solid #1e1e35; border-radius: 10px; padding: 14px 16px; text-align: center; }
    .sh-stat-val { font-size: 26px; font-weight: 700; color: #a07cff; }
    .sh-stat-lbl { font-size: 11px; color: #8888aa; margin-top: 4px; }
    .sh-tab { display: none; }
    .sh-tab.active { display: block; }
    #sh-sidebar::-webkit-scrollbar, #sh-main::-webkit-scrollbar { width: 4px; }
    #sh-sidebar::-webkit-scrollbar-track, #sh-main::-webkit-scrollbar-track { background: transparent; }
    #sh-sidebar::-webkit-scrollbar-thumb, #sh-main::-webkit-scrollbar-thumb { background: #2a2845; border-radius: 2px; }

    /* ── Stats ── */
    .sh-stats-grid {
      display: grid; grid-template-columns: repeat(2, 1fr);
      gap: 12px; margin-bottom: 16px;
    }
    .sh-stat-big {
      background: #13131f; border: 1px solid #1e1e30;
      border-radius: 14px; padding: 18px 16px; text-align: center;
    }
    .sh-stat-big--accent { border-color: rgba(124,92,252,0.35); background: rgba(124,92,252,0.07); }
    .sh-stat-big-val { font-size: 20px; font-weight: 700; color: #a07cff; margin-bottom: 6px; line-height: 1.2; }
    .sh-stat-big--accent .sh-stat-big-val { color: #c8b4ff; font-size: 22px; }
    .sh-stat-big-lbl { font-size: 11px; color: #8888aa; }
    .sh-stats-rows { display: flex; flex-direction: column; gap: 0; }
    .sh-stats-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 0; border-bottom: 1px solid #1a1a28; font-size: 13px;
    }
    .sh-stats-row:last-child { border-bottom: none; }
    .sh-stats-row span:first-child { color: #c8c8e8; }
    .sh-stats-row span:last-child { color: #a07cff; font-weight: 600; }
  `;
  document.head.appendChild(style);
  document.documentElement.style.cssText = 'background:#0a0a12 !important;';

  const page = document.createElement('div');
  page.id = 'sh-page';
  page.innerHTML = `
    <div id="sh-topbar">
      <div id="sh-topbar-logo">S</div>
      <span id="sh-topbar-name">Starvell Helper</span>
      <span id="sh-topbar-badge">v2.1.1</span>
      <a href="https://starvell.com" id="sh-topbar-back">← На сайт</a>
    </div>
    <div id="sh-body">
      <nav id="sh-sidebar">
        <div class="sh-nav-section">Инструменты</div>
        <div class="sh-nav-item active" data-tab="boost"><span class="sh-nav-icon">🚀</span> Автоподнятие</div>
        <div class="sh-nav-item" data-tab="bg"><span class="sh-nav-icon">🎨</span> Кастомный фон</div>
        <div class="sh-nav-item" data-tab="tickets"><span class="sh-nav-icon">🎫</span> Автотикеты</div>
        <div class="sh-nav-section">Данные</div>
        <div class="sh-nav-item" data-tab="stats"><span class="sh-nav-icon">📊</span> Статистика</div>
        <div class="sh-nav-item" data-tab="log"><span class="sh-nav-icon">📋</span> Лог событий</div>
        <div class="sh-nav-section">Система</div>
        <div class="sh-nav-item" data-tab="settings"><span class="sh-nav-icon">⚙️</span> Настройки</div>
        <div class="sh-nav-item" data-tab="about"><span class="sh-nav-icon">ℹ️</span> О расширении</div>
      </nav>
      <main id="sh-main">

        <!-- TAB: Автоподнятие -->
        <div class="sh-tab active" id="sh-tab-boost">
          <div class="sh-page-header">
            <div class="sh-page-title">🚀 Автоподнятие лотов</div>
            <div class="sh-page-sub">Автоматически нажимает «Поднять» через API с нужным интервалом</div>
          </div>
          <div class="sh-stats">
            <div class="sh-stat"><div class="sh-stat-val" id="sh-stat-total">0</div><div class="sh-stat-lbl">Поднятий всего</div></div>
            <div class="sh-stat"><div class="sh-stat-val" id="sh-stat-session">0</div><div class="sh-stat-lbl">За сессию</div></div>
            <div class="sh-stat"><div class="sh-stat-val" id="sh-stat-errors">0</div><div class="sh-stat-lbl">Ошибок</div></div>
          </div>
          <div class="sh-card">
            <div class="sh-card-title">Управление</div>
            <div class="sh-status-row">
              <div class="sh-dot inactive" id="sh-boost-dot"></div>
              <span id="sh-boost-status-text">Автоподнятие выключено</span>
            </div>
            <div id="sh-boost-hint" class="sh-hint" style="display:none">
              💡 Нажми «Поднять» на сайте вручную один раз — расширение запомнит игру и категории
            </div>
            <div class="sh-toggle-row">
              <div>
                <div class="sh-toggle-label">Включить автоподнятие</div>
                <div class="sh-toggle-desc">Автоматически поднимает все лоты с заданным интервалом</div>
              </div>
              <label class="sh-switch">
                <input type="checkbox" id="sh-auto-boost-toggle" />
                <span class="sh-slider"></span>
              </label>
            </div>
            <div class="sh-field-row">
              <label>Интервал подъёма</label>
              <select class="sh-select" id="sh-boost-interval">
                <option value="5">5 минут</option>
                <option value="10">10 минут</option>
                <option value="15">15 минут</option>
                <option value="30" selected>30 минут</option>
                <option value="60">1 час</option>
                <option value="120">2 часа</option>
              </select>
            </div>
            <div class="sh-btn-row">
              <button class="sh-btn sh-btn-primary" id="sh-boost-now-btn">⬆ Поднять сейчас</button>
            </div>
            <div class="sh-feedback" id="sh-boost-feedback"></div>
          </div>
        </div>

        <!-- TAB: Кастомный фон -->
        <div class="sh-tab" id="sh-tab-bg">
          <div class="sh-page-header">
            <div class="sh-page-title">🎨 Кастомный фон</div>
            <div class="sh-page-sub">Установи своё фоновое изображение на starvell.com</div>
          </div>
          <div class="sh-card">
            <div class="sh-card-title">Управление фоном</div>
            <div class="sh-toggle-row">
              <div>
                <div class="sh-toggle-label">Включить фон</div>
                <div class="sh-toggle-desc">Показывать кастомный фон на всех страницах Starvell</div>
              </div>
              <label class="sh-switch">
                <input type="checkbox" id="sh-bg-toggle" />
                <span class="sh-slider"></span>
              </label>
            </div>
            <input class="sh-input" type="url" id="sh-bg-url" placeholder="https://... прямая ссылка на изображение" />
            <div id="sh-bg-preview-wrap" style="display:none;margin-bottom:12px;border-radius:10px;overflow:hidden;border:1px solid #2a2845;background:#0a0a12;position:relative;max-height:220px;">
              <img id="sh-bg-preview-img" src="" alt="" style="width:100%;max-height:220px;object-fit:cover;display:block;" />
              <div id="sh-bg-preview-err" style="display:none;padding:20px;text-align:center;font-size:12px;color:#f25c5c;">⚠ Не удалось загрузить изображение</div>
              <div id="sh-bg-preview-loader" style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:#0a0a12;font-size:12px;color:#8888aa;">Загрузка...</div>
            </div>
            <div class="sh-range-row">
              <label>Проявление</label>
              <input type="range" id="sh-bg-opacity" min="0" max="100" value="100" />
              <span class="sh-range-val" id="sh-opacity-val">100%</span>
            </div>
            <div class="sh-presets">
              <button class="sh-preset" data-url="https://images.steamusercontent.com/ugc/11757048598727857695/9365618D2BC0524C3DC1C850FBB9873120789C35/?imw=640&&ima=fit&impolicy=Letterbox&imcolor=%23000000&letterbox=false">🌸 Аниме gif</button>
              <button class="sh-preset" data-url="https://i.postimg.cc/7hH1QfYt/devushka-reka-zakat-1067581-1920x1080.jpg">🌟 Аниме v2</button>
              <button class="sh-preset" data-url="https://images.unsplash.com/photo-1518531933037-91b2f5f229cc?w=1920">🌲 Лес</button>
              <button class="sh-preset" data-url="https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=1920">🏔 Горы</button>
            </div>
            <div class="sh-btn-row">
              <button class="sh-btn sh-btn-primary" id="sh-apply-bg-btn">✓ Применить фон</button>
              <button class="sh-btn sh-btn-danger" id="sh-remove-bg-btn">✕ Убрать фон</button>
            </div>
            <div class="sh-feedback" id="sh-bg-feedback"></div>
          </div>
        </div>

         <!-- TAB: Автотикеты -->
        <div class="sh-tab" id="sh-tab-tickets">
          <div class="sh-page-header">
            <div class="sh-page-title">🎫 Автотикеты (ТЕСТИТСЯ СИЛЬНО НЕ ПРИМЕНЯЙТЕ)</div>
            <div class="sh-page-sub">Автоматические запросы в поддержку по неподтверждённым заказам</div>
          </div>
          <div class="sh-card" style="margin-bottom:14px;">
            <div class="sh-toggle-row">
              <div>
                <div class="sh-toggle-label">Включить автотикеты</div>
                <div class="sh-toggle-desc">Раз в сутки проверяет старые заказы и отправляет тикет</div>
              </div>
              <label class="sh-switch">
                <input type="checkbox" id="sh-ticket-toggle" />
                <span class="sh-slider"></span>
              </label>
            </div>
            <div class="sh-row" style="gap:12px;align-items:center;margin-bottom:16px;">
              <div style="flex:1;">
                <div style="font-size:12px;color:#8888aa;margin-bottom:6px;">Порог ожидания</div>
                <select class="sh-select" id="sh-ticket-period">
                  <option value="1">🧪 1 день (тест)</option>
                  <option value="7">1 неделя (7 дней)</option>
                  <option value="14">2 недели (14 дней)</option>
                  <option value="30">1 месяц (30 дней)</option>
                </select>
              </div>
            </div>
            <div id="sh-ticket-status" style="font-size:12px;color:#8888aa;margin-bottom:12px;">Статус: выключено</div>
            <div id="sh-ticket-last" style="font-size:12px;color:#8888aa;margin-bottom:16px;"></div>
            <button class="sh-btn sh-btn-primary" id="sh-ticket-now-btn">🎫 Отправить тикет сейчас</button>
          </div>
          <div class="sh-card" style="margin-bottom:14px;">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px;">Шаблон тикета</div>
            <div style="font-size:12px;color:#8888aa;line-height:1.7;">
              <b>Тема:</b> Покупатели забыли подтвердить заказы<br>
              <b>Текст:</b> Здравствуйте, покупатели забыли подтвердить заказы в кол-ве [КОЛ-ВО] шт:<br>
              [Заказ #XXXXXX, Заказ #YYYYYY ...]<br><br>
              Там где не требуются доказательства (аренда или прочее), если на некоторые заказы нужны доказательства, напишите в тикет, при спорных моментах можно подключить поддержку (арбитраж)<br><br>
              Реализация автотикет в расширении starvell-helper (пробный)
            </div>
          </div>
          <div id="sh-ticket-feedback" class="sh-feedback" style="display:none;"></div>
          <div id="sh-ticket-log" style="font-size:12px;color:#8888aa;margin-top:8px;"></div>
        </div>

        <!-- TAB: Статистика -->
        <div class="sh-tab" id="sh-tab-stats">
          <div class="sh-page-header">
            <div class="sh-page-title">📊 Статистика продаж</div>
            <div class="sh-page-sub">Данные берутся со страниц «Мои продажи» и «Кошелёк»</div>
          </div>
          <div id="sh-stats-loading" class="sh-hint" style="display:none">⏳ Загружаем данные...</div>
          <div id="sh-stats-error" class="sh-feedback err" style="display:none"></div>
          <div class="sh-stats-grid" id="sh-stats-grid" style="display:none">
            <div class="sh-stat-big">
              <div class="sh-stat-big-val" id="shs-balance">—</div>
              <div class="sh-stat-big-lbl">💰 Баланс</div>
            </div>
            <div class="sh-stat-big">
              <div class="sh-stat-big-val" id="shs-earned">—</div>
              <div class="sh-stat-big-lbl">📈 Заработано</div>
            </div>
          </div>
          <div class="sh-card" id="sh-stats-details" style="display:none">
            <div class="sh-card-title">Детали</div>
            <div class="sh-stats-rows">
              <div class="sh-stats-row"><span>✅ Успешных заказов</span><span id="shs-completed">—</span></div>
              <div class="sh-stats-row"><span>↩️ Возвратов</span><span id="shs-refunded">—</span></div>
              <div class="sh-stats-row"><span>💵 Средний чек</span><span id="shs-avg">—</span></div>
              <div class="sh-stats-row"><span>👥 Уникальных покупателей</span><span id="shs-buyers">—</span></div>
              <div class="sh-stats-row"><span>🎮 Топ категория (количество продаж)</span><span id="shs-topgame">—</span></div>
              <div class="sh-stats-row"><span>🏅 Топ покупатель (количество продаж)</span><span id="shs-topbuyer">—</span></div>
            </div>
          </div>
          <div class="sh-btn-row" style="margin-top:4px">
            <button class="sh-btn sh-btn-primary" id="sh-stats-load-btn">🔄 Загрузить статистику</button>
            <button class="sh-btn sh-btn-secondary" id="sh-stats-all-btn" style="display:none">📥 Загрузить все страницы</button>
          </div>
          <div style="font-size:11px;color:#44445a;margin-top:8px" id="sh-stats-note"></div>
        </div>

        <!-- TAB: Лог -->
        <div class="sh-tab" id="sh-tab-log">
          <div class="sh-page-header">
            <div class="sh-page-title">📋 Лог событий</div>
            <div class="sh-page-sub">История всех действий расширения в этой сессии (P.S сессия длится до обновления страницы)</div>
          </div>
          <div class="sh-card">
            <div class="sh-card-title" style="display:flex;align-items:center;justify-content:space-between;">
              <span>События</span>
              <button class="sh-btn sh-btn-secondary" id="sh-clear-log-btn" style="padding:4px 12px;font-size:12px;">Очистить</button>
            </div>
            <div id="sh-log-list"><div class="sh-log-empty">Пока нет событий</div></div>
          </div>
        </div>

        <!-- TAB: Настройки -->
        <div class="sh-tab" id="sh-tab-settings">
          <div class="sh-page-header">
            <div class="sh-page-title">⚙️ Настройки</div>
            <div class="sh-page-sub">Глобальные параметры расширения</div>
          </div>
          <div class="sh-card">
            <div class="sh-card-title">Уведомления</div>
            <div class="sh-toggle-row">
              <div>
                <div class="sh-toggle-label">Уведомления браузера</div>
                <div class="sh-toggle-desc">Показывать всплывающие уведомления о результатах подъёма</div>
              </div>
              <label class="sh-switch">
                <input type="checkbox" id="sh-notif-toggle" checked />
                <span class="sh-slider"></span>
              </label>
            </div>
          </div>
          <div class="sh-card">
            <div class="sh-card-title">Сброс данных</div>
            <p style="font-size:13px;color:#8888aa;margin-bottom:14px;">Удалить все сохранённые настройки и запомненные параметры bump</p>
            <button class="sh-btn sh-btn-danger" id="sh-reset-btn">🗑 Сбросить все данные</button>
            <div class="sh-feedback" id="sh-reset-feedback"></div>
          </div>
        </div>

        <!-- TAB: О расширении -->
        <div class="sh-tab" id="sh-tab-about">
          <div class="sh-page-header">
            <div class="sh-page-title">ℹ️ О расширении</div>
          </div>
          <div class="sh-card" style="text-align:center;padding:32px;">
            <div style="font-size:48px;margin-bottom:12px;">⭐</div>
            <div style="font-size:20px;font-weight:700;margin-bottom:6px;">Starvell Helper</div>
            <div style="color:#8888aa;font-size:13px;margin-bottom:20px;">Версия 2.1.1 · Инструменты продавца</div>
            <div style="color:#c8c8e8;font-size:13px;line-height:1.7;max-width:440px;margin:0 auto;">
              Расширение автоматизирует рутинные действия на <b>starvell.com</b>:<br>
              автоподнятие лотов через API и кастомный фон страниц.<br><br>
              Работает без сторонних серверов — все данные хранятся только в браузере.
            </div>
          </div>
        </div>

      </main>
    </div>
  `;
  document.documentElement.appendChild(page);

  // ── Табы ────────────────────────────────────────────
  document.querySelectorAll('.sh-nav-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.sh-nav-item').forEach(i => i.classList.remove('active'));
      document.querySelectorAll('.sh-tab').forEach(t => t.classList.remove('active'));
      item.classList.add('active');
      const tab = document.getElementById('sh-tab-' + item.dataset.tab);
      if (tab) tab.classList.add('active');
      if (item.dataset.tab === 'log') renderLog(document.getElementById('sh-log-list'));
      if (item.dataset.tab === 'tickets') initTicketsTab();
    });
  });

  // ── Загружаем настройки ──────────────────────────────
  chrome.storage.local.get(
    ['autoBoost', 'boostInterval', 'customBg', 'bgUrl', 'bgOpacity', 'lastBumpPayload', 'shNotifications', 'shStatTotal', 'shStatErrors', 'autoTicket', 'ticketPeriod', 'ticketLastSent'],
    (data) => {
      const boostToggle = document.getElementById('sh-auto-boost-toggle');
      const intervalSel = document.getElementById('sh-boost-interval');
      boostToggle.checked = !!data.autoBoost;
      if (data.boostInterval) intervalSel.value = data.boostInterval;
      updateBoostStatus(!!data.autoBoost, intervalSel.value, !!data.lastBumpPayload);

      document.getElementById('sh-bg-toggle').checked = !!data.customBg;
      if (data.bgUrl) {
        document.getElementById('sh-bg-url').value = data.bgUrl;
        showPreview(data.bgUrl);
      }
      if (data.bgOpacity != null) {
        const opVal = Math.round(data.bgOpacity * 100);
        document.getElementById('sh-bg-opacity').value = opVal;
        document.getElementById('sh-opacity-val').textContent = opVal + '%';
      }
      if (data.shNotifications !== undefined)
        document.getElementById('sh-notif-toggle').checked = !!data.shNotifications;

      document.getElementById('sh-stat-total').textContent  = data.shStatTotal  || 0;
      document.getElementById('sh-stat-errors').textContent = data.shStatErrors || 0;

      // Автотикеты — инициализируем состояние и запускаем проверку расписания
      if (data.autoTicket) scheduleTicketCheck();
    }
  );

  // ── Автоподнятие toggle ──────────────────────────────
  document.getElementById('sh-auto-boost-toggle').addEventListener('change', () => {
    const enabled  = document.getElementById('sh-auto-boost-toggle').checked;
    const interval = parseInt(document.getElementById('sh-boost-interval').value);
    chrome.storage.local.set({ autoBoost: enabled, boostInterval: interval });
    chrome.runtime.sendMessage({ type: 'TOGGLE_AUTO_BOOST', enabled, interval });
    updateBoostStatus(enabled, interval, !!lastBumpPayload);
    shFeedback('sh-boost-feedback', enabled ? `✓ Включено (каждые ${interval} мин)` : '✓ Выключено', 'ok');
  });

  document.getElementById('sh-boost-interval').addEventListener('change', () => {
    const interval = parseInt(document.getElementById('sh-boost-interval').value);
    chrome.storage.local.set({ boostInterval: interval });
    if (document.getElementById('sh-auto-boost-toggle').checked) {
      chrome.runtime.sendMessage({ type: 'TOGGLE_AUTO_BOOST', enabled: true, interval });
      updateBoostStatus(true, interval, !!lastBumpPayload);
    }
  });

  // ── Поднять сейчас ───────────────────────────────────
  let sessionCount = 0, sessionErrors = 0;
  document.getElementById('sh-boost-now-btn').addEventListener('click', async () => {
    const btn = document.getElementById('sh-boost-now-btn');
    btn.disabled = true; btn.textContent = '⏳ Поднимаю...';
    const result = await boostAllLots();
    if (result.rateLimit) {
      shFeedback('sh-boost-feedback', '⚠ Rate limit — увеличь интервал до 60+ мин', 'err');
      sessionErrors++;
    } else if (result.count > 0) {
      shFeedback('sh-boost-feedback', '✓ Лоты подняты!', 'ok');
      sessionCount++;
    } else {
      shFeedback('sh-boost-feedback', '⚠ Нажми «Поднять» вручную один раз — расширение запомнит параметры', 'err');
      sessionErrors++;
    }
    document.getElementById('sh-stat-session').textContent = sessionCount;
    chrome.storage.local.get(['shStatTotal', 'shStatErrors'], d => {
      const total  = (d.shStatTotal  || 0) + result.count;
      const errors = (d.shStatErrors || 0) + (result.failed || 0);
      chrome.storage.local.set({ shStatTotal: total, shStatErrors: errors });
      document.getElementById('sh-stat-total').textContent  = total;
      document.getElementById('sh-stat-errors').textContent = errors;
    });
    btn.disabled = false; btn.textContent = '⬆ Поднять сейчас';
  });

  function updateBoostStatus(active, interval, hasPayload) {
    document.getElementById('sh-boost-dot').className = 'sh-dot ' + (active ? 'active' : 'inactive');
    document.getElementById('sh-boost-status-text').textContent = active
      ? `Активно — каждые ${interval} мин` : 'Автоподнятие выключено';
    const hint = document.getElementById('sh-boost-hint');
    if (hint) hint.style.display = hasPayload ? 'none' : 'block';
  }

  // После загрузки настроек, можно показать количество лотов (асинхронно)
  fetchAllActiveCategories().then(categories => {
    const groups = groupByGame(categories);
    const hint = document.getElementById('sh-boost-hint');
    if (hint && categories.length) {
      const totalCats = categories.length;
      hint.innerHTML = `💡 Найдено категорий с лотами: ${totalCats} (${groups.length} игр). Автоподнятие поднимет всё.`;
      hint.style.display = 'block';
    }
  }).catch(console.warn);

  // ── Фон ─────────────────────────────────────────────
  document.getElementById('sh-bg-opacity').addEventListener('input', () => {
    document.getElementById('sh-opacity-val').textContent = document.getElementById('sh-bg-opacity').value + '%';
  });

  // ── Превью изображения ────────────────────────────────
  function showPreview(url) {
    const wrap   = document.getElementById('sh-bg-preview-wrap');
    const img    = document.getElementById('sh-bg-preview-img');
    const err    = document.getElementById('sh-bg-preview-err');
    const loader = document.getElementById('sh-bg-preview-loader');
    if (!url) { wrap.style.display = 'none'; return; }
    wrap.style.display = 'block';
    img.style.display  = 'none';
    err.style.display  = 'none';
    loader.style.display = 'flex';
    img.onload = () => { loader.style.display = 'none'; img.style.display = 'block'; err.style.display = 'none'; };
    img.onerror = () => { loader.style.display = 'none'; img.style.display = 'none'; err.style.display = 'block'; };
    img.src = url;
  }

  let previewTimer = null;
  document.getElementById('sh-bg-url').addEventListener('input', () => {
    clearTimeout(previewTimer);
    const url = document.getElementById('sh-bg-url').value.trim();
    if (!url) { showPreview(null); return; }
    previewTimer = setTimeout(() => showPreview(url), 600);
  });
  document.querySelectorAll('.sh-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('sh-bg-url').value = btn.dataset.url;
      showPreview(btn.dataset.url);
    });
  });
  document.getElementById('sh-apply-bg-btn').addEventListener('click', () => {
    const url     = document.getElementById('sh-bg-url').value.trim();
    const opacity = parseInt(document.getElementById('sh-bg-opacity').value) / 100;
    if (!url) { shFeedback('sh-bg-feedback', '⚠ Введи ссылку или выбери пресет', 'err'); return; }
    chrome.storage.local.set({ customBg: true, bgUrl: url, bgOpacity: opacity });
    applyBackground(url, opacity);
    shFeedback('sh-bg-feedback', '✓ Фон применён!', 'ok');
  });
  document.getElementById('sh-remove-bg-btn').addEventListener('click', () => {
    chrome.storage.local.set({ customBg: false });
    removeBackground();
    document.getElementById('sh-bg-toggle').checked = false;
    shFeedback('sh-bg-feedback', '✓ Фон удалён', 'ok');
  });
  document.getElementById('sh-bg-toggle').addEventListener('change', () => {
    if (!document.getElementById('sh-bg-toggle').checked) {
      document.getElementById('sh-remove-bg-btn').click();
    } else if (document.getElementById('sh-bg-url').value.trim()) {
      document.getElementById('sh-apply-bg-btn').click();
    }
  });

  // ── Настройки ────────────────────────────────────────
  document.getElementById('sh-notif-toggle').addEventListener('change', () => {
    chrome.storage.local.set({ shNotifications: document.getElementById('sh-notif-toggle').checked });
  });
  document.getElementById('sh-reset-btn').addEventListener('click', () => {
    chrome.storage.local.clear(() => {
      shFeedback('sh-reset-feedback', '✓ Все данные сброшены. Перезагрузи страницу.', 'ok');
    });
  });

  // ── Лог ─────────────────────────────────────────────
  document.getElementById('sh-clear-log-btn').addEventListener('click', () => {
    chrome.storage.local.set({ shLog: [] }, () => {
      renderLog(document.getElementById('sh-log-list'));
    });
  });

  // ── Статистика ────────────────────────────────────────
  document.getElementById('sh-stats-load-btn').addEventListener('click', () => loadStats(false));
  document.getElementById('sh-stats-all-btn').addEventListener('click', () => loadStats(true));

  async function loadStats(loadAll) {
    const loading = document.getElementById('sh-stats-loading');
    const errBox  = document.getElementById('sh-stats-error');
    const grid    = document.getElementById('sh-stats-grid');
    const details = document.getElementById('sh-stats-details');
    const note    = document.getElementById('sh-stats-note');
    const allBtn  = document.getElementById('sh-stats-all-btn');
    const loadBtn = document.getElementById('sh-stats-load-btn');

    loading.style.display = 'block';
    errBox.style.display  = 'none';
    grid.style.display    = 'none';
    details.style.display = 'none';
    loadBtn.disabled = true;
    loadBtn.textContent = '⏳ Загружаю...';

    try {
      // ── 1. Кошелёк: баланс + выводы ──────────────────
      const walletHtml = await fetch('/wallet', { credentials: 'include' }).then(r => r.text());
      const walletDoc  = new DOMParser().parseFromString(walletHtml, 'text/html');

      let balance = 0;
      let withdrawnTotal = 0;

      const walletNext = walletDoc.getElementById('__NEXT_DATA__');
      if (walletNext) {
        const wd = JSON.parse(walletNext.textContent);
        const wp = wd.props?.pageProps || {};
        const user = wp.user || wp.profile || wp.seller || {};
        balance = user?.balance?.rubBalance ?? wp.balance?.rubBalance ?? 0;
      }
      if (!balance) {
        const h2 = walletDoc.querySelector('h2');
        if (h2) {
          balance = Math.round(parseFloat(h2.textContent.replace(/[^\d,\.]/g, '').replace(',', '.')) * 100);
        }
      }

      const walletWithdrawHtml = await fetch('/wallet?type=withdrawal', { credentials: 'include' }).then(r => r.text());
      const wdDoc = new DOMParser().parseFromString(walletWithdrawHtml, 'text/html');
      withdrawnTotal = parseWalletWithdrawals(wdDoc);

      // ── 2. Продажи через POST /api/orders/list ────────
      const LIMIT = 20;
      let allOrders  = [];
      let offset     = 0;
      let hasMore    = true;
      let batchCount = 0;

      // Первый батч всегда загружаем
      note.textContent = 'Загружаю заказы...';
      const firstBatch = await fetchOrdersBatch(offset);
      allOrders = firstBatch;
      offset   += firstBatch.length;
      hasMore   = firstBatch.length === LIMIT;
      batchCount++;

      if (loadAll) {
        // Грузим все батчи до конца
        while (hasMore) {
          note.textContent = `Загружено ${allOrders.length} заказов, продолжаю...`;
          await sleep(300);
          const batch = await fetchOrdersBatch(offset);
          allOrders = allOrders.concat(batch);
          offset   += batch.length;
          hasMore   = batch.length === LIMIT;
          batchCount++;
        }
      }

      // ── 3. Считаем статистику ─────────────────────────
      const completed = allOrders.filter(o => o.status === 'COMPLETED');
      const refunded  = allOrders.filter(o => o.status === 'REFUND' || o.status === 'REFUNDED' || o.status === 'RETURNED' || o.status === 'CANCELLED');

      const earnedKopecks = completed.reduce((s, o) => s + (o.basePrice || 0), 0);
      const earned    = earnedKopecks / 100;
      const avgCheck  = completed.length ? earned / completed.length : 0;
      const balanceRub = balance / 100;

      // Уникальные покупатели
      const buyerMap = {};
      completed.forEach(o => {
        const name = o.user?.username || String(o.buyerId) || 'unknown';
        buyerMap[name] = (buyerMap[name] || 0) + 1;
      });
      const uniqueBuyers = Object.keys(buyerMap).length;
      const topBuyer = Object.entries(buyerMap).sort((a, b) => b[1] - a[1])[0];

      // Топ категория
      const catMap = {};
      completed.forEach(o => {
        const cat = o.offerDetails?.category?.name || o.offerDetails?.game?.name || '?';
        catMap[cat] = (catMap[cat] || 0) + 1;
      });
      const topGame = Object.entries(catMap).sort((a, b) => b[1] - a[1])[0];

      // Итого заработано = выводы + текущий баланс
      const totalEarned = withdrawnTotal / 100 + balanceRub;

      // ── 4. Рендерим ───────────────────────────────────
      loading.style.display = 'none';
      grid.style.display    = 'grid';
      details.style.display = 'block';

      document.getElementById('shs-balance').textContent = fmt(balanceRub) + ' ₽';
      document.getElementById('shs-earned').textContent  = fmt(earned) + ' ₽';
      document.getElementById('shs-completed').textContent    = completed.length + (hasMore ? '+' : '');
      document.getElementById('shs-refunded').textContent     = refunded.length;
      document.getElementById('shs-avg').textContent          = completed.length ? fmt(avgCheck) + ' ₽' : '—';
      document.getElementById('shs-buyers').textContent       = uniqueBuyers || '—';
      document.getElementById('shs-topgame').textContent      = topGame ? `${topGame[0]} (${topGame[1]})` : '—';
      document.getElementById('shs-topbuyer').textContent     = topBuyer ? `${topBuyer[0]} (${topBuyer[1]})` : '—';

      if (hasMore) {
        allBtn.style.display = 'inline-block';
        note.textContent = `Показано первые ${allOrders.length} заказов. Нажми «Загрузить все» для полной статистики.`;
      } else {
        allBtn.style.display = 'none';
        note.textContent = `Загружено: ${allOrders.length} заказов (все)`;
      }

    } catch (e) {
      loading.style.display = 'none';
      errBox.style.display  = 'block';
      errBox.textContent    = '⚠ Ошибка загрузки: ' + e.message;
      console.error('[Starvell Helper Stats]', e);
    }

    loadBtn.disabled = false;
    loadBtn.textContent = '🔄 Обновить';
  }

  // Загружаем батч заказов через POST /api/orders/list
  async function fetchOrdersBatch(offset) {
    const LIMIT = 20;
    const resp = await originalFetch('/api/orders/list', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        filter: { status: null, gameId: null, userType: 'seller' },
        with: { buyer: true },
        limit: LIMIT,
        offset: offset
      })
    });
    if (!resp.ok) throw new Error(`/api/orders/list вернул ${resp.status}`);
    const data = await resp.json();
    // API возвращает массив напрямую
    return Array.isArray(data) ? data : (data.orders || data.items || data.data || []);
  }

  // Парсим сумму успешных выводов из DOM кошелька
  function parseWalletWithdrawals(doc) {
    let total = 0;
    // Ищем строки с суммами (h5 внутри wallet_amount)
    const amountEls = doc.querySelectorAll('[class*="wallet_amount"] h5, [class*="wallet_cell_amount"] h5');
    amountEls.forEach(el => {
      const txt = el.textContent.replace(/\s/g, '').replace(',', '.');
      const val = parseFloat(txt.replace(/[^\d.]/g, ''));
      if (!isNaN(val)) total += Math.round(val * 100);
    });
    return total;
  }

  function fmt(n) {
    return n.toLocaleString('ru-RU', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
  }

  function shFeedback(id, text, type) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'sh-feedback ' + type;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.className = 'sh-feedback'; }, 5000);
  }

  // =====================================================
  //  АВТОТИКЕТЫ
  // =====================================================

  function initTicketsTab() {
    chrome.storage.local.get(['autoTicket', 'ticketPeriod', 'ticketLastSent'], (data) => {
      const toggle = document.getElementById('sh-ticket-toggle');
      const period = document.getElementById('sh-ticket-period');
      if (!toggle) return;

      toggle.checked = !!data.autoTicket;
      if (data.ticketPeriod) period.value = data.ticketPeriod;
      updateTicketStatus(!!data.autoTicket, data.ticketLastSent);
    });

    document.getElementById('sh-ticket-toggle').addEventListener('change', () => {
      const enabled = document.getElementById('sh-ticket-toggle').checked;
      const period  = parseInt(document.getElementById('sh-ticket-period').value);
      chrome.storage.local.set({ autoTicket: enabled, ticketPeriod: period });
      updateTicketStatus(enabled, null);
      if (enabled) scheduleTicketCheck();
    });

    document.getElementById('sh-ticket-period').addEventListener('change', () => {
      const period = parseInt(document.getElementById('sh-ticket-period').value);
      chrome.storage.local.set({ ticketPeriod: period });
    });

    document.getElementById('sh-ticket-now-btn').addEventListener('click', async () => {
      const btn = document.getElementById('sh-ticket-now-btn');
      btn.disabled = true;
      btn.textContent = '⏳ Отправляю...';
      await sendAutoTicket(true);
      btn.disabled = false;
      btn.textContent = '🎫 Отправить тикет сейчас';
    });
  }

  function updateTicketStatus(enabled, lastSent) {
    const statusEl = document.getElementById('sh-ticket-status');
    const lastEl   = document.getElementById('sh-ticket-last');
    if (!statusEl) return;
    statusEl.textContent = enabled ? 'Статус: ✅ включено (проверка раз в сутки)' : 'Статус: выключено';
    statusEl.style.color = enabled ? '#7cf' : '#8888aa';
    if (lastEl) {
      lastEl.textContent = lastSent
        ? '🕐 Последний тикет: ' + new Date(lastSent).toLocaleString('ru-RU')
        : '';
    }
  }

  // Запускаем проверку расписания — раз при открытии дашборда
  function scheduleTicketCheck() {
    chrome.storage.local.get(['autoTicket', 'ticketPeriod', 'ticketLastSent'], async (data) => {
      if (!data.autoTicket) return;
      const period   = (data.ticketPeriod || 7) * 24 * 60 * 60 * 1000;
      const lastSent = data.ticketLastSent || 0;
      const now      = Date.now();
      // Допуск ±10% от периода (но не более 23ч)
      const tolerance = Math.min(period * 0.1, 23 * 60 * 60 * 1000);
      if (now - lastSent >= period - tolerance) {
        await sendAutoTicket(false);
      }
    });
  }

  async function sendAutoTicket(manual) {
    const logEl = document.getElementById('sh-ticket-log');
    const fbEl  = document.getElementById('sh-ticket-feedback');

    function log(msg) {
      addLog('🎫 ' + msg);
      if (logEl) logEl.textContent = msg;
    }

    try {
      log('Загружаю заказы продавца...');

      const period = await new Promise(res =>
        chrome.storage.local.get(['ticketPeriod'], d => res((d.ticketPeriod || 7)))
      );
      const thresholdMs = period * 24 * 60 * 60 * 1000;
      const now = Date.now();

      // Реальный контракт: POST /api/orders/list с телом {filter:{userType:"seller"}}.
      // Сервер отдаёт список; статус и дату фильтруем сами.
      const resp = await originalFetch('/api/orders/list', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ filter: { userType: 'seller' } })
      });
      if (!resp.ok) throw new Error('/api/orders/list вернул ' + resp.status);

      const raw = await resp.json();
      const allOrders = Array.isArray(raw) ? raw : (raw.orders || raw.data || raw.items || []);

      // Берём только неподтверждённые (CREATED) и старше порога.
      const getCreated = (o) => o.createdAt || o.created_at || o.date || o.createdDate;
      const pending = allOrders.filter(o => {
        const status = (o.status || o.orderStatus || '').toString().toUpperCase();
        if (status !== 'CREATED') return false;
        const ts = new Date(getCreated(o)).getTime();
        if (!ts) return false;
        return (now - ts) >= thresholdMs;
      });

      if (pending.length === 0) {
        log(`Нет CREATED-заказов старше ${period} дн. — тикет не нужен`);
        if (fbEl) { fbEl.textContent = '✅ Неподтверждённых заказов нет'; fbEl.className = 'sh-feedback ok'; fbEl.style.display = 'block'; }
        return;
      }

      // Короткий ID заказа: последний сегмент UUID → последние 8 символов, заглавными.
      const shortId = (o) => '#' + String(o.id).split('-').pop().slice(-8).toUpperCase();

      // Группируем по ДНЮ создания (локальная дата YYYY-MM-DD).
      // Каждый день, которому исполнилось >= period дней, уходит отдельным тикетом.
      const dayKey = (o) => {
        const d = new Date(getCreated(o));
        return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      };
      const groups = new Map();
      for (const o of pending) {
        const k = dayKey(o);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(o);
      }

      log(`Найдено ${pending.length} заказов в ${groups.size} дн. — отправляю тикеты...`);

      let sentTickets = 0;
      let lastTicketId = '?';

      for (const [day, orders] of groups) {
        const ids = orders.map(shortId);
        const ticketId = await createTicket(ids, orders.length, day);
        if (ticketId) { sentTickets++; lastTicketId = ticketId; }
        await sleep(1500); // пауза между тикетами
      }

      const sentAt = Date.now();
      chrome.storage.local.set({ ticketLastSent: sentAt });
      updateTicketStatus(true, sentAt);

      log(`✅ Отправлено тикетов: ${sentTickets} (последний #${lastTicketId})`);
      if (fbEl) {
        fbEl.textContent = `✅ Отправлено тикетов: ${sentTickets} по ${pending.length} заказам`;
        fbEl.className = 'sh-feedback ok';
        fbEl.style.display = 'block';
      }
      if (!manual) {
        chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: `Автотикеты: ${sentTickets} шт (${pending.length} заказов)` });
      }

    } catch (e) {
      log('❌ Ошибка: ' + e.message);
      if (fbEl) {
        fbEl.textContent = '❌ ' + e.message;
        fbEl.className = 'sh-feedback err';
        fbEl.style.display = 'block';
      }
      console.error('[Starvell Helper Tickets]', e);
    }
  }

  // Создание одного тикета через multipart/form-data (реальный контракт сайта).
  async function createTicket(shortIds, count, dayLabel) {
    const listHtml = shortIds.map(id => `<li>Заказ ${id}</li>`).join('');
    const description =
      `<p>Здравствуйте, покупатели забыли подтвердить заказы в кол-ве ${count} шт` +
      (dayLabel ? ` (от ${dayLabel})` : '') + `:</p>` +
      `<ul>${listHtml}</ul>` +
      `<p>Там где не требуются доказательства (аренда или прочее), если на некоторые заказы нужны доказательства, напишите в тикет, при спорных моментах можно подключить поддержку (арбитраж)</p>` +
      `<p>Реализация автотикет в расширении starvell-helper (пробный)</p>`;

    // ВАЖНО: сервер ждёт form-data, а не JSON. orderId — короткие ID через запятую.
    const fd = new FormData();
    fd.append('ticketType', '1');
    fd.append('subject', 'Покупатель забыл подтвердить заказ');
    fd.append('description', description);
    fd.append('orderId', shortIds.join(', '));
    fd.append('orderUserTypeId', '2');   // 2 = продавец
    fd.append('orderTopicId', '501');    // 501 = "покупатель забыл подтвердить"

    const resp = await originalFetch('/api/support/create', {
      method: 'POST',
      credentials: 'include',
      body: fd  // Content-Type выставит браузер сам (с boundary)
    });
    if (!resp.ok) throw new Error('create вернул ' + resp.status);
    const result = await resp.json();
    return result.id || result.ticketId || '?';
  }
}

// =====================================================
//  ФУНКЦИЯ 4 — Кнопка «S» в навбаре → открывает дашборд
// =====================================================

const NAV_BTN_ID   = 'starvell-helper-nav-btn';
const NAV_STYLE_ID = 'starvell-helper-nav-style';

function injectNavbarButton() {
  if (document.getElementById(NAV_BTN_ID)) return;

  const rightZone =
    document.querySelector('[class*="header_user_nav_main"]') ||
    document.querySelector('[class*="header_user_nav__"]')    ||
    document.querySelector('[class*="header_inner_"]')        ||
    document.querySelector('header');

  if (!rightZone) {
    console.warn('[Starvell Helper] Навбар не найден, повторим позже');
    return;
  }

  if (!document.getElementById(NAV_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = NAV_STYLE_ID;
    style.textContent = `
      [class*="header_user_nav_main"],
      [class*="header_user_nav__"],
      [class*="header_inner_"] { align-items: center !important; }

      #${NAV_BTN_ID} {
        display: inline-flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; min-width: 34px; min-height: 34px;
        border-radius: 9px;
        background: linear-gradient(135deg, #7c5cfc, #5a3fd0);
        color: #fff; font-size: 16px; font-weight: 800;
        font-family: 'Segoe UI', system-ui, sans-serif;
        letter-spacing: -0.5px; cursor: pointer;
        border: none; outline: none;
        box-shadow: 0 2px 8px rgba(124,92,252,0.45);
        transition: filter 0.18s, transform 0.15s, box-shadow 0.18s;
        flex-shrink: 0; align-self: center; position: relative;
        user-select: none; vertical-align: middle; line-height: 1;
        padding: 0; margin: 0 4px 0 0; text-decoration: none;
      }
      #${NAV_BTN_ID}:hover {
        filter: brightness(1.18); transform: translateY(-1px);
        box-shadow: 0 4px 16px rgba(124,92,252,0.6);
      }
      #${NAV_BTN_ID}:active { transform: translateY(0); filter: brightness(0.95); }
      #${NAV_BTN_ID}::after {
        content: 'Starvell Helper';
        position: absolute; bottom: -30px; left: 50%; transform: translateX(-50%);
        background: #1a1a28; color: #e8e8f0; font-size: 11px; font-weight: 500;
        white-space: nowrap; border-radius: 5px; padding: 4px 8px;
        pointer-events: none; opacity: 0; transition: opacity 0.15s;
        border: 1px solid #2a2845;
      }
      #${NAV_BTN_ID}:hover::after { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  const wrapper = document.createElement('span');
  wrapper.style.cssText = 'display: contents;';

  const btn = document.createElement('button');
  btn.id = NAV_BTN_ID;
  btn.title = 'Starvell Helper — открыть дашборд';
  btn.textContent = 'S';
  wrapper.appendChild(btn);

  // ── Клик → переходим на /starvell-helper в этой же вкладке
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    location.href = 'https://starvell.com/starvell-helper';
  });

  const firstNavItem =
    rightZone.querySelector('[class*="header_user_nav_item"]') ||
    rightZone.querySelector('a');

  if (firstNavItem) {
    rightZone.insertBefore(wrapper, firstNavItem);
  } else {
    rightZone.appendChild(wrapper);
  }

  console.log('[Starvell Helper] Кнопка добавлена в навбар');
}

// ── MutationObserver + polling ───────────────────────
function waitForNavbar() {
  injectNavbarButton();
  const observer = new MutationObserver(() => {
    if (!document.getElementById(NAV_BTN_ID)) injectNavbarButton();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  let attempts = 0;
  const poll = setInterval(() => {
    if (document.getElementById(NAV_BTN_ID) || ++attempts > 30) { clearInterval(poll); return; }
    injectNavbarButton();
  }, 500);
}

// Навбар не нужен на странице дашборда
if (location.pathname !== '/starvell-helper') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', waitForNavbar);
  } else {
    waitForNavbar();
  }
}

//доработать автотикет систему получить свежие запросы в https://starvell.com/support/new