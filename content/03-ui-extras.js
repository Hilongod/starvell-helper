// =====================================================
//  Starvell Helper — content/03-ui-extras.js
// =====================================================

// =====================================================
// ФУНКЦИЯ 4 — Кнопка «S» в навбаре → открывает дашборд ───
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

// =====================================================
//  ФУНКЦИЯ 5 — GLOW: свечение только крупных блоков
// =====================================================
const GLOW_STYLE_ID = 'starvell-helper-glow';

function applyGlow(colorKey, intensity) {
  // Не применяем на странице дашборда
  if (location.pathname === '/starvell-helper') {
    removeGlow();
    return;
  }

  removeGlow();

  const rgbMap = {
    violet: '124,92,252', pink: '255,107,157', orange: '255,159,67',
    yellow: '254,202,87', green: '76,175,130', cyan: '0,210,211',
    blue: '84,160,255', red: '242,92,92', magenta: '224,60,255',
    gold: '255,215,0', white: '232,232,240'
  };
  const rgb = rgbMap[colorKey] || rgbMap.violet;
  const a = Math.max(0.08, (intensity || 35) / 100);
  const spread = Math.max(4, (intensity || 35) / 4);

  const style = document.createElement('style');
  style.id = GLOW_STYLE_ID;
  style.textContent = `
    :root { --glow: ${rgb}; --glow-a: ${a}; --glow-s: ${spread}px; }

    /* ── Основной контейнер (layout_content_wide), исключая мини-чат ── */
    [class*="layout_content_wide"]:not([class*="with_minichat"]),
    [class*="layout_content"]:not([class*="with_minichat"]) {
      position: relative;
      isolation: isolate;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5)) !important;
      transition: box-shadow .25s ease !important;
    }
    [class*="layout_content_wide"]:not([class*="with_minichat"])::before,
    [class*="layout_content"]:not([class*="with_minichat"])::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5));
      pointer-events: none;
      z-index: 1;
    }

    /* ── Блок пользователя (с мини-чатом, но нужный) ── */
    [class*="users_content_box"] {
      position: relative;
      isolation: isolate;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5)) !important;
      transition: box-shadow .25s ease !important;
    }
    [class*="users_content_box"]::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5));
      pointer-events: none;
      z-index: 1;
    }
    [class*="users_content_box"]:hover {
      box-shadow: inset 0 0 0 1px rgba(var(--glow),calc(var(--glow-a)*1.6)), 0 0 calc(var(--glow-s)*1.4) rgba(var(--glow),calc(var(--glow-a)*0.9)) !important;
    }

    /* ── Блоки профиля (баннер и тело) ── */
    [class*="user-banner_root"],
    [class*="user-top_block__body"] {
      position: relative;
      isolation: isolate;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5)) !important;
      transition: box-shadow .25s ease !important;
    }
    [class*="user-banner_root"]::before,
    [class*="user-top_block__body"]::before {
      content: '';
      position: absolute;
      inset: -1px;
      border-radius: inherit;
      box-shadow: inset 0 0 0 1px rgba(var(--glow),var(--glow-a)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.5));
      pointer-events: none;
      z-index: 1;
    }

    /* ── Хедер (верхняя граница) ── */
    [class*="header_inner_wrapper"] {
      box-shadow: 0 2px 0 0 rgba(var(--glow),calc(var(--glow-a)*1.2)), 0 0 var(--glow-s) rgba(var(--glow),calc(var(--glow-a)*0.4)) !important;
    }

    /* ── Футер (нижняя граница) ── */
    [class*="footer_layout_footer__"] > div {
      box-shadow: 0 -2px 0 0 rgba(var(--glow),calc(var(--glow-a)*1.2)) !important;
    }

    /* ── Hover эффекты ── */
    [class*="layout_content_wide"]:not([class*="with_minichat"]):hover,
    [class*="layout_content"]:not([class*="with_minichat"]):hover,
    [class*="user-banner_root"]:hover,
    [class*="user-top_block__body"]:hover {
      box-shadow: inset 0 0 0 1px rgba(var(--glow),calc(var(--glow-a)*1.6)), 0 0 calc(var(--glow-s)*1.4) rgba(var(--glow),calc(var(--glow-a)*0.9)) !important;
    }
  `;
  document.head.appendChild(style);
}

function removeGlow() {
  document.getElementById(GLOW_STYLE_ID)?.remove();
}

// =====================================================
//  Открытие дашборда — /starvell-helper
// =====================================================
if (location.pathname === '/starvell-helper') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => injectHelperPage());
  } else {
    injectHelperPage();
  }
}