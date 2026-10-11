// =====================================================
//  Starvell Helper — background.js (Service Worker, MV3)
// =====================================================

// =====================================================
//  КЕШ НАСТРОЕК ЗВУКОВ + РАННИЙ ИНЖЕКТ В MAIN WORLD
// =====================================================

let soundSettingsCache = { message: 'default', purchase: 'default' };

// Загружаем кеш при старте service worker
chrome.storage.local.get(['shSoundMsg', 'shSoundOrder'], (data) => {
  soundSettingsCache.message = data.shSoundMsg || 'default';
  soundSettingsCache.purchase = data.shSoundOrder || 'default';
});

// Обновляем кеш при изменении настроек
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.shSoundMsg) soundSettingsCache.message = changes.shSoundMsg.newValue;
  if (changes.shSoundOrder) soundSettingsCache.purchase = changes.shSoundOrder.newValue;
});

// Инжектим перехват fetch ПЕРЕД загрузкой скриптов Starvell
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'loading') return;

  const settings = { ...soundSettingsCache };
  const extId = chrome.runtime.id;

  chrome.scripting.executeScript({
    target: { tabId },
    func: (settings, extId) => {
      if (window.__shSoundHook) return;
      if (!location.href.startsWith('https://starvell.com')) return;

      window.__shSoundHook = true;
      window.__shSoundSettings = settings;

      const MAP = {
        message: {
          custom1: `chrome-extension://${extId}/sounds/msg1.mp3`,
          custom2: `chrome-extension://${extId}/sounds/msg2.mp3`,
          custom3: `chrome-extension://${extId}/sounds/msg3.mp3`
        },
        purchase: {
          custom1: `chrome-extension://${extId}/sounds/order1.mp3`,
          custom2: `chrome-extension://${extId}/sounds/order2.mp3`,
          custom3: `chrome-extension://${extId}/sounds/order3.mp3`
        }
      };

      const origFetch = window.fetch;
      window.fetch = async function(...args) {
        let reqUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        if (!reqUrl) return origFetch.apply(this, args);

        let type = null;
        if (reqUrl.includes('/sounds/message.mp3')) type = 'message';
        else if (reqUrl.includes('/sounds/purchase.mp3')) type = 'purchase';

        if (type) {
          const mode = window.__shSoundSettings?.[type] ?? settings[type];
          if (mode === 'mute') {
            const silence = Uint8Array.from(atob('UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA='), c => c.charCodeAt(0));
            return new Response(new Blob([silence], {type:'audio/wav'}), {status:200});
          }
          const custom = MAP[type]?.[mode];
          if (custom) {
            if (typeof args[0] === 'string') {
              args[0] = custom;
            } else {
              const req = args[0];
              args[0] = new Request(custom, {
                method: req.method,
                headers: req.headers,
                body: req.body,
                mode: req.mode,
                credentials: req.credentials,
                cache: req.cache,
                redirect: req.redirect,
                referrer: req.referrer,
                integrity: req.integrity
              });
            }
          }
        }
        return origFetch.apply(this, args);
      };

      window.addEventListener('message', function(e){
        if (e.source !== window) return;
        if (e.data?.source === 'starvell-helper-sounds' && e.data.settings) {
          Object.assign(window.__shSoundSettings, e.data.settings);
        }
      });
    },
    args: [settings, extId],
    world: 'MAIN',
    injectImmediately: true
  }).catch(() => {});
});

// Клик по иконке расширения → открываем /starvell-helper
chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ url: 'https://starvell.com/*' }, (tabs) => {
    if (tabs.length > 0) {
      // Есть вкладка Starvell — переходим в ней
      chrome.tabs.update(tabs[0].id, { url: 'https://starvell.com/starvell-helper', active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      // Нет вкладки — открываем новую
      chrome.tabs.create({ url: 'https://starvell.com/starvell-helper' });
    }
  });
});

