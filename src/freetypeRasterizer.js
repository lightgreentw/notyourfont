// freetypeRasterizer.js
//
// 包裝 wasm/freetype.wasm（由 build/ft-bridge/ft_bridge.c 編譯而成，
// 是 FreeTypeGlyphRasterizer.cs 的逐行 C 移植，呼叫的是編譯進 wasm 的
// 真正 FreeType 2.13.3 函式庫本體）。
//
// 這一層只負責：載入字型資料進 wasm 記憶體、把 RenderSettings 轉成
// C 函式要的整數參數、把輸出的 0/1 網格從 wasm heap 複製出來。
// 不做任何加工——粗細調整／反相統一交給 bitmapMorphology.js，跟
// Canvas 引擎共用同一份實作。

import createFreeTypeModule from '../wasm/freetype.mjs';
import { cellWidthFor } from './glyphGeometry.js';

let modulePromise = null;
function getModule() {
  if (!modulePromise) modulePromise = createFreeTypeModule();
  return modulePromise;
}

const HINTING_MAP = { default: 0, forceAutohint: 1, noHinting: 2 };
const TARGET_MAP = { mono: 0, normal: 1, light: 2 };

export class FreeTypeRasterizer {
  constructor(module, facePtr, familyName) {
    this._module = module;
    this._facePtr = facePtr;
    this.familyName = familyName;
    this.engineLabel = 'FreeType';
  }

  /** @param {ArrayBuffer} arrayBuffer */
  static async create(arrayBuffer) {
    const Module = await getModule();
    const data = new Uint8Array(arrayBuffer);
    const dataPtr = Module._malloc(data.length);
    Module.HEAPU8.set(data, dataPtr);
    let facePtr;
    try {
      facePtr = Module.ccall(
        'ft_create_face',
        'number',
        ['number', 'number'],
        [dataPtr, data.length],
      );
    } finally {
      Module._free(dataPtr);
    }
    if (!facePtr) {
      throw new Error('FreeType 無法解析這個字型檔（可能不是有效的 TTF/OTF/TTC）。');
    }
    const namePtr = Module.ccall('ft_family_name', 'number', ['number'], [facePtr]);
    const familyName = Module.UTF8ToString(namePtr) || '';
    return new FreeTypeRasterizer(Module, facePtr, familyName);
  }

  hasGlyph(codePoint) {
    return this._module.ccall('ft_get_char_index', 'number', ['number', 'number'], [this._facePtr, codePoint]) !== 0;
  }

  /**
   * 對應 FreeTypeGlyphRasterizer.RasterizeChar，回傳 BoldAdjust/Invert 之前的原始網格。
   *
   * 格子大小：高 = settings.cellSize（取樣尺寸＝字高，也是 FreeType 的 pixel size），
   * 寬 = cellWidthFor(settings.mode, 高)——全形等於高，半形是 ceil(高 / 2)。
   *
   * @param {number} ascenderOverride 選用。-1（預設）= 用字型自身的 ascender；
   *   >=0 則覆寫成這個值當作基準線列（「字元對齊基準線」功能），
   *   見 main.js 的 computeAscenderOverride()。
   * @returns {{width:number, height:number, sampleWidth:number, sampleHeight:number,
   *            data:Uint8Array, clipped:number}}
   *   width/height = 畫布大小 max(取樣, 輸出)；sampleWidth/sampleHeight = 取樣格大小。
   *   clipped 是 C 端回報的裁切旗標：bit0 = 左右有墨跡被格子裁掉、bit1 = 上下有。
   */
  rasterizeCodePoint(codePoint, settings, ascenderOverride = -1) {
    const height = clampSize(settings.cellSize);
    const width = cellWidthFor(settings.mode, height);
    // 畫布大小 = max(取樣, 輸出)：取樣字高只決定字體大小與置中，畫布則要涵蓋輸出範圍。
    // 輸出比取樣大時（例如取樣 23、輸出 24），第 24 列的墨跡（下降部等）才不會在取樣邊界被
    // 丟掉再補一列空白。取樣 >= 輸出時畫布 = 取樣格，跟舊版逐像素相同。
    const bufWidth = Math.max(width, cellWidthFor(settings.mode, clampSize(settings.outputSize)));
    const bufHeight = Math.max(height, clampSize(settings.outputSize));
    const M = this._module;
    const gridPtr = M.ccall('ft_alloc_buffer', 'number', ['number'], [bufWidth * bufHeight]);
    try {
      const rc = M.ccall(
        'ft_rasterize_char',
        'number',
        Array(14).fill('number'),
        [
          this._facePtr,
          codePoint,
          width,
          height,
          bufWidth,
          bufHeight,
          HINTING_MAP[settings.freeTypeHinting] ?? 0,
          settings.freeTypePreferEmbeddedBitmap ? 1 : 0,
          TARGET_MAP[settings.freeTypeTarget] ?? 0,
          settings.offsetX,
          settings.offsetY,
          settings.threshold,
          ascenderOverride,
          gridPtr,
        ],
      );
      if (rc < 0) {
        throw new Error(`FreeType 渲染失敗（錯誤碼 ${rc}）。`);
      }
      const view = M.HEAPU8.subarray(gridPtr, gridPtr + bufWidth * bufHeight);
      // 複製出來，脫離 wasm heap 生命週期。width/height 是畫布大小；sampleWidth/sampleHeight
      // 是取樣格大小（預覽用來標示「超出取樣格、但在輸出範圍內」的區域）。
      return { width: bufWidth, height: bufHeight, sampleWidth: width, sampleHeight: height,
               data: new Uint8Array(view), clipped: rc };
    } finally {
      M.ccall('ft_free_buffer', null, ['number'], [gridPtr]);
    }
  }

