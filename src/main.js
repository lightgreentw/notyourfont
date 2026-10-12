// main.js
//
// 應用程式進入點：串接 sfntFontInfo / freetypeRasterizer / canvasRasterizer /
// bitmapMorphology / bdfWriter，並綁定 index.html 裡的所有互動元件。
//
// 章節對應原始 WinForms 專案 Form1.cs 的「第一層～第四層」註解分區，方便比對。

import { SfntFontInfo } from './sfntFontInfo.js';
import { FreeTypeRasterizer } from './freetypeRasterizer.js';
import { CanvasRasterizer } from './canvasRasterizer.js';
import { createDefaultSettings } from './renderSettings.js';
import { postProcess, resizeTopLeft } from './bitmapMorphology.js';
import { writeBdfFont } from './bdfWriter.js';
import { isCjkCodePoint } from './cjkDetect.js';
import { buildProportionalGlyph, isProportional, parseWidthOverrides, toBdfBox } from './proportional.js';
import { validateBdf } from './bdfValidator.js';
import {
  ASCII_FIRST, ASCII_LAST, MODE_LABELS, cellWidthFor, classifyWidth, isAsciiPrintable, isNonExportable,
} from './glyphGeometry.js';
import { isWoff2, decodeIfWoff2 } from './woff2Decode.js';
import { getBuiltinBig5Table, parseCustomEncodingTable, ENCODING_REGISTRY, ENCODING_LABELS } from './encodingSchemes.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// 品牌像素圖示（純裝飾，呼應「這是一個點陣字型工具」）
// ---------------------------------------------------------------------------

/** 畫一格點陣圖示：bgColor 先鋪滿底色（沒有給就維持透明），bitmap 裡值為 1
 * 的格子再疊上 fgColor。維持 1px = 1 canvas pixel，交給 CSS 的
 * image-rendering:pixelated 做最終放大，畫面才會保留硬邊的點陣顆粒感，
 * 不會被瀏覽器用平滑演算法糊掉。 */
function drawPixelGrid(canvas, bitmap, fgColor, bgColor) {
  const ctx = canvas.getContext('2d');
  const n = bitmap.length;
  ctx.clearRect(0, 0, n, n);
  if (bgColor) {
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, n, n);
  }
  ctx.fillStyle = fgColor;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (bitmap[y][x]) ctx.fillRect(x, y, 1, 1);
    }
  }
}

// 品牌圖示：9x9 點陣「字」，整字旋轉 180 度（讓「字」上下顛倒，象徵「轉字型
// 檔」這個動作）。顏色跟著目前主題變色（見 redrawBrandIcons：底色用
// --accent、字用 --accent-contrast，跟按鈕用亮主題色當背景、深色文字疊
// 在上面是同一套邏輯），不像上一版是固定灰階——這樣切換 Amber / Green
// 主題時，這個圖示會跟著變色（上傳區的箭頭圖示 BRAND_UPLOAD_ICON 本來就
// 是這樣，跟這個圖示現在一致）。
const BRAND_ICON_SIZE = 9;
const BRAND_ICON_ANGLE_DEG = 180;

// 未旋轉的原始字形（9x9，0/1 網格），從手繪點陣圖精確萃取而來。
const ZI_GLYPH = [
  [0,0,0,0,1,0,0,0,0],
  [1,1,1,1,1,1,1,1,1],
  [1,0,0,0,0,0,0,0,1],
  [0,0,1,1,1,1,1,0,0],
  [0,0,0,0,0,1,0,0,0],
  [0,0,0,0,1,0,0,0,0],
  [1,1,1,1,1,1,1,1,1],
  [0,0,0,0,1,0,0,0,0],
  [0,0,0,1,1,0,0,0,0],
];

/** 把 9x9 字形旋轉指定角度、輸出仍然是 9x9。做法：先把原始字形放大成
 * supersample 倍的高解析度網格，在那個網格上做反向旋轉取樣（超出邊界視為
 * 背景 0，字形是有限範圍，跟棋盤格那種「無限延伸」的取樣方式不一樣），
 * 最後再把每個 supersample x supersample 區塊用門檻值壓回一個 9x9 像素。
 * 這樣比直接在 9x9 網格上硬轉更能保留筆畫，不會因為旋轉角度不對齊格線
 * 就整筆斷掉（180 度其實剛好對齊格線、理論上單純把陣列上下左右反過來讀
 * 就好，但這裡沒有特別為 180 度寫捷徑，跟其他角度共用同一套邏輯，方便
 * 之後要調角度的話直接改 BRAND_ICON_ANGLE_DEG 就好，不用另外維護兩套）。
 *
 * 旋轉方向：angleDeg 為正＝順時針、為負＝逆時針（已用「單點在 3 點鐘方向，
 * +90 度後落在 6 點鐘」這個測試驗證過，+90 是順時針，所以逆時針要傳負值；
 * 180 度兩個方向結果相同，不受這個正負號規則影響）。 */
function rotateBitmapSupersampled(glyph, angleDeg, supersample) {
  const n = glyph.length;
  const ss = n * supersample;
  const center = (ss - 1) / 2;
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const hi = [];
  for (let y = 0; y < ss; y++) {
    const row = [];
    for (let x = 0; x < ss; x++) {
      row.push(glyph[Math.floor(y / supersample)][Math.floor(x / supersample)]);
    }
    hi.push(row);
  }

  const rotatedHi = [];
  for (let y = 0; y < ss; y++) {
    const row = [];
    for (let x = 0; x < ss; x++) {
      const dx = x - center;
      const dy = y - center;
      const sx = Math.round(dx * cos + dy * sin + center);
      const sy = Math.round(-dx * sin + dy * cos + center);
      row.push((sx >= 0 && sx < ss && sy >= 0 && sy < ss) ? hi[sy][sx] : 0);
    }
    rotatedHi.push(row);
  }

  const out = [];
  const threshold = supersample * supersample * 0.34; // 略低於一半，避免旋轉稀釋後筆畫整段消失
  for (let gy = 0; gy < n; gy++) {
    const row = [];
    for (let gx = 0; gx < n; gx++) {
      let sum = 0;
      for (let yy = 0; yy < supersample; yy++) {
        for (let xx = 0; xx < supersample; xx++) {
          sum += rotatedHi[gy * supersample + yy][gx * supersample + xx];
        }
      }
      row.push(sum >= threshold ? 1 : 0);
    }
    out.push(row);
  }
  return out;
}

const BRAND_ZI = rotateBitmapSupersampled(ZI_GLYPH, BRAND_ICON_ANGLE_DEG, 4);

const BRAND_UPLOAD_ICON = [
  [0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 1, 0, 0],
  [0, 1, 1, 1, 1, 1, 0],
  [0, 0, 0, 1, 0, 0, 0],
  [0, 0, 0, 1, 0, 0, 0],
  [1, 1, 1, 1, 1, 1, 1],
  [0, 0, 0, 0, 0, 0, 0],
];

/** 重畫品牌像素圖示。兩個都跟著目前主題變色：上傳區箭頭是單色 --accent；
 * 左上角旋轉 180 度的「字」圖示是底色 --accent、字用 --accent-contrast，
 * 跟按鈕用亮主題色當背景、深色文字疊在上面是同一套配色邏輯，所以切換
 * Amber／Green 主題時這個圖示會跟著變色，不是固定不變的識別標記。 */
function redrawBrandIcons() {
  const style = getComputedStyle(document.documentElement);
  const accent = style.getPropertyValue('--accent').trim() || '#ffb000';
  const accentContrast = style.getPropertyValue('--accent-contrast').trim() || '#1a1200';
  drawPixelGrid($('brandCanvas'), BRAND_ZI, accentContrast, accent);
  drawPixelGrid($('dropIconCanvas'), BRAND_UPLOAD_ICON, accent);
}

// ---------------------------------------------------------------------------
// 主題切換（Amber / Green）
// ---------------------------------------------------------------------------

const THEME_STORAGE_KEY = 'ttf-to-bdf-theme';

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_STORAGE_KEY, theme);

  const label = $('themeToggleLabel');
  label.textContent = theme === 'hacker' ? 'Amber Theme' : 'Green Theme';

  // 換色之後，canvas 畫出來的品牌圖示跟預覽格背景色是寫死在 JS 裡的，
  // 不會自動跟著 CSS 變數變化，需要手動重畫一次。
  redrawBrandIcons();
  refreshPreview();
}

function initTheme() {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // localStorage 在某些嚴格隱私模式下可能整個不可用，安靜地退回預設主題即可，
    // 不影響其他功能。
  }
  applyTheme(saved === 'hacker' ? 'hacker' : 'amber');

  $('themeToggleButton').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'hacker' ? 'amber' : 'hacker';
    applyTheme(next);
  });
}

// ---------------------------------------------------------------------------
// 應用程式狀態
// ---------------------------------------------------------------------------

const state = {
  fileName: '',
  arrayBuffer: null,
  originalByteLength: 0, // 使用者實際上傳/下載的檔案大小（WOFF2 解碼前），跟 arrayBuffer.byteLength 可能不同
  wasWoff2: false,
  fontInfo: null,
  /** @type {FreeTypeRasterizer | CanvasRasterizer | null} */
  rasterizer: null,
  // 全形／半形各自獨立記錄一整組微調參數（取樣尺寸、輸出尺寸、偏移、門檻值、
  // 粗細、反相、基準線對齊…全部分開），轉檔時各自套用。state.mode 是目前預覽／
  // 編輯的是哪一組，state.settings 永遠指向 state.modeSettings[state.mode]，所以
  // 程式裡所有讀寫 state.settings.xxx 的地方，自動就是在讀寫「目前這一組」。
  // 唯一共用的是取樣引擎（engine）：同一個字型只有一個光柵化器，切換時兩組一起改。
  mode: 'full',
  modeSettings: {
    full: createDefaultSettings('full'),
    half: createDefaultSettings('half'),
  },
  /** @type {ReturnType<typeof createDefaultSettings>} */
  settings: null,
  // 轉檔輸出編碼：scheme 是下拉選單目前的值，customTable 是使用者匯入的
  // 對照表（{ map, count, fileName }，還沒匯入時是 null）。
  encoding: {
    scheme: 'unicode',
    customTable: null,
  },
};

state.settings = state.modeSettings.full;

// 兩種模式各自的預設預覽文字，以及各自「目前暫存的文字」：全形、半形各有一份，
// 在其中一個模式輸入的文字只屬於那個模式，切換時文字框換成另一個模式暫存的內容，
// 切回來時原本輸入的文字還在。
const DEFAULT_PREVIEW_TEXT = {
  full: '微風輕彿，舒體通暢「！…；？）',
  half: 'ABCMW123pqijy@#,{]',
};
state.previewTexts = { ...DEFAULT_PREVIEW_TEXT };

// ---------------------------------------------------------------------------
// 第一層：字型讀取
// ---------------------------------------------------------------------------

async function handleFontFile(file) {
  setFontStatus(`讀取中：${file.name} …`, 'idle');
  disableConvert('讀取字型中…');
  try {
    const rawBuffer = await file.arrayBuffer();
    await loadFontFromBuffer(rawBuffer, file.name);
  } catch (err) {
    handleFontLoadError(err);
  }
}

/**
 * 從網址下載字型檔。只能抓「伺服器有開放跨來源存取（CORS）」的網址——這是
 * 瀏覽器本身的安全限制，網頁沒辦法繞過，不是這個工具的限制。Google Fonts
 * 的靜態字型檔網址、GitHub raw、jsDelivr 這類 CDN 通常都有開放；一般網站
 * 隨便一個網址則不一定。
 */