// =====================================================
//  Один планировщик для всех вкладок: Chrome Alarms
// =====================================================
const BOOST_ALARM = 'starvell-boost';
const BOOST_RUN_LIMIT_MS = 10 * 60 * 1000;
const BG_BOOST_DISCOVERY_MS = 30 * 60 * 1000;
const BG_BOOST_SAFETY_MS = 60 * 1000;
const BOOST_TIMING_REVISION = 'profile-30m-buffer-1m';
let boostQueue = Promise.resolve();

function queueBoostTask(task) {
  const pending = boostQueue.then(task);
  boostQueue = pending.catch(error => console.error('[Starvell Helper BG]', error));
  return pending;
}

function normalizeBoostInterval(value) {
  const minutes = Number(value);
  return Number.isFinite(minutes) && minutes >= 0.5 ? minutes : 120;
}

async function backgroundLog(type, text) {
  console.log('[Starvell Helper BG]', text);
  const data = await chrome.storage.local.get(['shLog']);
  const log = [{ type, text, time: new Date().toLocaleTimeString('ru-RU') }, ...(data.shLog || [])].slice(0, 200);
  await chrome.storage.local.set({ shLog: log });
}

async function scheduleBoostAt(when) {
  const nextAt = Math.max(Date.now() + 30000, Number(when) || Date.now() + 30000);
  await chrome.storage.local.set({ shBoostNextAt: nextAt });
  await chrome.alarms.create(BOOST_ALARM, { when: nextAt });
  return nextAt;
}

async function scheduleNextBoostCheck(fallback, allowOverdueBump = true) {
  const data = await chrome.storage.local.get(['shBoostNextBumpAt']);
  const bumpAt = Number(data.shBoostNextBumpAt);
  // Поднятие не ждёт очередного 30-минутного сканирования.
  // Просроченный срок при ошибке профиля не отменяет назначенную паузу повторной попытки.
  const nextAt = Math.min(Number(fallback) || Date.now() + BG_BOOST_DISCOVERY_MS,
    Date.now() + BG_BOOST_DISCOVERY_MS,
    bumpAt > Date.now() || (allowOverdueBump && bumpAt > 0) ? bumpAt : Infinity);
  return scheduleBoostAt(nextAt);
}

async function migrateBoostTiming() {
  const data = await chrome.storage.local.get(['shBoostTimingRevision', 'boostInterval']);
  if (data.shBoostTimingRevision === BOOST_TIMING_REVISION) return false;
  // Прежнее стандартное значение 30 минут меняется на 2 часа один раз.
  // Остальные выбранные интервалы и серверные cooldown сохраняются.
  const interval = Number(data.boostInterval) === 30 ? 120 : normalizeBoostInterval(data.boostInterval);
  await chrome.storage.local.set({ boostInterval: interval, shBoostTimingRevision: BOOST_TIMING_REVISION });
  await refreshBoostDeadline();
  return true;
}

async function getSessionCookie() {
  const cookie = await chrome.cookies.get({ url: 'https://starvell.com', name: 'session' });
  if (cookie?.value) return cookie;
  const cookies = await chrome.cookies.getAll({ domain: 'starvell.com' });
  return cookies.find(item => item.name === 'session' && item.value) || null;
}

