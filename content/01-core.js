// =====================================================
//  Starvell Helper — content/01-core.js
// =====================================================

const SH_VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch(e) { return '2.1.4'; }
})();
console.log(`%c[Starvell Helper] v${SH_VERSION} загружен`, 'color:#7c5cfc;font-weight:bold');

function pushSoundSettings(msg, order) {
  window.postMessage({ source: 'starvell-helper-sounds', settings: { message: msg, purchase: order } }, '*');
}

let sessionKeyVisible = false;
let currentSessionKey = '';
let boostRunPromise = null;
let homepageDataPromise = null;
let refreshedBuildId = null;
const originalFetch = window.fetch.bind(window);
const BOOST_DISCOVERY_MS = 30 * 60 * 1000;
const BOOST_SAFETY_MS = 60 * 1000;
const BOOST_ERROR_RETRY_MS = 5 * 60 * 1000;

function requestBackground(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, response => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else if (!response) reject(new Error('Background не ответил. Перезагрузи расширение и вкладку.'));
      else resolve(response);
    });
  });
}

function initializeContentSettings() {
  chrome.storage.local.get(['customBg', 'bgUrl', 'bgOpacity', 'glowEnabled', 'glowColor', 'glowIntensity'], data => {
    if (data.customBg && data.bgUrl) applyBackground(data.bgUrl, data.bgOpacity ?? 1);
    if (data.glowEnabled) applyGlow(data.glowColor || 'violet', data.glowIntensity || 35);
  });
  requestBackground({ type: 'BOOST_READY' }).catch(error => console.warn('[Starvell Helper]', error.message));
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeContentSettings, { once: true });
} else {
  setTimeout(initializeContentSettings, 0);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'BOOST_PROBE':
      sendResponse({ ok: true, protocol: 3, version: SH_VERSION, ready: document.readyState !== 'loading', busy: !!boostRunPromise });
      break;
    case 'BOOST_NOW': {
      if (!msg.runId) {
        sendResponse({ ok: false, error: 'Не указан идентификатор запуска.' });
        break;
      }
      if (boostRunPromise) {
        sendResponse({ ok: false, busy: true, error: 'Поднятие уже выполняется в этой вкладке.' });
        break;
      }
      // Короткое подтверждение: service worker не ждёт сеть/паузы в открытом порту.
      sendResponse({ ok: true, status: 'accepted', runId: msg.runId });
      boostAllLots({ automatic: msg.automatic !== false, expiresAt: msg.expiresAt })
        .then(result => requestBackground({ type: 'BOOST_COMPLETED', runId: msg.runId, result }))
        .catch(error => console.error('[Starvell Helper] Завершение поднятия:', error));
      break;
    }
    case 'APPLY_BG':
      applyBackground(msg.url, msg.opacity);
      sendResponse({ ok: true });
      break;
    case 'REMOVE_BG':
      removeBackground();
      sendResponse({ ok: true });
      break;
  }
});

async function checkAuth() {
  // user в данных Next.js — владелец авторизованной сессии, в отличие от foreignProfileUser.
  if (getCurrentUsername()) return true;
  // cookies API доступен в background, а не в content script.
  const response = await requestBackground({ type: 'CHECK_AUTH' });
  return response.authenticated === true;
}

function startAutoBoost(intervalMinutes) {
  return requestBackground({ type: 'TOGGLE_AUTO_BOOST', enabled: true, interval: intervalMinutes });
}
function stopAutoBoost() {
  return requestBackground({ type: 'TOGGLE_AUTO_BOOST', enabled: false });
}

function getNextData() {
  try {
    const node = document.getElementById('__NEXT_DATA__');
    return node ? JSON.parse(node.textContent) : null;
  } catch (error) { return null; }
}

function getCurrentUsername() {
  const pp = getNextData()?.props?.pageProps || {};
  // foreignProfileUser и URL относятся к просматриваемому профилю, не к владельцу сессии.
  return pp.user?.username || pp.bff?.user?.username || null;
}