async function handleFontUrl(url) {
  setFontStatus(`從網址下載中：${escapeHtml(url)} …`, 'idle');
  disableConvert('下載字型中…');
  try {
    let response;
    try {
      response = await fetch(url);
    } catch {
      throw new Error(
        '無法讀取這個網址。最常見的原因是對方伺服器沒有開放跨來源存取（CORS）——' +
        '瀏覽器基於安全限制，網頁只能讀取「明確允許被其他網站讀取」的資源，這不是這個' +
        '工具能繞過的限制；也可能單純是網址打錯或網路連不上。',
      );
    }
    if (!response.ok) {
      throw new Error(`伺服器回應錯誤：HTTP ${response.status} ${response.statusText}`);
    }
    const rawBuffer = await response.arrayBuffer();
    await loadFontFromBuffer(rawBuffer, deriveFileNameFromUrl(url));
  } catch (err) {
    handleFontLoadError(err);
  }
}

function deriveFileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const segments = u.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? decodeURIComponent(last) : url;
  } catch {
    return url;
  }
}

/**
 * 兩條載入路徑（選檔 / 網址）共用的核心邏輯：WOFF2 解碼 → 解析字型資訊 →
 * 建立取樣引擎 → 更新畫面。
 */
async function loadFontFromBuffer(rawBuffer, fileName) {
  const wasWoff2 = isWoff2(rawBuffer);
  let buffer;
  try {
    buffer = await decodeIfWoff2(rawBuffer);
  } catch (err) {
    throw new Error(err.message || 'WOFF2 解碼失敗。');
  }

  let fontInfo;
  try {
    fontInfo = SfntFontInfo.load(buffer);
  } catch (err) {
    throw new Error(`無法解析字型檔頭：${err.message}`);
  }

  disposeRasterizer();
  const rasterizer = await createRasterizer(state.settings.engine, buffer, fileName);

  state.fileName = fileName;
  state.arrayBuffer = buffer;
  state.originalByteLength = rawBuffer.byteLength;
  state.wasWoff2 = wasWoff2;
  state.fontInfo = fontInfo;
  state.rasterizer = rasterizer;

  recalcFontMetrics();
  refreshPreview();
  enableConvert();
  collapseFontSection(); // 讀取成功，收合 01 區塊成一行標題列，字型資訊顯示在標題文字裡
}

function handleFontLoadError(err) {
  console.error(err);
  expandFontSectionLayout(); // 只切版面/標題，不要動狀態文字——下一行要設的錯誤訊息才不會被蓋掉
  setFontStatus(`<p class="status-error">讀取失敗：${escapeHtml(err.message || String(err))}</p>`, 'error');
  disableConvert('字型讀取失敗，請換一個檔案或網址再試。');
}

function fontStatusOkHtml() {
  const info = state.fontInfo;
  const displayName = displayFamilyName();
  const sizeKb = (state.originalByteLength / 1024).toFixed(1);
  const woff2Note = state.wasWoff2 ? '　·　WOFF2（已解碼）' : '';
  return `<p class="status-line"><strong>${escapeHtml(displayName)}</strong>　（${escapeHtml(state.fileName)}，${sizeKb} KB${woff2Note}）</p>` +
    `<p class="status-line">支援碼位：${info.supportedCodePoints.size.toLocaleString()} 個（cmap，BMP 範圍）　·　UnitsPerEm：${info.unitsPerEm}</p>`;
}

let fontSectionExpanded = true; // 尚未讀取字型前一律展開，沒有東西可以收合

/** 標題列文字：沒有字型時顯示「字型」；讀取成功後顯示字型資訊，收合/展開都適用。 */
function updateFontSectionTitle() {
  const titleEl = $('fontSectionTitle');
  const chevron = $('fontSectionChevron');
  if (state.fontInfo) {
    const displayName = displayFamilyName();
    const sizeKb = (state.originalByteLength / 1024).toFixed(1);
    const woff2Note = state.wasWoff2 ? '　·　WOFF2' : '';
    titleEl.innerHTML =
      `<strong>${escapeHtml(displayName)}</strong>` +
      `<span class="font-title-meta">　·　${escapeHtml(state.fileName)}（${sizeKb} KB）` +
      `　·　碼位 ${state.fontInfo.supportedCodePoints.size.toLocaleString()}` +
      `　·　UnitsPerEm ${state.fontInfo.unitsPerEm}${woff2Note}</span>`;
    chevron.hidden = false;
    chevron.textContent = fontSectionExpanded ? '▾' : '▸';
  } else {
    titleEl.textContent = '字型';
    chevron.hidden = true;
  }
}

/** 收合成一行標題列：整個 panel-body（拖放區/網址輸入/狀態文字）都藏起來。 */
function collapseFontSection() {
  fontSectionExpanded = false;
  $('fontPanelBody').hidden = true;
  $('changeFontButton').hidden = false; // header 上的按鈕跟著一起出現，作為另一個展開入口
  $('fontSectionHeader').setAttribute('aria-expanded', 'false');
  updateFontSectionTitle();
}

/** 只處理版面切換（展開＋顯示 panel-body），不動狀態文字——讀取失敗時要用這個，
 *  避免緊接著要顯示的錯誤訊息被這裡覆寫掉。 */
function expandFontSectionLayout() {
  fontSectionExpanded = true;
  $('fontPanelBody').hidden = false;
  $('changeFontButton').hidden = true; // 本體已經看得到選檔區了，header 按鈕先藏起來
  $('fontSectionHeader').setAttribute('aria-expanded', 'true');
  $('fontFileInput').value = ''; // 清空，讓使用者可以重新選同一個檔案也會觸發 change
  updateFontSectionTitle();
}

function expandFontSection() {
  expandFontSectionLayout();
  if (state.fontInfo) {
    setFontStatus(fontStatusOkHtml(), 'ok'); // 還原成正確的狀態文字，蓋掉可能殘留的「切換引擎中…」
  }
}

/** 標題列本身可點擊：收合時點一下展開，展開時點一下收合。還沒讀取字型時
 *  沒有東西可以收合，點了沒反應。 */
function toggleFontSection() {
  if (!state.fontInfo) return;
  if (fontSectionExpanded) collapseFontSection(); else expandFontSection();
}

function displayFamilyName() {
  return (state.rasterizer && state.rasterizer.familyName)
    || (state.fontInfo && state.fontInfo.familyName)
    || state.fileName;
}

async function createRasterizer(engine, arrayBuffer, fileName) {
  if (engine === 'freetype') {
    return FreeTypeRasterizer.create(arrayBuffer);
  }
  return CanvasRasterizer.create(arrayBuffer);
}

function disposeRasterizer() {
  if (state.rasterizer) {
    state.rasterizer.dispose();
    state.rasterizer = null;
  }
}

