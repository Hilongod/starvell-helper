// =====================================================
//  Starvell Helper — content/01-core.js
// =====================================================

const SH_VERSION = (() => {
  try { return chrome.runtime.getManifest().version; } catch(e) { return '2.1.3'; }
})();
console.log(`%c[Starvell Helper] v${SH_VERSION} загружен`,`color:#7c5cfc;font-weight:bold`);

// Обновление настроек "на лету" (без перезагрузки страницы)
function pushSoundSettings(msg, order) {
  window.postMessage({
    source: 'starvell-helper-sounds',
    settings: { message: msg, purchase: order }
  }, '*');
}

let autoBoostInterval = null;
let boostIntervalMs = 30 * 60 * 1000;
let sessionKeyVisible = false;
let currentSessionKey = '';

// ─── Загружаем настройки при старте ─────────────────
chrome.storage.local.get(['autoBoost', 'boostInterval', 'customBg', 'bgUrl', 'bgOpacity', 'glowEnabled', 'glowColor', 'glowIntensity'], (data) => {
  if (data.autoBoost) startAutoBoost(data.boostInterval || 30);
  if (data.customBg && data.bgUrl) applyBackground(data.bgUrl, data.bgOpacity ?? 1);
  if (data.glowEnabled) applyGlow(data.glowColor || 'violet', data.glowIntensity || 35);
});

const originalFetch = window.fetch;

// ─── Слушаем команды от background.js / других частей расширения ───
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
      return true; // отвечаем асинхронно
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

// =====================================================
//  ПРОВЕРКА АВТОРИЗАЦИИ
// =====================================================

async function checkAuth() {
  const username = getCurrentUsername();
  if (username) return true;
  const cookie = await new Promise(res => chrome.cookies.get({url: 'https://starvell.com', name: 'session'}, res));
  if (cookie && cookie.value) return true;
  const cookies = await new Promise(res => chrome.cookies.getAll({domain: 'starvell.com'}, res));
  const sessionLike = cookies.find(c => c.value && c.value.length > 20);
  return !!sessionLike;
}

// =====================================================
//  ФУНКЦИЯ 1 — Автоподнятие лотов
// =====================================================

async function startAutoBoost(intervalMinutes) {
  stopAutoBoost();
  boostIntervalMs = (intervalMinutes || 30) * 60 * 1000;
  await boostAllLots(); // ждём первый прогон — если внутри cooldown, перепланирует сама
  if (!autoBoostInterval) { // только если boostAllLots НЕ перепланировала таймер
    autoBoostInterval = setInterval(() => boostAllLots(), boostIntervalMs);
  }
  console.log('[Starvell Helper] Автоподнятие запущено, интервал:', intervalMinutes, 'мин');
}

