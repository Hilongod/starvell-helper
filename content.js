// =====================================================
//  Starvell Helper — content.js
//  Работает прямо на странице starvell.com
// =====================================================

let autoBoostInterval = null;
let boostIntervalMs = 30 * 60 * 1000;

// ─── Загружаем настройки при старте ─────────────────
chrome.storage.local.get(['autoBoost', 'boostInterval', 'customBg', 'bgUrl', 'bgOpacity'], (data) => {
  if (data.autoBoost) startAutoBoost(data.boostInterval || 30);
  if (data.customBg && data.bgUrl) applyBackground(data.bgUrl, data.bgOpacity ?? 0.15);
});

// ─── Перехватываем XHR/fetch сайта чтобы украсть параметры bump ──────
let lastBumpPayload = null;

chrome.storage.local.get(['lastBumpPayload'], (data) => {
  if (data.lastBumpPayload) {
    lastBumpPayload = data.lastBumpPayload;
    console.log('[Starvell Helper] Восстановлен lastBumpPayload:', lastBumpPayload);
  }
});

// Патчим window.fetch чтобы перехватывать bump-запросы сайта
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const result = await originalFetch.apply(this, args);

  try {
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    const options = args[1];

    if (url && url.includes('/api/offers/bump') && options?.method === 'POST') {
      const body = JSON.parse(options.body);
      if (body.gameId && body.categoryIds?.length > 0) {
        lastBumpPayload = body;
        chrome.storage.local.set({ lastBumpPayload: body });
        console.log('[Starvell Helper] Перехвачен bump сайта, запомнили параметры:', body);
      }
    }
  } catch (e) {}

  return result;
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
      boostAllLots().then(result => sendResponse({ ok: true, ...result }));
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
      sendResponse({
        running: autoBoostInterval !== null,
        url: location.href,
        knownPayload: !!lastBumpPayload
      });
      break;
  }
});

// =====================================================
//  ФУНКЦИЯ 1 — Автоподнятие лотов через API
// =====================================================

function startAutoBoost(intervalMinutes) {
  stopAutoBoost();
  boostIntervalMs = (intervalMinutes || 30) * 60 * 1000;
  boostAllLots();
  autoBoostInterval = setInterval(() => boostAllLots(), boostIntervalMs);
  console.log('[Starvell Helper] Автоподнятие запущено, интервал:', intervalMinutes, 'мин');
}

function stopAutoBoost() {
  if (autoBoostInterval) {
    clearInterval(autoBoostInterval);
    autoBoostInterval = null;
    console.log('[Starvell Helper] Автоподнятие остановлено');
  }
}

// ─── Получаем параметры для bump ─────────────────────
async function getBumpPayload() {

  // 1. Перехваченный payload — самый надёжный
  if (lastBumpPayload?.gameId && lastBumpPayload?.categoryIds?.length > 0) {
    console.log('[Starvell Helper] Используем перехваченный payload:', lastBumpPayload);
    return lastBumpPayload;
  }

  // 2. Пробуем получить список моих офферов и собрать все categoryIds
  const categories = await fetchMyCategoryIds();
  if (categories) {
    console.log('[Starvell Helper] Получены категории из API:', categories);
    return categories;
  }

  // 3. Fallback по URL
  const fromUrl = getPayloadFromUrl();
  console.log('[Starvell Helper] Fallback payload из URL:', fromUrl);
  return fromUrl;
}

// ─── Получаем categoryIds из API офферов ─────────────
async function fetchMyCategoryIds() {
  // Пробуем эндпоинты
  const endpoints = [
    '/api/offers/my',
    '/api/profile/offers',
  ];

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        credentials: 'include',
        headers: { 'Accept': 'application/json' }
      });
      if (!resp.ok) continue;

      const data = await resp.json();
      const offers = data.offers || data.items || data.data || (Array.isArray(data) ? data : null);
      if (!Array.isArray(offers) || offers.length === 0) continue;

      // Берём gameId из первого оффера, собираем все уникальные categoryIds
      const gameId = offers[0].gameId || offers[0].game?.id;
      const catSet = new Set();
      for (const offer of offers) {
        const cats = offer.categoryIds || offer.categories?.map(c => c.id) || [];
        cats.forEach(id => catSet.add(id));
        if (offer.categoryId) catSet.add(offer.categoryId);
      }

      if (gameId && catSet.size > 0) {
        return { gameId, categoryIds: Array.from(catSet) };
      }
    } catch (e) {}
  }

  return null;
}

// ─── Fallback: payload из URL страницы ───────────────
function getPayloadFromUrl() {
  const m = location.pathname.match(/\/(?:roblox|games\/(\d+))/);
  const gameId = m?.[1] ? parseInt(m[1]) : 1;

  // Если мы на странице конкретной категории — берём из URL
  const catMatch = location.pathname.match(/\/categories\/(\d+)/);
  if (catMatch) {
    return { gameId, categoryIds: [parseInt(catMatch[1])] };
  }

  // Резерв — известные категории Roblox (gameId=1).
  // Обновятся при первом ручном нажатии «Поднять» на сайте.
  return {
    gameId: 1,
    categoryIds: [55, 3, 38, 44, 74, 101, 105, 118]
  };
}

// ─── Один bump-запрос ─────────────────────────────────
async function sendBump(gameId, categoryIds) {
  const body = JSON.stringify({ gameId, categoryIds });
  console.log('[Starvell Helper] Отправляем bump:', body);

  try {
    const resp = await originalFetch('/api/offers/bump', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body
    });

    if (resp.status === 429) {
      const retryAfter = resp.headers.get('Retry-After');
      const waitSec = retryAfter ? parseInt(retryAfter) : 90;
      console.warn(`[Starvell Helper] 429 — ждём ${waitSec}с и повторяем...`);
      await sleep(waitSec * 1000);

      const retry = await originalFetch('/api/offers/bump', {
        method: 'POST',
        credentials: 'include',
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

// ─── Главная функция ──────────────────────────────────
async function boostAllLots() {
  const payload = await getBumpPayload();

  if (!payload.gameId) {
    const msg = '⚠ Не удалось определить игру. Нажми «Поднять» вручную один раз — расширение запомнит параметры.';
    console.warn('[Starvell Helper]', msg);
    chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
    return { count: 0, failed: 1, rateLimit: false };
  }

  const result = await sendBump(payload.gameId, payload.categoryIds);

  let msg;
  if (result.status === 429) {
    msg = '⚠ Rate limit — сервер ограничивает. Увеличь интервал до 60+ мин.';
  } else if (result.ok) {
    msg = `✅ Лоты подняты! (gameId=${payload.gameId}, ${payload.categoryIds.length} категорий)`;
  } else {
    msg = `⚠ Ошибка ${result.status}. Проверь F12 → Console.`;
  }

  console.log('[Starvell Helper]', msg, result);
  chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });

  return {
    count: result.ok ? 1 : 0,
    failed: result.ok ? 0 : 1,
    rateLimit: result.status === 429
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =====================================================
//  ФУНКЦИЯ 2 — Кастомный фон
// =====================================================

const BG_OVERLAY_ID = 'starvell-helper-bg';
const BG_STYLE_ID   = 'starvell-helper-bg-style';

function applyBackground(imageUrl, opacity = 0.15) {
  removeBackground();

  // Слой только для фона — opacity не затрагивает контент
  const overlay = document.createElement('div');
  overlay.id = BG_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: -1;
    background-image: url("${imageUrl}");
    background-size: cover;
    background-position: center top;
    background-repeat: no-repeat;
    background-attachment: fixed;
    opacity: ${opacity};
    pointer-events: none;
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