async function restoreBoostSchedule() {
  const migrated = await migrateBoostTiming();
  const data = await chrome.storage.local.get(['autoBoost', 'shBoostNextAt', 'shBoostRun', 'shBoostCatalog', 'shBoostNextBumpAt', 'shBoostLastResult']);
  const alarm = await chrome.alarms.get(BOOST_ALARM);
  // Сохранённый запуск защищает от дубля после остановки/перезапуска service worker.
  if (data.shBoostRun?.expiresAt > Date.now()) {
    if (!alarm) await scheduleBoostAt(data.shBoostRun.expiresAt + 30000);
    return;
  }
  if (data.shBoostRun) await chrome.storage.local.remove('shBoostRun');
  if (!data.autoBoost) {
    await chrome.alarms.clear(BOOST_ALARM);
    if (data.shBoostNextAt) await chrome.storage.local.set({ shBoostNextAt: 0, shBoostNextBumpAt: 0 });
    return;
  }
  const profileAt = Number(data.shBoostCatalog?.checkedAt) ? Number(data.shBoostCatalog.checkedAt) + BG_BOOST_DISCOVERY_MS : Date.now();
  const fallback = migrated && data.shBoostCatalog ? profileAt : Number(data.shBoostNextAt) || profileAt;
  const bumpAt = Number(data.shBoostNextBumpAt);
  const allowOverdueBump = !(data.shBoostLastResult?.failed && !data.shBoostLastResult.nextBumpAt);
  const nextAt = Math.max(Date.now() + 30000, Math.min(fallback, Date.now() + BG_BOOST_DISCOVERY_MS,
    bumpAt > Date.now() || (allowOverdueBump && bumpAt > 0) ? bumpAt : Infinity));
  if (migrated || !alarm || alarm.scheduledTime > nextAt) await scheduleBoostAt(nextAt);
}

async function probeBoostTab(tabId) {
  let timeout;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: 'BOOST_PROBE' }),
      new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Вкладка не ответила на проверку готовности.')), 4000); })
    ]);
  } finally { clearTimeout(timeout); }
}

async function dispatchBoost(automatic, preferredTabId) {
  const data = await chrome.storage.local.get(['autoBoost', 'shBoostRun']);
  if (automatic && !data.autoBoost) return { ok: false, error: 'Автоподнятие выключено.' };
  if (data.shBoostRun?.expiresAt > Date.now()) return { ok: false, busy: true, error: 'Поднятие уже выполняется.' };

  const tabs = (await chrome.tabs.query({ url: 'https://starvell.com/*' }))
    .filter(tab => Number.isInteger(tab.id) && !tab.discarded && !tab.frozen && tab.status !== 'loading');
  tabs.sort((a, b) => {
    const priority = tab => tab.id === preferredTabId ? 2 : tab.active ? 1 : 0;
    return priority(b) - priority(a);
  });
  for (const tab of tabs) {
    let probe;
    try { probe = await probeBoostTab(tab.id); }
    catch (error) { console.warn('[Starvell Helper BG] Вкладка недоступна:', tab.id, error.message); continue; }
    if (!probe?.ok || probe.protocol !== 3 || !probe.ready) continue;
    if (probe.busy) {
      if (data.autoBoost) await scheduleBoostAt(Date.now() + 30000);
      return { ok: false, busy: true, error: 'Поднятие уже выполняется во вкладке.' };
    }
    const runId = crypto.randomUUID();
    const expiresAt = Date.now() + BOOST_RUN_LIMIT_MS;
    await chrome.storage.local.set({ shBoostRun: { runId, tabId: tab.id, automatic, expiresAt } });
    await scheduleBoostAt(expiresAt + 30000);
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'BOOST_NOW', runId, automatic, expiresAt });
      if (response?.ok === true && response.status === 'accepted' && response.runId === runId) {
        return { ok: true, status: 'accepted', runId };
      }
      // Явный отказ означает, что вкладка не начала POST. Снимаем только свой запуск.
      if (response?.ok === false) {
        await chrome.storage.local.remove('shBoostRun');
        if (data.autoBoost) await scheduleBoostAt(Date.now() + 30000);
        else { await chrome.alarms.clear(BOOST_ALARM); await chrome.storage.local.set({ shBoostNextAt: 0, shBoostNextBumpAt: 0 }); }
        return { ok: false, busy: !!response.busy, error: response.error || 'Вкладка не приняла запуск.' };
      }
    } catch (error) { console.warn('[Starvell Helper BG] Подтверждение запуска потеряно:', error.message); }
    // При потере подтверждения нельзя запускать вторую вкладку: первый POST мог уже уйти.
    return { ok: false, error: 'Подтверждение запуска потеряно. Ожидаю завершения или истечения сохранённого срока.' };
  }
  await chrome.storage.local.remove('shBoostRun');
  const message = tabs.length
    ? 'Нет готовой вкладки с новой версией расширения. Обнови все вкладки Starvell.'
    : 'Нет открытой готовой вкладки Starvell. Открой сайт и войди в аккаунт.';
  await backgroundLog('warn', message);
  if ((await chrome.storage.local.get(['autoBoost'])).autoBoost) await scheduleBoostAt(Date.now() + 60000);
  else {
    await chrome.alarms.clear(BOOST_ALARM);
    await chrome.storage.local.set({ shBoostNextAt: 0, shBoostNextBumpAt: 0 });
  }
  return { ok: false, error: message };
}