function parseNextDataHtml(html) {
  const match = html.match(/<script\b(?=[^>]*\bid\s*=\s*["']__NEXT_DATA__["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!match) throw new Error('Не удалось прочитать данные Starvell. Открой свою страницу профиля.');
  return JSON.parse(match[1]);
}

async function fetchWithTimeout(url, options = {}, readResponse = response => response) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await originalFetch(url, { ...options, signal: controller.signal });
    return await readResponse(response);
  } finally {
    clearTimeout(timer);
  }
}

function loadHomepageData(refresh = false) {
  if (!homepageDataPromise || refresh) {
    homepageDataPromise = (async () => {
      return fetchWithTimeout(`${location.origin}/`, { credentials: 'include', cache: 'no-store' }, async response => {
        if (!response.ok) throw new Error(`Главная Starvell вернула HTTP ${response.status}`);
        return parseNextDataHtml(await response.text());
      });
    })();
    homepageDataPromise.catch(() => { homepageDataPromise = null; });
  }
  return homepageDataPromise;
}

async function resolveCurrentUsername() {
  let username = getCurrentUsername();
  if (!username) {
    const home = await loadHomepageData(true);
    const pp = home.props?.pageProps || {};
    username = pp.user?.username || pp.bff?.user?.username;
  }
  if (!username) throw new Error('Не удалось определить владельца сессии. Войди в аккаунт и открой свой профиль.');
  await chrome.storage.local.set({ shUsername: username });
  return username;
}

async function fetchBuildId(refresh = false) {
  if (!refresh && refreshedBuildId) return refreshedBuildId;
  if (!refresh && getNextData()?.buildId) return getNextData().buildId;
  const home = await loadHomepageData(refresh);
  if (!home.buildId) throw new Error('Не удалось определить актуальный buildId Starvell.');
  refreshedBuildId = home.buildId;
  return refreshedBuildId;
}

function extractActiveCategories(pp) {
  const result = new Map();
  const knownEmpty = new Set();
  const catalog = pp.catalogUserProfileOffersResult ?? pp.bff?.catalogUserProfileOffersResult;
  const legacy = pp.userProfileOffers?.length ? pp.userProfileOffers : (pp.bff?.userProfileOffers || pp.userProfileOffers);
  const filters = pp.catalogUserProfileOffersFilters || pp.bff?.catalogUserProfileOffersFilters;
  const categories = Array.isArray(catalog?.categories) ? catalog.categories : legacy;
  if (!Array.isArray(categories) && !Array.isArray(filters?.games)) {
    throw new Error('Неизвестный формат профиля Starvell: список категорий отсутствует.');
  }
  function add(category, game, fromFilter = false) {
    const categoryId = Number(category.id);
    const gameId = Number(category.gameId ?? category.game?.id ?? game?.id);
    if (!Number.isSafeInteger(categoryId) || categoryId <= 0 || !Number.isSafeInteger(gameId) || gameId <= 0) return;
    const key = `${gameId}:${categoryId}`;
    const offersCount = Array.isArray(category.offers) ? category.offers.length : Number(category.offersCount || 0);
    if (!fromFilter && offersCount === 0) { if (catalog?.hasMore !== true) knownEmpty.add(key); return; }
    if (fromFilter && knownEmpty.has(key)) return;
    if (!result.has(key)) result.set(key, {
      categoryId, categoryName: category.name || String(categoryId),
      gameId, gameName: category.game?.name || game?.name || String(gameId),
      offersCount: fromFilter ? null : offersCount
    });
  }
  for (const category of categories || []) add(category);
  // Это фильтры конкретного профиля продавца, а не общий каталог сайта.
  // Они дополняют категории, отсутствующие в первой странице карточек лотов.
  for (const game of filters?.games || []) {
    for (const category of game.categories || []) add(category, game, true);
  }
  if (catalog?.hasMore === true && !filters?.games?.length) {
    throw new Error('Профиль содержит ещё страницы лотов, но список категорий недоступен. Нужен ответ фильтров Starvell.');
  }
  return [...result.values()].sort((a, b) => a.gameId - b.gameId || a.categoryId - b.categoryId);
}

