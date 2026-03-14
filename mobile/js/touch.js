/* ================================================================
   PDF Pro Mobile – Touch & PWA Layer (touch.js)
   Runs AFTER app.js to add mobile-specific behaviour.
   ================================================================ */
'use strict';

// ── Service Worker Registration ──────────────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(r => console.log('[SW] registered', r.scope))
      .catch(e => console.warn('[SW] failed:', e));
  });
}

// ── Helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const toast = (msg, dur = 3000) => {
  const t = $('m-toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._tid);
  t._tid = setTimeout(() => t.classList.remove('show'), dur);
};
const loading = show => {
  const el = $('m-loading');
  if (el) el.classList.toggle('show', show);
};

// ── Drawer System ─────────────────────────────────────────────
const drawers = {};
function openDrawer(id) {
  Object.keys(drawers).forEach(k => { if (k !== id) closeDrawer(k); });
  const d = drawers[id];
  if (!d) return;
  d.overlay.classList.add('open');
  d.el.classList.add('open');
}
function closeDrawer(id) {
  const d = drawers[id];
  if (!d) return;
  d.overlay.classList.remove('open');
  d.el.classList.remove('open');
}
function toggleDrawer(id) {
  const d = drawers[id];
  if (!d) return;
  d.el.classList.contains('open') ? closeDrawer(id) : openDrawer(id);
}
function registerDrawer(id, elId, overlayId) {
  const el      = $(elId);
  const overlay = $(overlayId);
  if (!el || !overlay) return;
  drawers[id] = { el, overlay };
  overlay.addEventListener('click', () => closeDrawer(id));
  // Allow swipe-down to close
  let startY = 0;
  el.addEventListener('touchstart', e => { startY = e.touches[0].clientY; }, { passive: true });
  el.addEventListener('touchend', e => {
    if (e.changedTouches[0].clientY - startY > 80) closeDrawer(id);
  }, { passive: true });
}

// ── Nav buttons ───────────────────────────────────────────────
function setupNavButtons() {
  // Bottom nav buttons → drawers or actions
  const navMap = {
    'nav-open':   () => $('file-input').click(),
    'nav-tools':  () => toggleDrawer('tools'),
    'nav-props':  () => toggleDrawer('props'),
    'nav-pages':  () => toggleDrawer('pages'),
    'nav-more':   () => toggleDrawer('more'),
  };
  Object.entries(navMap).forEach(([id, fn]) => {
    const btn = $(id);
    if (btn) btn.addEventListener('click', fn);
  });

  // Top bar buttons
  $('m-btn-open')   ?.addEventListener('click', () => $('file-input').click());
  $('m-btn-save')   ?.addEventListener('click', () => $('btn-save').click());
  $('m-btn-export') ?.addEventListener('click', () => $('btn-export').click());
  $('m-btn-undo')   ?.addEventListener('click', () => $('btn-undo').click());
  $('m-btn-redo')   ?.addEventListener('click', () => $('btn-redo').click());

  // Big open button in drop zone
  $('m-open-btn-big')?.addEventListener('click', () => $('file-input').click());
}

// ── Tool Items in Tools Drawer ────────────────────────────────
function setupToolItems() {
  const toolBtns = document.querySelectorAll('.m-tool-item[data-tool]');
  toolBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const t = btn.dataset.tool;
      // Delegate to desktop tool buttons
      const desktop = $('tool-' + t);
      if (desktop) desktop.click();
      // If text tool, close drawer first
      if (t === 'text') { closeDrawer('tools'); return; }
      closeDrawer('tools');
      updateActiveToolUI(t);
    });
  });

  // Stamp, detect-fields, clear-fields etc.
  $('m-tool-detect') ?.addEventListener('click', () => { closeDrawer('tools'); $('btn-detect-fields').click(); });
  $('m-tool-clear')  ?.addEventListener('click', () => { closeDrawer('tools'); $('btn-clear-fields').click(); });
  $('m-tool-stamp')  ?.addEventListener('click', () => { closeDrawer('tools'); $('tool-stamp').click(); });
  $('m-tool-image')  ?.addEventListener('click', () => { closeDrawer('tools'); $('image-input').click(); });
  $('m-tool-spell')  ?.addEventListener('click', () => { closeDrawer('tools'); $('btn-spellcheck').click(); });
  $('m-tool-delete') ?.addEventListener('click', () => { $('btn-delete').click(); });
}

function updateActiveToolUI(tool) {
  document.querySelectorAll('.m-tool-item').forEach(b => b.classList.remove('active'));
  const active = document.querySelector(`.m-tool-item[data-tool="${tool}"]`);
  if (active) active.classList.add('active');
  // Update active nav button
  $('nav-tools')?.classList.toggle('active', true);
}