async function toggleAutoBoost(msg, sender) {
  const data = await chrome.storage.local.get(['autoBoost', 'boostInterval', 'shBoostRun', 'shBoostNextAt']);
  const interval = normalizeBoostInterval(msg.interval ?? data.boostInterval);
  const enabled = msg.enabled === true;
  await chrome.storage.local.set({ autoBoost: enabled, boostInterval: interval });
  if (enabled) await refreshBoostDeadline();
  if (!enabled) {
    if (data.shBoostRun?.expiresAt > Date.now()) await scheduleBoostAt(data.shBoostRun.expiresAt + 30000);
    else {
      await chrome.alarms.clear(BOOST_ALARM);
      await chrome.storage.local.set({ shBoostNextAt: 0, shBoostNextBumpAt: 0 });
    }
    return { ok: true, enabled: false, interval };
  }
  if (!data.autoBoost) {
    const result = await dispatchBoost(true, sender.tab?.id);
    return { ok: true, enabled: true, interval, ...result };
  }
  // Изменение интервала не запускает второй POST; уже известный cooldown сохраняется в content.
  if (data.shBoostRun?.expiresAt > Date.now()) await scheduleBoostAt(data.shBoostRun.expiresAt + 30000);
  else await scheduleNextBoostCheck(data.shBoostNextAt > Date.now() ? data.shBoostNextAt : Date.now() + BG_BOOST_DISCOVERY_MS);
  return { ok: true, enabled: true, interval };
}

async function refreshBoostDeadline(fallback = 0) {
  const data = await chrome.storage.local.get(['boostInterval', 'shBoostCatalog', 'shBoostStateOwner', 'shBoostGameStates', 'shBoostRateLimitUntil']);
  if (!data.shBoostCatalog || data.shBoostCatalog.owner !== data.shBoostStateOwner) {
    await chrome.storage.local.set({ shBoostNextBumpAt: Number(fallback) || 0 });
    return;
  }
  const states = { ...(data.shBoostGameStates || {}) };
  const period = normalizeBoostInterval(data.boostInterval) * 60000 + BG_BOOST_SAFETY_MS;
  const due = data.shBoostCatalog.games.map(game => {
    const state = { ...(states[game.gameId] || {}) };
    if (state.reason === 'interval' && state.lastSuccessAt) state.nextAt = Number(state.lastSuccessAt) + period;
    states[game.gameId] = state;
    return Math.max(Number(state.nextAt) || Date.now(), Number(data.shBoostRateLimitUntil) || 0);
  });
  await chrome.storage.local.set({ shBoostGameStates: states, shBoostNextBumpAt: due.length ? Math.max(Date.now(), Math.min(...due)) : 0 });
}

