// =====================================================
//  Starvell Helper — background.js (Service Worker)
// =====================================================

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
});

// Alarm срабатывает — шлём BOOST_NOW на все вкладки Starvell
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'starvell-boost') {
    chrome.storage.local.get(['autoBoost'], (data) => {
      if (!data.autoBoost) return;

      chrome.tabs.query({ url: 'https://starvell.com/*' }, (tabs) => {
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'BOOST_NOW' }).catch(() => {});
        }
      });
    });
  }
});

// Восстанавливаем alarm после перезапуска браузера / обновления расширения
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.get(['autoBoost', 'boostInterval'], (data) => {
    if (data.autoBoost) {
      chrome.alarms.create('starvell-boost', {
        periodInMinutes: data.boostInterval || 30
      });
      console.log('[Starvell Helper BG] Alarm восстановлен после перезапуска');
    }
  });
});