async function fetchAllActiveCategories() {
  let username = (await resolveCurrentUsername()).toLowerCase();
  let buildId = await fetchBuildId();
  let refreshedBuild = false, refreshedOwner = false, redirectCount = 0;
  let pp, user;
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = `${location.origin}/_next/data/${encodeURIComponent(buildId)}/profile/`
      + `${encodeURIComponent(username)}.json?username=${encodeURIComponent(username)}`;
    const response = await fetchWithTimeout(url, {
      credentials: 'include', cache: 'no-store', headers: { 'x-nextjs-data': '1' }
    }, async response => ({ ok: response.ok, status: response.status, data: response.ok ? await response.json() : null }));
    if ((response.status === 404 || response.status === 410) && !refreshedBuild) {
      refreshedBuild = true;
      buildId = await fetchBuildId(true);
      continue;
    }
    if (!response.ok) throw new Error(`Профиль Starvell вернул HTTP ${response.status}`);
    pp = response.data?.pageProps || {};
    if (pp.__N_REDIRECT) {
      const redirect = pp.__N_REDIRECT.match(/^\/profile\/([^/?#]+)(?:[/?#]|$)/i);
      if (redirect && redirectCount++ < 2 && decodeURIComponent(redirect[1]).toLowerCase() === username.toLowerCase()) { username = decodeURIComponent(redirect[1]); continue; }
      throw new Error('Starvell перенаправил запрос профиля. Войди в аккаунт и открой свой профиль.');
    }
    user = pp.user || pp.bff?.user;
    // Авторизацию поднятия определяет свежий ответ сайта. Извлечение Secret Key для POST не требуется.
    if (!user?.username) throw new Error('Вы не авторизованы на Starvell. Войдите в аккаунт.');
    const owner = user.username.toLowerCase();
    if (owner !== username.toLowerCase() && !refreshedOwner) {
      refreshedOwner = true;
      username = owner;
      continue;
    }
    const profile = pp.foreignProfileUser || pp.bff?.foreignProfileUser;
    if (owner !== username.toLowerCase() || (profile && ((user.id && String(user.id) !== String(profile.id))
        || (profile.username && profile.username.toLowerCase() !== owner)))) {
      throw new Error('Ответ Starvell относится к другому профилю. Открой свой профиль и повтори.');
    }
    const categories = extractActiveCategories(pp);
    const games = groupByGame(categories);
    const previous = (await chrome.storage.local.get(['shBoostCatalog'])).shBoostCatalog;
    const signature = JSON.stringify(categories.map(category => [category.gameId, category.categoryId, category.offersCount]));
    const snapshot = {
      owner, userId: user.id == null ? null : String(user.id), checkedAt: Date.now(),
      categories, games, signature,
      totalOffers: categories.reduce((sum, category) => sum + (category.offersCount || 0), 0),
      offersCountComplete: categories.every(category => category.offersCount !== null)
    };
    await chrome.storage.local.set({ shUsername: user.username, shBoostCatalog: snapshot });
    if (previous?.owner !== owner || previous.signature !== signature) {
      addLog('info', `Каталог обновлён: ${games.length} игр/сервисов, ${categories.length} категорий с лотами.`);
    }
    return categories;
  }
  throw new Error('Не удалось получить актуальный профиль Starvell после повторной проверки.');
}

function groupByGame(categories) {
  const map = new Map();
  for (const category of categories) {
    if (!map.has(category.gameId)) map.set(category.gameId, { gameName: category.gameName, categoryIds: new Set() });
    map.get(category.gameId).categoryIds.add(category.categoryId);
  }
  return [...map.entries()].map(([gameId, value]) => ({
    gameId, gameName: value.gameName, categoryIds: [...value.categoryIds]
  }));
}

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - now) / 1000) : 0;
}

function bumpCooldown(result) {
  const body = result.body || {};
  const extras = [body.data, body.extra, body.error?.data, body.error?.extra, body.error, body];
  const detail = extras.find(value => value?.code === 'OFFERS_BUMP_COOLDOWN');
  const rateLimit = result.status === 429;
  if (!detail && !rateLimit) return null;
  const seconds = Number(detail?.retryAfterSeconds
    ?? extras.find(value => value?.retryAfterSeconds != null)?.retryAfterSeconds);
  const header = result.headers?.get('Retry-After');
  const validHeader = header != null && String(header).trim() !== ''
    && ((Number.isFinite(Number(header)) && Number(header) >= 0) || Number.isFinite(Date.parse(header)));
  const retryAfter = Number.isFinite(seconds) && seconds >= 0
    ? seconds : validHeader ? parseRetryAfter(header) : (detail ? 3600 : 90);
  return { retryAfter, global: rateLimit && !detail };
}

