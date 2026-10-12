// encodingSchemes.js
//
// 字型輸出編碼方案：決定 BDF 每個字元的 ENCODING 欄位（以及 XLFD 檔名裡的
// registry 欄位）要用哪一種字碼，而不是一律用內部處理時用的 Unicode 碼位。
//
// 「內建 Big5」刻意不是手打或內嵌一份好幾千行的對照表，而是直接借用瀏覽器
// 本身就必須支援的 Big5 legacy decoder——WHATWG Encoding Standard 規定所有
// 主流瀏覽器都要能 `new TextDecoder('big5')`。做法是把所有合法的 Big5
// 雙位元組組合都暴力 decode 一次，反過來建出「Unicode → Big5」對照表。
// 這樣完全不用在程式碼裡塞資料表，準確度等同瀏覽器內建的 Big5（實務上等同
// Microsoft Code Page 950，已經用使用者提供的 CodePage950 對照表逐筆核對過
// 常見範圍，結果一致）。
//
// 這個做法涵蓋標準 Big5 兩個字面等級（常用字＋次常用字），但不包含各家廠商
// 自行擴充的「造字區」擴充字元（例如 ETen 擴充、HKSCS 擴充）——那些屬於
// 非標準延伸，不同瀏覽器／作業系統的對應表本來就不完全一致，所以沒有辦法
// 用「暴力嘗試 decode」這個方法可靠重建。有這類需求的話，請改用下面的
// 「匯入自訂對照表」功能，貼上對應廠商發布的官方對照表。

let cachedBig5Table = null;

/** 惰性建立、快取起來的 Unicode → Big5 對照表（Map<number, number>）。 */
export function getBuiltinBig5Table() {
  if (cachedBig5Table) return cachedBig5Table;

  const map = new Map();
  // ASCII 範圍（0x00–0x7F）在 Big5 裡是單位元組、碼位跟 Unicode 一樣。
  for (let b = 0; b < 0x80; b++) map.set(b, b);

  let decoder;
  try {
    decoder = new TextDecoder('big5', { fatal: false });
  } catch {
    cachedBig5Table = map; // 瀏覽器不支援 Big5 legacy decoder 的話，至少保留 ASCII 範圍
    return cachedBig5Table;
  }

  // Big5 雙位元組範圍：lead 0x81–0xFE，trail 0x40–0x7E 或 0xA1–0xFE
  // （0x7F–0xA0 這段依規範本來就不會出現，直接跳過）。
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail >= 0x7f && trail <= 0xa0) continue;
      const decoded = decoder.decode(new Uint8Array([lead, trail]));
      if (decoded.length !== 1) continue; // 跳過會 decode 成代理對／多碼位序列的組合
      const cp = decoded.codePointAt(0);
      if (cp === 0xfffd || map.has(cp)) continue; // 0xFFFD＝無效位元組組合；重複碼位保留先出現（等級較前面）的那個
      map.set(cp, (lead << 8) | trail);
    }
  }

  cachedBig5Table = map;
  return cachedBig5Table;
}

/**
 * 解析使用者匯入的編碼對照表純文字檔。
 *
 * 支援的格式：每行兩個十六進位數字，中間用空白或 tab 分隔，第一個是目標
 * 編碼的碼、第二個是對應的 Unicode 碼位；兩個數字前綴可以是 `0x` 或 `U+`
 * （兩種混用也可以），# 開頭整行當註解略過。這是坊間 Big5 對照表最常見的
 * 兩種寫法，使用者提供的「中文編碼.zip」裡 CodePage950、Big5-2003、
 * Mozilla 1.8、Big5-HKSCS（*-u2b.txt / *-b2u.txt / hkscs1999.txt /
 * hkscs2001.txt / hkscs2004.txt）全部都在支援範圍內（欄位數多寡不影響，
 * 每行只取前兩個數字，後面不管是註解還是其他附加欄位都會被忽略），例如：
 *   0xA140 0x3000
 *   0x8140	0xEEB8      # <control>
 *   0x8840	U+F303		#
 *
 * 注意：這個 zip 裡「WHATWG Encoding Standard/index-big5.txt」是另一種完全
 * 不同的格式（十進位 pointer + Unicode，且部分碼位需要額外規則換算回雙
 * 位元組碼、跟其他標準檔案不共用同一套換算方式），這裡沒有支援，匯入那個
 * 檔案會被視為 0 筆有效資料——請改用同一個 zip 裡其他資料夾的對照表檔案。
 *
 * @param {string} text
 * @returns {{ map: Map<number, number>, count: number }}
 */
export function parseCustomEncodingTable(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  const hexPairPattern = /^(?:0x|U\+)([0-9a-fA-F]+)\s+(?:0x|U\+)([0-9a-fA-F]+)/i;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(hexPairPattern);
    if (!m) continue;
    const targetCode = parseInt(m[1], 16);
    const unicode = parseInt(m[2], 16);
    if (!map.has(unicode)) map.set(unicode, targetCode); // 重複碼位保留第一筆
  }

  return { map, count: map.size };
}

// BDF 檔案的 XLFD 檔名（FONT 那行）裡，charset registry-encoding 欄位要跟著
// 輸出編碼換，這樣其他程式讀到 BDF 才知道 ENCODING 欄位裡的數字該用哪一套
// 字碼表去解讀，不會誤判成 Unicode。
export const ENCODING_REGISTRY = {
  unicode: 'ISO10646-1',
  utf8: 'ISO10646-1',
  big5: 'big5-0',
  custom: 'custom-0',
};

export const ENCODING_LABELS = {
  unicode: 'Unicode',
  utf8: 'UTF-8',
  big5: 'Big5',
  custom: '自訂／匯入對照表',
};