// ──  Page navigation ──────────────────────────────────────────
function setupPageControls() {
  $('m-prev-page')?.addEventListener('click', () => $('btn-prev-page').click());
  $('m-next-page')?.addEventListener('click', () => $('btn-next-page').click());
}

// ── Zoom controls ─────────────────────────────────────────────
function setupZoomControls() {
  $('m-zoom-in') ?.addEventListener('click', () => $('btn-zoom-in').click());
  $('m-zoom-out')?.addEventListener('click', () => $('btn-zoom-out').click());
  $('m-zoom-fit')?.addEventListener('click', () => $('btn-zoom-fit').click());
}

// ── Pinch-to-zoom on the viewer ───────────────────────────────
function setupPinchZoom() {
  const viewer = $('m-viewer');
  if (!viewer) return;
  let lastDist = 0;
  let pinching = false;
  const badge  = $('m-zoom-badge');
  let badgeTimer;

  viewer.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      pinching  = true;
      lastDist  = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }, { passive: true });

  viewer.addEventListener('touchmove', e => {
    if (!pinching || e.touches.length !== 2) return;
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const delta = dist - lastDist;
    lastDist = dist;
    if (Math.abs(delta) > 3) {
      delta > 0 ? $('btn-zoom-in').click() : $('btn-zoom-out').click();
      // Show zoom badge
      if (badge) {
        badge.textContent = $('zoom-label').textContent;
        badge.classList.add('show');
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => badge.classList.remove('show'), 1200);
      }
    }
  }, { passive: true });

  viewer.addEventListener('touchend', () => { pinching = false; }, { passive: true });
}

// ── Swipe left/right to change pages ─────────────────────────
function setupSwipeNavigation() {
  const viewer = $('m-viewer');
  if (!viewer) return;
  let sx = 0, sy = 0;

  viewer.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    sx = e.touches[0].clientX;
    sy = e.touches[0].clientY;
  }, { passive: true });

  viewer.addEventListener('touchend', e => {
    if (e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - sx;
    const dy = e.changedTouches[0].clientY - sy;
    // Only horizontal swipe with small vertical component
    if (Math.abs(dx) > 60 && Math.abs(dy) < 50) {
      if (dx < 0) $('btn-next-page').click();
      else         $('btn-prev-page').click();
    }
  }, { passive: true });
}

// ── Long-press for context menu ───────────────────────────────
function setupLongPress() {
  const viewer = $('m-viewer');
  if (!viewer) return;
  let timer;

  viewer.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
    timer = setTimeout(() => {
      const cm = $('m-context-menu');
      if (!cm) return;
      // Only show if fabric has an active object
      if (typeof fabricCanvas !== 'undefined' && fabricCanvas?.getActiveObject()) {
        cm.style.left    = cx + 'px';
        cm.style.top     = (cy - 160) + 'px';
        cm.style.display = 'block';
      }
    }, 600);
  }, { passive: true });

  viewer.addEventListener('touchmove',  () => clearTimeout(timer), { passive: true });
  viewer.addEventListener('touchend',   () => clearTimeout(timer), { passive: true });
  viewer.addEventListener('touchcancel',() => clearTimeout(timer), { passive: true });

  document.addEventListener('click', e => {
    const cm = $('m-context-menu');
    if (cm && !cm.contains(e.target)) cm.style.display = 'none';
  });
}

// ── Text input overlay (mobile) ───────────────────────────────
// Intercept the desktop text-overlay so the mobile version shows instead.
function setupTextOverlay() {
  const desktopOverlay = $('text-overlay');
  const mobileOverlay  = $('m-text-overlay');
  if (!desktopOverlay || !mobileOverlay) return;

  // Observe when desktop overlay is shown and redirect to mobile one
  const obs = new MutationObserver(() => {
    if (desktopOverlay.style.display !== 'none' && desktopOverlay.style.display !== '') {
      desktopOverlay.style.display = 'none';
      mobileOverlay.classList.add('open');
      setTimeout(() => $('m-text-editor')?.focus(), 100);
    }
  });
  obs.observe(desktopOverlay, { attributes: true, attributeFilter: ['style'] });

  // Confirm → copy text to desktop editor and click confirm
  $('m-text-confirm')?.addEventListener('click', () => {
    const mEditor = $('m-text-editor');
    const dEditor = $('text-editor');
    if (mEditor && dEditor) dEditor.innerText = mEditor.innerText;
    mobileOverlay.classList.remove('open');
    if (mEditor) mEditor.innerText = '';
    $('text-confirm').click();
  });

  // Cancel
  $('m-text-cancel')?.addEventListener('click', () => {
    mobileOverlay.classList.remove('open');
    $('m-text-editor').innerText = '';
    $('text-cancel').click();
  });
}