function stopAutoBoost() {
  if (autoBoostInterval) {
    clearInterval(autoBoostInterval);
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
    const stored = await new Promise(res => chrome.storage.local.get(['shUsername'], res));
    username = stored.shUsername;
  }
  if (!username) {
    addLog('error', 'Не удалось определить username — открой свою страницу профиля.');
    return [];
  }
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

// ─── ГЛАВНАЯ: поднять все игры (по одному bump на игру) ───
async function boostAllLots() {
  if (!(await checkAuth())) {
    const msg = '⚠ Вы не авторизованы на Starvell. Войдите в аккаунт.';
    addLog('error', msg);
    chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
    return { count: 0, failed: 1, rateLimit: false, cooldownSec: 0 };
  }

  // 🔥 НОВОЕ: fallback username из storage, если сейчас не на профиле
  let username = getCurrentUsername();
  if (!username) {
    const stored = await new Promise(res => chrome.storage.local.get(['shUsername'], res));
    username = stored.shUsername;
  } else {
    chrome.storage.local.set({ shUsername: username }); 
  }

  const categories = await fetchAllActiveCategories();
  if (!categories.length) {
    const msg = '⚠ Активных лотов не найдено. Открой свою страницу профиля и попробуй снова.';
    addLog('error', msg);
    chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
    return { count: 0, failed: 1, rateLimit: false, cooldownSec: 0 };
  }

  const games = groupByGame(categories);
  addLog('info', `Поднимаю ${games.length} игр(ы), всего категорий: ${categories.length}.`);

  let successCount = 0, failCount = 0, rateLimited = false;
  let cooldownSec = 0; 

  for (let i = 0; i < games.length; i++) {
    const { gameId, gameName, categoryIds } = games[i];
    addLog('info', `${gameName} (id ${gameId}): ${categoryIds.length} категорий...`);

    const result = await sendBumpWithRetry(gameId, categoryIds);

    // 🔥 НОВОЕ: обработка cooldown
    if (result.cooldown) {
      rateLimited = true;
      cooldownSec = Math.max(cooldownSec, result.retryAfter);
      addLog('warn', `⏳ Cooldown «${gameName}» — ждать ${Math.round(result.retryAfter/60)} мин`);
      // Cooldown обычно общий на аккаунт, остальные игры тоже пропускаем
      break;
    }

    if (result.status === 429) {
      rateLimited = true;
      addLog('warn', `Rate limit на «${gameName}» — пропускаем.`);
      failCount++;
    } else if (result.ok && result.body?.success !== false) {
      successCount++;
      addLog('ok', `✅ ${gameName} поднята (${categoryIds.length} кат.).`);
    } else {
      failCount++;
      const errMsg = result.body?.message || `ошибка ${result.status}`;
      addLog('error', `❌ ${gameName}: ${errMsg}.`);
    }

    if (i < games.length - 1) await sleep(2500); // пауза между играми против 429
  }

  // 🔥 НОВОЕ: перепланируем автоподнятие, если был cooldown
  if (cooldownSec > 0) {
    const nextMs = (cooldownSec + 60) * 1000; // +1 минута запаса
    addLog('info', `⏳ Автоподнятие перепланировано через ${Math.round(nextMs/60000)} мин`);
    rescheduleAutoBoost(nextMs);
  }

  const msg = successCount
    ? `✅ Поднято игр: ${successCount} из ${games.length}.`
    : (cooldownSec > 0 ? `⏳ Cooldown — следующий подъём через ${Math.round(cooldownSec/60)} мин.` : `⚠ Не удалось поднять ни одной игры.`);
  chrome.runtime.sendMessage({ type: 'SHOW_NOTIFICATION', text: msg });
  addLog(successCount ? 'ok' : (cooldownSec > 0 ? 'warn' : 'warn'), msg);

  return { count: successCount, failed: failCount, rateLimit: rateLimited, cooldownSec };
}

function rescheduleAutoBoost(ms) {
  stopAutoBoost();
  boostIntervalMs = ms;

  // Пересоздаём интервал
  autoBoostInterval = setInterval(() => boostAllLots(), boostIntervalMs);

  // Обновляем UI
  updateBoostTimerUI(ms);
}

function updateBoostTimerUI(ms) {
  const statusEl = document.getElementById('sh-boost-status-text');
  const dot = document.getElementById('sh-boost-dot');
  if (!statusEl) return;

  if (dot) dot.className = 'sh-dot inactive';

  const deadline = Date.now() + ms;

  // Очищаем старый таймер обновления текста
  if (window._shBoostTimer) clearInterval(window._shBoostTimer);

  window._shBoostTimer = setInterval(() => {
    const left = deadline - Date.now();
    if (left <= 0) {
      clearInterval(window._shBoostTimer);
      if (dot) dot.className = 'sh-dot active';
      statusEl.textContent = 'Активно — поднимаю...';
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    statusEl.textContent = `⏳ Cooldown — следующий подъём через ${m}:${String(s).padStart(2,'0')}`;
  }, 1000);
}

// Вспомогательная функция с повторной попыткой при 429
async function sendBumpWithRetry(gameId, categoryIds, retryCount = 0) {
  const result = await sendBump(gameId, categoryIds);

  // 🔥 НОВОЕ: ловим cooldown от сервера (200 OK, но success: false)
  if (result.body?.success === false && result.body?.data?.code === 'OFFERS_BUMP_COOLDOWN') {
    return {
      ...result,
      cooldown: true,
      retryAfter: result.body.data.retryAfterSeconds || 3600
    };
  }

  if (result.status === 429 && retryCount < 2) {
    const retryAfter = parseInt(result.headers?.get('Retry-After')) || 90;
    addLog('warn', `429 на gameId=${gameId}, ждём ${retryAfter} сек...`);
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
    return { ok: false, status: 0, body: {}, headers: new Headers() };
  }
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
  document.documentElement.appendChild(overlay);

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
      if (resp && resp.success && resp.value && resp.value.length > 20) {
        currentSessionKey = resp.value;
        renderSessionKey();
        shFeedback('sh-session-feedback', '✓ Ключ загружен (background)', 'ok');
        console.log('[SH] Session from background:', resp.value.slice(0, 8) + '...');
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
      const pairs = dc.split(';').map(s => s.trim().split('=')).filter(p => p.length === 2);
      for (const [n, v] of pairs) {
        const dec = decodeURIComponent(v);
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
    shFeedback('sh-session-feedback', `✓ Ключ найден (${source})`, 'ok');
  }

  function noKey() {
    currentSessionKey = '';
    renderSessionKey();
    shFeedback('sh-session-feedback', '⚠ Ключ не найден. Проверь авторизацию на starvell.com', 'err');
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