  /**
   * 半形「不等寬」用：在一塊比較寬的暫存格（scratchWidth x 取樣字高）裡渲染，字的原點
   * 固定在第 penX 欄（不置中、不套水平偏移——水平偏移由 proportional.js 平移裁切視窗達成），
   * 並回報字型的 advance。對應 C 端的 ft_rasterize_prop，見 build/ft-bridge/ft_bridge.c。
   *
   * @returns {{width:number, height:number, data:Uint8Array, clipped:number,
   *            advance26:number, bearingX:number, bearingTop:number}}
   *   advance26 是 26.6 定點數（停用提示時是未取整的實際字寬；字型內建提示時已是整數像素）。
   *   字型沒有這個字碼時 advance26 = 0、點陣全空。
   */
  rasterizeProportional(codePoint, settings, ascenderOverride, penX, scratchWidth) {
    const height = clampSize(settings.cellSize);
    // 暫存格高 = max(取樣, 輸出)，理由同 rasterizeCodePoint：輸出比取樣高時，多出來的列要能放墨跡。
    const scratchHeight = Math.max(height, clampSize(settings.outputSize));
    const M = this._module;
    const gridPtr = M.ccall('ft_alloc_buffer', 'number', ['number'], [scratchWidth * scratchHeight]);
    const infoPtr = M.ccall('ft_alloc_buffer', 'number', ['number'], [16]);
    try {
      new Int32Array(M.HEAPU8.buffer, infoPtr, 4).fill(0);
      const rc = M.ccall(
        'ft_rasterize_prop',
        'number',
        Array(14).fill('number'),
        [
          this._facePtr,
          codePoint,
          scratchWidth,
          height,
          scratchHeight,
          penX,
          HINTING_MAP[settings.freeTypeHinting] ?? 0,
          settings.freeTypePreferEmbeddedBitmap ? 1 : 0,
          TARGET_MAP[settings.freeTypeTarget] ?? 0,
          settings.offsetY,
          settings.threshold,
          ascenderOverride,
          gridPtr,
          infoPtr,
        ],
      );
      if (rc < 0) {
        throw new Error(`FreeType 渲染失敗（錯誤碼 ${rc}）。`);
      }
      const info = new Int32Array(M.HEAPU8.buffer, infoPtr, 4);
      const data = new Uint8Array(M.HEAPU8.subarray(gridPtr, gridPtr + scratchWidth * scratchHeight));
      return {
        width: scratchWidth,
        height: scratchHeight,
        data,
        clipped: rc,
        advance26: info[0],
        bearingX: info[1],
        bearingTop: info[2],
      };
    } finally {
      M.ccall('ft_free_buffer', null, ['number'], [infoPtr]);
      M.ccall('ft_free_buffer', null, ['number'], [gridPtr]);
    }
  }

  dispose() {
    if (this._facePtr) {
      this._module.ccall('ft_destroy_face', null, ['number'], [this._facePtr]);
      this._facePtr = 0;
    }
  }
}

function clampSize(size) {
  return Math.min(Math.max(Math.round(size), 7), 32);
}
