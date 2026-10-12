// sfntFontInfo.js
//
// 逐行對應原始 WinForms 專案的 SfntFontInfo.cs：直接以二進位方式解析
// sfnt 字型檔（TTF/OTF/TTC）的表格結構，取得 head/hhea 的字型度量，
// 以及 cmap 表所支援的 Unicode 碼位清單。純陣列/位元運算，跟平台完全
// 無關，因此可以逐行搬過來，行為與 WinForm 版本一致。
//
// 限制（與原版相同）：
//  - TTC（字型合集）僅解析第一個字型面。
//  - cmap format 4 在 idRangeOffset != 0 的區段，簡化為「視為有支援」。
//  - 僅支援 BMP（0x0000~0xFFFF）以內的碼位（BMP 以外的數量記在 nonBmpCount，轉檔時會提示）。

export class SfntFontInfo {
  constructor() {
    this.unitsPerEm = 1000;
    this.ascent = 0;
    this.descent = 0;
    this.lineGap = 0;
    /** OS/2 表的 sTypoAscender／sTypoDescender（字型設計者指定的「字面框」上下界）。沒有 OS/2 表時為 0。
     *  很多 CJK 字型（例如 Noto Sans CJK）的 hhea 度量包含大量行距（Noto Sans TC：1160/-288，
     *  em=1000），直接拿來當基準線會讓字整個掉出字格；typo 度量（880/-120）才是字面框。 */
    this.typoAscent = 0;
    this.typoDescent = 0;
    /** cmap 裡 BMP（U+0000–FFFF）以外的碼位數量。這個工具只轉 BMP，報告時要告知有多少字沒轉。 */
    this.nonBmpCount = 0;
    /** @type {string} 從 name 表（nameID=1）取得的家族名稱，找不到時為空字串。 */
    this.familyName = '';
    /** @type {string} 從 name 表（nameID=0）取得的著作權聲明，找不到時為空字串。
     *  轉成 BDF 時會寫進 COPYRIGHT 屬性——BDF 是原字型的衍生物，授權聲明
     *  （OFL 等）需要跟著帶走，不應該轉完就把來源資訊洗掉。 */
    this.copyright = '';
    /** @type {Set<number>} */
    this.supportedCodePoints = new Set();
  }

  /** @param {ArrayBuffer} arrayBuffer */
  static load(arrayBuffer) {
    const info = new SfntFontInfo();
    const dv = new DataView(arrayBuffer);
    const bytes = new Uint8Array(arrayBuffer);
    let pos = 0;

    const u16 = () => { const v = dv.getUint16(pos, false); pos += 2; return v; };
    const i16 = () => { const v = dv.getInt16(pos, false); pos += 2; return v; };
    const u32 = () => { const v = dv.getUint32(pos, false); pos += 4; return v; };

    let fontOffset;
    const tag = u32();
    if (tag === 0x74746366) { // 'ttcf'
      u32(); // version
      const numFonts = u32();
      if (numFonts === 0) throw new Error('TTC 檔案內沒有任何字型。');
      fontOffset = u32(); // 取第一個字型面
    } else {
      fontOffset = 0;
    }

    pos = fontOffset;
    u32(); // sfntVersion
    const numTables = u16();
    u16(); u16(); u16(); // searchRange, entrySelector, rangeShift

    /** @type {Map<string, {offset:number, length:number}>} */
    const tables = new Map();
    for (let i = 0; i < numTables; i++) {
      const tableTag = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      pos += 4;
      u32(); // checksum
      const offset = u32();
      const length = u32();
      tables.set(tableTag, { offset, length });
    }

    if (tables.has('head')) {
      pos = tables.get('head').offset + 18;
      info.unitsPerEm = u16();
    }

    if (tables.has('hhea')) {
      pos = tables.get('hhea').offset + 4;
      info.ascent = i16();
      info.descent = i16();
      info.lineGap = i16();
    } else if (tables.has('OS/2')) {
      pos = tables.get('OS/2').offset + 68;
      info.ascent = i16();
      info.descent = i16();
    }

    if (tables.has('OS/2') && tables.get('OS/2').length >= 72) {
      pos = tables.get('OS/2').offset + 68;
      info.typoAscent = i16();
      info.typoDescent = i16();
    }

    if (tables.has('cmap')) {
      const stats = { nonBmp: 0 };
      readCmap(dv, tables.get('cmap').offset, info.supportedCodePoints, stats);
      info.nonBmpCount = stats.nonBmp;
    }

    if (tables.has('name')) {
      info.familyName = readNameString(dv, bytes, tables.get('name').offset, 1);
      info.copyright = readNameString(dv, bytes, tables.get('name').offset, 0);
    }

    return info;
  }
}

