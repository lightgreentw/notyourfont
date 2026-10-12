// canvasRasterizer.js
//
// 取代原始 GdiGlyphRasterizer.cs（以及被移除的 WPF 引擎）的網頁版實作。
// 演算法流程跟 GDI+ 版本相同：先以「取樣尺寸 x 超取樣倍率」的大尺寸畫布
// 反鋸齒渲染，再縮小平均取樣、套用 Gamma / 對比度，最後用門檻值二值化。
//
// 跟原版最大的差異在最底層：GDI+ 版本呼叫的是 Windows 的 GDI+ 文字光柵化，
// 這裡改交給瀏覽器自己的字型引擎（Canvas 2D fillText），兩者字形輪廓來源
// 相同（都是讀同一個 TTF/OTF 的向量外框），但反鋸齒與次像素處理的細節
// 不會逐像素相同。這個取捨是使用者確認可以接受的（「GDI+的部份可以改成
// Canvas」），需要跟 WinForm 版本逐像素一致時請改用 FreeType 引擎。

import { cellWidthFor } from './glyphGeometry.js';

let fontCounter = 0;

export class CanvasRasterizer {
  constructor(fontFamily, familyName, fontFace) {
    this._fontFamily = fontFamily;
    this.familyName = familyName;
    this._fontFace = fontFace;
    this.engineLabel = 'Canvas (GDI+ 替代)';
    this._canvas = document.createElement('canvas');
    this._ctx = this._canvas.getContext('2d', { willReadFrequently: true });
  }

  /**
   * @param {ArrayBuffer} arrayBuffer
   */
  static async create(arrayBuffer) {
    fontCounter += 1;
    const uniqueFamily = `ttf-to-bdf-preview-${fontCounter}`;
    // FontFace 建構子在不同瀏覽器對同一個 arrayBuffer 是否可重複使用有差異，
    // 這裡複製一份以策安全（呼叫端可能還會把同一個 buffer 交給 FreeType 引擎用）。
    const face = new FontFace(uniqueFamily, arrayBuffer.slice(0));
    await face.load();
    document.fonts.add(face);
    // familyName 刻意留空：Canvas 引擎本身沒有可靠的方式讀出字型內部的家族名稱，
    // 交給呼叫端（main.js 的 displayFamilyName）去 fallback 到 SfntFontInfo 解析出來的
    // name 表資料，或最後才退到檔名——不要在這裡先塞檔名，否則會擋住更準確的來源。
    return new CanvasRasterizer(uniqueFamily, '', face);
  }

  hasGlyph() {
    // Canvas 引擎沒有可靠的方式判斷「字型內是否真的有這個字的輪廓」，
    // 一律回傳 true，交由呼叫端以 FreeType 引擎的 SfntFontInfo 判斷結果為準。
    return true;
  }

  /**
   * 對應 GdiGlyphRasterizer.RasterizeChar，回傳 BoldAdjust/Invert 之前的原始網格。
   *
   * 格子大小：高 = settings.cellSize（取樣尺寸＝字高），寬 = cellWidthFor(settings.mode, 高)
   * （全形等於高，半形是 ceil(高 / 2)）。字體大小只跟「高」有關（emSize = 高 x 0.92），
   * 寬度只決定「在水平方向置中、並裁出多寬」——跟 FreeType 引擎的語意一致。
   *
   * @param {string} ch 單一字元（非 code point，因為 Canvas fillText 吃字串）
   * @param {number} ascenderOverride 選用。-1（預設）= 用置中方式定位（原本行為）；
   *   >=0 則直接把基準線固定在這一列（cellSize 座標系），不再置中——用於
   *   「字元對齊基準線」功能，見 main.js 的 computeAscenderOverride()。
   * @returns {{width:number, height:number, data:Uint8Array, clipped:number}}
   *   clipped：bit0 = 左右有墨跡超出格子、bit1 = 上下有。Canvas 沒辦法像 FreeType
   *   那樣逐像素精確統計被丟掉的墨跡，這裡改用 measureText 回報的字形外框
   *   （actualBoundingBox*）估算，超出超過半個取樣像素才算，避免抗鋸齒邊緣誤報。
   */
  rasterizeChar(ch, settings, ascenderOverride = -1) {
    const height = clampSize(settings.cellSize);
    const width = cellWidthFor(settings.mode, height);
    // 畫布 = max(取樣, 輸出)：理由見 freetypeRasterizer.js 的 rasterizeCodePoint。
    const outHeight = clampSize(settings.outputSize);
    const bufW = Math.max(width, cellWidthFor(settings.mode, outHeight));
    const bufH = Math.max(height, outHeight);
    return this._render(ch, settings, ascenderOverride, width, height, null, bufW, bufH);
  }

  /**
   * 半形「不等寬」用：在比較寬的暫存格（scratchWidth x 取樣字高）裡渲染，字的原點固定在
   * 第 penX 欄（不置中、不套水平偏移——水平偏移由 proportional.js 平移裁切視窗達成），
   * advance 取自 measureText 的字寬（Canvas 沒有「字型內建提示後的整數 advance」，
   * 所以通常是小數，由「取整方式」參數決定怎麼取整）。
   * @returns {{width:number, height:number, data:Uint8Array, clipped:number, advance26:number}}
   */
  rasterizeProportional(ch, settings, ascenderOverride, penX, scratchWidth) {
    const height = clampSize(settings.cellSize);
    const scratchHeight = Math.max(height, clampSize(settings.outputSize));
    const r = this._render(ch, settings, ascenderOverride, scratchWidth, height, penX, scratchWidth, scratchHeight);
    return { ...r, advance26: Math.round(r.advancePx * 64) };
  }

