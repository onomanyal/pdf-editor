/* ============================================================
   PDF Pro Editor – Main Application JS
   ============================================================
   Stack:
     • PDF.js  v3  – render PDF pages to canvas
     • pdf-lib v1  – embed annotations into PDF on export
     • Fabric.js v5 – interactive annotation canvas layer
   ============================================================ */

'use strict';

// ──────────────────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────────────────
const State = {
  pdfDoc:        null,   // PDF.js document
  pdfLibDoc:     null,   // pdf-lib document (for export)
  pdfBytes:      null,   // original ArrayBuffer
  totalPages:    0,
  currentPage:   1,
  scale:         1.5,
  rotation:      0,
  activeTool:    'select',
  clipboard:     null,

  // drawing
  isDrawing:     false,
  drawStart:     { x: 0, y: 0 },
  tempShape:     null,

  // text input pending position
  pendingTextPos:{ x: 0, y: 0 },

  // per-page annotation snapshots (JSON)
  pageAnnotations: {},   // { pageNum: fabricJSON }

  // history stacks per page
  historyUndo:   {},
  historyRedo:   {},
};

// ──────────────────────────────────────────────────────────────
// DOM REFS
// ──────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);

const fileInput       = $('file-input');
const imageInput      = $('image-input');
const dropZone        = $('drop-zone');
const pageContainer   = $('page-container');
const pdfCanvas       = $('pdf-canvas');
const pageInput       = $('page-input');
const pageTotal       = $('page-total');
const zoomLabel       = $('zoom-label');
const statusTool      = $('status-tool');
const statusCoords    = $('status-coords');
const statusInfo      = $('status-info');
const thumbsList      = $('thumbnails-list');
const textOverlay     = $('text-overlay');
const textEditor      = $('text-editor');
const stampModal      = $('stamp-modal');
const contextMenu     = $('context-menu');
const spellcheckModal = $('spellcheck-modal');
const spellLangInline = $('spell-lang');
const spellLangModal  = $('spell-modal-lang');

// Properties
const propFontFamily  = $('prop-font-family');
const propFontSize    = $('prop-font-size');
const propFontColor   = $('prop-font-color');
const propBold        = $('prop-bold');
const propItalic      = $('prop-italic');
const propUnderlineBtn= $('prop-underline-btn');
const propTextBgColor = $('prop-text-bg-color');
const propTextBgNone  = $('prop-text-bg-none');
const propStrokeColor = $('prop-stroke-color');
const propStrokeWidth = $('prop-stroke-width');
const strokeWidthLabel= $('stroke-width-label');
const propFillColor   = $('prop-fill-color');
const propFillNone    = $('prop-fill-none');
const propOpacity     = $('prop-opacity');
const opacityLabel    = $('opacity-label');
const propHighlightColor  = $('prop-highlight-color');
const propHighlightOpacity= $('prop-highlight-opacity');
const highlightOpLabel    = $('highlight-opacity-label');

// ──────────────────────────────────────────────────────────────
// FABRIC CANVAS MANAGER  (single shared canvas, per-page JSON state)
// ──────────────────────────────────────────────────────────────
let fabricCanvas = null;  // single fabric.Canvas instance (created once)
let isLoadingPage = false; // suppress history saves during page load

/** Create the Fabric canvas the very first time (dynamic canvas element), or resize it. */
function initFabric(width, height) {
  if (!fabricCanvas) {
    // Create a fresh <canvas> element — do NOT use one already in the DOM
    // so Fabric never interferes with #pdf-canvas
    const fc_el = document.createElement('canvas');
    fc_el.id    = 'annotation-canvas';
    pageContainer.appendChild(fc_el);

    fabricCanvas = new fabric.Canvas(fc_el, {
      selection: true,
      preserveObjectStacking: true,
      backgroundColor: 'rgba(0,0,0,0)',
      width,
      height,
    });

    // Make BOTH inner canvases fully transparent so PDF shows through
    fabricCanvas.lowerCanvasEl.style.background      = 'transparent';
    fabricCanvas.lowerCanvasEl.style.backgroundColor = 'transparent';
    fabricCanvas.upperCanvasEl.style.background      = 'transparent';
    fabricCanvas.upperCanvasEl.style.backgroundColor = 'transparent';

    // Position the Fabric wrapper exactly over #pdf-canvas
    const wrapper = fabricCanvas.wrapperEl;
    wrapper.style.position = 'absolute';
    wrapper.style.top      = '0';
    wrapper.style.left     = '0';
    wrapper.style.width    = width  + 'px';
    wrapper.style.height   = height + 'px';

    // ── Events ────────────────────────────────────────────
    fabricCanvas.on('object:added',    () => saveHistory(State.currentPage));
    fabricCanvas.on('object:modified', () => saveHistory(State.currentPage));
    fabricCanvas.on('object:removed',  () => saveHistory(State.currentPage));

    fabricCanvas.on('selection:created', syncPropsFromSelection);
    fabricCanvas.on('selection:updated', syncPropsFromSelection);

    fabricCanvas.on('mouse:down',     (opt) => handleFabricMouseDown(fabricCanvas, opt));
    fabricCanvas.on('mouse:move',     (opt) => handleFabricMouseMove(fabricCanvas, opt));
    fabricCanvas.on('mouse:up',       (opt) => handleFabricMouseUp(fabricCanvas, opt));
    fabricCanvas.on('mouse:dblclick', () => {
      const obj = fabricCanvas.getActiveObject();
      if (!obj) return;
      if (obj.isFormField) {
        // Double-click on a detected form field → open text input inside it
        State.pendingTextPos = { x: obj.left + 4, y: obj.top + 4 };
        openTextInput();
        return;
      }
      if (obj.type === 'textbox' || obj.type === 'i-text') {
        obj.enterEditing();
        fabricCanvas.renderAll();
      }
    });

    // Context menu on right-click
    fabricCanvas.upperCanvasEl.addEventListener('contextmenu', (e) => {
      if (fabricCanvas.getActiveObject()) {
        e.preventDefault();
        contextMenu.style.display = 'block';
        contextMenu.style.left    = e.clientX + 'px';
        contextMenu.style.top     = e.clientY + 'px';
      }
    });

  } else {
    // Resize existing Fabric canvas
    fabricCanvas.setWidth(width);
    fabricCanvas.setHeight(height);
    const wrapper = fabricCanvas.wrapperEl;
    wrapper.style.width  = width  + 'px';
    wrapper.style.height = height + 'px';
  }

  // Always ensure background stays transparent
  fabricCanvas.setBackgroundColor('rgba(0,0,0,0)', () => {});
}

/** Save current page annotations before leaving the page. */
function savePageAnnotations(pageNum) {
  if (!fabricCanvas) return;
  State.pageAnnotations[pageNum] = fabricCanvas.toJSON(['id', 'stampType', 'isFormField', 'fieldName']);
}

/** Load saved annotations for a page (or start blank). */
function loadPageAnnotations(pageNum) {
  if (!fabricCanvas) return;
  isLoadingPage = true;
  const data = State.pageAnnotations[pageNum];
  if (data && data.objects && data.objects.length > 0) {
    fabricCanvas.loadFromJSON(data, () => {
      isLoadingPage = false;
      fabricCanvas.renderAll();
    });
  } else {
    fabricCanvas.clear();
    fabricCanvas.setBackgroundColor('rgba(0,0,0,0)', () => fabricCanvas.renderAll());
    isLoadingPage = false;
  }
}

function saveHistory(pageNum) {
  if (!fabricCanvas || isLoadingPage) return;
  const json = JSON.stringify(fabricCanvas.toJSON(['id', 'stampType']));
  if (!State.historyUndo[pageNum]) State.historyUndo[pageNum] = [];
  State.historyUndo[pageNum].push(json);
  if (State.historyRedo[pageNum]) State.historyRedo[pageNum] = [];
}

