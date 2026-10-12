// cjkDetect.js
//
// 判斷一個 Unicode 碼位是否屬於「CJK 類」文字（漢字、假名、諺文等東亞文字）。
// 用於「CJK／非CJK 分開偏移」功能：同一條基準線下，CJK 部件跟拉丁字母的
// 下降部（g/j/y 等）伸出去的量常常不一樣多，單一組「位置偏移」不夠用時，
// 分開兩組獨立微調。
//
// 這裡只涵蓋 BMP（0000–FFFF）範圍，跟這個工具本身的碼位範圍限制一致。
// 範圍表刻意保守但夠用：涵蓋漢字（含擴充A）、假名、注音、諺文、CJK 標點符號、
// 半形假名／諺文等最常見的 CJK 相關區塊；沒有列進來的字一律視為「非 CJK」。
//
// 「全形拉丁字母／數字／符號」（Unicode 的 Halfwidth and Fullwidth Forms
// 區塊裡，U+FF01–FF5E、U+FF5F–FF60、U+FFE0–FFE6 這幾段，形狀上是英文字母、
// 阿拉伯數字、標點符號被畫成全形寬度，本質上還是拉丁字母/數字/符號，只是
// 排版寬度跟 CJK 對齊）刻意「不」算進 CJK——這樣才能跟真正的漢字/假名/諺文
// 分開偏移，而不是被綁在一起用同一組數值調整。同一個區塊裡真正的東亞文字
// （半形假名、半形諺文、半形 CJK 標點）則維持算 CJK，見下面 CJK_RANGES 裡
// 拆開的三段。
const CJK_RANGES = [
  [0x2e80, 0x2eff], // CJK Radicals Supplement
  [0x2f00, 0x2fdf], // Kangxi Radicals
  [0x3000, 0x303f], // CJK Symbols and Punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3100, 0x312f], // Bopomofo（注音）
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x3190, 0x319f], // Kanbun
  [0x31a0, 0x31bf], // Bopomofo Extended
  [0x31c0, 0x31ef], // CJK Strokes
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3200, 0x32ff], // Enclosed CJK Letters and Months
  [0x3300, 0x33ff], // CJK Compatibility
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs（常用漢字主要範圍）
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables（諺文）
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  // Halfwidth and Fullwidth Forms 區塊（0xFF00–0xFFEF）裡，只有下面這三段
  // 真正是東亞文字本身，算 CJK；U+FF01–FF60（全形拉丁字母/數字/標點）跟
  // U+FFE0–FFE6（全形貨幣/技術符號）刻意不列進來，讓它們被歸類成非 CJK。
  [0xff61, 0xff9f], // Halfwidth CJK 標點 + 半形片假名
  [0xffa0, 0xffdc], // Halfwidth Hangul（半形諺文）
  [0xffe8, 0xffee], // Halfwidth Forms（半形箭頭等相容符號）
];

/** @param {number} codePoint @returns {boolean} */
export function isCjkCodePoint(codePoint) {
  for (const [start, end] of CJK_RANGES) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
}