// name 表的單一字串（nameID=1 字型家族名稱、nameID=0 著作權聲明…）：
// 優先取 Windows 平台（platformID=3, UTF-16BE），找不到再退而求其次取 Macintosh
// 平台（platformID=1, 單位元組編碼，僅處理 ASCII 範圍）。
function readNameString(dv, bytes, nameOffset, wantedNameId) {
  let pos = nameOffset;
  const u16 = () => { const v = dv.getUint16(pos, false); pos += 2; return v; };

  const format = u16();
  const count = u16();
  const stringOffsetFromTableStart = u16();
  const storageOffset = nameOffset + stringOffsetFromTableStart;

  let winCandidate = null;
  let macCandidate = null;

  for (let i = 0; i < count; i++) {
    const platformId = u16();
    const encodingId = u16();
    const languageId = u16();
    const nameId = u16();
    const length = u16();
    const offset = u16();

    if (nameId !== wantedNameId) continue;

    const recordOffset = storageOffset + offset;
    if (platformId === 3) {
      // Windows：UTF-16BE，優先取美式英語（languageId 0x0409），沒有就先記下第一筆。
      if (winCandidate === null || languageId === 0x0409) {
        winCandidate = decodeUtf16Be(bytes, recordOffset, length);
      }
    } else if (platformId === 1 && macCandidate === null) {
      // Macintosh：單位元組（多半是 Mac Roman），這裡只安全處理 ASCII 範圍的字元。
      macCandidate = decodeAsciiSubset(bytes, recordOffset, length);
    }
  }

  return winCandidate || macCandidate || '';
}

function decodeUtf16Be(bytes, offset, length) {
  const units = [];
  for (let i = 0; i + 1 < length; i += 2) {
    units.push((bytes[offset + i] << 8) | bytes[offset + i + 1]);
  }
  try {
    return String.fromCharCode(...units).trim();
  } catch {
    return '';
  }
}

function decodeAsciiSubset(bytes, offset, length) {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = bytes[offset + i];
    if (c >= 0x20 && c < 0x7f) s += String.fromCharCode(c);
  }
  return s.trim();
}

function readCmap(dv, cmapOffset, result, stats = { nonBmp: 0 }) {
  let pos = cmapOffset;
  const u16 = () => { const v = dv.getUint16(pos, false); pos += 2; return v; };
  const i16 = () => { const v = dv.getInt16(pos, false); pos += 2; return v; };
  const u32 = () => { const v = dv.getUint32(pos, false); pos += 4; return v; };
  const u8 = () => { const v = dv.getUint8(pos); pos += 1; return v; };

  u16(); // version
  const numTables = u16();

  let bestOffset = 0;
  let bestScore = -1;

  for (let i = 0; i < numTables; i++) {
    const platformId = u16();
    const encodingId = u16();
    const offset = u32();

    let score;
    if (platformId === 3 && encodingId === 10) score = 5;
    else if (platformId === 0 && encodingId === 6) score = 5;
    else if (platformId === 0 && encodingId === 4) score = 4;
    else if (platformId === 3 && encodingId === 1) score = 3;
    else if (platformId === 0 && encodingId === 3) score = 2;
    else if (platformId === 0) score = 1;
    else score = 0;

    if (score > bestScore) {
      bestScore = score;
      bestOffset = cmapOffset + offset;
    }
  }
  if (bestOffset === 0) return;

  pos = bestOffset;
  const format = u16();

  if (format === 4) {
    u16(); // length
    u16(); // language
    const segCountX2 = u16();
    const segCount = segCountX2 / 2;
    u16(); u16(); u16(); // searchRange, entrySelector, rangeShift

    const endCodes = new Array(segCount);
    for (let i = 0; i < segCount; i++) endCodes[i] = u16();
    u16(); // reservedPad
    const startCodes = new Array(segCount);
    for (let i = 0; i < segCount; i++) startCodes[i] = u16();
    const idDeltas = new Array(segCount);
    for (let i = 0; i < segCount; i++) idDeltas[i] = i16();
    const idRangeOffsets = new Array(segCount);
    for (let i = 0; i < segCount; i++) idRangeOffsets[i] = u16();

    for (let s = 0; s < segCount; s++) {
      if (startCodes[s] === 0xFFFF && endCodes[s] === 0xFFFF) continue;
      for (let c = startCodes[s]; c <= endCodes[s] && c !== 0xFFFF; c++) {
        if (idRangeOffsets[s] === 0) {
          // (ushort)(c + idDelta) 的等價寫法：先做 32 位元加法，再遮罩成 16 位元，
          // JS 的位元運算子會先轉成 32 位元有號整數再運算，對負值一樣能得到
          // 正確的「模 65536」結果（跟 C# 的 ushort 轉型行為一致）。
          const gid = (c + idDeltas[s]) & 0xFFFF;
          if (gid !== 0) result.add(c);
        } else {
          // 簡化處理：不逐一計算 glyphIdArray，直接視為支援（與 C# 版本相同的簡化）。
          result.add(c);
        }
      }
    }
  } else if (format === 12) {
    u16(); // reserved
    u32(); // length
    u32(); // language
    const numGroups = u32();
    for (let g = 0; g < numGroups; g++) {
      const startChar = u32();
      const endChar = u32();
      u32(); // startGlyphId
      for (let c = startChar; c <= endChar && c <= 0xFFFF; c++) result.add(c);
      if (endChar > 0xFFFF) stats.nonBmp += endChar - Math.max(startChar, 0x10000) + 1;
    }
  } else if (format === 6) {
    u16(); u16(); // length, language
    const first = u16();
    const count = u16();
    for (let i = 0; i < count; i++) {
      const gid = u16();
      if (gid !== 0) result.add(first + i);
    }
  } else if (format === 0) {
    u16(); u16(); // length, language
    for (let c = 0; c < 256; c++) {
      const gid = u8();
      if (gid !== 0) result.add(c);
    }
  }
}