function undo() {
  const p = State.currentPage;
  if (!State.historyUndo[p] || State.historyUndo[p].length < 2) return;
  const cur = State.historyUndo[p].pop();
  if (!State.historyRedo[p]) State.historyRedo[p] = [];
  State.historyRedo[p].push(cur);
  const prev = State.historyUndo[p][State.historyUndo[p].length - 1];
  fabricCanvas.loadFromJSON(JSON.parse(prev), () => fabricCanvas.renderAll());
}

function redo() {
  const p = State.currentPage;
  if (!State.historyRedo[p] || !State.historyRedo[p].length) return;
  const next = State.historyRedo[p].pop();
  if (!State.historyUndo[p]) State.historyUndo[p] = [];
  State.historyUndo[p].push(next);
  fabricCanvas.loadFromJSON(JSON.parse(next), () => fabricCanvas.renderAll());
}

// ──────────────────────────────────────────────────────────────
// PDF LOADING
// ──────────────────────────────────────────────────────────────
async function loadPdfFile(file) {
  try {
    statusInfo.textContent = 'جاري التحميل…';
    const arrayBuf = await file.arrayBuffer();
    State.pdfBytes  = arrayBuf.slice(0); // keep original for export
    const pdfData   = new Uint8Array(arrayBuf);

    // ── 1. Load with PDF.js (rendering) ──────────────────
    const loadingTask = pdfjsLib.getDocument({ data: pdfData });
    State.pdfDoc = await loadingTask.promise;

    State.totalPages  = State.pdfDoc.numPages;
    State.currentPage = 1;
    pageInput.max     = State.totalPages;
    pageInput.value   = 1;
    pageTotal.textContent = '/ ' + State.totalPages;

    // ── 2. Update UI immediately ──────────────────────────
    dropZone.classList.add('hidden');
    pageContainer.classList.add('visible');

    statusInfo.textContent = `${file.name}  (${State.totalPages} صفحة)`;

    // ── 3. Reset per-page annotation state ───────────────
    State.pageAnnotations = {};
    State.historyUndo     = {};
    State.historyRedo     = {};

    if (fabricCanvas) {
      fabricCanvas.clear();
      fabricCanvas.setBackgroundColor('rgba(0,0,0,0)', () => {});
    }

    // ── 4. Render first page ──────────────────────────────
    await renderPage(1);
    generateThumbnails();

    // ── 5. Load pdf-lib in background (non-blocking) ──────
    try {
      State.pdfLibDoc = await PDFLib.PDFDocument.load(
        new Uint8Array(State.pdfBytes),
        { ignoreEncryption: true }
      );
    } catch (e) {
      console.warn('pdf-lib could not load the file (export disabled):', e.message);
      State.pdfLibDoc = null;
    }

  } catch (err) {
    console.error('Failed to load PDF:', err);
    statusInfo.textContent = 'خطأ في تحميل الملف: ' + err.message;
    alert('تعذّر فتح الملف. تأكد أنه ملف PDF صحيح.\n\n' + err.message);
  }
}

// ──────────────────────────────────────────────────────────────
// PAGE RENDERING
// ──────────────────────────────────────────────────────────────
async function renderPage(num) {
  if (!State.pdfDoc) return;

  // Always save current page annotations before re-rendering
  if (fabricCanvas) {
    savePageAnnotations(State.currentPage);
  }

  State.currentPage = num;
  pageInput.value   = num;

  const page     = await State.pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: State.scale, rotation: State.rotation });

  pdfCanvas.width  = viewport.width;
  pdfCanvas.height = viewport.height;

  const ctx = pdfCanvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Initialize or resize the single Fabric canvas
  initFabric(viewport.width, viewport.height);

  // Load this page's saved annotations (or blank)
  loadPageAnnotations(num);

  setTool(State.activeTool);
  zoomLabel.textContent = Math.round(State.scale * 100) + '%';
  highlightActiveThumbnail(num);
}

// ──────────────────────────────────────────────────────────────
// THUMBNAILS
// ──────────────────────────────────────────────────────────────
async function generateThumbnails() {
  thumbsList.innerHTML = '';
  for (let i = 1; i <= State.totalPages; i++) {
    const page      = await State.pdfDoc.getPage(i);
    const viewport  = page.getViewport({ scale: 0.18 });
    const canvas    = document.createElement('canvas');
    canvas.width    = viewport.width;
    canvas.height   = viewport.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === State.currentPage ? ' active' : '');
    item.dataset.page = i;
    item.appendChild(canvas);

    const lbl = document.createElement('div');
    lbl.className = 'thumb-label';
    lbl.textContent = 'صفحة ' + i;
    item.appendChild(lbl);

    item.addEventListener('click', () => renderPage(i));
    thumbsList.appendChild(item);
  }
}

function highlightActiveThumbnail(num) {
  $$('.thumb-item').forEach(el => {
    el.classList.toggle('active', +el.dataset.page === num);
  });
}

// ──────────────────────────────────────────────────────────────
// TOOL SYSTEM
// ──────────────────────────────────────────────────────────────
const TOOL_NAMES = {
  select: 'تحديد', hand: 'تمرير', text: 'نص', highlight: 'تمييز',
  underline: 'تسطير', strikeout: 'شطب', pen: 'قلم حر', eraser: 'ممحاة',
  rect: 'مستطيل', circle: 'دائرة', arrow: 'سهم', line: 'خط',
  image: 'صورة', stamp: 'ختم',
};

