// =====================================================
//  Starvell Helper — content/03-ui-extras.js
// =====================================================

// Кнопка находится в собственном узле вне #__next. Заголовок React только читается.
const NAV_BTN_ID = 'starvell-helper-nav-btn';
const NAV_HOST_ID = 'starvell-helper-nav-host';
let navbarFrame = null;

function positionNavbarButton(host) {
  const rightZone = document.querySelector('[class*="header_user_nav_main"]')
    || document.querySelector('[class*="header_user_nav__"]');
  const rect = rightZone?.getBoundingClientRect();
  if (rect && rect.left >= 50 && rect.bottom > 0 && rect.top < window.innerHeight) {
    host.style.left = `${Math.min(window.innerWidth - 42, Math.max(8, Math.round(rect.left - 42)))}px`;
    host.style.top = `${Math.max(8, Math.round(rect.top + (rect.height - 34) / 2))}px`;
    host.style.right = 'auto'; host.style.bottom = 'auto';
  } else {
    // В узком/новом навбаре оставляем доступную кнопку без изменения разметки сайта.
    host.style.left = 'auto'; host.style.top = 'auto'; host.style.right = '16px'; host.style.bottom = '16px';
  }
}

function injectNavbarButton() {
  if (!document.body) return;
  let host = document.getElementById(NAV_HOST_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = NAV_HOST_ID;
    host.style.cssText = 'position:fixed;width:34px;height:34px;z-index:2147483646;pointer-events:none;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      button {
        display:block; width:34px; height:34px; border-radius:9px;
        background:linear-gradient(135deg,#7c5cfc,#5a3fd0); color:#fff;
        font:800 16px 'Segoe UI',system-ui,sans-serif; border:0; padding:0;
        cursor:pointer; pointer-events:auto; box-shadow:0 2px 8px rgba(124,92,252,.45);
      }
      button:hover { filter:brightness(1.18); }
      button:focus-visible { outline:2px solid #c8b8ff; outline-offset:3px; }
    `;
    const button = document.createElement('button');
    button.id = NAV_BTN_ID; button.type = 'button'; button.title = 'Starvell Helper — открыть дашборд';
    button.setAttribute('aria-label', 'Открыть Starvell Helper'); button.textContent = 'S';
    button.addEventListener('click', event => { event.stopPropagation(); location.href = 'https://starvell.com/starvell-helper'; });
    shadow.appendChild(style); shadow.appendChild(button);
    document.body.appendChild(host);
    console.log('[Starvell Helper] Кнопка S добавлена вне разметки React');
  }
  positionNavbarButton(host);
}

function queueNavbarPosition() {
  if (navbarFrame !== null) return;
  navbarFrame = requestAnimationFrame(() => { navbarFrame = null; injectNavbarButton(); });
}

function waitForNavbar() {
  injectNavbarButton();
  const observer = new MutationObserver(queueNavbarPosition);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', queueNavbarPosition, { passive: true });
  window.addEventListener('scroll', queueNavbarPosition, { passive: true, capture: true });
}

function afterPageLoad(action) {
  const run = () => requestAnimationFrame(() => requestAnimationFrame(action));
  if (document.readyState === 'complete') run();
  else window.addEventListener('load', run, { once: true });
}

if (location.pathname !== '/starvell-helper') afterPageLoad(waitForNavbar);

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
if (location.pathname === '/starvell-helper') afterPageLoad(injectHelperPage);
