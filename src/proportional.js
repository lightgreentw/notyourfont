// proportional.js
//
// 半形「不等寬」模式的核心邏輯（純函式，不碰 DOM，預覽與轉檔共用同一份）。
//
// 等寬（全形、半形等寬）：每個字都塞進同一個固定大小的格子，BBX = 整個格子。
// 不等寬：每個字有自己的字寬（advance → BDF 的 DWIDTH），BBX 貼緊墨跡（BDF 標準做法）。
//
// 流程（buildProportionalGlyph）：
//   1. 取樣引擎在一塊比較寬的「暫存格」裡渲染，字的原點固定在 penX，並回報字型的 advance。
//   2. 粗細調整（膨脹／侵蝕）作用在整塊暫存格。
//   3. 依「寬度來源」決定這個字的字寬（advance）與裁切視窗的起點：
//        font：字寬 = 字型 advance（依取整方式取整），視窗從原點開始。
//        ink ：字寬 = 墨跡寬度 + 墨跡間距，視窗從最左邊的墨點開始（字貼左）。
//      再加上「字距調整」、套用最小／最大字寬，最後才套用「空白字寬」與「例外覆寫」
//      （這兩個是精確指定的字寬，不受字距與上下限影響）。
//   4. 水平偏移 = 墨跡在字寬框內平移（實作方式是反向平移視窗）。
//      視窗 [x0, x0 + 字寬) 以外的墨跡怎麼處理由 propOverflow 決定：
//        widen（預設）：自動加寬字寬，直到墨跡全部放得進去（左右兩側都會加）；
//                       最大字寬是上限，加到上限還放不下的部分才裁切。
//        crop         ：直接裁切，字寬不變。
//      「空白字寬」與「例外覆寫」是精確指定的字寬，兩種模式都不會被加寬。
//   5. 裁出來的點陣，列數依輸出字高裁切／補白（跟等寬模式的語意一致），再套用反相。
//   6. 取貼緊墨跡的最小外框（BBX）；完全沒有墨點（例如空白）就沒有外框。

import { adjustBitmap, invertBitmap, resizeTopLeft } from './bitmapMorphology.js';

/** 目前這組設定是不是「半形不等寬」。全形、半形等寬都回傳 false。 */
export function isProportional(settings) {
  return settings.mode === 'half' && settings.widthMode === 'proportional';
}

/** 字型 advance（26.6 定點數）依取整方式轉成整數像素。 */
export function roundAdvance(advance26, rounding) {
  switch (rounding) {
    case 'ceil': return Math.ceil(advance26 / 64);
    case 'floor': return Math.floor(advance26 / 64);
    default: return Math.round(advance26 / 64);
  }
}

/**
 * 解析「例外覆寫」文字，格式：每項「字元=字寬」，項目之間用逗號、分號、換行或空白隔開。
 * 字元可以寫成字元本身（i=3）、U+碼位（U+0049=3、0x49=3）或 space（空白，=U+0020）。
 * 字寬範圍 1–64。回傳 { map: Map<碼位, 字寬>, errors: string[] }。
 */
export function parseWidthOverrides(text) {
  const map = new Map();
  const errors = [];
  const normalized = String(text || '').replace(/\s*=\s*/g, '=').trim();
  if (normalized === '') return { map, errors };

  for (const token of normalized.split(/[\s,;，；]+/)) {
    if (token === '') continue;
    const eq = token.lastIndexOf('=');
    if (eq <= 0) { errors.push(`「${token}」：格式應為 字元=字寬（例如 i=3）`); continue; }

    const left = token.slice(0, eq);
    const right = token.slice(eq + 1);
    if (!/^\d+$/.test(right)) { errors.push(`「${token}」：字寬必須是整數`); continue; }
    const width = parseInt(right, 10);
    if (width < 1 || width > 64) { errors.push(`「${token}」：字寬要在 1–64 之間`); continue; }

    let cp = null;
    if (left.toLowerCase() === 'space') cp = 0x20;
    else if (/^(u\+|0x)[0-9a-f]{1,6}$/i.test(left)) cp = parseInt(left.replace(/^(u\+|0x)/i, ''), 16);
    else if (Array.from(left).length === 1) cp = left.codePointAt(0);
    if (cp === null) { errors.push(`「${token}」：看不懂的字元「${left}」（可寫字元本身、U+0049 或 space）`); continue; }

    map.set(cp, width);
  }
  return { map, errors };
}

/** 墨點的外框（含），沒有任何墨點回傳 null。 */
export function inkBounds(data, width, height) {
  let minX = width; let maxX = -1; let minY = height; let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[y * width + x]) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, maxX, minY, maxY };
}

/** 從 src 的第 x0 欄起裁出 newWidth 欄（超出 src 範圍的部分補 0）。x0 可以是負數。 */
export function cropColumns(data, srcWidth, height, x0, newWidth) {
  const out = new Uint8Array(newWidth * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < newWidth; x++) {
      const sx = x0 + x;
      if (sx >= 0 && sx < srcWidth) out[y * newWidth + x] = data[y * srcWidth + sx];
    }
  }
  return out;
}

/** 視窗 [x0, x0 + windowWidth) 以外還有多少墨點（= 會被裁掉的墨點數）。 */
export function countInkOutside(data, srcWidth, height, x0, windowWidth) {
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < srcWidth; x++) {
      if (data[y * srcWidth + x] && (x < x0 || x >= x0 + windowWidth)) n++;
    }
  }
  return n;
}

/** 取出 bbox（{x, y, width, height}）範圍內的點陣，成為緊密排列的 width*height 陣列。 */
export function extractBox(data, srcWidth, bbox) {
  const out = new Uint8Array(bbox.width * bbox.height);
  for (let y = 0; y < bbox.height; y++) {
    for (let x = 0; x < bbox.width; x++) {
      out[y * bbox.width + x] = data[(bbox.y + y) * srcWidth + (bbox.x + x)];
    }
  }
  return out;
}