async function completeBoost(msg, sender) {
  const data = await chrome.storage.local.get(['autoBoost', 'boostInterval', 'shBoostRun', 'shStatTotal', 'shStatErrors']);
  if (!data.shBoostRun || data.shBoostRun.runId !== msg.runId || data.shBoostRun.tabId !== sender.tab?.id) {
    return { ok: false, error: 'Результат устаревшего запуска пропущен.' };
  }
  const raw = msg.result || {};
  const count = Number.isFinite(raw.count) && raw.count > 0 ? raw.count : 0;
  const failed = Number.isFinite(raw.failed) && raw.failed > 0 ? raw.failed : 0;
  const result = { ...raw, count, failed, runId: msg.runId, finishedAt: Date.now() };
  await chrome.storage.local.remove('shBoostRun');
  await chrome.storage.local.set({
    shBoostLastResult: result,
    shBoostNextBumpAt: Number(raw.nextBumpAt) || 0,
    shStatTotal: (Number(data.shStatTotal) || 0) + count,
    shStatErrors: (Number(data.shStatErrors) || 0) + failed
  });
  await refreshBoostDeadline(raw.nextBumpAt);
  if (data.autoBoost) {
    const delay = Number(raw.nextDelayMs);
    await scheduleNextBoostCheck(Date.now() + (Number.isFinite(delay) && delay > 0 ? delay : BG_BOOST_DISCOVERY_MS), Number(raw.nextBumpAt) > 0);
  } else {
    await chrome.alarms.clear(BOOST_ALARM);
    await chrome.storage.local.set({ shBoostNextAt: 0, shBoostNextBumpAt: 0 });
  }
  return { ok: true };
}

// Каждая команда отвечает явно. Асинхронный ответ совместим и со старыми Chrome.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  let operation;
  switch (msg.type) {
    case 'SHOW_NOTIFICATION':
      operation = (async () => {
        const data = await chrome.storage.local.get(['shNotifications']);
        if (data.shNotifications !== false) await chrome.notifications.create({
          type: 'basic', iconUrl: 'icons/icon48.png', title: '🚀 Starvell Helper',
          message: msg.text || 'Готово!', silent: false
        });
        return { ok: true };
      })();
      break;
    case 'GET_SESSION_COOKIE':
      operation = getSessionCookie().then(cookie => ({ success: !!cookie, value: cookie?.value || null }));
      break;
    case 'CHECK_AUTH':
      operation = getSessionCookie().then(cookie => ({ ok: true, authenticated: !!cookie }));
      break;
    case 'TOGGLE_AUTO_BOOST':
      operation = queueBoostTask(() => toggleAutoBoost(msg, sender));
      break;
    case 'BOOST_REQUEST':
      operation = queueBoostTask(() => dispatchBoost(false, sender.tab?.id));
      break;
    case 'BOOST_COMPLETED':
      operation = queueBoostTask(() => completeBoost(msg, sender));
      break;
    case 'BOOST_READY':
      operation = queueBoostTask(async () => {
        const data = await chrome.storage.local.get(['autoBoost', 'shBoostNextAt', 'shBoostRun']);
        if (data.autoBoost && !data.shBoostRun && (!data.shBoostNextAt || data.shBoostNextAt <= Date.now())) {
          return dispatchBoost(true, sender.tab?.id);
        }
        await restoreBoostSchedule();
        return { ok: true };
      });
      break;
    default: return;
  }
  operation.then(sendResponse).catch(error => {
    console.error('[Starvell Helper BG]', error);
    sendResponse({ ok: false, success: false, error: error.message });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== BOOST_ALARM) return;
  queueBoostTask(async () => {
    const data = await chrome.storage.local.get(['autoBoost', 'shBoostRun']);
    if (data.shBoostRun?.expiresAt > Date.now()) {
      await scheduleBoostAt(data.shBoostRun.expiresAt + 30000);
      return;
    }
    if (data.shBoostRun) {
      await chrome.storage.local.remove('shBoostRun');
      await backgroundLog('warn', 'Предыдущий запуск не завершился: вкладка могла закрыться. Проверяю расписание.');
    }
    if (data.autoBoost) await dispatchBoost(true);
    else await restoreBoostSchedule();
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.autoBoost) queueBoostTask(restoreBoostSchedule);
});
chrome.runtime.onStartup.addListener(() => queueBoostTask(restoreBoostSchedule));
chrome.runtime.onInstalled.addListener(() => queueBoostTask(restoreBoostSchedule));
queueBoostTask(restoreBoostSchedule);