  /**
   * 共用的渲染本體。fixedPenX === null：字置中在格子裡並套用 settings.offsetX（等寬，原本的行為）；
   * 否則字的原點固定在第 fixedPenX 欄，不套 offsetX（不等寬）。
   *
   * width x height 是「取樣格」：height 決定字體大小與垂直置中，width 決定水平置中。
   * bufW x bufH 是實際畫布與輸出點陣的大小（>= 取樣格），用來讓輸出比取樣大時，
   * 落在取樣格外、輸出範圍內的墨跡能保留下來。bufW/bufH 等於 width/height 時與舊版相同。
   */
  _render(ch, settings, ascenderOverride, width, height, fixedPenX, bufW = width, bufH = height) {
    const ss = Math.max(1, Math.round(settings.supersampleFactor) || 1);
    const bigW = bufW * ss;          // 畫布大小
    const bigH = bufH * ss;
    const cellBigW = width * ss;     // 取樣格大小（字體大小、置中用）
    const cellBigH = height * ss;

    const canvas = this._canvas;
    if (canvas.width !== bigW || canvas.height !== bigH) {
      canvas.width = bigW;
      canvas.height = bigH;
    }
    const ctx = this._ctx;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, bigW, bigH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, bigW, bigH);
    ctx.imageSmoothingEnabled = !!settings.antiAlias;

    const emSize = cellBigH * 0.92;
    ctx.font = `${emSize}px "${this._fontFamily}"`;
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#000000';

    const metrics = ctx.measureText(ch);
    const textWidth = metrics.width;

    let y;
    if (ascenderOverride >= 0) {
      // 固定基準線模式：直接把基準線放在指定列，不做置中，讓不同字元共用同一條基準線。
      y = ascenderOverride * ss + settings.offsetY * ss;
    } else {
      const ascent = metrics.actualBoundingBoxAscent || emSize * 0.75;
      const descent = metrics.actualBoundingBoxDescent || emSize * 0.2;
      const textHeight = ascent + descent;
      const yTop = (cellBigH - textHeight) / 2 + settings.offsetY * ss;
      y = yTop + ascent;
    }
    const x = fixedPenX === null
      ? (cellBigW - textWidth) / 2 + settings.offsetX * ss
      : fixedPenX * ss;

    let clipped = 0;
    if (ch && ch.trim().length > 0) {
      ctx.fillText(ch, x, y);

      const tolerance = ss * 0.5;
      const inkLeft = x - (metrics.actualBoundingBoxLeft || 0);
      const inkRight = x + (metrics.actualBoundingBoxRight || textWidth);
      const inkTop = y - (metrics.actualBoundingBoxAscent || 0);
      const inkBottom = y + (metrics.actualBoundingBoxDescent || 0);
      if (inkLeft < -tolerance || inkRight > bigW + tolerance) clipped |= 1;
      if (inkTop < -tolerance || inkBottom > bigH + tolerance) clipped |= 2;
    }

    const imgData = ctx.getImageData(0, 0, bigW, bigH).data;

    // 縮小取樣：每個目標像素取對應 ss x ss 大格子區域的平均灰階亮度。
    const gray = new Float64Array(bufW * bufH);
    for (let yy = 0; yy < bufH; yy++) {
      for (let xx = 0; xx < bufW; xx++) {
        let sum = 0;
        for (let sy = 0; sy < ss; sy++) {
          const py = yy * ss + sy;
          const rowBase = py * bigW;
          for (let sx = 0; sx < ss; sx++) {
            const px = xx * ss + sx;
            const idx = (rowBase + px) * 4;
            sum += (imgData[idx] + imgData[idx + 1] + imgData[idx + 2]) / 3;
          }
        }
        gray[yy * bufW + xx] = sum / (ss * ss);
      }
    }

    // Gamma / 對比度：作用在「墨色濃度」= 255 - 灰階亮度，跟 GDI+ 版本相同的公式。
    const gamma = settings.gamma || 1.0;
    const contrast = settings.contrast || 0;
    for (let i = 0; i < gray.length; i++) {
      let normalized = (255 - gray[i]) / 255;
      if (Math.abs(gamma - 1.0) > 0.001) {
        normalized = Math.pow(Math.max(normalized, 0), 1.0 / gamma);
      }
      if (contrast !== 0) {
        const c = (100 + contrast) / 100;
        normalized = (normalized - 0.5) * c + 0.5;
      }
      normalized = Math.min(1, Math.max(0, normalized));
      gray[i] = 255 - normalized * 255;
    }

    const data = new Uint8Array(bufW * bufH);
    const threshold = settings.threshold;
    for (let i = 0; i < gray.length; i++) {
      data[i] = gray[i] <= threshold ? 1 : 0;
    }

    return { width: bufW, height: bufH, sampleWidth: width, sampleHeight: height, data, clipped, advancePx: textWidth / ss };
  }

  dispose() {
    if (this._fontFace) {
      document.fonts.delete(this._fontFace);
      this._fontFace = null;
    }
  }
}

function clampSize(size) {
  return Math.min(Math.max(Math.round(size), 7), 32);
}