function setTool(tool) {
  State.activeTool = tool;
  $$('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`.tool-btn[data-tool="${tool}"]`);
  if (btn) btn.classList.add('active');
  statusTool.textContent = 'الأداة: ' + (TOOL_NAMES[tool] || tool);

  if (!fabricCanvas) return;

  // Reset fabric mode
  fabricCanvas.isDrawingMode = false;
  fabricCanvas.selection     = true;
  fabricCanvas.defaultCursor = 'default';
  fabricCanvas.upperCanvasEl.style.cursor = 'default';

  switch (tool) {
    case 'select':
      fabricCanvas.selection = true;
      fabricCanvas.forEachObject(o => { o.selectable = true; o.evented = true; });
      break;

    case 'hand':
      fabricCanvas.selection = false;
      fabricCanvas.forEachObject(o => { o.selectable = false; o.evented = false; });
      fabricCanvas.upperCanvasEl.style.cursor = 'grab';
      break;

    case 'pen':
      fabricCanvas.isDrawingMode = true;
      fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
      fabricCanvas.freeDrawingBrush.color   = propStrokeColor.value;
      fabricCanvas.freeDrawingBrush.width   = +propStrokeWidth.value;
      fabricCanvas.defaultCursor = 'crosshair';
      break;

    case 'eraser':
      fabricCanvas.isDrawingMode = true;
      fabricCanvas.freeDrawingBrush = new fabric.PencilBrush(fabricCanvas);
      fabricCanvas.freeDrawingBrush.color  = 'rgba(255,255,255,1)';
      fabricCanvas.freeDrawingBrush.width  = (+propStrokeWidth.value) * 4;
      fabricCanvas.defaultCursor = 'cell';
      break;

    case 'text':
    case 'highlight':
    case 'underline':
    case 'strikeout':
    case 'rect':
    case 'circle':
    case 'arrow':
    case 'line':
      fabricCanvas.selection = false;
      fabricCanvas.forEachObject(o => { o.selectable = false; o.evented = false; });
      fabricCanvas.upperCanvasEl.style.cursor = 'crosshair';
      break;

    case 'image':
      imageInput.click();
      break;

    case 'stamp':
      stampModal.style.display = 'flex';
      break;
  }
}

// Pan support for 'hand' tool
let panStart = null;

// ──────────────────────────────────────────────────────────────
// SHAPE DRAWING — via Fabric event system
// ──────────────────────────────────────────────────────────────

function handleFabricMouseDown(fc, opt) {
  const e    = opt.e;
  const tool = State.activeTool;
  if (e.button !== 0) return;

  const p = fc.getPointer(e);
  statusCoords.textContent = `X: ${Math.round(p.x)}  Y: ${Math.round(p.y)}`;

  if (tool === 'hand') {
    panStart = { x: e.clientX, y: e.clientY };
    fc.upperCanvasEl.style.cursor = 'grabbing';
    return;
  }

  if (['select', 'pen', 'eraser'].includes(tool)) return;

  if (tool === 'text') {
    State.pendingTextPos = p;
    openTextInput();
    return;
  }

  State.isDrawing = true;
  State.drawStart = p;

  const strokeColor = propStrokeColor.value;
  const strokeWidth = +propStrokeWidth.value;
  const opacity     = propOpacity.value / 100;
  const fillColor   = propFillNone.checked ? 'transparent' : propFillColor.value;
  const hlColor     = hexToRgba(propHighlightColor.value, propHighlightOpacity.value / 100);

  switch (tool) {
    case 'rect':
      State.tempShape = new fabric.Rect({
        left: p.x, top: p.y, width: 1, height: 1,
        stroke: strokeColor, strokeWidth, fill: fillColor,
        opacity, selectable: false, evented: false,
      });
      break;
    case 'circle':
      State.tempShape = new fabric.Ellipse({
        left: p.x, top: p.y, rx: 1, ry: 1,
        stroke: strokeColor, strokeWidth, fill: fillColor,
        opacity, selectable: false, evented: false,
      });
      break;
    case 'line':
      State.tempShape = new fabric.Line([p.x, p.y, p.x, p.y], {
        stroke: strokeColor, strokeWidth, opacity,
        selectable: false, evented: false,
      });
      break;
    case 'arrow':
      State.tempShape = createArrow(p.x, p.y, p.x, p.y, strokeColor, strokeWidth, opacity);
      break;
    case 'highlight':
      State.tempShape = new fabric.Rect({
        left: p.x, top: p.y, width: 1, height: Math.max(+propFontSize.value, 20),
        fill: hlColor, stroke: null, opacity: 1,
        selectable: false, evented: false,
      });
      break;
    case 'underline':
      State.tempShape = new fabric.Line([p.x, p.y + 18, p.x, p.y + 18], {
        stroke: strokeColor, strokeWidth: 2, opacity,
        selectable: false, evented: false,
      });
      break;
    case 'strikeout':
      State.tempShape = new fabric.Line([p.x, p.y + 9, p.x, p.y + 9], {
        stroke: '#e53e3e', strokeWidth: 2, opacity,
        selectable: false, evented: false,
      });
      break;
  }

  if (State.tempShape) {
    fc.add(State.tempShape);
    fc.renderAll();
  }
}

function handleFabricMouseMove(fc, opt) {
  const e = opt.e;
  const p = fc.getPointer(e);
  statusCoords.textContent = `X: ${Math.round(p.x)}  Y: ${Math.round(p.y)}`;

  if (State.activeTool === 'hand' && panStart) {
    const dx = e.clientX - panStart.x;
    const dy = e.clientY - panStart.y;
    const wrapper = document.getElementById('canvas-wrapper');
    wrapper.scrollLeft -= dx;
    wrapper.scrollTop  -= dy;
    panStart = { x: e.clientX, y: e.clientY };
    return;
  }

  if (!State.isDrawing || !State.tempShape) return;
  const s    = State.drawStart;
  const tool = State.activeTool;

  switch (tool) {
    case 'rect': {
      const left   = Math.min(p.x, s.x);
      const top    = Math.min(p.y, s.y);
      State.tempShape.set({ left, top, width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) });
      break;
    }
    case 'circle': {
      const rx   = Math.abs(p.x - s.x) / 2;
      const ry   = Math.abs(p.y - s.y) / 2;
      State.tempShape.set({ left: Math.min(p.x, s.x), top: Math.min(p.y, s.y), rx, ry, width: rx * 2, height: ry * 2 });
      break;
    }
    case 'line':
    case 'underline':
    case 'strikeout':
      State.tempShape.set({ x2: p.x, y2: p.y });
      break;
    case 'arrow':
      fc.remove(State.tempShape);
      State.tempShape = createArrow(s.x, s.y, p.x, p.y,
        propStrokeColor.value, +propStrokeWidth.value, propOpacity.value / 100);
      fc.add(State.tempShape);
      break;
    case 'highlight': {
      State.tempShape.set({ left: Math.min(p.x, s.x), width: Math.abs(p.x - s.x) });
      break;
    }
  }
  fc.renderAll();
}

function handleFabricMouseUp(fc, opt) {
  const tool = State.activeTool;
  if (tool === 'hand') {
    panStart = null;
    fc.upperCanvasEl.style.cursor = 'grab';
    return;
  }

  if (!State.isDrawing) return;
  State.isDrawing = false;

  if (State.tempShape) {
    State.tempShape.set({ selectable: true, evented: true });
    fc.setActiveObject(State.tempShape);
    fc.renderAll();
    State.tempShape = null;
  }
}

// ──────────────────────────────────────────────────────────────
// ARROW SHAPE (Group: line + triangle)
// ──────────────────────────────────────────────────────────────
function createArrow(x1, y1, x2, y2, color, width, opacity) {
  const dx    = x2 - x1;
  const dy    = y2 - y1;
  const angle = Math.atan2(dy, dx) * (180 / Math.PI);
  const len   = Math.sqrt(dx * dx + dy * dy);

  const line = new fabric.Line([0, 0, len - 12, 0], {
    stroke: color, strokeWidth: width,
    originX: 'left', originY: 'center',
  });
  const head = new fabric.Triangle({
    width: 12, height: 14,
    fill: color, left: len - 12,
    originX: 'left', originY: 'center',
    angle: 90,
  });
  const grp = new fabric.Group([line, head], {
    left: x1, top: y1,
    angle,
    opacity,
    originX: 'left', originY: 'center',
    selectable: false, evented: false,
  });
  return grp;
}

// ──────────────────────────────────────────────────────────────
// TEXT INPUT
// ──────────────────────────────────────────────────────────────
function openTextInput() {
  textEditor.style.fontFamily      = propFontFamily.value;
  textEditor.style.fontSize        = propFontSize.value + 'px';
  textEditor.style.color           = propFontColor.value;
  textEditor.style.backgroundColor = propTextBgNone.checked ? 'transparent' : propTextBgColor.value;
  textEditor.style.fontWeight      = propBold.classList.contains('active')   ? 'bold'   : 'normal';
  textEditor.style.fontStyle       = propItalic.classList.contains('active') ? 'italic' : 'normal';
  textEditor.style.textDecoration  = propUnderlineBtn.classList.contains('active') ? 'underline' : 'none';
  textEditor.textContent = '';
  textOverlay.style.display = 'flex';
  textEditor.focus();
}

$('text-confirm').addEventListener('click', commitText);
$('text-cancel').addEventListener('click', () => {
  textOverlay.style.display = 'none';
  setTool('select');
});

