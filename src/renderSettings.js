// renderSettings.js
//
// 對應原始 WinForms 專案的 RenderSettings.cs。WPF 引擎已依需求移除，
// 其餘欄位與預設值逐一對應（GDI+ 改名為 canvas，其參數集不變）。

/**
 * 全形、半形各有一份獨立的設定（見 main.js 的 state.modeSettings），兩份都用這個
 * 函式建立，只有 mode 不同。engine（取樣引擎）是整個字型共用的，切換時兩份一起改。
 * @param {'full'|'half'} mode
 * @returns {RenderSettings}
 */
export function createDefaultSettings(mode = 'full') {
  return {
    /** 'full' = 全形（格寬 = 字高）；'half' = 半形 ASCII（格寬 = ceil(字高 / 2)）。 */
    mode,

    /** @type {'freetype'|'canvas'} */
    engine: 'freetype',

    // ---- 半形「不等寬」專用參數（只有 mode === 'half' 且 widthMode === 'proportional'
    // 時才會用到；全形與半形等寬完全忽略這些欄位，見 proportional.js）----
    /** 'fixed' = 半形等寬（每字同寬，BBX = 整格）；'proportional' = 不等寬（每字自己的 DWIDTH，BBX 貼緊墨跡）。 */
    widthMode: 'fixed',
    /** 字寬來源：'font' = 字型內建 advance；'ink' = 墨跡寬度 + propInkGap。 */
    propWidthSource: 'font',
    /** 字型 advance 的取整方式（只在有小數 advance 時有差別，例如停用提示）：'round' | 'ceil' | 'floor'。 */
    propRounding: 'round',
    /** 字距調整：每個字的字寬統一加減幾個像素（可為負）。 */
    propLetterSpacing: 0,
    /** 墨跡間距：字寬來源為 'ink' 時，墨跡寬度之外再加幾個像素的留白。 */
    propInkGap: 1,
    /** 最小字寬（像素，>= 1）。 */
    propMinWidth: 1,
    /** 最大字寬（像素）；0 = 不限制。超過的字，墨跡會被裁切。 */
    propMaxWidth: 0,
    /** 空白（U+0020）的字寬；0 = 依字寬來源自動決定（字型 advance）。 */
    propSpaceWidth: 0,
    /** 墨跡超出字寬框時怎麼辦：'widen' = 自動加寬字寬（直到最大字寬上限）；'crop' = 裁切。
     *  空白字寬與例外覆寫是精確指定的字寬，兩種模式都不會被加寬。 */
    propOverflow: 'widen',
    /** 例外覆寫文字，格式見 proportional.js 的 parseWidthOverrides。 */
    propOverrides: '',

    // 取樣尺寸＝字高（7~32）：實際渲染用的字高（FreeType 的 pixel size）。
    // 格寬由字高推導（全形 = 字高；半形 = ceil(字高 / 2)），見 glyphGeometry.js。
    cellSize: 16,
    // 輸出尺寸＝字高（7~32）：寫進 BDF 檔的最終字高，取樣結果左上角裁切/補白。
    outputSize: 16,

    // 位置偏移：offsetX/offsetY 是「CJK」這組（lockOffsets=true 鎖定時，
    // 非 CJK 字元也共用這組，等同原本單一偏移的行為）。
    offsetX: 0,
    offsetY: 0,
    // 非 CJK 專屬偏移，只有 lockOffsets=false（取消鎖定）時才會實際套用。
    nonCjkOffsetX: 0,
    nonCjkOffsetY: 0,
    // true = CJK／非CJK 共用同一組偏移（預設，行為單純）；
    // false = 兩組偏移各自獨立調整，用於同一條基準線下 CJK 部件跟拉丁字母
    // 下降部（g/j/y 等）伸出去的量不一樣多、單一組偏移調不出兩者都好的結果時。
    // 半形（ASCII）沒有 CJK／非CJK 之分，永遠是 true（UI 上該選項會 disable）。
    lockOffsets: true,

    // 灰階轉黑白門檻值 0~255。Canvas 引擎一定用得到；FreeType 只有 Normal/Light 目標時用得到。
    threshold: 128,

    // 以下四項僅 Canvas 引擎使用。
    gamma: 1.0,
    supersampleFactor: 4,
    antiAlias: true,
    contrast: 0,

    // 以下三項僅 FreeType 引擎使用。
    /** @type {'default'|'forceAutohint'|'noHinting'} */
    freeTypeHinting: 'default',
    freeTypePreferEmbeddedBitmap: true,
    /** @type {'mono'|'normal'|'light'} */
    freeTypeTarget: 'mono',

    // 三種引擎皆適用（對最終黑白點陣做形態學後製，與取樣引擎無關）。
    boldAdjust: 0,
    invert: false,

    // 字元對齊：所有字元（不分 CJK/非 CJK）統一改用 FONT_ASCENT 當基準線，
    // 取代字型本身的全域 ascender。跟預覽格上畫的綠色基準線是同一個數字。
    // 見 main.js 的 computeAscenderOverride()。
    // 預設開啟：BDF 的 BBX yoff 是以 FONT_ASCENT 當基準線算出來的（見 bdfWriter.js），
    // 字也必須真的貼在這條線上，檔頭宣告的基準線才跟實際點陣一致。關閉時字依取樣引擎
    // 自己的 ascender 定位，對 hhea 含大量行距的 CJK 字型（例如 Noto Sans TC）會整批掉出字格。
    alignAllToBaseline: true,
  };
}

export function cloneSettings(settings) {
  return { ...settings };
}