async function sendBump(gameId, categoryIds) {
  try {
    const response = await fetchWithTimeout('/api/offers/bump', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ gameId, categoryIds })
    }, async response => ({ ok: response.ok, status: response.status, headers: response.headers, text: await response.text() }));
    const text = response.text;
    let body = {};
    if (text.trim()) {
      try { body = JSON.parse(text); }
      catch (error) { return { ok: false, status: response.status, body: {}, headers: response.headers, error: 'Starvell вернул ответ не в формате JSON.' }; }
    }
    return { ok: response.ok, status: response.status, body: body || {}, headers: response.headers };
  } catch (error) {
    return { ok: false, status: 0, body: {}, headers: new Headers(), error: error.name === 'AbortError' ? 'Превышено время ожидания Starvell.' : error.message };
  }
}

async function sendBumpWithRetry(gameId, categoryIds) {
  // Cooldown перепланирует Chrome Alarm; вкладка не спит 90+ секунд и не повторяет POST.
  const result = await sendBump(gameId, categoryIds);
  const cooldown = bumpCooldown(result);
  return cooldown ? { ...result, cooldown: true, ...cooldown } : result;
}

function boostAllLots(options = {}) {
  if (boostRunPromise) return boostRunPromise;
  boostRunPromise = performBoost(options).catch(error => {
    const message = `❌ ${error.message}`;
    addLog('error', message);
    requestBackground({ type: 'SHOW_NOTIFICATION', text: message }).catch(console.warn);
    return { count: 0, failed: 1, rateLimit: false, cooldownSec: 0, nextDelayMs: BOOST_ERROR_RETRY_MS, message };
  }).finally(() => { boostRunPromise = null; });
  return boostRunPromise;
}