function commitText() {
  textOverlay.style.display = 'none';
  const content = textEditor.innerText.trim();
  if (!content || !fabricCanvas) return;

  const txt = new fabric.Textbox(content, {
    left:     State.pendingTextPos.x,
    top:      State.pendingTextPos.y,
    fontFamily:           propFontFamily.value,
    fontSize:             +propFontSize.value,
    fill:                 propFontColor.value,
    textBackgroundColor:  propTextBgNone.checked ? '' : propTextBgColor.value,
    fontWeight:      propBold.classList.contains('active')        ? 'bold'      : 'normal',
    fontStyle:       propItalic.classList.contains('active')      ? 'italic'    : 'normal',
    underline:       propUnderlineBtn.classList.contains('active'),
    opacity:         propOpacity.value / 100,
    width:           240,
    editable:        true,
    splitByGrapheme: false,
  });

  fabricCanvas.add(txt);
  fabricCanvas.setActiveObject(txt);
  fabricCanvas.renderAll();
  setTool('select');
}

// (dblclick is handled inside initFabric via fc.on('mouse:dblclick'))

// ══════════════════════════════════════════════════════════════
// SPELL CHECK — LanguageTool API (تدقيق لغوي)
// ══════════════════════════════════════════════════════════════
const LT_API = 'https://api.languagetool.org/v2/check';

async function languageToolCheck(text, lang) {
  if (!text || !text.trim()) return [];
  const body = new URLSearchParams({ text, language: lang === 'auto' ? 'auto' : lang });
  const resp = await fetch(LT_API, {
    method : 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  const data = await resp.json();
  return data.matches || [];
}

// ─── Inline spell check (text overlay editor) ─────────────────
$('btn-check-inline').addEventListener('click', runInlineSpellCheck);

async function runInlineSpellCheck() {
  const text      = ($('text-editor').innerText || '').trim();
  const indicator = $('spell-checking-indicator');
  const panel     = $('spell-errors-panel');
  const listEl    = $('spell-errors-list');
  const countEl   = $('spell-error-count');

  if (!text) return;

  indicator.style.display = 'flex';
  panel.style.display     = 'none';

  try {
    const lang    = spellLangInline ? spellLangInline.value : 'auto';
    const matches = await languageToolCheck(text, lang);

    indicator.style.display = 'none';

    if (!matches.length) {
      countEl.textContent  = '✅ لا توجد أخطاء';
      listEl.innerHTML     = '<div style="padding:10px;color:#4ade80;font-size:.75rem;">لا توجد أخطاء لغوية مكتشفة ✅</div>';
      panel.style.display  = 'block';
      return;
    }

    countEl.textContent = matches.length + ' خطأ';
    listEl.innerHTML    = '';

    matches.forEach((match) => {
      const errWord    = text.substring(match.offset, match.offset + match.length);
      const suggs      = (match.replacements || []).slice(0, 5).map(r => r.value);

      const item = document.createElement('div');
      item.className = 'spell-error-item';
      item.innerHTML =
        `<div class="spell-error-original">🔴 "${errWord}"</div>` +
        `<div class="spell-error-message">${match.message}</div>` +
        `<div class="spell-suggestions">` +
          suggs.map(s =>
            `<button class="spell-suggestion-btn" data-original="${errWord.replace(/"/g,'&quot;')}" data-replacement="${s.replace(/"/g,'&quot;')}">✔ ${s}</button>`
          ).join('') +
          (!suggs.length ? '<span style="color:var(--text-muted);font-size:.7rem">لا توجد اقتراحات</span>' : '') +
        `</div>`;

      item.querySelectorAll('.spell-suggestion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const editor = $('text-editor');
          editor.innerText = editor.innerText.replace(btn.dataset.original, btn.dataset.replacement);
          runInlineSpellCheck();
        });
      });

      listEl.appendChild(item);
    });

    panel.style.display = 'block';

  } catch (err) {
    indicator.style.display = 'none';
    countEl.textContent     = 'خطأ في الاتصال';
    listEl.innerHTML        = `<div style="padding:10px;color:#f87171;font-size:.73rem;">تعذّر الاتصال بخدمة التدقيق. تأكد من اتصال الإنترنت.<br><small>${err.message}</small></div>`;
    panel.style.display     = 'block';
    console.warn('LanguageTool error:', err);
  }
}

(function wireSpellPanelClose() {
  const btn = $('spell-panel-close');
  if (btn) btn.addEventListener('click', () => { $('spell-errors-panel').style.display = 'none'; });
})();

if (spellLangInline) {
  spellLangInline.addEventListener('change', () => {
    const editor = $('text-editor');
    if (editor) editor.dir = spellLangInline.value === 'ar' ? 'rtl' : 'auto';
  });
}

// ─── Modal spell check (all text objects on the page) ─────────
$('btn-spellcheck').addEventListener('click', openSpellCheckModal);
$('spellcheck-close').addEventListener('click', () => { spellcheckModal.style.display = 'none'; });
(function wireBackdrop() {
  const bd = $('spellcheck-backdrop');
  if (bd) bd.addEventListener('click', () => { spellcheckModal.style.display = 'none'; });
})();

function openSpellCheckModal() {
  if (!State.pdfDoc) { alert('الرجاء فتح ملف PDF أولاً.'); return; }
  const resultsEl = $('spell-modal-results');
  const statusEl  = $('spell-modal-status');
  const summaryEl = $('spell-modal-summary');
  if (resultsEl) resultsEl.innerHTML   = '';
  if (statusEl)  { statusEl.textContent = 'اضغط "فحص الصفحة" لبدء التدقيق على نصوص الصفحة الحالية.'; statusEl.style.display = 'block'; }
  if (summaryEl) summaryEl.textContent = '';
  spellcheckModal.style.display = 'flex';
}

$('btn-run-spellcheck').addEventListener('click', runModalSpellCheck);

async function runModalSpellCheck() {
  if (!fabricCanvas) return;

  const textObjs = fabricCanvas.getObjects().filter(o =>
    o.type === 'textbox' || o.type === 'i-text' || o.type === 'text'
  );

  const resultsEl = $('spell-modal-results');
  const statusEl  = $('spell-modal-status');
  const summaryEl = $('spell-modal-summary');

  resultsEl.innerHTML = '';

  if (!textObjs.length) {
    statusEl.textContent  = 'لا توجد نصوص مضافة في هذه الصفحة.';
    statusEl.style.display = 'block';
    return;
  }

  const lang = spellLangModal ? spellLangModal.value : 'auto';
  statusEl.innerHTML     = '<i class="fa fa-spinner fa-spin"></i> جاري فحص ' + textObjs.length + ' نص…';
  statusEl.style.display = 'block';

  let totalErrors = 0;
  let totalFixed  = 0;

  for (let i = 0; i < textObjs.length; i++) {
    const obj  = textObjs[i];
    const text = (obj.text || '').trim();
    if (!text) continue;

    let matches = [];
    try { matches = await languageToolCheck(text, lang); }
    catch (e) { console.warn('LT error obj', i, e); }

    if (!matches.length) continue;
    totalErrors += matches.length;

    const card    = document.createElement('div');
    card.className = 'spell-obj-card';
    const preview  = text.length > 80 ? text.slice(0, 80) + '…' : text;
    card.innerHTML =
      `<div class="spell-obj-header">` +
        `<i class="fa fa-text-width"></i> نص #${i + 1} ` +
        `<span class="spell-obj-text-preview">‎${preview}</span>` +
      `</div>`;

    matches.forEach((match) => {
      const errWord  = text.substring(match.offset, match.offset + match.length);
      const suggs    = (match.replacements || []).slice(0, 6).map(r => r.value);

      const errorDiv = document.createElement('div');
      errorDiv.className = 'spell-modal-error-item';
      errorDiv.innerHTML =
        `<div class="spell-modal-error-row">` +
          `<div class="spell-modal-error-original">&ldquo;${errWord}&rdquo;</div>` +
          `<div class="spell-modal-error-body">` +
            `<div class="spell-modal-error-msg">${match.message}</div>` +
            `<div class="spell-modal-suggestions">` +
              suggs.map(s =>
                `<button class="spell-modal-suggestion-btn" data-obj-idx="${i}" data-original="${errWord.replace(/"/g,'&quot;')}" data-replacement="${s.replace(/"/g,'&quot;')}">✔ ${s}</button>`
              ).join('') +
              `<button class="spell-ignore-btn">تجاهل</button>` +
            `</div>` +
          `</div>` +
        `</div>`;

      errorDiv.querySelectorAll('.spell-modal-suggestion-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const target = textObjs[+btn.dataset.objIdx];
          if (target) {
            target.set({ text: target.text.replace(btn.dataset.original, btn.dataset.replacement) });
            fabricCanvas.renderAll();
            totalFixed++;
            if (summaryEl) summaryEl.textContent = `تم تصحيح ${totalFixed} خطأ`;
          }
          errorDiv.style.opacity       = '.4';
          errorDiv.style.pointerEvents = 'none';
        });
      });
      errorDiv.querySelector('.spell-ignore-btn').addEventListener('click', () => {
        errorDiv.style.opacity       = '.35';
        errorDiv.style.pointerEvents = 'none';
      });

      card.appendChild(errorDiv);
    });

    resultsEl.appendChild(card);
  }

  statusEl.style.display = 'none';

  if (!totalErrors) {
    resultsEl.innerHTML =
      '<div class="spell-no-errors"><i class="fa fa-check-circle"></i> لا توجد أخطاء لغوية في هذه الصفحة ✅</div>';
    if (summaryEl) summaryEl.textContent = 'لا أخطاء';
  } else {
    if (summaryEl) summaryEl.textContent = `وجد ${totalErrors} خطأ في ${textObjs.length} نص`;
  }
}

