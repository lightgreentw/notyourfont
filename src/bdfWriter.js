// bdfWriter.js
//
// 對應原始 WinForms 專案的 BdfWriter.cs，輸出格式（含 CRLF 換行、XLFD 命名規則、
// 每行的十六進位點陣資料）沿用 WinForm 版本。網頁版新增的部分：
//   - 格子寬高分離（半形 ASCII 的寬是高的一半），不再假設正方形。
//   - 字元依 ENCODING 由小到大排序輸出（不少 BDF 讀取器假設遞增順序，
//     Big5／自訂編碼下「Unicode 順序」跟「ENCODING 順序」並不相同）。
//   - 半形 ASCII 的 STARTCHAR 用標準字形名（space、exclam、A…），全形維持 uniXXXX。
//   - DEFAULT_CHAR 必須指向「實際存在」的字形；舊版固定寫 0，但輸出裡通常沒有
//     ENCODING 0 的字，等於指向不存在的字元。由呼叫端決定要用哪個字，找不到就省略。
//   - COPYRIGHT 屬性：把來源字型 name 表的著作權聲明帶進去。
//   - XLFD 修正：家族名稱只留英數字（XLFD 以 '-' 分欄，名稱裡有 '-' 或空白會讓欄位數不對，
//     FreeType 之類的讀取器就讀不到 family）；SIZE 與解析度改成自洽的 72 dpi
//     （像素 = 點數，POINT_SIZE = 像素 x 10，SWIDTH 公式剛好是 DWIDTH x 1000 / 像素）。
//   - 基準線一致：BBX／FONTBOUNDINGBOX 的 yoff 以 FONT_ASCENT（基準線所在列）計算，
//     不再假設 FONT_ASCENT + FONT_DESCENT 剛好等於字高；宣告的 ASCENT／DESCENT 如果
//     小於墨跡實際延伸的範圍會自動放大（否則 X11、FreeType 類的程式會把超出的墨跡裁掉）。
//   - 換行字元可選 LF（預設）或 CRLF。

import { bdfGlyphName } from './glyphGeometry.js';

function sanitize(name) {
  const chars = Array.from(name).map((c) => (/[a-zA-Z0-9]/.test(c) ? c : '-'));
  const result = chars.join('');
  return result.trim() === '' ? 'Font' : result;
}

function toHex2(n) {
  return n.toString(16).toUpperCase().padStart(2, '0');
}

/** BDF 字串屬性值：雙引號包起來、內部雙引號寫成兩個、不能有換行。 */
function quoteBdfString(text) {
  return `"${String(text).replace(/[\r\n]+/g, ' ').replace(/"/g, '""')}"`;
}

/**
 * BDF 是 ASCII 文字格式，規格也限制每行長度（2.1 版是 256 位元組）。字型 name 表裡的
 * 授權文字常常很長、還夾雜中日文，所以 COMMENT／COPYRIGHT 一律先轉成純 ASCII
 * （非 ASCII 字元拿掉、空白壓成一個），超長的文字再另外折行。
 */