async function performBoost({ automatic = false, expiresAt = Infinity } = {}) {
  const settings = await chrome.storage.local.get([
    'autoBoost', 'boostInterval', 'shUsername', 'shBoostStateOwner', 'shBoostGameStates',
    'shBoostCooldowns', 'shBoostRateLimitUntil'
  ]);
  if (automatic && !settings.autoBoost) return { count: 0, failed: 0, cancelled: true };
  if (Date.now() >= expiresAt) throw new Error('Истекло время запуска. Повторная проверка будет выполнена позже.');
  const interval = Number(settings.boostInterval);
  const baseMs = (Number.isFinite(interval) && interval >= 0.5 ? interval : 120) * 60000 + BOOST_SAFETY_MS;

  // Плановое обнаружение — раз в 30 минут. Перед поднятием также читаем свежий профиль.
  const categories = await fetchAllActiveCategories();
  const catalog = (await chrome.storage.local.get(['shBoostCatalog'])).shBoostCatalog;
  const owner = catalog.owner;
  const sameOwner = settings.shBoostStateOwner === owner;
  const legacyOwner = !settings.shBoostStateOwner && String(settings.shUsername || '').toLowerCase() === owner;
  const states = sameOwner ? { ...(settings.shBoostGameStates || {}) } : {};
  let globalUntil = sameOwner || legacyOwner ? Number(settings.shBoostRateLimitUntil) || 0 : 0;
  if (legacyOwner) {
    for (const [gameId, until] of Object.entries(settings.shBoostCooldowns || {})) {
      if (Number(until) > Date.now()) states[gameId] = { nextAt: Number(until), cooldownUntil: Number(until), reason: 'cooldown' };
    }
  }
  const games = groupByGame(categories);
  // Обновляем состав каждой игры до проверки сроков: добавленные категории сохраняются и во время cooldown.
  for (const game of games) {
    const state = { ...(states[game.gameId] || {}), categoryIds: game.categoryIds, gameName: game.gameName };
    if (state.reason === 'interval' && state.lastSuccessAt) state.nextAt = Number(state.lastSuccessAt) + baseMs;
    states[game.gameId] = state;
  }
  // Необработанные игры имеют приоритет перед повторным поднятием уже обработанных.
  // При большом каталоге это позволяет продолжить очередь после ограничения времени запуска.
  games.sort((a, b) => (Number(states[a.gameId].nextAt) || 0) - (Number(states[b.gameId].nextAt) || 0));
  async function saveState() {
    const cooldowns = {};
    for (const [gameId, state] of Object.entries(states)) {
      if (Number(state.cooldownUntil) > Date.now()) cooldowns[gameId] = Number(state.cooldownUntil);
    }
    await chrome.storage.local.set({ shBoostStateOwner: owner, shBoostGameStates: states, shBoostCooldowns: cooldowns, shBoostRateLimitUntil: globalUntil });
  }

  let count = 0, failed = 0, attempted = 0, skipped = 0, cancelled = false;
  let rateLimit = globalUntil > Date.now();
  for (let i = 0; i < games.length; i++) {
    if (Date.now() >= expiresAt) { failed++; addLog('error', 'Истекло время запуска. Остальные игры будут проверены позже.'); break; }
    if (automatic && !(await chrome.storage.local.get(['autoBoost'])).autoBoost) { cancelled = true; break; }
    const { gameId, gameName, categoryIds } = games[i];
    const state = states[gameId];
    const cooling = Number(state.cooldownUntil) > Date.now();
    if (cooling) rateLimit = true;
    if (globalUntil > Date.now() || cooling || (automatic && Number(state.nextAt) > Date.now())) { skipped++; continue; }
    attempted++;
    addLog('info', `${gameName} (id ${gameId}): поднимаю ${categoryIds.length} категорий.`);
    const result = await sendBumpWithRetry(gameId, categoryIds);
    if (result.cooldown) {
      rateLimit = true;
      const until = Date.now() + result.retryAfter * 1000 + BOOST_SAFETY_MS;
      if (result.global) globalUntil = until;
      else Object.assign(state, { nextAt: until, cooldownUntil: until, reason: 'cooldown', retryAfterSeconds: result.retryAfter });
      addLog('warn', `⏳ ${gameName}: cooldown ${Math.ceil(result.retryAfter / 60)} мин (+1 мин запаса).`);
      await saveState();
      if (result.global) break;
    } else if (result.ok && result.body?.success !== false && !result.body?.error) {
      const successAt = Date.now();
      Object.assign(state, { lastSuccessAt: successAt, nextAt: successAt + baseMs, cooldownUntil: 0, reason: 'interval' });
      count++;
      addLog('ok', `✅ ${gameName} поднята (${categoryIds.length} кат.).`);
      await saveState(); // результат сохраняется сразу, в том числе при последующем закрытии вкладки
    } else {
      Object.assign(state, { nextAt: Date.now() + BOOST_ERROR_RETRY_MS, reason: 'error' });
      failed++;
      const message = result.error || result.body?.message || result.body?.data?.message || result.body?.error?.message || `HTTP ${result.status}`;
      addLog('error', `❌ ${gameName}: ${message}`);
      if (result.status === 401 || result.status === 403) break;
    }
    if (i < games.length - 1) await sleep(2500);
  }
  await saveState();
  const now = Date.now();
  const dueTimes = games.map(game => Math.max(Number(states[game.gameId].nextAt) || now, globalUntil));
  const nextBumpAt = dueTimes.length ? Math.max(now, Math.min(...dueTimes)) : 0;
  const nextDelayMs = nextBumpAt ? Math.min(BOOST_DISCOVERY_MS, Math.max(30000, nextBumpAt - now)) : BOOST_DISCOVERY_MS;
  const cooldownTimes = games.map(game => Number(states[game.gameId].cooldownUntil)).filter(time => time > now);
  const cooldownSec = globalUntil > now ? Math.ceil((globalUntil - now) / 1000)
    : cooldownTimes.length ? Math.ceil((Math.min(...cooldownTimes) - now) / 1000) : 0;
  const message = cancelled ? `Автоподнятие остановлено. Поднято игр/сервисов: ${count}.`
    : count ? `✅ Поднято игр/сервисов: ${count} из ${games.length}.`
    : failed ? '⚠ Не удалось поднять предложения. Подробности в логе.'
    : !games.length ? 'Активных лотов нет. Продолжаю проверять профиль на новые предложения.'
    : rateLimit ? '⏳ Ожидаю cooldown. Новые игры и категории продолжаю проверять.'
    : 'Ожидаю следующего срока поднятия. Профиль проверяется на новые предложения.';
  if (attempted || failed || cancelled) addLog(count ? 'ok' : failed ? 'error' : 'warn', message);
  if (attempted || failed) await requestBackground({ type: 'SHOW_NOTIFICATION', text: message }).catch(console.warn);
  return { count, failed, attempted, skipped, cancelled, rateLimit, cooldownSec, nextDelayMs, nextBumpAt, message, totalGames: games.length, profileOwner: owner };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// ─── Лог событий ─────────────────────────────────────
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

  // 1) сам фон — полноэкранный слой позади контента сайта
  const overlay = document.createElement('div');
  overlay.id = BG_OVERLAY_ID;
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: -1;
    background-image: url("${imageUrl}");
    background-size: cover; background-position: center top;
    background-repeat: no-repeat; background-attachment: fixed;
    opacity: ${opacity}; pointer-events: none;
  `;
  document.body.appendChild(overlay);

  // 2) делаем непрозрачные блоки сайта прозрачными, чтобы фон был виден
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
//  ФУНКЦИЯ 3 — Session key
// =====================================================

function sessionKeyFeedback(text, type) {
  const element = document.getElementById('sh-session-feedback');
  if (!element) return;
  element.textContent = text;
  element.className = 'sh-feedback ' + (type === 'ok' ? 'ok' : 'err');
  element.style.display = 'block';
}

function loadSessionKey() {
  const displayEl = document.getElementById('sh-session-display');
  if (!displayEl) return;

  // Шаг 1: Спрашиваем background.js (единственный, кто видит HttpOnly cookie)
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
    chrome.runtime.sendMessage({ type: 'GET_SESSION_COOKIE' }, (resp) => {
      if (chrome.runtime.lastError) {
        console.warn('[SH] background error:', chrome.runtime.lastError.message);
        fallbackLoadSession();
        return;
      }
      if (resp && resp.success && typeof resp.value === 'string' && resp.value.length > 20) {
        currentSessionKey = resp.value;
        renderSessionKey();
        sessionKeyFeedback('✓ Ключ загружен (background)', 'ok');
        return;
      }
      console.warn('[SH] Background не нашёл session, пробуем fallback...');
      fallbackLoadSession();
    });
  } else {
    fallbackLoadSession();
  }

  // Шаг 2: Fallback — если background не ответил
  function fallbackLoadSession() {
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    // Пробуем document.cookie
    const dc = document.cookie;
    if (dc) {
      const pairs = dc.split(';').map(s => { const at = s.indexOf('='); return [s.slice(0, at).trim(), s.slice(at + 1)]; });
      for (const [n, v] of pairs) {
        let dec;
        try { dec = decodeURIComponent(v); } catch (error) { continue; }
        if (n.trim() === 'session' && (uuidRe.test(dec) || dec.length > 30)) {
          return setKey(dec, 'document.cookie');
        }
      }
    }

    // Пробуем __NEXT_DATA__
    try {
      const nd = document.getElementById('__NEXT_DATA__');
      if (nd) {
        const data = JSON.parse(nd.textContent);
        const pp = data.props?.pageProps || {};
        const candidates = [pp.user?.session, pp.user?.token, pp.bff?.user?.session, pp.session];
        for (const v of candidates) {
          if (v && (uuidRe.test(v) || v.length > 30)) return setKey(v, '__NEXT_DATA__');
        }
      }
    } catch(e) {}

    noKey();
  }

  function setKey(value, source) {
    currentSessionKey = value;
    renderSessionKey();
    sessionKeyFeedback(`✓ Ключ найден (${source})`, 'ok');
  }

  function noKey() {
    currentSessionKey = '';
    renderSessionKey();
    sessionKeyFeedback('⚠ Ключ не найден. Проверь авторизацию на starvell.com', 'err');
  }
}

function renderSessionKey() {
  const el = document.getElementById('sh-session-display');
  const btn = document.getElementById('sh-session-toggle-btn');
  if (!el) return;
  if (!currentSessionKey) {
    el.textContent = '—';
    if (btn) btn.textContent = '👁 Показать';
    return;
  }
  if (sessionKeyVisible) {
    el.textContent = currentSessionKey;
    if (btn) btn.textContent = '❌ Скрыть';
  } else {
    el.textContent = '•'.repeat(Math.min(currentSessionKey.length, 40));
    if (btn) btn.textContent = '👁 Показать';
  }
}

function drawSalesChart(orders) {
  const card = document.getElementById('sh-stats-chart-card');
  const canvas = document.getElementById('sh-stats-chart');
  if (!canvas || !card) return;
  const completed = orders.filter(o => o.status === 'COMPLETED');
  if (completed.length === 0) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const byDay = {};
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = `${String(d.getDate()).padStart(2,'0')}.${String(d.getMonth()+1).padStart(2,'0')}`;
    byDay[key] = 0;
  }
  completed.forEach(o => {
    const date = new Date(o.createdAt || o.created_at || o.date || 0);
    const key = `${String(date.getDate()).padStart(2,'0')}.${String(date.getMonth()+1).padStart(2,'0')}`;
    if (byDay.hasOwnProperty(key)) { byDay[key] += (o.basePrice || 0) / 100; }
  });
  const labels = Object.keys(byDay);
  const values = Object.values(byDay);
  const maxVal = Math.max(...values, 1);
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = rect.width || 600;
  const h = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const pad = {top: 20, right: 30, bottom: 30, left: 50}; // right: 30 вместо 10
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;
  const barW = cw / labels.length * 0.6;
  const gap = cw / labels.length * 0.4;
  ctx.strokeStyle = '#1e1e35';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + ch * (i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    const val = maxVal * (1 - i / 4);
    ctx.fillStyle = '#8888aa'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(Math.round(val) + '₽', pad.left - 6, y + 3);
  }
  labels.forEach((label, i) => {
    const val = values[i];
    const barH = (val / maxVal) * ch;
    const x = pad.left + i * (cw / labels.length) + gap / 2;
    const y = pad.top + ch - barH;
    const grad = ctx.createLinearGradient(0, y, 0, y + barH);
    grad.addColorStop(0, '#7c5cfc');
    grad.addColorStop(1, '#5a3fd0');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(x, y, barW, barH, [4, 4, 0, 0]);
    ctx.fill();
    ctx.fillStyle = '#8888aa'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(label, x + barW / 2, h - 8);
  });

  // ── Tooltip ──
  let tooltip = document.getElementById('sh-chart-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'sh-chart-tooltip';
    tooltip.style.cssText = `
      position:absolute; background:#1a1a28; border:1px solid #2a2845;
      border-radius:8px; padding:8px 12px; font-size:12px; color:#e8e8f0;
      pointer-events:none; opacity:0; transition:opacity 0.15s; z-index:10;
      white-space:nowrap; box-shadow:0 4px 12px rgba(0,0,0,0.4);
    `;
    canvas.parentElement.style.position = 'relative';
    canvas.parentElement.appendChild(tooltip);
  }

  // Сохраняем актуальные данные на canvas для обработчиков
  canvas._shChartData = { labels, values, pad, cw, w };

  if (!canvas._shChartListeners) {
    canvas._shChartListeners = true;
    canvas.addEventListener('mousemove', (e) => {
      const data = canvas._shChartData;
      if (!data) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const colW = data.cw / data.labels.length;
      const idx = Math.floor((mx - data.pad.left) / colW);
      if (idx >= 0 && idx < data.labels.length && mx >= data.pad.left && mx <= data.w - data.pad.right) {
        tooltip.style.opacity = '1';
        tooltip.style.left = (mx + 12) + 'px';
        tooltip.style.top = (e.clientY - rect.top - 40) + 'px';
        tooltip.innerHTML = `<b style="color:#a07cff">${data.labels[idx]}</b> — заработано <b>${Math.round(data.values[idx])} ₽</b>`;
      } else {
        tooltip.style.opacity = '0';
      }
    });
    canvas.addEventListener('mouseleave', () => {
      tooltip.style.opacity = '0';
    });
  }
}