// ──────────────────────────────────────────────────────────────
// IMAGE INSERT
// ──────────────────────────────────────────────────────────────
imageInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file || !fabricCanvas) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const dataUrl = ev.target.result;
    // Create an HTMLImageElement first to ensure the image is decoded
    const htmlImg = new Image();
    htmlImg.onload = () => {
      const fabricImg = new fabric.Image(htmlImg, {
        left: 60,
        top: 60,
        crossOrigin: null,
      });
      const maxW = fabricCanvas.width  * 0.6;
      const maxH = fabricCanvas.height * 0.6;
      const scale = Math.min(maxW / htmlImg.width, maxH / htmlImg.height, 1);
      fabricImg.scale(scale);
      fabricCanvas.add(fabricImg);
      fabricCanvas.setActiveObject(fabricImg);
      fabricCanvas.requestRenderAll();
      setTool('select');
    };
    htmlImg.src = dataUrl;
  };
  reader.readAsDataURL(file);
  imageInput.value = '';
});

// ──────────────────────────────────────────────────────────────
// STAMP
// ──────────────────────────────────────────────────────────────
const STAMP_COLORS = {
  approved:     { stroke: '#22c55e', fill: 'rgba(34,197,94,.12)' },
  rejected:     { stroke: '#ef4444', fill: 'rgba(239,68,68,.12)' },
  draft:        { stroke: '#f59e0b', fill: 'rgba(245,158,11,.12)' },
  confidential: { stroke: '#6366f1', fill: 'rgba(99,102,241,.12)' },
  final:        { stroke: '#0ea5e9', fill: 'rgba(14,165,233,.12)' },
  urgent:       { stroke: '#f97316', fill: 'rgba(249,115,22,.12)' },
};
const STAMP_LABELS = {
  approved: 'موافق عليه', rejected: 'مرفوض', draft: 'مسودة',
  confidential: 'سري', final: 'نهائي', urgent: 'عاجل',
};

$$('.stamp-item').forEach(item => {
  item.addEventListener('click', () => {
    const key = item.dataset.stamp;
    stampModal.style.display = 'none';
    if (!fabricCanvas) return;

    const c = STAMP_COLORS[key];
    const cx = fabricCanvas.width / 2;
    const cy = fabricCanvas.height / 2;

    const rect = new fabric.Rect({
      width: 160, height: 60,
      fill: c.fill, stroke: c.stroke, strokeWidth: 3,
      rx: 6, ry: 6,
      originX: 'center', originY: 'center',
    });
    const text = new fabric.Text(STAMP_LABELS[key], {
      fontSize: 20, fill: c.stroke, fontWeight: 'bold',
      originX: 'center', originY: 'center',
    });
    const grp = new fabric.Group([rect, text], {
      left: cx - 80, top: cy - 30,
      angle: -15,
      stampType: key,
    });

    fabricCanvas.add(grp);
    fabricCanvas.setActiveObject(grp);
    fabricCanvas.renderAll();
    setTool('select');
  });
});

$('stamp-close').addEventListener('click', () => {
  stampModal.style.display = 'none';
  setTool('select');
});

// ──────────────────────────────────────────────────────────────
// FORM FIELD DETECTION (كشف حقول النموذج تلقائياً)
// ──────────────────────────────────────────────────────────────