// ── Mirror status bar text ────────────────────────────────────
function mirrorStatus() {
  const src  = $('status-info');
  const dest = $('m-status-info');
  if (!src || !dest) return;
  const obs = new MutationObserver(() => { dest.textContent = src.textContent; });
  obs.observe(src, { childList: true, characterData: true, subtree: true });
  dest.textContent = src.textContent;

  // Mirror zoom label to page bar
  const zSrc  = $('zoom-label');
  const zDest = $('m-zoom-info');
  if (zSrc && zDest) {
    new MutationObserver(() => { zDest.textContent = zSrc.textContent; })
      .observe(zSrc, { childList: true, characterData: true, subtree: true });
    zDest.textContent = zSrc.textContent;
  }

  // Mirror page info
  function syncPageInfo() {
    const pi = $('page-input');
    const pt = $('page-total');
    const mi = $('m-page-info');
    if (pi && pt && mi) mi.textContent = 'صفحة ' + pi.value + ' ' + pt.textContent;
  }
  const pi = $('page-input'), pt = $('page-total');
  if (pi) pi.addEventListener('change', syncPageInfo);
  if (pt) new MutationObserver(syncPageInfo).observe(pt, { childList: true, characterData: true, subtree: true });
  syncPageInfo();
}

// ── Show/hide page bar and page container on PDF load ─────────
function observePdfLoad() {
  const pageContainer = $('page-container');
  if (!pageContainer) return;
  const obs = new MutationObserver(() => {
    const visible = pageContainer.style.display !== 'none' && pageContainer.style.display !== '';
    $('m-page-bar')?.classList.toggle('visible', visible);
    $('m-drop-zone')?.style && ($('m-drop-zone').style.display = visible ? 'none' : 'flex');
  });
  obs.observe(pageContainer, { attributes: true, attributeFilter: ['style'] });
}

// ── Context-menu item wiring ──────────────────────────────────
function setupContextMenuItems() {
  $('m-ctx-copy')       ?.addEventListener('click', () => { $('ctx-copy').click();        $('m-context-menu').style.display='none'; });
  $('m-ctx-cut')        ?.addEventListener('click', () => { $('ctx-cut').click();         $('m-context-menu').style.display='none'; });
  $('m-ctx-paste')      ?.addEventListener('click', () => { $('ctx-paste').click();       $('m-context-menu').style.display='none'; });
  $('m-ctx-delete')     ?.addEventListener('click', () => { $('ctx-delete').click();      $('m-context-menu').style.display='none'; });
  $('m-ctx-front')      ?.addEventListener('click', () => { $('ctx-bring-front').click(); $('m-context-menu').style.display='none'; });
  $('m-ctx-back')       ?.addEventListener('click', () => { $('ctx-send-back').click();   $('m-context-menu').style.display='none'; });
}

// ── More drawer: Rotation, Fullscreen, Fields ─────────────────
function setupMoreDrawer() {
  $('m-more-rotate-l')?.addEventListener('click', () => { $('btn-rotate-left').click();  closeDrawer('more'); });
  $('m-more-rotate-r')?.addEventListener('click', () => { $('btn-rotate-right').click(); closeDrawer('more'); });
  $('m-more-fullscreen')?.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
    closeDrawer('more');
  });
  $('m-more-detect')?.addEventListener('click', () => { $('btn-detect-fields').click(); closeDrawer('more'); });
  $('m-more-clear' )?.addEventListener('click', () => { $('btn-clear-fields').click();  closeDrawer('more'); });
  $('m-more-spell' )?.addEventListener('click', () => { $('btn-spellcheck').click();    closeDrawer('more'); });
}

// ── Pages drawer: thumbnails ──────────────────────────────────
function setupPagesDrawer() {
  // Move thumbnails list into the mobile pages drawer
  const dest = $('m-thumbs-container');
  const src  = $('thumbnails-list');
  if (dest && src) dest.appendChild(src);
}

// ── PWA Install Prompt ────────────────────────────────────────
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstallPrompt = e;
  $('m-install-banner')?.classList.add('show');
});
window.addEventListener('appinstalled', () => {
  $('m-install-banner')?.classList.remove('show');
  toast('✅ تم تثبيت التطبيق بنجاح!');
});

function setupInstallBanner() {
  $('m-install-yes')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    if (outcome === 'accepted') toast('جاري التثبيت…');
    deferredInstallPrompt = null;
    $('m-install-banner')?.classList.remove('show');
  });
  $('m-install-no')?.addEventListener('click', () => {
    $('m-install-banner')?.classList.remove('show');
  });
}

// ── Keyboard-safe: shrink viewer when keyboard opens ─────────
function setupKeyboardAwareness() {
  if (!window.visualViewport) return;
  window.visualViewport.addEventListener('resize', () => {
    const viewer = $('m-viewer');
    if (!viewer) return;
    const vvh = window.visualViewport.height;
    const wh  = window.innerHeight;
    // If keyboard opened (viewport shrank significantly)
    viewer.style.bottom = vvh < wh * 0.75
      ? (wh - vvh) + 'px'
      : '';
  });
}

