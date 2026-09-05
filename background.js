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

// Слушаем сообщения от content.js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Уведомление
  if (msg.type === 'SHOW_NOTIFICATION') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: '🚀 Starvell Helper',
      message: msg.text || 'Готово!',
      silent: false
    });
  }

  // Управление alarm при включении/выключении автоподнятия
  if (msg.type === 'TOGGLE_AUTO_BOOST') {
    if (msg.enabled) {
      chrome.alarms.create('starvell-boost', {
        periodInMinutes: msg.interval
      });
      console.log('[Starvell Helper BG] Alarm создан, интервал:', msg.interval, 'мин');
    } else {
      chrome.alarms.clear('starvell-boost');
      console.log('[Starvell Helper BG] Alarm удалён');
    }
  }

  // Отдаём session cookie content script'у (HttpOnly, только background может прочитать)
  if (msg.type === 'GET_SESSION_COOKIE') {
    chrome.cookies.get({ url: 'https://starvell.com', name: 'session' }, (cookie) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
        return;
      }
      if (cookie && cookie.value) {
        sendResponse({ success: true, value: cookie.value });
        return;
      }
      // Fallback: ищем по домену
      chrome.cookies.getAll({ domain: 'starvell.com' }, (cookies) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        const found = cookies.find(c => c.name === 'session' && c.value.length > 20);
        sendResponse({ success: !!found, value: found?.value || null });
      });
    });
    return true;
  }

});

// Теперь поднятие происходит один раз за тик, независимо от числа вкладок.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'starvell-boost') {
    chrome.storage.local.get(['autoBoost'], (data) => {
      if (!data.autoBoost) return;

      chrome.tabs.query({ url: 'https://starvell.com/*' }, (tabs) => {
        if (!tabs || tabs.length === 0) {
          console.log('[Starvell Helper BG] Нет вкладок Starvell — пропускаю тик');
          return;
        }
        // Берём одну вкладку: приоритет активной, иначе первую попавшуюся.
        const target = tabs.find(t => t.active) || tabs[0];
        chrome.tabs.sendMessage(target.id, { type: 'BOOST_NOW' })
          .then(resp => console.log('[Starvell Helper BG] BOOST_NOW отправлен, ответ:', resp))
          .catch(() => {
            // Вкладка не ответила (например, дашборд) — пробуем следующую
            const fallback = tabs.find(t => t.id !== target.id);
            if (fallback) chrome.tabs.sendMessage(fallback.id, { type: 'BOOST_NOW' }).catch(() => {});
          });
      });
    });
  }
});

// Восстанавливаем alarm после перезапуска браузера / обновления расширения
chrome.runtime.onStartup.addListener(() => {
  // Очищаем лог событий — новая сессия браузера
  chrome.storage.local.remove('shLog');
  console.log('[Starvell Helper BG] Лог событий очищен (новая сессия)');

  chrome.storage.local.get(['autoBoost', 'boostInterval'], (data) => {
    if (data.autoBoost) {
      chrome.alarms.create('starvell-boost', {
        periodInMinutes: data.boostInterval || 30
      });
      console.log('[Starvell Helper BG] Alarm восстановлен после перезапуска');
    }
  });
});