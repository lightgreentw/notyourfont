// glyphGeometry.js
//
// 「全形／半形」的共用規則集中在這個檔案，避免預覽、轉檔、BDF 寫出各自
// 寫一份、日後改規則時漏改其中一處。
//
// 兩種模式（mode）：
//   'full'  全形：格子寬 = 高（CJK、全形英數符號等）。
//   'half'  半形：格子寬 = ceil(高 / 2)（ASCII 英數符號）。
//
// 「字高」才是使用者設定的主參數（取樣尺寸、輸出尺寸都是字高），寬度一律
// 由字高推導，不單獨設定。奇數字高（7, 9, 11, 13, 15…）的半形寬度無條件進位：
//   高 7→4、9→5、11→6、13→7、15→8；偶數高 12→6、14→7、16→8。

export const ASCII_FIRST = 0x20; // 空白
export const ASCII_LAST = 0x7e;  // ~（0x7F DEL 不是可顯示字元，不輸出）

/** 半形格寬：字高除以 2，無條件進位。 */
export function halfWidthOf(height) {
  return Math.ceil(height / 2);
}

/** @param {'full'|'half'} mode @param {number} height */
export function cellWidthFor(mode, height) {
  return mode === 'half' ? halfWidthOf(height) : height;
}

export const MODE_LABELS = { full: '全形', half: '半形' };

/** 可顯示的 ASCII（U+0020–U+007E）。 */
export function isAsciiPrintable(cp) {
  return cp >= ASCII_FIRST && cp <= ASCII_LAST;
}

/**
 * 這個碼位「應該用哪一種格子」：ASCII 可顯示字元歸半形，其餘一律歸全形。
 * 預覽的「模式不符」提示、轉檔時的分流都用這個函式，兩邊的判斷不會不一致。
 *
 * 刻意把 Latin-1 補充（é、ß、¥…）、半形片假名（U+FF61–FF9F）等也歸在「全形」：
 * 它們在這個工具裡走「非 CJK／CJK 全形」輸出，不會混進 _ascii 檔。
 * @returns {'full'|'half'}
 */
export function classifyWidth(cp) {
  return isAsciiPrintable(cp) ? 'half' : 'full';
}

/**
 * 不應該寫進 BDF 的碼位：C0／C1 控制字元（含 DEL）、Unicode 非字元
 * （U+FFFE／U+FFFF）、代理對區（U+D800–DFFF，單獨出現不是合法字元）。
 * 有些字型的 cmap 會把這些碼位對到 .notdef 之類的佔位字形，
 * 轉進 BDF 只會多出一堆沒有意義的「幽靈字元」。
 */
export function isNonExportable(cp) {
  return cp < 0x20
    || (cp >= 0x7f && cp <= 0x9f)
    || (cp >= 0xd800 && cp <= 0xdfff)
    || cp === 0xfffe
    || cp === 0xffff;
}

// ASCII 字形名稱（Adobe Glyph List／X11 BDF 慣用名稱），索引 = 碼位 - 0x20。
// 半形 BDF 的 STARTCHAR 用這些名稱；全形維持 uniXXXX。
const ASCII_NAMES = [
  'space', 'exclam', 'quotedbl', 'numbersign', 'dollar', 'percent', 'ampersand', 'quotesingle',
  'parenleft', 'parenright', 'asterisk', 'plus', 'comma', 'hyphen', 'period', 'slash',
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'colon', 'semicolon', 'less', 'equal', 'greater', 'question', 'at',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'bracketleft', 'backslash', 'bracketright', 'asciicircum', 'underscore', 'grave',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'braceleft', 'bar', 'braceright', 'asciitilde',
];

/** STARTCHAR 名稱：半形 ASCII 用標準字形名，其餘用 uniXXXX。 */
export function bdfGlyphName(codePoint, mode) {
  if (mode === 'half' && isAsciiPrintable(codePoint)) {
    return ASCII_NAMES[codePoint - ASCII_FIRST];
  }
  return `uni${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}