/**
 * 貼緊墨跡的 BBX → BDF 的 BBX 四個數字。
 * 列座標是由上往下，基準線在第 fontAscent 列的上緣（跟渲染時「字元對齊基準線」把字貼齊的
 * 那一條線是同一條，也是預覽格上的綠色虛線）。BDF 的 yoff 是「外框底邊」相對基準線的高度：
 * 外框底邊在第 y + height 列的上緣，所以 yoff = fontAscent - (y + height)。
 * 等寬模式整格 BBX 用的是同一個座標系（見 bdfWriter.js），字的位置不會因為換成不等寬而移動。
 */
export function toBdfBox(bbox, fontAscent) {
  return {
    width: bbox.width,
    height: bbox.height,
    xoff: bbox.x,
    yoff: fontAscent - (bbox.y + bbox.height),
  };
}

/**
 * @param {{width:number, height:number, data:Uint8Array, advance26:number, clipped:number}} raw
 *   取樣引擎在暫存格裡的渲染結果（寬度 = 暫存格寬、高度 = 取樣字高）。
 * @param {object} settings 半形那一組設定（要有 prop* 欄位）
 * @param {number} codePoint
 * @param {number} penX 暫存格裡字的原點所在欄
 * @param {number} outputHeight 輸出字高
 * @param {Map<number,number>} overrides parseWidthOverrides().map
 * @returns {{
 *   advance:number, width:number, height:number, data:Uint8Array,
 *   bbox:{x:number,y:number,width:number,height:number}|null, tight:Uint8Array|null,
 *   clippedH:boolean, clippedV:boolean, hitMin:boolean, hitMax:boolean, widenedBy:number
 * }}
 *   data = 裁出來的整個字寬框（advance x outputHeight，給預覽畫圖用）；
 *   bbox／tight = 貼緊墨跡的最小外框與其點陣（給 BDF 用）。
 */
export function buildProportionalGlyph(raw, settings, codePoint, penX, outputHeight, overrides) {
  const { width: sw, height: sh, advance26 } = raw;

  // 2. 粗細調整（整塊暫存格）
  const scratch = settings.boldAdjust !== 0
    ? adjustBitmap(sw, sh, raw.data, settings.boldAdjust)
    : raw.data;

  // 3. 字寬與視窗起點
  const fontAdvance = Math.max(0, roundAdvance(advance26, settings.propRounding));
  const ink = inkBounds(scratch, sw, sh);

  let base;
  let windowStart;
  if (settings.propWidthSource === 'ink' && ink) {
    base = (ink.maxX - ink.minX + 1) + settings.propInkGap;
    windowStart = ink.minX;
  } else {
    base = fontAdvance;
    windowStart = penX;
  }

  let advance = base + settings.propLetterSpacing;
  let hitMin = false;
  let hitMax = false;
  if (advance < settings.propMinWidth) { advance = settings.propMinWidth; hitMin = true; }
  if (settings.propMaxWidth > 0 && advance > settings.propMaxWidth) { advance = settings.propMaxWidth; hitMax = true; }

  // 精確指定的字寬：空白字寬、例外覆寫（後者優先）。不受字距與上下限影響，也不會被自動加寬。
  let exact = false;
  if (codePoint === 0x20 && settings.propSpaceWidth > 0) { advance = settings.propSpaceWidth; hitMin = hitMax = false; exact = true; }
  if (overrides && overrides.has(codePoint)) { advance = overrides.get(codePoint); hitMin = hitMax = false; exact = true; }
  advance = Math.max(1, advance);

  // 4. 水平偏移 = 反向平移視窗
  let x0 = windowStart - settings.offsetX;

  // 自動加寬：墨跡超出視窗時，把視窗往超出的那一側擴張到剛好放得下（左側超出時視窗起點左移，
  // 等於在字的左邊多留空白）。最大字寬是上限：加到上限還放不下的部分才會被裁切。
  let widenedBy = 0;
  if (settings.propOverflow !== 'crop' && !exact && ink) {
    const left = Math.min(x0, ink.minX);
    const right = Math.max(x0 + advance - 1, ink.maxX);
    const needed = right - left + 1;
    if (needed > advance) {
      const cap = settings.propMaxWidth > 0 ? settings.propMaxWidth : Infinity;
      const widened = Math.min(needed, Math.max(cap, advance)); // 不會比原本的字寬還窄
      if (widened > advance) {
        widenedBy = widened - advance;
        advance = widened;
        x0 = left;
      }
      if (widened < needed) hitMax = true; // 加到上限了，剩下的墨跡只能裁切
    }
  }

  const clippedH = countInkOutside(scratch, sw, sh, x0, advance) > 0;
  const clippedV = (raw.clipped & 2) !== 0;

  // 5. 裁出字寬框 → 依輸出字高裁切／補白列 → 反相
  let framed = { width: advance, height: sh, data: cropColumns(scratch, sw, sh, x0, advance) };
  if (framed.height !== outputHeight) framed = resizeTopLeft(framed, advance, outputHeight);
  const data = settings.invert ? invertBitmap(framed.data) : framed.data;

  // 6. 貼緊墨跡的外框
  const b = inkBounds(data, advance, outputHeight);
  const bbox = b ? { x: b.minX, y: b.minY, width: b.maxX - b.minX + 1, height: b.maxY - b.minY + 1 } : null;
  const tight = bbox ? extractBox(data, advance, bbox) : null;

  return { advance, width: advance, height: outputHeight, data, bbox, tight, clippedH, clippedV, hitMin, hitMax, widenedBy };
}