function asciiOnly(text) {
  return String(text).replace(/[^\x20-\x7e]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** 依單字邊界折成每行不超過 width 個字元。 */
function wrapWords(text, width) {
  const out = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && (line + ' ' + word).length > width) { out.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

const COPYRIGHT_PROPERTY_MAX = 200;
/** 解析度（dpi）：72 時 1 點 = 1 像素，SIZE／POINT_SIZE／SWIDTH 三者才互相自洽。 */
const BDF_RESOLUTION = 72;
const COMMENT_WRAP = 100;

/**
 * @param {object} opts
 * @param {string} opts.fontName
 * @param {'full'|'half'} [opts.mode='full'] 影響字形名稱（half 用 ASCII 標準名稱）
 * @param {number} opts.cellWidth   BDF 字格寬（全形 = 字高；半形 = ceil(字高 / 2)）
 * @param {number} opts.cellHeight  BDF 字格高（字高）
 * @param {number} opts.fontAscent
 * @param {number} opts.fontDescent
 * @param {Array<{codePoint:number, encoding:number, width:number, height:number, data:Uint8Array}>} opts.glyphs
 *   每個 glyph 的 data 必須已經是 cellWidth * cellHeight（width/height 要跟 cellWidth/cellHeight 一致）。
 *   codePoint 是這個字的 Unicode 碼位，用來組 STARTCHAR 名稱；encoding 才是實際寫進
 *   ENCODING 那行的碼——兩者在「Unicode／UTF-8」輸出編碼下是同一個數字，但在
 *   「Big5／自訂對照表」輸出編碼下 encoding 會是換算過的目標編碼碼位。
 *   呼叫端不需要先排序，這裡會依 encoding 遞增排序（不會改動傳入的陣列）。
 * @param {boolean} [opts.proportional=false] true = 不等寬（半形不等寬）：每個字有自己的
 *   DWIDTH，BBX 貼緊墨跡（BDF 標準做法），SPACING 為 "P"，FONTBOUNDINGBOX 取所有字外框的聯集。
 *   此時 glyphs 的每個元素改用 { codePoint, encoding, advance, bbox, data }：
 *   advance = 字寬（DWIDTH，像素）；bbox = { width, height, xoff, yoff } 或 null（完全沒有墨點，
 *   例如空白，輸出 BBX 0 0 0 0）；data = 緊密排列的 bbox.width * bbox.height 點陣。
 *   此時 cellWidth 不使用。false（預設）時完全維持原本等寬的輸出格式。
 * @param {string} [opts.registry='ISO10646-1'] XLFD 檔名裡的 charset registry-encoding 欄位
 *   （例如 Unicode 用 "ISO10646-1"，Big5 用 "big5-0"），讓其他程式讀到 BDF
 *   時知道 ENCODING 欄位裡的數字該用哪一套字碼表解讀。
 * @param {number|null} [opts.defaultChar=null] DEFAULT_CHAR 的 ENCODING 值；null = 不寫這個屬性。
 *   必須是 glyphs 裡確實存在的 encoding，這個檢查由呼叫端負責（見 main.js 的 pickDefaultChar）。
 * @param {string} [opts.copyright=''] 來源字型的著作權聲明（COPYRIGHT 屬性放前 200 個 ASCII 字元，完整 ASCII 部分折成 COMMENT）
 * @param {string[]} [opts.comments=[]] 額外的 COMMENT 行
 * @param {string} [opts.eol='\n'] 換行字元：'\n'（LF，Unix／X11 工具的慣例）或 '\r\n'（CRLF）
 * @param {object|null} [opts.report=null] 傳入一個空物件，寫出時會填入實際寫進檔頭的
 *   { fontAscent, fontDescent, adjusted }——宣告的度量比墨跡實際範圍小時會被放大，
 *   呼叫端可以據此告知使用者。
 * @returns {string} 完整 BDF 檔案內容（含結尾換行）
 */
export function writeBdfFont({
  fontName,
  mode = 'full',
  cellWidth,
  cellHeight,
  fontAscent,
  fontDescent,
  glyphs,
  proportional = false,
  registry = 'ISO10646-1',
  defaultChar = null,
  copyright = '',
  comments = [],
  eol = '\n',
  report = null,
}) {
  const lines = [];
  lines.push('STARTFONT 2.1');
  for (const c of comments) {
    for (const part of wrapWords(asciiOnly(c), COMMENT_WRAP)) lines.push(`COMMENT ${part}`);
  }

  // 著作權聲明：COPYRIGHT 屬性只放前 200 個字元（單行不能太長）；比這長的話，完整的
  // 英文／ASCII 部分另外折成多行 COMMENT，授權條款（OFL 等）才不會在轉檔後遺失。
  const copyrightAscii = asciiOnly(copyright);
  let copyrightProperty = copyrightAscii;
  if (copyrightAscii.length > COPYRIGHT_PROPERTY_MAX) {
    const cut = copyrightAscii.lastIndexOf(' ', COPYRIGHT_PROPERTY_MAX);
    copyrightProperty = copyrightAscii.slice(0, cut > 0 ? cut : COPYRIGHT_PROPERTY_MAX) + ' ...';
    lines.push('COMMENT --- Full copyright / license text of the source font (ASCII part) ---');
    for (const part of wrapWords(copyrightAscii, COMMENT_WRAP)) lines.push(`COMMENT ${part}`);
  }

  // 等寬：字格寬固定，外框 = 整個字格。不等寬：平均字寬取所有字 advance 的平均（單位是
  // 十分之一像素，XLFD 的 AVERAGE_WIDTH 規定），外框取所有字貼緊墨跡 BBX 的聯集。
  let avgWidth = cellWidth * 10;
  let spacing = 'C';
  // 整格 BBX 的垂直定位：基準線在第 fontAscent 列的上緣，點陣底邊（第 cellHeight 列的下緣）
  // 相對基準線的高度是 fontAscent - cellHeight（<= 0 表示在基準線下方）。
  // FONT_ASCENT + FONT_DESCENT == 字高時，這個值就等於 -FONT_DESCENT（舊版固定用的值）。
  const cellBottom = fontAscent - cellHeight;
  let fbb = { width: cellWidth, height: cellHeight, xoff: 0, yoff: cellBottom };
  if (proportional) {
    spacing = 'P';
    const n = Math.max(glyphs.length, 1);
    avgWidth = Math.round((glyphs.reduce((sum, g) => sum + g.advance, 0) / n) * 10);
    const boxes = glyphs.map((g) => g.bbox).filter(Boolean);
    if (boxes.length > 0) {
      const minX = Math.min(...boxes.map((b) => b.xoff));
      const minY = Math.min(...boxes.map((b) => b.yoff));
      const maxX = Math.max(...boxes.map((b) => b.xoff + b.width));
      const maxY = Math.max(...boxes.map((b) => b.yoff + b.height));
      fbb = { width: maxX - minX, height: maxY - minY, xoff: minX, yoff: minY };
    } else {
      fbb = { width: 0, height: 0, xoff: 0, yoff: 0 };
    }
  }

  // 宣告的 ASCENT／DESCENT 必須涵蓋墨跡實際延伸的範圍（外框的上緣與下緣），否則照規格
  // 墨跡超出的部分會被某些程式裁掉。使用者填的值夠大就原樣使用，不夠才放大。
  const declAscent = Math.max(fontAscent, fbb.yoff + fbb.height);
  const declDescent = Math.max(fontDescent, -fbb.yoff);
  if (report) {
    report.fontAscent = declAscent;
    report.fontDescent = declDescent;
    report.adjusted = declAscent !== fontAscent || declDescent !== fontDescent;
  }

  const safeName = sanitize(fontName);
  // XLFD 以 '-' 分成 14 欄：欄位值不能含 '-'（也避免空白），家族名稱只留英數字。
  const xlfdFamily = String(fontName).replace(/[^a-zA-Z0-9]+/g, '') || 'Font';
  const pointSize = cellHeight * 10; // 72 dpi：1 點 = 1 像素，POINT_SIZE 是十分之一點
  const xlfd = `-Custom-${xlfdFamily}-Medium-R-Normal--${cellHeight}-${pointSize}-${BDF_RESOLUTION}-${BDF_RESOLUTION}-${spacing}-${avgWidth}-${registry}`;
  lines.push(`FONT ${xlfd}`);
  lines.push(`SIZE ${cellHeight} ${BDF_RESOLUTION} ${BDF_RESOLUTION}`);
  lines.push(`FONTBOUNDINGBOX ${fbb.width} ${fbb.height} ${fbb.xoff} ${fbb.yoff}`);

  const props = [];
  props.push(`FONT_ASCENT ${declAscent}`);
  props.push(`FONT_DESCENT ${declDescent}`);
  // XLFD 的 14 個欄位各自也要有對應的屬性（FONT 那行與這些屬性必須一致）。
  props.push('FOUNDRY "Custom"');
  props.push(`FAMILY_NAME ${quoteBdfString(xlfdFamily)}`);
  props.push('WEIGHT_NAME "Medium"');
  props.push('SLANT "R"');
  props.push('SETWIDTH_NAME "Normal"');
  props.push('ADD_STYLE_NAME ""');
  props.push(`POINT_SIZE ${pointSize}`);
  props.push(`RESOLUTION_X ${BDF_RESOLUTION}`);
  props.push(`RESOLUTION_Y ${BDF_RESOLUTION}`);
  // XLFD 標準屬性：沒有這幾個的時候，FreeType 之類的讀取器只能從 FONT 那行猜，
  // 例如半形檔會被當成「寬 11」。AVERAGE_WIDTH 是十分之一像素為單位的平均字寬。
  props.push(`PIXEL_SIZE ${cellHeight}`);
  props.push(`AVERAGE_WIDTH ${avgWidth}`);
  props.push(`SPACING "${spacing}"`);
  const dash = registry.lastIndexOf('-');
  if (dash > 0) {
    props.push(`CHARSET_REGISTRY ${quoteBdfString(registry.slice(0, dash))}`);
    props.push(`CHARSET_ENCODING ${quoteBdfString(registry.slice(dash + 1))}`);
  }
  if (defaultChar !== null && defaultChar !== undefined) props.push(`DEFAULT_CHAR ${defaultChar}`);
  props.push(`FONT_NAME ${quoteBdfString(safeName)}`);
  if (copyrightProperty) props.push(`COPYRIGHT ${quoteBdfString(copyrightProperty)}`);

  lines.push(`STARTPROPERTIES ${props.length}`);
  for (const p of props) lines.push(p);
  lines.push('ENDPROPERTIES');

  const sorted = [...glyphs].sort((a, b) => a.encoding - b.encoding);
  lines.push(`CHARS ${sorted.length}`);

  if (proportional) {
    for (const { codePoint, encoding, advance, bbox, data } of sorted) {
      lines.push(`STARTCHAR ${bdfGlyphName(codePoint, mode)}`);
      lines.push(`ENCODING ${encoding}`);
      lines.push(`SWIDTH ${Math.round((advance * 1000) / Math.max(cellHeight, 1))} 0`);
      lines.push(`DWIDTH ${advance} 0`);
      if (bbox) {
        lines.push(`BBX ${bbox.width} ${bbox.height} ${bbox.xoff} ${bbox.yoff}`);
        lines.push('BITMAP');
        const rowBytesCount = Math.floor((bbox.width + 7) / 8);
        for (let y = 0; y < bbox.height; y++) {
          const rowBytes = new Uint8Array(rowBytesCount);
          for (let x = 0; x < bbox.width; x++) {
            if (data[y * bbox.width + x]) rowBytes[x >> 3] |= 1 << (7 - (x & 7));
          }
          let hex = '';
          for (let b = 0; b < rowBytes.length; b++) hex += toHex2(rowBytes[b]);
          lines.push(hex);
        }
      } else {
        // 沒有任何墨點（空白字元）：BBX 0 0 0 0，BITMAP 後面不放資料列。
        lines.push('BBX 0 0 0 0');
        lines.push('BITMAP');
      }
      lines.push('ENDCHAR');
    }
    lines.push('ENDFONT');
    return lines.join(eol) + eol;
  }

  const bytesPerRow = Math.floor((cellWidth + 7) / 8);

  for (const { codePoint, encoding, width, data } of sorted) {
    lines.push(`STARTCHAR ${bdfGlyphName(codePoint, mode)}`);
    lines.push(`ENCODING ${encoding}`);
    lines.push(`SWIDTH ${Math.round((cellWidth * 1000) / Math.max(cellHeight, 1))} 0`);
    lines.push(`DWIDTH ${cellWidth} 0`);
    lines.push(`BBX ${cellWidth} ${cellHeight} 0 ${cellBottom}`);
    lines.push('BITMAP');

    for (let y = 0; y < cellHeight; y++) {
      const rowBytes = new Uint8Array(bytesPerRow);
      for (let x = 0; x < cellWidth; x++) {
        if (data[y * width + x]) {
          const byteIndex = Math.floor(x / 8);
          const bitIndex = 7 - (x % 8);
          rowBytes[byteIndex] |= 1 << bitIndex;
        }
      }
      let hex = '';
      for (let b = 0; b < rowBytes.length; b++) hex += toHex2(rowBytes[b]);
      lines.push(hex);
    }
    lines.push('ENDCHAR');
  }

  lines.push('ENDFONT');

  return lines.join(eol) + eol;
}
