// =====================================================
//  Starvell Helper — popup.js
// =====================================================

const autoBoostToggle = document.getElementById('autoBoostToggle');
const boostInterval   = document.getElementById('boostInterval');
const boostDot        = document.getElementById('boostDot');
const boostStatusText = document.getElementById('boostStatusText');
const boostNowBtn     = document.getElementById('boostNowBtn');
const boostFeedback   = document.getElementById('boostFeedback');

const bgToggle      = document.getElementById('bgToggle');
const bgControls    = document.getElementById('bgControls');
const bgUrlInput    = document.getElementById('bgUrl');
const bgOpacity     = document.getElementById('bgOpacity');
const opacityVal    = document.getElementById('opacityVal');
const applyBgBtn    = document.getElementById('applyBgBtn');
const removeBgBtn   = document.getElementById('removeBgBtn');
const bgFeedback    = document.getElementById('bgFeedback');

// ── Загружаем сохранённые настройки ──────────────────
chrome.storage.local.get(
  ['autoBoost', 'boostInterval', 'customBg', 'bgUrl', 'bgOpacity', 'lastBumpPayload'],
  (data) => {
    autoBoostToggle.checked = !!data.autoBoost;
    if (data.boostInterval) boostInterval.value = data.boostInterval;
    updateBoostStatus(!!data.autoBoost, data.lastBumpPayload);

    bgToggle.checked = !!data.customBg;
    bgControls.style.display = data.customBg ? 'block' : 'none';
    if (data.bgUrl) bgUrlInput.value = data.bgUrl;
    if (data.bgOpacity) {
      bgOpacity.value = Math.round(data.bgOpacity * 100);
      opacityVal.textContent = bgOpacity.value + '%';
    }
  }
);

// ─────────────────────────────────────────────────────
//  Блок 1: Автоподнятие
// ─────────────────────────────────────────────────────

autoBoostToggle.addEventListener('change', async () => {
  const enabled  = autoBoostToggle.checked;
  const interval = parseInt(boostInterval.value);

  chrome.storage.local.set({ autoBoost: enabled, boostInterval: interval });

  const tab = await getStarvellTab();
  if (!tab) {
    showFeedback(boostFeedback, '⚠ Открой starvell.com в браузере', 'err');
    autoBoostToggle.checked = false;
    return;
  }

  chrome.tabs.sendMessage(tab.id, {
    type: 'TOGGLE_AUTO_BOOST',
    enabled,
    interval
  }, (resp) => {
    chrome.storage.local.get(['lastBumpPayload'], d => {
      updateBoostStatus(enabled, d.lastBumpPayload);
    });
    showFeedback(
      boostFeedback,
      enabled ? `✓ Включено (каждые ${interval} мин)` : '✓ Выключено',
      'ok'
    );
  });
});

boostInterval.addEventListener('change', () => {
  chrome.storage.local.set({ boostInterval: parseInt(boostInterval.value) });
  if (autoBoostToggle.checked) {
    autoBoostToggle.dispatchEvent(new Event('change'));
  }
});

boostNowBtn.addEventListener('click', async () => {
  boostNowBtn.disabled = true;
  boostNowBtn.textContent = '⏳ Поднимаю...';

  const tab = await getStarvellTab();
  if (!tab) {
    showFeedback(boostFeedback, '⚠ Открой starvell.com в браузере', 'err');
    resetBoostBtn();
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'BOOST_NOW' }, (resp) => {
    if (chrome.runtime.lastError) {
      showFeedback(boostFeedback, '⚠ Обнови страницу starvell.com', 'err');
      resetBoostBtn();
      return;
    }

    if (resp?.rateLimit) {
      showFeedback(boostFeedback, '⚠ Rate limit — увеличь интервал до 60+ мин', 'err');
    } else if (resp?.ok && resp.count > 0) {
      showFeedback(boostFeedback, `✓ Лоты подняты!`, 'ok');
    } else if (resp?.ok && resp.count === 0) {
      showFeedback(boostFeedback, '⚠ Нажми «Поднять» вручную один раз — расширение запомнит параметры', 'err');
    } else {
      showFeedback(boostFeedback, '⚠ Ошибка — смотри F12 → Console', 'err');
    }
    resetBoostBtn();
  });
});

function resetBoostBtn() {
  boostNowBtn.disabled = false;
  boostNowBtn.textContent = '⬆ Поднять сейчас';
}

function updateBoostStatus(active, lastPayload) {
  if (active) {
    boostDot.className = 'dot active';
    boostStatusText.textContent = `Активно — каждые ${boostInterval.value} мин`;
  } else {
    boostDot.className = 'dot inactive';
    boostStatusText.textContent = 'Автоподнятие выключено';
  }

  // Подсказка если параметры ещё не известны
  const hint = document.getElementById('boostHint');
  if (hint) {
    if (!lastPayload) {
      hint.style.display = 'block';
      hint.textContent = '💡 Нажми «Поднять» на сайте вручную один раз — расширение запомнит все твои категории';
    } else {
      hint.style.display = 'none';
    }
  }
}

// ─────────────────────────────────────────────────────
//  Блок 2: Кастомный фон
// ─────────────────────────────────────────────────────

bgOpacity.addEventListener('input', () => {
  opacityVal.textContent = bgOpacity.value + '%';
});

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    bgUrlInput.value = btn.dataset.url;
  });
});

bgToggle.addEventListener('change', () => {
  bgControls.style.display = bgToggle.checked ? 'block' : 'none';
  if (!bgToggle.checked) {
    removeBgBtn.click();
  } else if (bgUrlInput.value.trim()) {
    applyBgBtn.click();
  }
});

applyBgBtn.addEventListener('click', async () => {
  const url     = bgUrlInput.value.trim();
  const opacity = parseInt(bgOpacity.value) / 100;

  if (!url) {
    showFeedback(bgFeedback, '⚠ Введи ссылку или выбери пресет', 'err');
    return;
  }

  chrome.storage.local.set({ customBg: true, bgUrl: url, bgOpacity: opacity });

  const tab = await getStarvellTab();
  if (!tab) {
    showFeedback(bgFeedback, '⚠ Открой вкладку starvell.com', 'err');
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'APPLY_BG', url, opacity }, () => {
    showFeedback(bgFeedback, '✓ Фон применён!', 'ok');
  });
});

removeBgBtn.addEventListener('click', async () => {
  chrome.storage.local.set({ customBg: false });

  const tab = await getStarvellTab();
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'REMOVE_BG' });

  bgToggle.checked = false;
  bgControls.style.display = 'none';
  showFeedback(bgFeedback, '✓ Фон удалён', 'ok');
});

// ─────────────────────────────────────────────────────
//  Утилиты
// ─────────────────────────────────────────────────────

async function getStarvellTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://starvell.com/*' }, tabs => {
      resolve(tabs[0] || null);
    });
  });
}

function showFeedback(el, text, type) {
  el.textContent = text;
  el.className = 'feedback ' + type;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'feedback'; }, 5000);
}