function showFieldsToast(msg) {
  const t = $('fields-toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 3600);
}

$('btn-detect-fields').addEventListener('click', detectFormFields);
$('btn-clear-fields').addEventListener('click',  clearFormFields);

function clearFormFields() {
  if (!fabricCanvas) return;
  fabricCanvas.getObjects()
    .filter(o => o.isFormField)
    .forEach(o => fabricCanvas.remove(o));
  fabricCanvas.renderAll();
  showFieldsToast('تم مسح جميع حقول النموذج');
}

async function detectFormFields() {
  if (!State.pdfDoc) { showFieldsToast('افتح ملف PDF أولاً'); return; }

  const btn = $('btn-detect-fields');
  btn.classList.add('detecting');
  btn.disabled = true;

  try {
    clearFormFields();

    // ── 1. Try native AcroForm fields (digital PDFs) ─────────
    const page       = await State.pdfDoc.getPage(State.currentPage);
    const viewport   = page.getViewport({ scale: State.scale, rotation: State.rotation });
    const annotations = await page.getAnnotations();
    const widgets     = annotations.filter(a => a.subtype === 'Widget');

    if (widgets.length > 0) {
      widgets.forEach(field => {
        const r = viewport.convertToViewportRectangle(field.rect);
        const left   = Math.min(r[0], r[2]);
        const top    = Math.min(r[1], r[3]);
        const width  = Math.abs(r[2] - r[0]);
        const height = Math.abs(r[3] - r[1]);
        if (width < 10 || height < 6) return;
        addFormFieldRect(left, top, width, height, field.fieldName || '');
      });
      fabricCanvas.renderAll();
      showFieldsToast('✅ تم اكتشاف ' + widgets.length + ' حقل من AcroForm');
      return;
    }

    // ── 2. Visual detection via Sobel edge map + projection profiles ──
    // Render the page at a fixed high scale for detection accuracy
    const DET_SCALE  = Math.max(2.5, State.scale);
    const detVP      = page.getViewport({ scale: DET_SCALE, rotation: State.rotation });
    const detCanvas  = document.createElement('canvas');
    detCanvas.width  = Math.round(detVP.width);
    detCanvas.height = Math.round(detVP.height);
    const detCtx     = detCanvas.getContext('2d');
    await page.render({ canvasContext: detCtx, viewport: detVP }).promise;

    const cw  = detCanvas.width;
    const ch  = detCanvas.height;
    const img = detCtx.getImageData(0, 0, cw, ch);
    const px  = img.data;

    // Linearise to greyscale float32 array
    const grey = new Float32Array(cw * ch);
    for (let i = 0; i < cw * ch; i++) {
      grey[i] = (0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2]) / 255;
    }

    // Sobel edge magnitude (normalised 0-1), stored in Float32Array
    const edge = new Float32Array(cw * ch);
    for (let y = 1; y < ch - 1; y++) {
      for (let x = 1; x < cw - 1; x++) {
        const tl = grey[(y-1)*cw+(x-1)], tm = grey[(y-1)*cw+x], tr = grey[(y-1)*cw+(x+1)];
        const ml = grey[y*cw+(x-1)],                             mr = grey[y*cw+(x+1)];
        const bl = grey[(y+1)*cw+(x-1)], bm = grey[(y+1)*cw+x], br = grey[(y+1)*cw+(x+1)];
        const gx = -tl - 2*ml - bl + tr + 2*mr + br;
        const gy = -tl - 2*tm - tr + bl + 2*bm + br;
        edge[y*cw+x] = Math.min(1, Math.sqrt(gx*gx + gy*gy) / 1.5);
      }
    }

    // Horizontal projection: average edge strength per row
    const hProj = new Float32Array(ch);
    for (let y = 0; y < ch; y++) {
      let s = 0;
      for (let x = 0; x < cw; x++) s += edge[y*cw+x];
      hProj[y] = s / cw;
    }

    // Vertical projection: average edge strength per column
    const vProj = new Float32Array(cw);
    for (let x = 0; x < cw; x++) {
      let s = 0;
      for (let y = 0; y < ch; y++) s += edge[y*cw+x];
      vProj[x] = s / ch;
    }

    // Adaptive threshold: mean + 1.5 * std-dev of projection array
    const projThreshold = arr => {
      let sum = 0, sum2 = 0, n = arr.length;
      for (let i = 0; i < n; i++) { sum += arr[i]; sum2 += arr[i]*arr[i]; }
      const mean = sum / n;
      const std  = Math.sqrt(sum2 / n - mean * mean);
      return mean + 1.5 * std;
    };

    const hThr = projThreshold(hProj);
    const vThr = projThreshold(vProj);

    // Collect positions that exceed threshold
    const hCand = [], vCand = [];
    for (let y = 0; y < ch; y++) if (hProj[y] >= hThr) hCand.push(y);
    for (let x = 0; x < cw; x++) if (vProj[x] >= vThr) vCand.push(x);

    // Group consecutive positions by gap → keep peak value's centre
    const groupByGap = (arr, gap) => {
      if (!arr.length) return [];
      const groups = [];
      let g = [arr[0]];
      for (let i = 1; i < arr.length; i++) {
        if (arr[i] - arr[i-1] <= gap) { g.push(arr[i]); }
        else { groups.push(g); g = [arr[i]]; }
      }
      groups.push(g);
      return groups.map(grp => Math.round(grp.reduce((a,b) => a+b, 0) / grp.length));
    };

    const scaleFactor = State.scale / DET_SCALE; // map detection coords → display coords
    const hLines = groupByGap(hCand, 6).map(v => Math.round(v * scaleFactor));
    const vLines = groupByGap(vCand, 6).map(v => Math.round(v * scaleFactor));

    if (hLines.length < 2 || vLines.length < 2) {
      showFieldsToast('⚠️ لم يتم اكتشاف شبكة نموذج. جرّب تكبير الصفحة أولاً.');
      return;
    }

    // Evaluate whether each cell interior is mostly white/light → writable field
    const dCtx2 = detCanvas.getContext('2d');
    let count = 0;
    const PAD = 6, SAMP = 16;

    for (let i = 0; i < hLines.length - 1; i++) {
      for (let j = 0; j < vLines.length - 1; j++) {
        const x1 = vLines[j], x2 = vLines[j + 1];
        const y1 = hLines[i], y2 = hLines[i + 1];
        const fw = x2 - x1, fh = y2 - y1;
        if (fw < 24 || fh < 8) continue;

        // Sample interior luminance on the detection canvas (scale back up)
        const dx1 = Math.round(x1 / scaleFactor), dx2 = Math.round(x2 / scaleFactor);
        const dy1 = Math.round(y1 / scaleFactor), dy2 = Math.round(y2 / scaleFactor);
        const dfw = dx2 - dx1, dfh = dy2 - dy1;
        let light = 0, tot = 0;
        for (let si = 1; si < SAMP - 1; si++) {
          for (let sj = 1; sj < SAMP - 1; sj++) {
            const sx = Math.min(cw-1, Math.round(dx1 + PAD + (dfw - PAD*2) * si / SAMP));
            const sy = Math.min(ch-1, Math.round(dy1 + PAD + (dfh - PAD*2) * sj / SAMP));
            tot++;
            if (grey[sy * cw + sx] > 0.70) light++;
          }
        }
        if (tot > 0 && light / tot >= 0.55) {
          addFormFieldRect(x1, y1, fw, fh, '');
          count++;
        }
      }
    }

    fabricCanvas.renderAll();
    showFieldsToast(count
      ? '✅ تم اكتشاف ' + count + ' حقل — انقر مرتين لتعبئة أي حقل'
      : '⚠️ لم يتم اكتشاف حقول. الصفحة قد لا تحتوي على نموذج ذو شبكة.');

  } catch (err) {
    console.error('detectFormFields:', err);
    showFieldsToast('حدث خطأ أثناء الكشف');
  } finally {
    btn.classList.remove('detecting');
    btn.disabled = false;
  }
}

function addFormFieldRect(left, top, width, height, fieldName) {
  const rect = new fabric.Rect({
    left, top, width, height,
    fill:            'rgba(59,130,246,0.09)',
    stroke:          '#3b82f6',
    strokeWidth:     1.5,
    strokeDashArray: [6, 4],
    rx: 3, ry: 3,
    selectable:  true,
    evented:     true,
    isFormField: true,
    fieldName,
    hoverCursor: 'text',
  });

  // Single click with text tool → fill immediately
  rect.on('mousedown', () => {
    if (State.activeTool === 'text') {
      State.pendingTextPos = { x: rect.left + 5, y: rect.top + 5 };
      openTextInput();
    }
  });

  fabricCanvas.add(rect);
}

// ──────────────────────────────────────────────────────────────
// SAVE (DOWNLOAD ANNOTATED IMAGE) & EXPORT PDF
// ──────────────────────────────────────────────────────────────
$('btn-save').addEventListener('click', saveCurrentPageImage);

function saveCurrentPageImage() {
  if (!fabricCanvas) return;

  // Temporarily hide form-field overlays so they don't appear in the export
  const fieldRects = fabricCanvas.getObjects().filter(o => o.isFormField);
  fieldRects.forEach(o => o.set('opacity', 0));
  fabricCanvas.renderAll();

  const merged = document.createElement('canvas');
  merged.width  = pdfCanvas.width;
  merged.height = pdfCanvas.height;
  const mctx = merged.getContext('2d');
  mctx.drawImage(pdfCanvas, 0, 0);

  const tmp = document.createElement('canvas');
  tmp.width  = pdfCanvas.width;
  tmp.height = pdfCanvas.height;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(fabricCanvas.lowerCanvasEl, 0, 0);
  tctx.drawImage(fabricCanvas.upperCanvasEl, 0, 0);
  mctx.drawImage(tmp, 0, 0);

  // Restore form field visibility
  fieldRects.forEach(o => o.set('opacity', 1));
  fabricCanvas.renderAll();

  const link = document.createElement('a');
  link.download = `pdf-pro-page${State.currentPage}.png`;
  link.href = merged.toDataURL('image/png');
  link.click();
}

$('btn-export').addEventListener('click', exportToPdf);