// ── Stamp items in mobile stamp drawer ───────────────────────
function setupMobileStamps() {
  document.querySelectorAll('.m-stamp-item').forEach(item => {
    item.addEventListener('click', () => {
      const type = item.dataset.stamp;
      closeDrawer('tools');
      // Set stamp type in hidden stamp modal and simulate click
      const desktopItems = document.querySelectorAll('#stamp-modal .stamp-item');
      desktopItems.forEach(di => {
        if (di.dataset.stamp === type) di.click();
      });
    });
  });
}

// ── Properties drawer: mirror prop controls ──────────────────
function setupPropsDrawer() {
  // The desktop prop controls already exist (hidden). Mirror value changes.
  const mirrors = [
    ['m-prop-font-family', 'prop-font-family', 'change'],
    ['m-prop-font-size',   'prop-font-size',   'input'],
    ['m-prop-font-color',  'prop-font-color',  'input'],
    ['m-prop-stroke-color','prop-stroke-color','input'],
    ['m-prop-stroke-width','prop-stroke-width','input'],
    ['m-prop-opacity',     'prop-opacity',     'input'],
    ['m-prop-fill-color',  'prop-fill-color',  'input'],
  ];
  mirrors.forEach(([mId, dId, event]) => {
    const mEl = $(mId), dEl = $(dId);
    if (!mEl || !dEl) return;
    // Mobile → desktop
    mEl.addEventListener(event, () => {
      dEl.value = mEl.value;
      dEl.dispatchEvent(new Event(event, { bubbles: true }));
    });
    // Desktop → mobile (e.g. when object is selected)
    new MutationObserver(() => { mEl.value = dEl.value; })
      .observe(dEl, { attributes: true });
  });

  // Style buttons
  const styleMirrors = [
    ['m-prop-bold',      'prop-bold'],
    ['m-prop-italic',    'prop-italic'],
    ['m-prop-underline', 'prop-underline-btn'],
  ];
  styleMirrors.forEach(([mId, dId]) => {
    const mEl = $(mId), dEl = $(dId);
    if (!mEl || !dEl) return;
    mEl.addEventListener('click', () => dEl.click());
    // Sync active state
    new MutationObserver(() => {
      mEl.classList.toggle('active', dEl.classList.contains('active'));
    }).observe(dEl, { attributes: true, attributeFilter: ['class'] });
  });
}

// ── Stamp drawer in more panel ───────────────────────────────

// ── Show loading during PDF render ───────────────────────────
function hookLoadingSpinner() {
  const origLoad = window.loadPdfFile;
  if (typeof origLoad !== 'function') return;
  window.loadPdfFile = async function(file) {
    loading(true);
    try {
      await origLoad.call(this, file);
    } finally {
      loading(false);
    }
  };
}

// ── Make toast available globally ────────────────────────────
window.mobileToast = toast;

// ── Forward fields-toast to mobile toast ─────────────────────
function forwardFieldsToast() {
  const fieldToast = $('fields-toast');
  if (!fieldToast) return;
  new MutationObserver(() => {
    if (fieldToast.classList.contains('show')) {
      toast(fieldToast.textContent);
    }
  }).observe(fieldToast, { attributes: true, attributeFilter: ['class'] });
}

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {

  // Register drawers
  registerDrawer('tools',  'm-drawer-tools',  'm-overlay-tools');
  registerDrawer('props',  'm-drawer-props',  'm-overlay-props');
  registerDrawer('pages',  'm-drawer-pages',  'm-overlay-pages');
  registerDrawer('more',   'm-drawer-more',   'm-overlay-more');

  setupNavButtons();
  setupToolItems();
  setupPageControls();
  setupZoomControls();
  setupPinchZoom();
  setupSwipeNavigation();
  setupLongPress();
  setupTextOverlay();
  mirrorStatus();
  observePdfLoad();
  setupContextMenuItems();
  setupMoreDrawer();
  setupPagesDrawer();
  setupInstallBanner();
  setupKeyboardAwareness();
  setupMobileStamps();
  setupPropsDrawer();
  forwardFieldsToast();
  hookLoadingSpinner();

  // Remove desktop-only layout wrappers from view (they're hidden by CSS)
  // just make sure none of them intercept touch events
  ['toolbar', 'right-panel', 'statusbar'].forEach(id => {
    const el = $(id);
    if (el) {
      el.setAttribute('aria-hidden', 'true');
      el.style.pointerEvents = 'none';
    }
  });

  console.log('[PDF Pro Mobile] initialised');
});