function setFontStatus(html, kind) {
  $('fontStatus').innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 引擎切換 ----------

async function switchEngine(engine) {
  // 引擎是全形／半形共用的（同一個字型只有一個光柵化器），兩組設定一起改。
  state.modeSettings.full.engine = engine;
  state.modeSettings.half.engine = engine;
  document.body.dataset.engine = engine;
  $('engineBadge').textContent = `引擎：${engine === 'freetype' ? 'FreeType' : 'Canvas'}`;

  if (!state.arrayBuffer) return;

  setFontStatus('<p class="status-line">切換引擎中…</p>', 'idle');
  try {
    disposeRasterizer();
    state.rasterizer = await createRasterizer(engine, state.arrayBuffer, state.fileName);
    updateFontSectionTitle(); // 家族名稱可能因為引擎不同（FreeType / Canvas 取得名稱的方式不同）而改變
    if (fontSectionExpanded) {
      setFontStatus(fontStatusOkHtml(), 'ok');
    }
    refreshPreview();
  } catch (err) {
    console.error(err);
    setFontStatus(`<p class="status-error">切換引擎失敗：${escapeHtml(err.message || String(err))}</p>`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 第四層（度量部分）：依輸出尺寸換算 FONT_ASCENT / FONT_DESCENT
// ---------------------------------------------------------------------------

/** 轉檔區「字碼範圍」目前的勾選狀態。 */
function getExportSelection() {
  return {
    half: $('exportHalfCheckbox').checked,
    full: $('exportFullCheckbox').checked,
    cjk: $('exportCjkCheckbox').checked,
    nonCjk: $('exportNonCjkCheckbox').checked,
  };
}

/** 度量警示／基準線提醒要檢查哪些模式：有勾選要轉出的就只看那些，都沒勾就兩個都看。 */
function modesToCheck() {
  const sel = getExportSelection();
  const modes = [];
  if (sel.full) modes.push('full');
  if (sel.half) modes.push('half');
  return modes.length > 0 ? modes : ['full', 'half'];
}

/**
 * FONT_ASCENT / FONT_DESCENT 只有一組，全形、半形兩個 BDF 共用（基準線一致）。
 * 自動換算一律以「全形」的輸出字高為準：全形是基準線的基準，半形的字高通常跟它一樣。
 *
 * 換算規則：基準線（FONT_ASCENT）取字型的上緣度量按字高縮放，FONT_DESCENT = 字高 − FONT_ASCENT，
 * 所以兩者加起來永遠剛好等於字高（BDF 字格字型的標準形式）。上緣度量優先用 OS/2 的
 * sTypoAscender（設計者指定的字面框上緣，Noto Sans CJK 是 880/1000），沒有才用 hhea 的 ascender
 * ——hhea 常含大量行距（Noto Sans TC 是 1160/-288），拿來換算基準線會整個跑出字格。
 */
function recalcFontMetrics() {
  const info = state.fontInfo;
  if (!info || !info.unitsPerEm) return;

  const size = state.modeSettings.full.outputSize;
  const sourceAscent = info.typoAscent > 0 ? info.typoAscent : info.ascent;
  let ascentPx = Math.round((sourceAscent / info.unitsPerEm) * size);
  ascentPx = Math.min(Math.max(ascentPx, 1), size - 1);
  const descentPx = size - ascentPx;

  $('fontAscentInput').value = String(ascentPx);
  $('fontDescentInput').value = String(descentPx);
  updateMetricWarning();
  updateBaselineConsistencyNote();
}

/**
 * FONT_ASCENT + FONT_DESCENT 應該剛好等於輸出字高（BDF 字格字型的標準形式）：
 *  - 小於字高：點陣會超出檔頭宣告的上下範圍（轉檔時會自動放大 FONT_DESCENT 涵蓋，但行高會變）。
 *  - 大於字高：BDF 仍然有效，只是行高比字高大。
 * 兩個模式共用同一組 ASCENT/DESCENT，所以要對「會轉出的每個模式」各自檢查它的輸出字高。
 * 深色主題下用 --danger（偏淡的珊瑚紅）而不是純紅色，維持可讀性。
 */
function updateMetricWarning() {
  const ascent = parseInt($('fontAscentInput').value, 10);
  const descent = parseInt($('fontDescentInput').value, 10);
  const valid = !Number.isNaN(ascent) && !Number.isNaN(descent);
  const sum = ascent + descent;
  const bad = valid
    ? modesToCheck()
      .map((m) => ({ m, h: state.modeSettings[m].outputSize }))
      .filter(({ h }) => sum !== h)
    : [];
  const warn = bad.length > 0;

  $('metricWarningMark').hidden = !warn;
  $('metricWarningNote').hidden = !warn;
  $('fontAscentInput').classList.toggle('metric-input-warning', warn);
  $('fontDescentInput').classList.toggle('metric-input-warning', warn);

  if (warn) {
    const detail = bad.map(({ m, h }) => `${MODE_LABELS[m]}輸出字高 (${h})`).join('、');
    const short = bad.some(({ h }) => sum < h);
    $('metricWarningNote').textContent =
      `* FONT_ASCENT (${ascent}) + FONT_DESCENT (${descent}) = ${sum}，與${detail}不同。` +
      (short
        ? '小於字高時點陣會超出宣告的上下範圍，轉檔時會自動放大 FONT_DESCENT 以涵蓋墨跡。'
        : '大於字高時，基準線（第 FONT_ASCENT 列）會偏下、甚至落到字格之外，字很容易被裁切（BDF 檔本身仍然有效）。');
  }
}

/**
 * FONTBOUNDINGBOX／每個字元的 BBX 在 bdfWriter.js 裡固定等於「輸出字格大小，
 * yoff = -FONT_DESCENT」——這對「固定網格」點陣字型（這個工具的設計）來說
 * 永遠是自洽的（因為每個字的 BBX 本來就都跟 FONTBOUNDINGBOX 相等），不需要
 * 從實際墨色反推。
 *
 * 但這只保證了「格子大小」的宣告正確，沒有保證「FONT_ASCENT 宣告的基準線列，
 * 跟實際渲染出來的基準線列一致」——沒有勾選「字元對齊基準線」時，每個字元是
 * 用取樣引擎自己的字型內建 ascender 定位，跟這裡填的 FONT_ASCENT（自動換算
 * 或手動輸入）不一定是同一個數字，兩者可能有些微落差。勾選「字元對齊基準線」
 * 後，每個字元都會強制貼齊 row=FONT_ASCENT，這時候兩者才保證完全一致。
 * 全形、半形各有一個「字元對齊基準線」開關，這裡只在「會轉出、但沒勾選」的
 * 模式上顯示提醒。
 */
function updateBaselineConsistencyNote() {
  const note = $('baselineConsistencyNote');
  const lacking = modesToCheck().filter((m) => !state.modeSettings[m].alignAllToBaseline);
  const show = lacking.length > 0 && !!state.fontInfo;
  note.hidden = !show;
  if (show) {
    const names = lacking.map((m) => MODE_LABELS[m]).join('、');
    note.textContent =
      `「${names}」尚未勾選「字元對齊基準線」（見③微調點陣字）：FONT_ASCENT 是這裡宣告的數字，` +
      '但每個字元實際的基準線位置是由取樣引擎的字型內建 ascender 決定，兩者不保證完全一致。' +
      '若需要 BDF 檔頭的度量數字精確對應每個字元的實際基準線，請開啟該選項。';
  }
}

// ---------------------------------------------------------------------------
// 第二層：點陣預覽
// ---------------------------------------------------------------------------

const PREVIEW_CELL_PX = 12; // 每個取樣像素在預覽格內畫成幾個實際畫布像素（直接畫在正確解析度，紅格線才會是清晰的 1px）
const ZONE_PAD_COLOR = '#dcead6';   // 淺灰綠：超出取樣格、但在輸出尺寸內的區域（也會渲染，有墨跡照常顯示）
const ZONE_CROP_COLOR = '#d7e2ec';  // 淺灰藍：裁切區（取樣尺寸有資料，但超出輸出尺寸，最終會被丟棄）
const OUTPUT_BOUNDARY_COLOR = '#ffb000'; // 輸出尺寸的實際邊界（琥珀色，跟主題色一致）

const BBOX_COLOR = 'rgba(80, 170, 255, 0.95)';       // 不等寬：貼緊墨跡的 BBX 外框（藍色細虛線）
const REF_WIDTH_COLOR = 'rgba(190, 130, 255, 0.95)'; // 不等寬：標準半形寬（⌈字高÷2⌉）參考線（紫色虛線）
const BASELINE_COLOR = '#22c55e'; // 綠色基準線（BDF 語意：row = FONT_ASCENT，ASCENT/DESCENT 兩區的交界）

/**
 * 白底、黑色墨色像素、紅色像素格線——直接在目標解析度繪製，不靠 CSS 縮放。
 *
 * 格子是「寬 x 高」（全形寬 = 高；半形寬 = ceil(高 / 2)），預覽格大小以取樣字高
 * 為準：每個取樣像素畫成 cellPx 個畫布像素，所以半形預覽格就是全形的一半寬。
 *
 * 當取樣尺寸跟輸出尺寸不一致時，會畫成 max(取樣, 輸出) 大小的格子（寬、高各自取
 * 最大值），讓使用者同時看到「取樣出來的樣子」跟「最終輸出的範圍」：
 *  - 取樣 < 輸出：右下多出來的區域塗淺灰綠色，表示「超出取樣格、但在輸出範圍內」。
 *    這一區也會被渲染（例如下降部多出來的那一列），有墨跡就照常畫出來，不會被取樣格邊界截掉。
 *  - 取樣 > 輸出：右下超出輸出範圍的裁切區塗淺灰藍色（這塊有取樣到的墨色資料，
 *    但轉檔時會被裁掉，不會出現在最終的 BDF 裡），並在輸出邊界畫一條琥珀色線。
 *
 * @param {{width:number, height:number, data:Uint8Array}} bitmap 取樣結果
 * @param {number} outputWidth  輸出格寬（由輸出字高推導）
 * @param {number} outputHeight 輸出字高
 * @param {{bbox?:{x:number,y:number,width:number,height:number}|null, refWidth?:number}} [extras]
 *   不等寬預覽用：bbox = 貼緊墨跡的 BBX（畫藍色虛線框）；refWidth = 標準半形寬，
 *   小於這個字的字寬時，在那一欄畫紫色虛線，讓人一眼看出哪些字比標準半形寬。
 * @param {number} fontAscent 目前的 FONT_ASCENT 值（NaN 表示不畫基準線）。
 *   對應 BDF 語意：row 0..FONT_ASCENT-1 是 ascent 區，row FONT_ASCENT 開始是
 *   descent 區，兩者交界（也就是基準線）畫一條綠色粗虛線，跟「字元對齊」
 *   功能覆寫的基準線用同一個數字，方便對照。全形、半形用同一個 FONT_ASCENT，
 *   所以兩種預覽格上的基準線在同一列。
 */
function drawGlyphCell(canvas, bitmap, cellPx, outputWidth, outputHeight, fontAscent, extras = {}) {
  // bitmap.width/height = 點陣（畫布）大小，一定 >= 輸出大小或 = 取樣格大小；
  // bitmap.sampleWidth/sampleHeight = 取樣格大小（沒給就當作等於點陣大小）。
  const { width: bw, height: bh, data } = bitmap;
  const cellW = bitmap.sampleWidth ?? bw;
  const cellH = bitmap.sampleHeight ?? bh;
  const gridW = Math.max(bw, outputWidth);
  const gridH = Math.max(bh, outputHeight);
  const pxW = gridW * cellPx;
  const pxH = gridH * cellPx;
  canvas.width = pxW;
  canvas.height = pxH;
  const ctx = canvas.getContext('2d');

  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const inCellSize = x < cellW && y < cellH;
      const inOutputSize = x < outputWidth && y < outputHeight;

      let bg;
      if (inOutputSize && inCellSize) bg = '#ffffff';
      else if (inOutputSize && !inCellSize) bg = ZONE_PAD_COLOR;
      else bg = ZONE_CROP_COLOR; // gridW/H = max(...) 保證兩者不會同時是 false

      ctx.fillStyle = bg;
      ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);

      // 墨跡可能落在「取樣格外、輸出範圍內」（輸出比取樣大時，例如取樣 23、輸出 24 的第 24 列），
      // 這一區同樣有渲染結果，所以只要在點陣範圍內就畫，不限於取樣格。
      if (x < bw && y < bh && data[y * bw + x]) {
        ctx.fillStyle = '#000000';
        ctx.fillRect(x * cellPx, y * cellPx, cellPx, cellPx);
      }
    }
  }

  ctx.strokeStyle = 'rgba(255, 59, 59, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= gridW; i++) {
    const pos = i * cellPx + 0.5; // +0.5 讓 1px 線落在像素格線上，畫出來才會清晰不模糊
    ctx.moveTo(pos, 0);
    ctx.lineTo(pos, pxH);
  }
  for (let j = 0; j <= gridH; j++) {
    const pos = j * cellPx + 0.5;
    ctx.moveTo(0, pos);
    ctx.lineTo(pxW, pos);
  }
  ctx.stroke();

  // 只有「取樣 > 輸出」（裁切）時才需要額外畫邊界線：補白的情況下輸出範圍
  // 本來就跟畫布邊緣重合，不需要再畫一條線標示。寬、高各自判斷。
  ctx.strokeStyle = OUTPUT_BOUNDARY_COLOR;
  ctx.lineWidth = 2;
  if (gridW > outputWidth) {
    const boundaryX = outputWidth * cellPx;
    ctx.beginPath();
    ctx.moveTo(boundaryX, 0);
    ctx.lineTo(boundaryX, pxH);
    ctx.stroke();
  }
  if (gridH > outputHeight) {
    const boundaryY = outputHeight * cellPx;
    ctx.beginPath();
    ctx.moveTo(0, boundaryY);
    ctx.lineTo(pxW, boundaryY);
    ctx.stroke();
  }

  // 不等寬：BBX 外框與標準半形寬參考線（等寬模式不傳 extras，完全不畫）。
  if (extras.bbox || extras.refWidth) {
    ctx.save();
    ctx.lineWidth = 2;
    ctx.setLineDash([cellPx * 0.35, cellPx * 0.25]);
    if (extras.refWidth && extras.refWidth < gridW) {
      ctx.strokeStyle = REF_WIDTH_COLOR;
      const rx = extras.refWidth * cellPx;
      ctx.beginPath();
      ctx.moveTo(rx, 0);
      ctx.lineTo(rx, pxH);
      ctx.stroke();
    }
    if (extras.bbox) {
      ctx.strokeStyle = BBOX_COLOR;
      ctx.strokeRect(
        extras.bbox.x * cellPx + 1,
        extras.bbox.y * cellPx + 1,
        extras.bbox.width * cellPx - 2,
        extras.bbox.height * cellPx - 2,
      );
    }
    ctx.restore();
  }

  // 綠色粗虛線基準線：row = FONT_ASCENT，畫在該列的上緣（跟 ASCENT/DESCENT
  // 兩區交界對齊）。只要有合法的 FONT_ASCENT 數字就畫，跟「字元對齊」有沒有
  // 打勾無關——這是給使用者對照用的參考線，勾選對齊功能只是讓字元本身也真的
  // 貼上這條線而已。FONT_ASCENT 超出目前格子範圍時（度量警示會亮紅字的那種
  // 情況）改成夾在邊緣畫，至少讓使用者看得出「基準線已經超出範圍」，而不是
  // 什麼都不畫、看起來像這個功能沒作用。
  if (!Number.isNaN(fontAscent) && fontAscent >= 0) {
    const clampedAscent = Math.min(fontAscent, gridH);
    const baselinePos = clampedAscent * cellPx;
    ctx.save();
    ctx.strokeStyle = BASELINE_COLOR;
    ctx.lineWidth = 2.5;
    ctx.setLineDash([cellPx * 0.7, cellPx * 0.45]);
    ctx.beginPath();
    ctx.moveTo(0, Math.min(baselinePos, pxH - 1.5));
    ctx.lineTo(pxW, Math.min(baselinePos, pxH - 1.5));
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * 「字元對齊」：勾選後，所有字元（不分 CJK 或非 CJK）一律改用 FONT_ASCENT
 * 當基準線列（row = FONT_ASCENT，跟預覽格上畫的綠色基準線是同一個數字），
 * 取代字型本身的全域 ascender。
 *
 * 注意：公式是直接用 FONT_ASCENT，不是用「輸出尺寸 - FONT_DESCENT」反推——
 * 這兩者只有在 FONT_ASCENT + FONT_DESCENT 剛好等於輸出尺寸時才相等；一旦
 * 兩者加起來超過輸出尺寸（也就是①字型度量那邊會出現紅字警示的情況），
 * 用「輸出尺寸 - FONT_DESCENT」反推會算出比字型實際需要的基準線更低的值，
 * 導致字被截斷、往上浮動，反而更糟（實測過，見對話紀錄）。直接用
 * FONT_ASCENT，數值正常時效果跟預設幾乎相同，數值不正常時至少不會比
 * 預設更糟，而且跟綠色基準線視覺化的數字完全一致，行為好預測。
 *
 * 統一套用到所有字元（不分 CJK）而不是只套用在非 CJK 身上，是因為：用同一條
 * 基準線之後，中文英文會一起跟著「位置偏移」移動，不會發生調整位置偏移救了
 * 英文卻推壞中文的情況。
 *
 * @returns {number} -1 表示不覆寫（沿用引擎預設的置中/字型 ascender 定位）
 */
function computeAscenderOverride(settings, fontAscent) {
  if (!settings.alignAllToBaseline) return -1;
  if (Number.isNaN(fontAscent)) return -1;
  return fontAscent;
}

function currentFontAscentValue() {
  return parseInt($('fontAscentInput').value, 10);
}

/**
 * 「CJK／非CJK 分開偏移」：lockOffsets=true（鎖定，預設）時，不管 CJK 還是
 * 非 CJK 字元一律用 offsetX/offsetY（等同單一偏移的舊行為）。取消鎖定後，
 * CJK 字元仍然用 offsetX/offsetY，非 CJK 字元改用 nonCjkOffsetX/nonCjkOffsetY，
 * 兩組各自獨立微調——用於同一條基準線下，CJK 部件跟拉丁字母下降部（g/j/y 等）
 * 伸出去的量不一樣多，單一組偏移調不出兩者都好的結果時。
 *
 * 回傳的是一個「有效設定」物件，複製自傳入的 settings 但可能覆寫 offsetX/Y，
 * 交給光柵化引擎使用；bitmapMorphology 的 boldAdjust/invert 等其他欄位不受影響。
 */
function effectiveSettingsForChar(codePoint, settings) {
  if (settings.lockOffsets || isCjkCodePoint(codePoint)) {
    return settings;
  }
  return { ...settings, offsetX: settings.nonCjkOffsetX, offsetY: settings.nonCjkOffsetY };
}

/**
 * 用指定模式（settings.mode）的設定對單一碼位取樣，回傳「後製之前」的原始點陣
 * （帶 clipped 旗標）跟實際生效的設定（可能因為 CJK／非CJK 分開偏移而不同）。
 */
function rasterizeGlyph(codePoint, settings, fontAscent = currentFontAscentValue()) {
  const eff = effectiveSettingsForChar(codePoint, settings);
  const ascenderOverride = computeAscenderOverride(eff, fontAscent);
  let bitmap;
  if (settings.engine === 'freetype') {
    bitmap = state.rasterizer.rasterizeCodePoint(codePoint, eff, ascenderOverride);
  } else {
    bitmap = state.rasterizer.rasterizeChar(String.fromCodePoint(codePoint), eff, ascenderOverride);
  }
  return { bitmap, eff };
}

function rasterizeAndPostProcess(codePoint, settings = state.settings) {
  const { bitmap, eff } = rasterizeGlyph(codePoint, settings);
  return postProcess(bitmap, eff);
}

/**
 * 半形不等寬：對單一碼位取樣，回傳 proportional.js 的 buildProportionalGlyph 結果
 * （advance、裁好的字寬框點陣、貼緊墨跡的 bbox、裁切旗標）。
 * 暫存格：字的原點放在第 penX = 字高 欄（左邊留一個字高的空間，容納負的左側間距），
 * 總寬 3 x 字高，足以容納一般字型的任何字寬／懸伸。
 * @param {Map<number,number>} [overrides] 例外覆寫；沒給就從設定現場解析（預覽與轉檔
 *   每個字元都解析一次太浪費，呼叫端迴圈外先解析好傳進來）。
 */
function rasterizeProportionalGlyph(codePoint, settings, fontAscent = currentFontAscentValue(), overrides) {
  const eff = effectiveSettingsForChar(codePoint, settings);
  const ascenderOverride = computeAscenderOverride(eff, fontAscent);
  const height = Math.min(32, Math.max(7, Math.round(eff.cellSize)));
  const penX = height;
  const scratchWidth = height * 3;
  const raw = eff.engine === 'freetype'
    ? state.rasterizer.rasterizeProportional(codePoint, eff, ascenderOverride, penX, scratchWidth)
    : state.rasterizer.rasterizeProportional(String.fromCodePoint(codePoint), eff, ascenderOverride, penX, scratchWidth);
  const map = overrides || parseWidthOverrides(eff.propOverrides).map;
  return buildProportionalGlyph(raw, eff, codePoint, penX, eff.outputSize, map);
}

/** 字元清單縮成「「微」「風」…」的短字串，太長就截斷。 */
function formatCharList(chars, max = 12) {
  const shown = chars.slice(0, max).map((c) => `「${c}」`).join('');
  return chars.length > max ? `${shown}…（共 ${chars.length} 個）` : shown;
}

/**
 * 文字框裡有跟目前模式不符的字時顯示提示，並附一個一鍵切換的按鈕：
 *  - 全形模式下出現 ASCII 半形字元 → 提示改用半形預覽。
 *  - 半形模式下出現非 ASCII 字元（CJK、全形英數…）→ 提示改用全形預覽。
 * 判斷標準跟轉檔時的分流是同一個 classifyWidth()，預覽看到的歸類就是轉出時的歸類。
 */
function updateModeMismatchHint(chars) {
  const mode = state.mode;
  const bad = [];
  for (const ch of chars) {
    if (/^\s$/.test(ch)) continue;
    if (classifyWidth(ch.codePointAt(0)) !== mode && !bad.includes(ch)) bad.push(ch);
  }

  const hint = $('previewModeHint');
  hint.hidden = bad.length === 0;
  if (bad.length === 0) return;

  const other = mode === 'full' ? 'half' : 'full';
  $('previewModeHintText').textContent = mode === 'full'
    ? `文字框含半形（ASCII）字元：${formatCharList(bad)}。這些字屬於「半形」，會輸出到 _ascii 檔，請切換為半形預覽。`
    : `文字框含全形／非 ASCII 字元：${formatCharList(bad)}。半形只輸出 ASCII，這些字屬於「全形」，請切換為全形預覽。`;
  $('previewModeHintButton').textContent = `切換為${MODE_LABELS[other]}`;
}

function updateClipHint(clippedH, clippedV) {
  const hint = $('previewClipHint');
  const show = state.mode === 'half' && (clippedH.length > 0 || clippedV.length > 0);
  hint.hidden = !show;
  if (!show) return;

  const prop = isProportional(state.settings);
  const parts = [];
  if (clippedH.length > 0) {
    parts.push(prop
      ? `${formatCharList(clippedH)}的墨跡超出字寬框、左右被裁切`
      : `${formatCharList(clippedH)}寬度超出半形字格（寬 ${cellWidthFor('half', state.settings.cellSize)}），左右被裁切`);
  }
  if (clippedV.length > 0) {
    parts.push(`${formatCharList(clippedV)}上下超出字格被裁切`);
  }

  let advice;
  if (clippedH.length > 0) {
    advice = prop
      ? (state.settings.propOverflow === 'crop'
        ? '目前設定為「裁切」：可改成「自動加寬」，或用「字距調整」放寬字寬、「位置偏移 X」把墨跡移回字寬框內。'
        : '這些字已經加寬到「最大字寬」上限，或是「空白字寬／例外覆寫」精確指定的字寬（不會被加寬）；可調高最大字寬或修改覆寫。')
      : '半形字格寬 = 字高 ÷ 2，縮小取樣尺寸時字格也會跟著縮小，所以調尺寸解決不了超寬；' +
        '這通常表示字型的 ASCII 是比例字形（M、W 等字天生比半形格寬），可改選「字寬：不等寬」，' +
        '或用「位置偏移」決定哪一側被切、「粗細調整」變細，或改用等寬的 ASCII 字型。';
  } else {
    advice = '可調整「位置偏移」，或檢查 FONT_ASCENT／「字元對齊基準線」。';
  }
  $('previewClipHintText').textContent = `⚠ ${parts.join('；')}。${advice}`;
}

function updatePreviewDimNote() {
  const s = state.settings;
  if (isProportional(s)) {
    $('previewDimNote').textContent =
      `半形（不等寬）預覽：字高 ${s.cellSize} → 輸出字高 ${s.outputSize}，字寬逐字決定。` +
      `藍色虛線框 = 貼緊墨跡的 BBX；紫色虛線 = 標準半形寬 ${cellWidthFor('half', s.outputSize)}（只在字比它寬時出現）。`;
    return;
  }
  const cw = cellWidthFor(state.mode, s.cellSize);
  const ow = cellWidthFor(state.mode, s.outputSize);
  $('previewDimNote').textContent =
    `${MODE_LABELS[state.mode]}預覽格（寬×高）：取樣 ${cw}×${s.cellSize}　→　輸出 ${ow}×${s.outputSize}`;
}

function refreshPreview() {
  const grid = $('previewGrid');
  grid.innerHTML = '';

  const text = $('previewText').value;
  const chars = Array.from(text);

  updatePreviewDimNote();
  updateModeMismatchHint(chars); // 純文字判斷，字型還沒載入也能提示

  const clippedH = [];
  const clippedV = [];

  if (!state.rasterizer || chars.length === 0) {
    updateClipHint(clippedH, clippedV);
    return;
  }

  const info = state.fontInfo;
  const settings = state.settings;
  const mode = state.mode;
  const outputHeight = settings.outputSize;
  const outputWidth = cellWidthFor(mode, outputHeight);
  const prop = isProportional(settings);
  const overrides = prop ? parseWidthOverrides(settings.propOverrides).map : null;

  for (const ch of chars) {
    if (/^\s$/.test(ch)) continue; // 純空白字元跳過，避免預覽塞一堆空格子

    const codePoint = ch.codePointAt(0);
    const supported = settings.engine === 'canvas' || !info || info.supportedCodePoints.size === 0
      ? true
      : info.supportedCodePoints.has(codePoint);
    const mismatch = classifyWidth(codePoint) !== mode;

    let bitmap;
    let propGlyph = null;
    try {
      if (prop) {
        propGlyph = rasterizeProportionalGlyph(codePoint, settings, currentFontAscentValue(), overrides);
        bitmap = { width: propGlyph.width, height: propGlyph.height, data: propGlyph.data,
                   sampleWidth: propGlyph.width, sampleHeight: settings.cellSize,
                   clipped: (propGlyph.clippedH ? 1 : 0) | (propGlyph.clippedV ? 2 : 0) };
      } else {
        bitmap = rasterizeAndPostProcess(codePoint);
      }
    } catch (err) {
      console.error('預覽渲染失敗：', ch, err);
      continue;
    }

    // 超寬／超高只對「真的屬於這個模式」的字統計；模式不符的字已經有專屬提示了，
    // 把 CJK 字塞進半形格本來就一定會超寬，不需要再重複報一次。
    const clipped = supported && !mismatch ? bitmap.clipped : 0;
    if (clipped & 1) clippedH.push(ch);
    if (clipped & 2) clippedV.push(ch);

    const cell = document.createElement('div');
    cell.className = 'glyph-cell'
      + (supported ? '' : ' glyph-missing')
      + (mismatch ? ' glyph-mismatch' : '')
      + (clipped ? ' glyph-clipped' : '');

    const canvas = document.createElement('canvas');
    if (prop) {
      // 不等寬：每個字的格寬 = 它自己的字寬（沒有「取樣／輸出」的寬度差，所以輸出寬 = 字寬）。
      drawGlyphCell(canvas, bitmap, PREVIEW_CELL_PX, bitmap.width, bitmap.height, currentFontAscentValue(), {
        bbox: propGlyph.bbox,
        refWidth: outputWidth,
      });
    } else {
      drawGlyphCell(canvas, bitmap, PREVIEW_CELL_PX, outputWidth, outputHeight, currentFontAscentValue());
    }

    const label = document.createElement('span');
    label.className = 'glyph-label';
    let labelText = `${ch}  U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
    if (!supported) labelText += ' 缺字';
    if (mismatch) labelText += `（應切${MODE_LABELS[mode === 'full' ? 'half' : 'full']}）`;
    if (prop) labelText += ` 字寬${bitmap.width}` + (propGlyph.widenedBy > 0 ? `（加寬+${propGlyph.widenedBy}）` : '');
    if (clipped & 1) labelText += prop ? ' 被裁切' : ' 超寬';
    if (clipped & 2) labelText += ' 超高';
    label.textContent = labelText;

    cell.appendChild(canvas);
    cell.appendChild(label);
    grid.appendChild(cell);
  }

  updateClipHint(clippedH, clippedV);
}

// 註：舊版用橫向拖曳捲動來看預覽格，新版改成 preview-grid 自動換行
// （見 style.css 的 .preview-grid { flex-wrap: wrap }），兩欄式版面本身已經
// 讓預覽跟微調同時可見，不需要再靠拖曳捲動了。

// ---------------------------------------------------------------------------
// 第三層：微調點陣字 —— 控制項綁定
// ---------------------------------------------------------------------------

function bindNumber(id, key, { min, max, isFloat = false, onAfter } = {}) {
  const input = $(id);
  input.addEventListener('input', () => {
    let v = isFloat ? parseFloat(input.value) : parseInt(input.value, 10);
    if (Number.isNaN(v)) return;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    state.settings[key] = v;
    if (onAfter) onAfter(v);
    refreshPreview();
  });
}

function bindCheckbox(id, key) {
  $(id).addEventListener('change', (e) => {
    state.settings[key] = e.target.checked;
    refreshPreview();
  });
}

function bindSelect(id, key) {
  $(id).addEventListener('change', (e) => {
    state.settings[key] = e.target.value;
    refreshPreview();
  });
}

/**
 * 綁定一組偏移面板（上下左右＋重置四個按鈕）。idSuffix 是 'Cjk' 或 'NonCjk'，
 * 對應 index.html 裡 offsetUpCjk/offsetUpNonCjk 之類的 id 命名規則。
 * 只有 'Cjk' 這組在鎖定狀態下會額外把值同步鏡射到 nonCjkOffsetX/Y——
 * 'NonCjk' 那組的按鈕平常就藏在鎖定畫面後面，不會被點到，不需要處理鏡射。
 */
function bindOffsetPad(idSuffix, xKey, yKey) {
  const mirrorIfLocked = () => {
    if (idSuffix === 'Cjk' && state.settings.lockOffsets) {
      state.settings.nonCjkOffsetX = state.settings.offsetX;
      state.settings.nonCjkOffsetY = state.settings.offsetY;
    }
  };
  const step = (dx, dy) => {
    state.settings[xKey] += dx;
    state.settings[yKey] += dy;
    mirrorIfLocked();
    updateOffsetLabels();
    refreshPreview();
  };
  $(`offsetUp${idSuffix}`).addEventListener('click', () => step(0, -1));
  $(`offsetDown${idSuffix}`).addEventListener('click', () => step(0, 1));
  $(`offsetLeft${idSuffix}`).addEventListener('click', () => step(-1, 0));
  $(`offsetRight${idSuffix}`).addEventListener('click', () => step(1, 0));
  $(`offsetReset${idSuffix}`).addEventListener('click', () => {
    state.settings[xKey] = 0;
    state.settings[yKey] = 0;
    mirrorIfLocked();
    updateOffsetLabels();
    refreshPreview();
  });
}

function updateOffsetLabels() {
  $('offsetValueCjk').textContent = `X=${state.settings.offsetX}, Y=${state.settings.offsetY}`;
  $('offsetValueNonCjk').textContent = `X=${state.settings.nonCjkOffsetX}, Y=${state.settings.nonCjkOffsetY}`;
}

/** 鎖定時只顯示一組（標題改成中性的「位置偏移」）；取消鎖定顯示兩組，各自標明 CJK／非 CJK。
 *  半形（ASCII）沒有 CJK／非 CJK 之分，永遠只有一組，等同鎖定。 */
function updateOffsetGroupsVisibility() {
  const locked = state.mode === 'half' || state.settings.lockOffsets;
  $('offsetGroupNonCjk').hidden = locked;
  $('offsetGroupCjkCaption').hidden = locked; // 只有兩欄並排時才需要「CJK」這個小字來區分
}

function bindControls() {
  // 引擎選擇
  $('engineFreetype').addEventListener('change', () => { if ($('engineFreetype').checked) switchEngine('freetype'); });
  $('engineCanvas').addEventListener('change', () => { if ($('engineCanvas').checked) switchEngine('canvas'); });

  // 預覽文字
  $('previewText').addEventListener('input', () => {
    state.previewTexts[state.mode] = $('previewText').value; // 只存在目前這個模式的暫存裡
    refreshPreview();
  });

  // 全形／半形切換：radio、提示列上的一鍵切換按鈕都走同一個 setMode()
  $('previewModeFull').addEventListener('change', () => { if ($('previewModeFull').checked) setMode('full'); });
  $('previewModeHalf').addEventListener('change', () => { if ($('previewModeHalf').checked) setMode('half'); });
  $('previewModeHintButton').addEventListener('click', () => setMode(state.mode === 'full' ? 'half' : 'full'));

  // 尺寸
  // 取樣尺寸、輸出尺寸都是「字高」；格寬由字高推導（全形 = 字高，半形 = ceil(字高 / 2)）。
  // 輸出字高改變時：全形要重新換算 FONT_ASCENT/DESCENT（全形是基準線的基準）；
  // 半形只重新檢查警示，不動基準線數字。
  bindNumber('cellSizeInput', 'cellSize', { min: 7, max: 32, onAfter: updateModeLabels });
  bindNumber('outputSizeInput', 'outputSize', {
    min: 7,
    max: 32,
    onAfter: () => {
      updateModeLabels();
      if (state.mode === 'full') recalcFontMetrics(); else updateMetricWarning();
    },
  });

  // 位置偏移：CJK／非CJK 兩組面板（鎖定時非CJK那組隱藏、且會跟著CJK連動）
  bindOffsetPad('Cjk', 'offsetX', 'offsetY');
  bindOffsetPad('NonCjk', 'nonCjkOffsetX', 'nonCjkOffsetY');
  $('lockOffsetsCheckbox').addEventListener('change', (e) => {
    state.settings.lockOffsets = e.target.checked;
    if (state.settings.lockOffsets) {
      // 重新鎖定：非CJK那組直接拉回跟CJK一致，避免殘留一組使用者已經看不到、
      // 但轉檔時其實還在生效的舊偏移值。
      state.settings.nonCjkOffsetX = state.settings.offsetX;
      state.settings.nonCjkOffsetY = state.settings.offsetY;
    }
    updateOffsetGroupsVisibility();
    updateOffsetLabels();
    refreshPreview();
  });

  // 門檻值
  $('thresholdSlider').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    state.settings.threshold = v;
    $('thresholdValue').textContent = String(v);
    refreshPreview();
  });

  // Canvas 專屬
  bindNumber('gammaInput', 'gamma', { min: 0.1, max: 5, isFloat: true });
  bindCheckbox('antiAliasCheckbox', 'antiAlias');
  bindSelect('supersampleSelect', 'supersampleFactor');
  $('supersampleSelect').addEventListener('change', (e) => { state.settings.supersampleFactor = parseInt(e.target.value, 10); refreshPreview(); });
  bindNumber('contrastInput', 'contrast', { min: -100, max: 100 });

  // FreeType 專屬
  bindSelect('hintingSelect', 'freeTypeHinting');
  bindCheckbox('preferEmbeddedBitmapCheckbox', 'freeTypePreferEmbeddedBitmap');
  bindSelect('freetypeTargetSelect', 'freeTypeTarget');

  // 半形字寬：等寬／不等寬，以及不等寬的規則參數（只有半形那一組設定會用到）
  $('widthModeFixed').addEventListener('change', () => { if ($('widthModeFixed').checked) setWidthMode('fixed'); });
  $('widthModeProp').addEventListener('change', () => { if ($('widthModeProp').checked) setWidthMode('proportional'); });
  $('propSourceSelect').addEventListener('change', (e) => {
    state.settings.propWidthSource = e.target.value;
    syncPropControls();
    refreshPreview();
  });
  bindSelect('propRoundingSelect', 'propRounding');
  bindSelect('propOverflowSelect', 'propOverflow');
  bindNumber('propLetterSpacingInput', 'propLetterSpacing', { min: -8, max: 16 });
  bindNumber('propInkGapInput', 'propInkGap', { min: 0, max: 16 });
  bindNumber('propMinWidthInput', 'propMinWidth', { min: 1, max: 32 });
  bindNumber('propMaxWidthInput', 'propMaxWidth', { min: 0, max: 64 });
  bindNumber('propSpaceWidthInput', 'propSpaceWidth', { min: 0, max: 64 });
  $('propOverridesInput').addEventListener('input', (e) => {
    state.settings.propOverrides = e.target.value;
    updateOverridesNote();
    refreshPreview();
  });

  // 共通後製
  bindNumber('boldAdjustInput', 'boldAdjust', { min: -5, max: 5 });
  bindCheckbox('invertCheckbox', 'invert');

  // 字元對齊：所有字元統一改用 FONT_ASCENT 當基準線
  $('alignAllCheckbox').addEventListener('change', (e) => {
    state.settings.alignAllToBaseline = e.target.checked;
    updateBaselineConsistencyNote();
    refreshPreview();
  });

  // 重置參數（點陣尺寸／輸出尺寸／引擎選擇不受影響，對應原版 ResetRenderParameters）
  $('resetParamsButton').addEventListener('click', resetRenderParams);

  // FONT_ASCENT / FONT_DESCENT：手動編輯時即時更新警示標示。FONT_ASCENT 還會
  // 決定綠色基準線的位置、以及「字元對齊」勾選時的實際基準線，所以要刷新預覽；
  // FONT_DESCENT 目前只影響警示訊息文字，不影響任何繪製，不需要刷新預覽。
  $('fontAscentInput').addEventListener('input', () => { updateMetricWarning(); refreshPreview(); });
  $('fontDescentInput').addEventListener('input', updateMetricWarning);

  // 字碼範圍：半形／全形／CJK／非CJK 勾選會影響「可不可以轉換」、度量警示要檢查哪些
  // 模式、基準線提醒要列出哪些模式，所以變動時要即時更新。
  ['exportHalfCheckbox', 'exportFullCheckbox', 'exportCjkCheckbox', 'exportNonCjkCheckbox'].forEach((id) => {
    $(id).addEventListener('change', () => {
      updateExportUi();
      updateConvertAvailability();
      updateMetricWarning();
      updateBaselineConsistencyNote();
    });
  });
  // 起始／結束碼位欄位變動不需要即時處理，轉換時才讀取

  // 字型編碼：切換到「其他／匯入對照表」才顯示檔案匯入區塊；匯入檔案後
  // 立刻解析、更新狀態文字，轉換時才會真的用到解析結果。
  $('fontEncodingSelect').addEventListener('change', updateEncodingImportUi);
  $('encodingTableInput').addEventListener('change', (e) => {
    if (e.target.files[0]) handleEncodingTableFile(e.target.files[0]);
  });

  // 拖放與選檔
  const dropZone = $('dropZone');
  const fileInput = $('fontFileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  dropZone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFontFile(fileInput.files[0]); });

  ['dragenter', 'dragover'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach((evt) => dropZone.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
  dropZone.addEventListener('drop', (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFontFile(file);
  });

  // 更換字型：把 01 區塊從收合摘要展開回選檔畫面
  // 更換字型：把 01 區塊從收合狀態展開回選檔畫面
  $('changeFontButton').addEventListener('click', expandFontSection);

  // 「01 字型」標題列本身也可以點擊展開/收合（沒有字型時點了沒反應，見 toggleFontSection）
  const fontSectionHeader = $('fontSectionHeader');
  fontSectionHeader.addEventListener('click', toggleFontSection);
  fontSectionHeader.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFontSection(); }
  });

  // 從網址載入
  const urlInput = $('fontUrlInput');
  const urlLoadButton = $('fontUrlLoadButton');
  const triggerUrlLoad = () => {
    const url = urlInput.value.trim();
    if (url) handleFontUrl(url);
  };
  urlLoadButton.addEventListener('click', triggerUrlLoad);
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); triggerUrlLoad(); } });

  // 轉換
  $('convertButton').addEventListener('click', convert);
}

/**
 * 把 state.settings（目前這一組）的值全部同步回畫面上的控制項。切換全形／半形、
 * 重置參數時用——兩組設定各自獨立記錄，切換時畫面要換成對方那一組記錄的值。
 */
function syncControlsFromSettings() {
  const s = state.settings;
  const half = state.mode === 'half';

  $('cellSizeInput').value = String(s.cellSize);
  $('outputSizeInput').value = String(s.outputSize);

  // 半形沒有 CJK／非CJK 之分：鎖定選項 disable（顯示為勾選＋灰階），只留一組偏移。
  $('lockOffsetsCheckbox').checked = s.lockOffsets;
  $('lockOffsetsCheckbox').disabled = half;
  $('lockOffsetsField').classList.toggle('is-disabled', half);
  updateOffsetGroupsVisibility();
  updateOffsetLabels();

  $('thresholdSlider').value = String(s.threshold);
  $('thresholdValue').textContent = String(s.threshold);
  $('gammaInput').value = String(s.gamma);
  $('antiAliasCheckbox').checked = s.antiAlias;
  $('supersampleSelect').value = String(s.supersampleFactor);
  $('contrastInput').value = String(s.contrast);
  $('hintingSelect').value = s.freeTypeHinting;
  $('preferEmbeddedBitmapCheckbox').checked = s.freeTypePreferEmbeddedBitmap;
  $('freetypeTargetSelect').value = s.freeTypeTarget;
  $('boldAdjustInput').value = String(s.boldAdjust);
  $('invertCheckbox').checked = s.invert;
  $('alignAllCheckbox').checked = s.alignAllToBaseline;

  syncPropControls();
  updateModeLabels();
  updateBaselineConsistencyNote();
}

/**
 * 半形「字寬」區塊（等寬／不等寬）與不等寬參數：只有半形才顯示；不等寬參數只有
 * 選了「不等寬」才展開；「墨跡間距」只有寬度來源選「墨跡」才需要。
 */
function syncPropControls() {
  const s = state.settings;
  const half = state.mode === 'half';
  const prop = isProportional(s);

  $('halfWidthBlock').hidden = !half;
  $('widthModeFixed').checked = s.widthMode !== 'proportional';
  $('widthModeProp').checked = s.widthMode === 'proportional';
  $('propOptions').hidden = !prop;
  $('propInkGapField').hidden = s.propWidthSource !== 'ink';

  $('propSourceSelect').value = s.propWidthSource;
  $('propOverflowSelect').value = s.propOverflow;
  $('propRoundingSelect').value = s.propRounding;
  $('propLetterSpacingInput').value = String(s.propLetterSpacing);
  $('propInkGapInput').value = String(s.propInkGap);
  $('propMinWidthInput').value = String(s.propMinWidth);
  $('propMaxWidthInput').value = String(s.propMaxWidth);
  $('propSpaceWidthInput').value = String(s.propSpaceWidth);
  $('propOverridesInput').value = s.propOverrides;
  updateOverridesNote();
}

/** 例外覆寫文字有格式錯誤時，在欄位下方列出來；格式都對就顯示解析出幾筆。 */
function updateOverridesNote() {
  const note = $('propOverridesNote');
  const { map, errors } = parseWidthOverrides(state.settings.propOverrides);
  note.classList.toggle('is-error', errors.length > 0);
  if (errors.length > 0) note.textContent = errors.slice(0, 3).join('；') + (errors.length > 3 ? `…（共 ${errors.length} 項有問題）` : '');
  else note.textContent = map.size > 0 ? `已套用 ${map.size} 筆例外字寬。` : '';
}

function setWidthMode(mode) {
  state.settings.widthMode = mode;
  syncPropControls();
  updateModeLabels();
  refreshPreview();
}

/** 跟「目前是哪個模式」有關的文字標籤：徽章、重置按鈕、字寬說明、半形偏移說明。 */
function updateModeLabels() {
  const mode = state.mode;
  const half = mode === 'half';
  const s = state.settings;

  $('tuneModeBadge').textContent = MODE_LABELS[mode];
  $('resetParamsButton').textContent = `重置微調參數（${MODE_LABELS[mode]}）`;
  $('halfOffsetNote').hidden = !half;

  const cw = cellWidthFor(mode, s.cellSize);
  const ow = cellWidthFor(mode, s.outputSize);
  if (isProportional(s)) {
    $('sizeDimNote').textContent =
      `不等寬：每個字的字寬由下方規則逐字決定，取樣／輸出尺寸只管字高（取樣 ${s.cellSize}、輸出 ${s.outputSize}）；標準半形寬 ${ow} 只是預覽的參考線。`;
  } else {
    $('sizeDimNote').textContent = half
      ? `字格寬 = 字高 ÷ 2（奇數字高無條件進位）：取樣 ${cw}×${s.cellSize}、輸出 ${ow}×${s.outputSize}（寬×高）。`
      : `字格寬 = 字高：取樣 ${cw}×${s.cellSize}、輸出 ${ow}×${s.outputSize}（寬×高）。`;
  }

  updatePreviewDimNote();
}

/**
 * 切換預覽／編輯的是全形還是半形。全形、半形各自獨立記錄：
 *  1. 微調參數：state.settings 改指向新模式那一組，畫面控制項同步成那一組記錄的值。
 *  2. 預覽文字：目前文字框的內容存回舊模式的暫存，文字框換成新模式自己暫存的內容
 *     （沒輸入過就是該模式的預設文字）。在全形輸入的半形英數不會帶到半形預覽，反之亦然；
 *     文字框裡有跟模式不符的字時，由「模式不符」提示列提醒。
 */
function setMode(mode) {
  $('previewModeFull').checked = mode === 'full';
  $('previewModeHalf').checked = mode === 'half';
  if (mode === state.mode) return;

  const input = $('previewText');
  state.previewTexts[state.mode] = input.value;

  state.mode = mode;
  state.settings = state.modeSettings[mode];
  input.value = state.previewTexts[mode];
  syncControlsFromSettings();
  refreshPreview();
}

function resetRenderParams() {
  // 只重置「目前這一組」（全形或半形）；另一組的記錄不受影響。
  const d = createDefaultSettings(state.mode);
  const s = state.settings;

  s.offsetX = d.offsetX; s.offsetY = d.offsetY;
  s.nonCjkOffsetX = d.nonCjkOffsetX; s.nonCjkOffsetY = d.nonCjkOffsetY;
  s.lockOffsets = d.lockOffsets;
  s.threshold = d.threshold;
  s.gamma = d.gamma;
  s.supersampleFactor = d.supersampleFactor;
  s.antiAlias = d.antiAlias;
  s.contrast = d.contrast;
  s.freeTypeHinting = d.freeTypeHinting;
  s.freeTypePreferEmbeddedBitmap = d.freeTypePreferEmbeddedBitmap;
  s.freeTypeTarget = d.freeTypeTarget;
  s.boldAdjust = d.boldAdjust;
  s.invert = d.invert;
  s.alignAllToBaseline = d.alignAllToBaseline;
  s.propWidthSource = d.propWidthSource;
  s.propRounding = d.propRounding;
  s.propOverflow = d.propOverflow;
  s.propLetterSpacing = d.propLetterSpacing;
  s.propInkGap = d.propInkGap;
  s.propMinWidth = d.propMinWidth;
  s.propMaxWidth = d.propMaxWidth;
  s.propSpaceWidth = d.propSpaceWidth;
  s.propOverrides = d.propOverrides;
  // 注意：cellSize / outputSize / engine / widthMode（等寬或不等寬）刻意不重置：
  // 前三者比照原版行為，widthMode 是「這一組輸出什麼種類的字型」的選擇，不是微調參數。

  syncControlsFromSettings();
  refreshPreview();
}

// ---------------------------------------------------------------------------
// 第四層：轉檔
// ---------------------------------------------------------------------------

/** 依目前選的輸出編碼，回傳一個「Unicode 碼位 → 目標編碼碼位」的轉換函式。
 * Unicode／UTF-8 是原樣傳回（兩種輸出編碼實際上共用同一套 ENCODING 數值，
 * 差別只在 BDF 檔名的 registry 標示不同）；Big5／自訂對照表則是查表，查不到
 * 就回傳 null，呼叫端要自己決定略過。 */
function getEncoderForScheme(scheme) {
  if (scheme === 'big5') {
    const table = getBuiltinBig5Table();
    return (cp) => (table.has(cp) ? table.get(cp) : null);
  }
  if (scheme === 'custom') {
    const table = state.encoding.customTable ? state.encoding.customTable.map : null;
    return (cp) => (table && table.has(cp) ? table.get(cp) : null);
  }
  return (cp) => cp; // unicode / utf8
}

function updateEncodingImportUi() {
  const scheme = $('fontEncodingSelect').value;
  $('encodingImportRow').hidden = scheme !== 'custom';

  const statusEl = $('encodingImportStatus');
  if (scheme !== 'custom') return;
  const table = state.encoding.customTable;
  if (!table) {
    statusEl.textContent = '尚未匯入對照表。';
  } else if (table.count === 0) {
    statusEl.textContent = `${table.fileName}：沒有解析到任何有效的對照資料，請確認檔案格式（可能是不支援的 WHATWG pointer 格式）。`;
  } else {
    statusEl.textContent = `已匯入 ${table.fileName}，共 ${table.count.toLocaleString()} 筆 Unicode → 目標碼對照。`;
  }
}

async function handleEncodingTableFile(file) {
  const statusEl = $('encodingImportStatus');
  statusEl.textContent = `讀取中：${file.name} …`;
  try {
    const text = await file.text();
    const { map, count } = parseCustomEncodingTable(text);
    state.encoding.customTable = { map, count, fileName: file.name };
  } catch (err) {
    console.error(err);
    state.encoding.customTable = null;
    statusEl.textContent = `讀取失敗：${err.message || err}`;
    return;
  }
  updateEncodingImportUi();
}

function disableConvert(message) {
  $('convertButton').disabled = true;
  $('convertStatus').textContent = message || '';
}

function enableConvert() {
  updateConvertAvailability();
}

/** 「字碼範圍」勾選有沒有問題；沒問題回傳 null，有問題回傳要給使用者看的說明。 */
function exportSelectionProblem(sel) {
  if (!sel.half && !sel.full) return '請至少勾選「半形」或「全形」其中一項。';
  if (sel.full && !sel.cjk && !sel.nonCjk) return '「全形」底下請至少勾選「CJK」或「非 CJK」其中一項。';
  return null;
}

/** 轉換期間不重新啟用按鈕，避免使用者在轉換途中改勾選又觸發第二次轉換。 */
let converting = false;

function updateConvertAvailability() {
  if (converting || !state.fontInfo || !state.rasterizer) return;
  const problem = exportSelectionProblem(getExportSelection());
  $('convertButton').disabled = !!problem;
  $('convertStatus').textContent = problem || '就緒，可以開始轉換。';
}

/** 全形底下的 CJK／非CJK 子選項、進階碼位範圍：全形沒勾時一起灰掉。 */
function updateExportUi() {
  const fullOn = $('exportFullCheckbox').checked;
  $('exportFullSub').classList.toggle('is-disabled', !fullOn);
  $('exportCjkCheckbox').disabled = !fullOn;
  $('exportNonCjkCheckbox').disabled = !fullOn;
  $('codeStartInput').disabled = !fullOn;
  $('codeEndInput').disabled = !fullOn;
}

function parseHexInt(text) {
  const t = text.trim();
  if (!/^[0-9a-fA-F]+$/.test(t)) return null;
  return parseInt(t, 16);
}

/**
 * 半形：U+0020–U+007E（95 個）。字型沒有的 ASCII 字元不輸出（會回報缺了哪些），
 * 但空白（U+0020）一律輸出——空白字形本來就是全空白點陣，字型 cmap 沒收也不影響，
 * 而 BDF 少了空白會讓大部分文字排版程式在字詞之間出問題。
 */
function collectHalfCodePoints() {
  const info = state.fontInfo;
  const codePoints = [];
  const missing = [];
  for (let cp = ASCII_FIRST; cp <= ASCII_LAST; cp++) {
    const has = info.supportedCodePoints.has(cp)
      || (state.settings.engine === 'freetype' && state.rasterizer.hasGlyph(cp));
    if (has || cp === 0x20) codePoints.push(cp);
    else missing.push(cp);
  }
  return { codePoints, missing };
}

/**
 * 全形：字型支援的所有碼位，扣掉 ASCII 可顯示字元（它們屬於半形檔）與不該輸出的
 * 碼位（控制字元、非字元），再依勾選的 CJK／非CJK 與（選填的）碼位範圍過濾。
 * 回傳 null 代表範圍欄位格式錯誤（已經 alert 過了）。
 */
function collectFullCodePoints(sel) {
  const startText = $('codeStartInput').value.trim();
  const endText = $('codeEndInput').value.trim();
  let rangeStart = 0;
  let rangeEnd = 0xffff;
  if (startText !== '' || endText !== '') {
    const startCp = parseHexInt(startText);
    const endCp = parseHexInt(endText);
    if (startCp === null || endCp === null || startCp > endCp) {
      alert('字碼區間格式錯誤，請輸入十六進位碼位，例如起始 4E00、結束 9FFF。');
      return null;
    }
    rangeStart = startCp;
    rangeEnd = endCp;
  }

  return Array.from(state.fontInfo.supportedCodePoints)
    .filter((cp) => {
      if (isAsciiPrintable(cp) || isNonExportable(cp)) return false;
      if (cp < rangeStart || cp > rangeEnd) return false;
      return isCjkCodePoint(cp) ? sel.cjk : sel.nonCjk;
    })
    .sort((a, b) => a - b);
}

/**
 * DEFAULT_CHAR：必須是輸出裡真的存在的字。半形用空白；全形優先用 U+FFFD（替代字元，
 * 通常畫成一個明顯的記號），沒有就用 U+3000（全形空白），都沒有就不寫這個屬性。
 */
function pickDefaultChar(glyphs, mode) {
  const encodingOf = new Map(glyphs.map((g) => [g.codePoint, g.encoding]));
  const candidates = mode === 'half' ? [0x20] : [0xfffd, 0x3000];
  for (const cp of candidates) {
    if (encodingOf.has(cp)) return encodingOf.get(cp);
  }
  return null;
}

/** 轉檔期間產生的下載連結 blob URL，重新轉換前要先釋放，不然每轉一次就多佔一份記憶體。 */
let downloadUrls = [];

function clearDownloads() {
  for (const url of downloadUrls) URL.revokeObjectURL(url);
  downloadUrls = [];
  $('downloadLinks').innerHTML = '';
  $('convertReport').hidden = true;
  $('convertReport').innerHTML = '';
}

function addReportLine(text, warn = false) {
  const report = $('convertReport');
  report.hidden = false;
  const p = document.createElement('p');
  if (warn) p.className = 'report-warn';
  p.textContent = text;
  report.appendChild(p);
}

async function convert() {
  if (!state.rasterizer || !state.fontInfo) {
    alert('請先讀取字型檔。');
    return;
  }

  const fontAscent = parseInt($('fontAscentInput').value.trim(), 10);
  const fontDescent = parseInt($('fontDescentInput').value.trim(), 10);
  if (Number.isNaN(fontAscent)) { alert('FONT_ASCENT 必須是整數。'); return; }
  if (Number.isNaN(fontDescent)) { alert('FONT_DESCENT 必須是整數。'); return; }

  const sel = getExportSelection();
  const problem = exportSelectionProblem(sel);
  if (problem) { alert(problem); return; }

  const encodingScheme = $('fontEncodingSelect').value;
  if (sel.full && encodingScheme === 'custom' && (!state.encoding.customTable || state.encoding.customTable.count === 0)) {
    alert('選了「其他／匯入對照表」，但還沒有成功匯入任何對照資料，請先在「字型編碼」區塊選擇對照表檔案。');
    return;
  }

  // ---- 準備各檔案要轉的碼位 ----
  /** @type {Array<{mode:'full'|'half', codePoints:number[], missing:number[], settings:object}>} */
  const jobs = [];
  if (sel.half) {
    const { codePoints, missing } = collectHalfCodePoints();
    if (codePoints.length <= 1) {
      alert('這個字型沒有任何 ASCII 英數字元，沒有東西可以輸出半形檔。');
      return;
    }
    // 轉換開始當下把各組參數複製一份快照：轉換途中就算又動了畫面上的參數，也不影響這一次。
    const halfSettings = { ...state.modeSettings.half };
    jobs.push({ mode: 'half', codePoints, missing, settings: halfSettings, proportional: isProportional(halfSettings) });
  }
  if (sel.full) {
    const codePoints = collectFullCodePoints(sel);
    if (codePoints === null) return;
    if (codePoints.length === 0) {
      alert('全形：沒有符合條件的字碼可供轉換。');
      return;
    }
    jobs.push({ mode: 'full', codePoints, missing: [], settings: { ...state.modeSettings.full }, proportional: false });
  }

  const baseEncode = getEncoderForScheme(encodingScheme);
  const fontFamilyName = displayFamilyName().replace(/\.[^.]+$/, '') || 'Font';
  const safeName = fontFamilyName.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'font';

  converting = true;
  $('convertButton').disabled = true;
  clearDownloads();
  const progressEl = $('convertProgress');
  progressEl.max = jobs.reduce((n, j) => n + j.codePoints.length, 0);
  progressEl.value = 0;
  let done = 0;

  const results = [];
  try {
    for (const job of jobs) {
      const { mode, codePoints, settings } = job;
      const prop = job.proportional;
      const outHeight = settings.outputSize;
      // 不等寬沒有固定的輸出字格寬（每個字自己的字寬），這裡用 0 表示「不適用」。
      const outWidth = prop ? 0 : cellWidthFor(mode, outHeight);
      const overrides = prop ? parseWidthOverrides(settings.propOverrides).map : null;
      const advances = [];
      const widened = [];

      // 半形：ASCII 在所有支援的編碼裡碼位都一樣（Big5 的單位元組部分就是 ASCII），
      // 對照表查不到時退回 ASCII 碼位本身，不會因為自訂對照表漏掉 ASCII 就整段消失。
      const encode = mode === 'half'
        ? (cp) => { const e = baseEncode(cp); return e === null ? cp : e; }
        : baseEncode;
      // 半形檔的 registry：Big5 時標 ISO8859-1（ASCII 單位元組字型的標準寫法，
      // 方便跟 big5-0 的全形檔搭成一組）；其他編碼跟全形一致。
      const registry = (mode === 'half' && encodingScheme === 'big5')
        ? 'ISO8859-1'
        : (ENCODING_REGISTRY[encodingScheme] || 'ISO10646-1');

      const glyphs = [];
      const seenEncodings = new Set();
      const clippedH = [];
      const clippedV = [];
      let skippedByEncoding = 0;
      let duplicateEncodings = 0;

      for (let i = 0; i < codePoints.length; i++) {
        const cp = codePoints[i];
        const encoded = encode(cp);
        if (encoded === null) {
          // 這個字在目前選的輸出編碼裡沒有對應碼位（例如 Big5 沒有收錄的字），
          // 沒辦法寫進 ENCODING 欄位，只能略過這個字，不整批轉換失敗。
          skippedByEncoding++;
        } else if (seenEncodings.has(encoded)) {
          // 兩個不同 Unicode 碼位對到同一個目標碼（部分 Big5 對照表有這種重複碼）：
          // BDF 的 ENCODING 不能重複，保留先出現的。
          duplicateEncodings++;
        } else {
          seenEncodings.add(encoded);
          if (prop) {
            // 不等寬：每個字自己的字寬（DWIDTH）、貼緊墨跡的 BBX（BDF 標準做法）。
            const g = rasterizeProportionalGlyph(cp, settings, fontAscent, overrides);
            if (g.clippedH) clippedH.push(cp);
            if (g.clippedV) clippedV.push(cp);
            advances.push(g.advance);
            if (g.widenedBy > 0) widened.push(cp);
            glyphs.push({
              codePoint: cp,
              encoding: encoded,
              advance: g.advance,
              bbox: g.bbox ? toBdfBox(g.bbox, fontAscent) : null,
              data: g.tight,
            });
          } else {
            const { bitmap, eff } = rasterizeGlyph(cp, settings, fontAscent);
            if (bitmap.clipped & 1) clippedH.push(cp);
            if (bitmap.clipped & 2) clippedV.push(cp);
            let out = postProcess(bitmap, eff);
            if (out.width !== outWidth || out.height !== outHeight) {
              out = resizeTopLeft(out, outWidth, outHeight);
            }
            glyphs.push({ codePoint: cp, encoding: encoded, width: outWidth, height: outHeight, data: out.data });
          }
        }

        done++;
        if (done % 25 === 0 || done === progressEl.max) {
          progressEl.value = done;
          $('convertStatus').textContent = `轉換中（${MODE_LABELS[mode]}）... ${done}/${progressEl.max}`;
        }
        if (done % 200 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0)); // 讓出主執行緒，保持畫面回應
        }
      }

      const result = { mode, proportional: prop, advances, widened, alignAll: settings.alignAllToBaseline, glyphCount: glyphs.length, skippedByEncoding, duplicateEncodings, clippedH, clippedV, missing: job.missing, outWidth, outHeight };
      if (glyphs.length > 0) {
        const metricsReport = {};
        const bdfText = writeBdfFont({
          fontName: fontFamilyName,
          mode,
          cellWidth: outWidth,
          cellHeight: outHeight,
          fontAscent,
          fontDescent,
          glyphs,
          proportional: prop,
          registry,
          defaultChar: pickDefaultChar(glyphs, mode),
          eol: $('eolSelect').value === 'crlf' ? '\r\n' : '\n',
          report: metricsReport,
          copyright: state.fontInfo.copyright,
          comments: [
            `Generated by Not Your FONT from "${displayFamilyName()}" (${state.fileName})`,
            `${mode === 'half' ? 'Half-width (ASCII)' : 'Full-width'} ${prop ? `proportional, height ${outHeight}` : `${outWidth}x${outHeight}`}, sampled at ${settings.cellSize}px height with ${settings.engine}`,
          ],
        });
        result.metrics = metricsReport;
        result.validation = validateBdf(bdfText); // 檢查的是實際要下載的文字
        const blob = new Blob([bdfText], { type: 'text/plain;charset=ascii' });
        const url = URL.createObjectURL(blob);
        downloadUrls.push(url);
        // 半形檔名加 _ascii；全形維持原本的命名。
        // 半形不等寬再加 _prop，跟等寬的 _ascii 檔分開。
        result.fileName = `${safeName}-${outHeight}px${mode === 'half' ? (prop ? '_ascii_prop' : '_ascii') : ''}.bdf`;
        result.url = url;
      }
      results.push(result);
    }

    progressEl.value = progressEl.max;
    renderConvertResults(results, encodingScheme);
  } catch (err) {
    console.error(err);
    $('convertStatus').textContent = `轉換失敗：${err.message || err}`;
    alert('轉換失敗：' + (err.message || err));
  } finally {
    converting = false;
    $('convertButton').disabled = !!exportSelectionProblem(getExportSelection());
  }
}

/** 轉檔完成後：下載連結＋逐檔報告（字元數、缺字、被裁切、編碼略過）。 */
function renderConvertResults(results, encodingScheme) {
  const links = $('downloadLinks');
  // 組合符號（U+0300 等）單獨顯示會黏到前一個字上、看不出是哪個字，改顯示碼位。
  const showCp = (cp) => {
    const ch = String.fromCodePoint(cp);
    return /\p{M}/u.test(ch) ? `U+${cp.toString(16).toUpperCase().padStart(4, '0')}` : ch;
  };
  const charText = (cps, max = 16) => {
    const shown = cps.slice(0, max).map(showCp).join(' ');
    return cps.length > max ? `${shown} …（共 ${cps.length} 個）` : shown;
  };

  const okCounts = [];
  for (const r of results) {
    const label = MODE_LABELS[r.mode];
    if (!r.url) {
      addReportLine(`${label}：${ENCODING_LABELS[encodingScheme]} 編碼下，選取範圍內沒有任何字元可以對應到目標碼位，沒有輸出檔案。`, true);
      continue;
    }
    okCounts.push(`${label}${r.proportional ? '（不等寬）' : ''} ${r.glyphCount} 字`);

    const a = document.createElement('a');
    a.className = 'btn btn-download';
    a.href = r.url;
    a.download = r.fileName;
    a.textContent = `下載 ${r.fileName}`;
    links.appendChild(a);

    if (r.proportional) {
      const adv = r.advances;
      const avg = adv.length > 0 ? adv.reduce((a, b) => a + b, 0) / adv.length : 0;
      addReportLine(`${label}（不等寬）：${r.glyphCount} 個字元，字高 ${r.outHeight}，字寬 ${Math.min(...adv)}–${Math.max(...adv)}（平均 ${avg.toFixed(1)}），BBX 貼緊墨跡 → ${r.fileName}`);
    } else {
      addReportLine(`${label}：${r.glyphCount} 個字元，字格 ${r.outWidth}×${r.outHeight}（寬×高）→ ${r.fileName}`);
    }
    if (r.missing.length > 0) {
      addReportLine(`　字型缺少 ${r.missing.length} 個 ASCII 字元（未輸出）：${charText(r.missing)}`, true);
    }
    if (r.clippedH.length > 0) {
      addReportLine(`　⚠ ${r.clippedH.length} 個字元的墨跡超出${r.proportional ? '自己的字寬框' : '字格寬度'}、左右被裁切：${charText(r.clippedH)}`
        + (r.proportional
          ? '。不等寬不會自動加寬：可用字距調整／最小字寬放寬、位置偏移 X 移回框內，或寫進例外覆寫。'
          : r.mode === 'half'
          ? '。半形字格寬 = 字高 ÷ 2，調取樣尺寸解決不了；通常是字型的 ASCII 為比例字形，可用位置偏移／粗細調整，或改用等寬 ASCII 字型。'
          : '。'), true);
    }
    if (r.widened && r.widened.length > 0) {
      addReportLine(`　${r.widened.length} 個字元的墨跡超出原本字寬，已自動加寬：${charText(r.widened)}`);
    }
    if (r.metrics && r.metrics.adjusted) {
      addReportLine(`　檔頭的 FONT_ASCENT／FONT_DESCENT 已放大為 ${r.metrics.fontAscent}／${r.metrics.fontDescent}（你填的值比墨跡實際延伸的範圍小，不放大的話部分程式會裁掉超出的墨跡）。`, true);
    }
    if (r.clippedV.length > 0) {
      addReportLine(`　⚠ ${r.clippedV.length} 個字元的墨跡超出字格高度、上下被裁切：${charText(r.clippedV)}。`
        + (r.alignAll
          ? '可調整位置偏移，或檢查 FONT_ASCENT 是否合適。'
          : '這一組尚未勾選「字元對齊基準線」，字是依字型內建的 ascender 定位，常會整體偏下；勾選後以 FONT_ASCENT 為基準線通常能大幅改善。'), true);
    }
    if (r.skippedByEncoding > 0) {
      addReportLine(`　${r.skippedByEncoding} 個字元在 ${ENCODING_LABELS[encodingScheme]} 編碼下沒有對應碼位，已略過。`);
    }
    if (r.validation) {
      const { errors, warnings } = r.validation;
      if (errors.length === 0 && warnings.length === 0) addReportLine('　BDF 規格檢查：通過（0 錯誤、0 警告）。');
      for (const e of errors) addReportLine(`　BDF 規格錯誤：${e}`, true);
      for (const w of warnings) addReportLine(`　BDF 規格警告：${w}`, true);
    }
    if (r.duplicateEncodings > 0) {
      addReportLine(`　${r.duplicateEncodings} 個字元對到已被使用的目標碼位（對照表重複碼），已略過重複者。`);
    }
  }

  const nonBmp = state.fontInfo ? state.fontInfo.nonBmpCount : 0;
  if (nonBmp > 0 && results.some((r) => r.mode === 'full' && r.url)) {
    addReportLine(`字型另有 ${nonBmp} 個 BMP 以外（U+10000 以上，例如 CJK 擴充 B 區）的字元，這個工具只轉 BMP，未包含。`);
  }

  $('convertStatus').textContent = okCounts.length > 0
    ? `轉換完成：${okCounts.join('、')}。`
    : '轉換失敗：沒有任何檔案可以輸出。';
}

// ---------------------------------------------------------------------------
// 「微調點陣字」浮動視窗：把 03 側欄拉出版面之外，變成可拖曳的浮動面板，
// 讓 02 預覽區補滿整個寬度——比較好對照大量字元時，不用一直上下捲動切換
// 「看預覽」跟「調參數」兩個區塊。
// ---------------------------------------------------------------------------

const floatState = {
  active: false,
  dragging: false,
  startX: 0,
  startY: 0,
  startLeft: 0,
  startTop: 0,
};

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function toggleFloating() {
  const panel = $('section-tune');
  const row = document.querySelector('.preview-tune-row');
  const btn = $('floatToggleButton');
  const opacitySlider = $('floatOpacitySlider');

  floatState.active = !floatState.active;

  if (floatState.active) {
    // 浮動當下就用側欄目前實際所在的位置/寬度當起點，避免一按下去畫面跳來跳去。
    const rect = panel.getBoundingClientRect();
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.setProperty('--float-opacity', String(opacitySlider.value / 100)); // 預設 70%，跟著滑桿目前的值
    panel.classList.add('floating');
    row.classList.add('tune-floating');
    btn.textContent = '⤡';
    btn.title = '收回為側欄';
    btn.setAttribute('aria-label', '收回為側欄');
  } else {
    panel.classList.remove('floating');
    panel.style.left = '';
    panel.style.top = '';
    panel.style.width = '';
    row.classList.remove('tune-floating');
    btn.textContent = '⤢';
    btn.title = '切換浮動視窗';
    btn.setAttribute('aria-label', '切換浮動視窗');
  }
}

function bindFloatingPanel() {
  $('floatToggleButton').addEventListener('click', toggleFloating);

  const handle = $('tuneDragHandle');
  const panel = $('section-tune');
  const opacitySlider = $('floatOpacitySlider');

  opacitySlider.addEventListener('input', (e) => {
    panel.style.setProperty('--float-opacity', String(e.target.value / 100));
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!floatState.active) return;
    if (e.target.closest('button, input, select')) return; // 避免按按鈕/拉滑桿時誤觸發拖曳
    floatState.dragging = true;
    floatState.startX = e.clientX;
    floatState.startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    floatState.startLeft = rect.left;
    floatState.startTop = rect.top;
    panel.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!floatState.dragging) return;
    const dx = e.clientX - floatState.startX;
    const dy = e.clientY - floatState.startY;
    const rect = panel.getBoundingClientRect();
    // 拖曳範圍限制：至少留 60px 在可視範圍內，不會整個被拖到畫面外找不回來。
    const nextLeft = clamp(floatState.startLeft + dx, -rect.width + 60, window.innerWidth - 60);
    const nextTop = clamp(floatState.startTop + dy, 0, window.innerHeight - 40);
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
  });

  const stopDrag = () => {
    floatState.dragging = false;
    panel.classList.remove('dragging');
  };
  handle.addEventListener('pointerup', stopDrag);
  handle.addEventListener('pointercancel', stopDrag);
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function init() {
  document.body.dataset.engine = state.settings.engine;
  updateOffsetLabels();
  updateOffsetGroupsVisibility();
  updateModeLabels();
  updateExportUi();
  bindControls();
  bindFloatingPanel();
  initTheme();
}

init();