async function exportToPdf() {
  if (!State.pdfLibDoc) { alert('افتح ملف PDF أولاً'); return; }

  try {
    // Save current page annotations before exporting
    savePageAnnotations(State.currentPage);

    const pages      = State.pdfLibDoc.getPages();
    const tmpCanvas  = document.createElement('canvas');
    tmpCanvas.style.display = 'none';
    document.body.appendChild(tmpCanvas);

    for (let i = 1; i <= State.totalPages; i++) {
      const annotations = State.pageAnnotations[i];
      if (!annotations || !annotations.objects || annotations.objects.length === 0) continue;

      // Get native PDF page dimensions (scale = 1)
      const pdfPage    = await State.pdfDoc.getPage(i);
      const nativePort = pdfPage.getViewport({ scale: 1.0 });
      const nW = nativePort.width;
      const nH = nativePort.height;

      // Render at 3× for crisp text / sharp lines in the exported PDF
      const EXPORT_DPI = 3;
      const ratio = 1.0 / State.scale;

      const scaledObjects = (annotations.objects || [])
        .filter(obj => !obj.isFormField)      // exclude form-field guide overlays
        .map(obj => {
          const o = Object.assign({}, obj);
          // Scale numeric geometry props from rendered coords → native coords
          ['left','top','width','height','radius','rx','ry',
           'x1','y1','x2','y2','strokeWidth','fontSize'].forEach(k => {
            if (typeof o[k] === 'number') o[k] = o[k] * ratio;
          });
          // Scale freehand path coordinates
          if (Array.isArray(o.path)) {
            o.path = o.path.map(seg => seg.map((v, idx) => (idx === 0 ? v : v * ratio)));
          }
          if (o.scaleX) o.scaleX = o.scaleX;
          if (o.scaleY) o.scaleY = o.scaleY;
          return o;
        });

      // Skip this page if all objects were form-field guides
      if (!scaledObjects.length) continue;

      const scaledData = Object.assign({}, annotations, { objects: scaledObjects });

      tmpCanvas.width  = nW;
      tmpCanvas.height = nH;

      const tmpFc = new fabric.Canvas(tmpCanvas, {
        backgroundColor: null, width: nW, height: nH,
      });

      await new Promise(resolve => {
        tmpFc.loadFromJSON(scaledData, () => { tmpFc.renderAll(); resolve(); });
      });

      // multiplier:3 → Fabric renders internally at 3× → crisp PNG embedded at native PDF size
      const annotDataUrl = tmpFc.toDataURL({ format: 'png', multiplier: EXPORT_DPI });
      tmpFc.dispose();

      // Re-create element for next iteration
      if (i < State.totalPages) {
        const fresh = document.createElement('canvas');
        fresh.style.display = 'none';
        tmpCanvas.parentNode.insertBefore(fresh, tmpCanvas);
        tmpCanvas.parentNode.removeChild(tmpCanvas);
      }

      const imgBytes = dataUrlToBytes(annotDataUrl);
      const pngImage = await State.pdfLibDoc.embedPng(imgBytes);
      const libPage  = pages[i - 1];
      const { width, height } = libPage.getSize();
      libPage.drawImage(pngImage, { x: 0, y: 0, width, height });
    }

    // Clean up
    if (tmpCanvas.parentNode) tmpCanvas.parentNode.removeChild(tmpCanvas);

    const pdfBytes = await State.pdfLibDoc.save();
    const blob     = new Blob([pdfBytes], { type: 'application/pdf' });
    const link     = document.createElement('a');
    link.href      = URL.createObjectURL(blob);
    link.download  = 'annotated-document.pdf';
    link.click();

    statusInfo.textContent = 'تم تصدير الملف بنجاح';
  } catch (err) {
    console.error(err);
    alert('حدث خطأ أثناء التصدير: ' + err.message);
  }
}

function dataUrlToBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ──────────────────────────────────────────────────────────────
// CONTEXT MENU
// ──────────────────────────────────────────────────────────────
document.addEventListener('click', () => { contextMenu.style.display = 'none'; });

$('ctx-copy').addEventListener('click', () => {
  const obj = fabricCanvas?.getActiveObject();
  if (obj) obj.clone(c => { State.clipboard = c; });
});
$('ctx-cut').addEventListener('click', () => {
  const obj = fabricCanvas?.getActiveObject();
  if (obj) {
    obj.clone(c => { State.clipboard = c; });
    fabricCanvas.remove(obj);
    fabricCanvas.renderAll();
  }
});
$('ctx-paste').addEventListener('click', () => {
  if (!State.clipboard || !fabricCanvas) return;
  State.clipboard.clone(c => {
    c.set({ left: c.left + 20, top: c.top + 20 });
    fabricCanvas.add(c);
    fabricCanvas.setActiveObject(c);
    fabricCanvas.renderAll();
    State.clipboard = c;
  });
});
$('ctx-delete').addEventListener('click', deleteSelected);
$('ctx-bring-front').addEventListener('click', () => {
  fabricCanvas?.getActiveObject()?.bringToFront();
  fabricCanvas?.renderAll();
});
$('ctx-send-back').addEventListener('click', () => {
  fabricCanvas?.getActiveObject()?.sendToBack();
  fabricCanvas?.renderAll();
});

// ──────────────────────────────────────────────────────────────
// PROPERTIES SYNC
// ──────────────────────────────────────────────────────────────
function syncPropsFromSelection() {
  const obj = fabricCanvas?.getActiveObject();
  if (!obj) return;
  const isText = obj.type === 'textbox' || obj.type === 'i-text';

  if (isText) {
    if (obj.fontFamily) propFontFamily.value = obj.fontFamily;
    if (obj.fontSize)   propFontSize.value   = obj.fontSize;
    if (obj.fill)       propFontColor.value  = rgbToHex(obj.fill) || propFontColor.value;
    propBold.classList.toggle('active',        obj.fontWeight === 'bold');
    propItalic.classList.toggle('active',      obj.fontStyle  === 'italic');
    propUnderlineBtn.classList.toggle('active',obj.underline  === true);
    const tbg = obj.textBackgroundColor;
    if (tbg && tbg !== '') {
      propTextBgNone.checked   = false;
      propTextBgColor.value    = rgbToHex(tbg) || propTextBgColor.value;
    } else {
      propTextBgNone.checked   = true;
    }
  }

  if (obj.stroke) {
    const h = rgbToHex(obj.stroke);
    if (h) propStrokeColor.value = h;
  }
  if (obj.strokeWidth !== undefined) {
    propStrokeWidth.value     = obj.strokeWidth;
    strokeWidthLabel.textContent = obj.strokeWidth;
  }
  if (obj.opacity !== undefined) {
    propOpacity.value         = Math.round(obj.opacity * 100);
    opacityLabel.textContent  = Math.round(obj.opacity * 100) + '%';
  }
}

// Live property changes
propFontFamily.addEventListener('change',  applyPropsToSelected);
propFontSize.addEventListener('input',     applyPropsToSelected);
propFontColor.addEventListener('input',    applyPropsToSelected);
propTextBgColor.addEventListener('input',  applyPropsToSelected);
propTextBgNone.addEventListener('change',  applyPropsToSelected);
propStrokeColor.addEventListener('input',  applyPropsToSelected);
propFillColor.addEventListener('input',    applyPropsToSelected);
propFillNone.addEventListener('change',    applyPropsToSelected);
propOpacity.addEventListener('input', () => {
  opacityLabel.textContent = propOpacity.value + '%';
  applyPropsToSelected();
});
propStrokeWidth.addEventListener('input', () => {
  strokeWidthLabel.textContent = propStrokeWidth.value;
  if (fabricCanvas?.isDrawingMode) {
    fabricCanvas.freeDrawingBrush.width = +propStrokeWidth.value;
  }
  applyPropsToSelected();
});
propHighlightOpacity.addEventListener('input', () => {
  highlightOpLabel.textContent = propHighlightOpacity.value + '%';
});

[propBold, propItalic, propUnderlineBtn].forEach(btn => {
  btn.addEventListener('click', () => {
    btn.classList.toggle('active');
    applyPropsToSelected();
  });
});

function applyPropsToSelected() {
  const obj = fabricCanvas?.getActiveObject();
  if (!obj) return;
  const isText = obj.type === 'textbox' || obj.type === 'i-text';

  if (isText) {
    obj.set({
      fontFamily:          propFontFamily.value,
      fontSize:            +propFontSize.value,
      fill:                propFontColor.value,
      textBackgroundColor: propTextBgNone.checked ? '' : propTextBgColor.value,
      fontWeight: propBold.classList.contains('active')        ? 'bold'   : 'normal',
      fontStyle:  propItalic.classList.contains('active')      ? 'italic' : 'normal',
      underline:  propUnderlineBtn.classList.contains('active'),
    });
  }

  obj.set({
    stroke:      propStrokeColor.value,
    strokeWidth: +propStrokeWidth.value,
    opacity:     propOpacity.value / 100,
    fill:        propFillNone.checked ? 'transparent' : propFillColor.value,
  });

  fabricCanvas.renderAll();
}

// ──────────────────────────────────────────────────────────────
// PANEL TABS
// ──────────────────────────────────────────────────────────────
$$('.panel-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.panel-tab').forEach(t => t.classList.remove('active'));
    $$('.panel-content').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.panel).classList.add('active');
  });
});

// ──────────────────────────────────────────────────────────────
// TOOLBAR BUTTON EVENTS
// ──────────────────────────────────────────────────────────────
$$('.tool-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

$('btn-undo').addEventListener('click', undo);
$('btn-redo').addEventListener('click', redo);

$('btn-delete').addEventListener('click', deleteSelected);

function deleteSelected() {
  if (!fabricCanvas) return;
  const obj = fabricCanvas.getActiveObject();
  if (!obj) return;
  if (obj.type === 'activeSelection') {
    obj.forEachObject(o => fabricCanvas.remove(o));
    fabricCanvas.discardActiveObject();
  } else {
    fabricCanvas.remove(obj);
  }
  fabricCanvas.renderAll();
}

// ──────────────────────────────────────────────────────────────
// FILE OPEN
// ──────────────────────────────────────────────────────────────
$('btn-open').addEventListener('click', () => fileInput.click());
$('btn-browse').addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (file) loadPdfFile(file);
  fileInput.value = '';
});

// Drag-and-drop on the whole wrapper
const canvasWrapper = document.getElementById('canvas-wrapper');
canvasWrapper.addEventListener('dragover', (e) => {
  e.preventDefault();
  canvasWrapper.classList.add('dragover');
});
canvasWrapper.addEventListener('dragleave', () => canvasWrapper.classList.remove('dragover'));
canvasWrapper.addEventListener('drop', (e) => {
  e.preventDefault();
  canvasWrapper.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadPdfFile(file);
});

// Allow dropping onto the Fabric canvas area as well
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type === 'application/pdf') loadPdfFile(file);
});

// ──────────────────────────────────────────────────────────────
// NAVIGATION CONTROLS
// ──────────────────────────────────────────────────────────────
$('btn-prev-page').addEventListener('click', () => {
  if (State.currentPage > 1) renderPage(State.currentPage - 1);
});
$('btn-next-page').addEventListener('click', () => {
  if (State.currentPage < State.totalPages) renderPage(State.currentPage + 1);
});
pageInput.addEventListener('change', () => {
  const n = Math.min(Math.max(1, +pageInput.value), State.totalPages);
  renderPage(n);
});

// ZOOM
$('btn-zoom-in').addEventListener('click',  () => { State.scale = Math.min(5, State.scale + 0.25); renderPage(State.currentPage); });
$('btn-zoom-out').addEventListener('click', () => { State.scale = Math.max(0.3, State.scale - 0.25); renderPage(State.currentPage); });
$('btn-zoom-fit').addEventListener('click', () => {
  const wrapper = document.getElementById('canvas-wrapper');
  if (!State.pdfDoc) return;
  State.pdfDoc.getPage(State.currentPage).then(page => {
    const vp   = page.getViewport({ scale: 1 });
    const fit  = (wrapper.clientWidth - 48) / vp.width;
    State.scale = Math.max(0.3, Math.min(5, fit));
    renderPage(State.currentPage);
  });
});

// ROTATION
$('btn-rotate-left').addEventListener('click', () => {
  State.rotation = (State.rotation - 90 + 360) % 360;
  renderPage(State.currentPage);
});
$('btn-rotate-right').addEventListener('click', () => {
  State.rotation = (State.rotation + 90) % 360;
  renderPage(State.currentPage);
});

// FULLSCREEN
$('btn-fullscreen').addEventListener('click', () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
});

// ──────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ──────────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName.toLowerCase();
  if (['input','textarea','select'].includes(tag) || document.activeElement.contentEditable === 'true') return;

  const k = e.key.toLowerCase();

  if (e.ctrlKey) {
    switch (k) {
      case 'z': e.preventDefault(); undo(); break;
      case 'y': e.preventDefault(); redo(); break;
      case 'a': e.preventDefault(); fabricCanvas?.selectAll(); fabricCanvas?.renderAll(); break;
      case 'c': {
        const obj = fabricCanvas?.getActiveObject();
        if (obj) obj.clone(c => { State.clipboard = c; });
        break;
      }
      case 'v': {
        if (State.clipboard && fabricCanvas) {
          State.clipboard.clone(c => {
            c.set({ left: c.left + 20, top: c.top + 20 });
            fabricCanvas.add(c);
            fabricCanvas.setActiveObject(c);
            fabricCanvas.renderAll();
            State.clipboard = c;
          });
        }
        break;
      }
    }
    return;
  }

  switch (k) {
    case 'v':      setTool('select');    break;
    case 'h':      setTool('hand');      break;
    case 't':      setTool('text');      break;
    case 'p':      setTool('pen');       break;
    case 'e':      setTool('eraser');    break;
    case 'r':      setTool('rect');      break;
    case 'c':      setTool('circle');    break;
    case 'a':      setTool('arrow');     break;
    case 'l':      setTool('line');      break;
    case 'delete':
    case 'backspace': deleteSelected(); break;
    case 'arrowleft':  if (State.currentPage > 1) renderPage(State.currentPage - 1); break;
    case 'arrowright': if (State.currentPage < State.totalPages) renderPage(State.currentPage + 1); break;
    case '+':
    case '=': State.scale = Math.min(5, State.scale + 0.25); renderPage(State.currentPage); break;
    case '-': State.scale = Math.max(0.3, State.scale - 0.25); renderPage(State.currentPage); break;
    case 'f7': e.preventDefault(); openSpellCheckModal(); break;
  }
});

// ──────────────────────────────────────────────────────────────
// UTILITIES
// ──────────────────────────────────────────────────────────────
function hexToRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${opacity})`;
}

function rgbToHex(color) {
  if (!color) return null;
  if (color.startsWith('#')) return color;
  const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
  if (!m) return null;
  return '#' + [m[1], m[2], m[3]].map(n => (+n).toString(16).padStart(2, '0')).join('');
}

// ──────────────────────────────────────────────────────────────
// INIT
// ──────────────────────────────────────────────────────────────
setTool('select');
statusInfo.textContent = 'جاهز — افتح ملف PDF للبدء';
