// bdfValidator.js
//
// 轉檔完成後，對「實際要給使用者下載的 BDF 文字」做一次規格檢查（Adobe BDF 2.1 與
// X11／XLFD 慣例）。檢查的是輸出檔本身，不是程式裡的中間資料，所以不管日後轉檔流程怎麼
// 改，只要輸出檔違規就會被抓到。
//
// errors   = 違反規格，多數讀取器會讀不進去或讀錯。
// warnings = 技術上讀得進去，但很可能不是你要的結果（宣告值與實際內容不一致等）。

/** @returns {{errors:string[], warnings:string[], glyphCount:number}} */
export function validateBdf(text) {
  const errors = [];
  const warnings = [];
  const MAX_REPORT = 12;
  const err = (m) => { if (errors.length < MAX_REPORT) errors.push(m); else if (errors.length === MAX_REPORT) errors.push('…（還有更多錯誤）'); };
  const warn = (m) => { if (warnings.length < MAX_REPORT) warnings.push(m); else if (warnings.length === MAX_REPORT) warnings.push('…（還有更多警告）'); };

  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();

  // ---- 逐行：純 ASCII、行長 ----
  let nonAscii = 0;
  let tooLong = 0;
  for (const l of lines) {
    if (/[^\x20-\x7e\t]/.test(l)) nonAscii++;
    if (l.length > 255) tooLong++;
  }
  if (nonAscii > 0) err(`有 ${nonAscii} 行含非 ASCII 字元（BDF 必須是純 ASCII）`);
  if (tooLong > 0) err(`有 ${tooLong} 行超過 255 字元（BDF 2.1 的行長上限）`);

  if (!/^STARTFONT\s+2\.[12]$/.test(lines[0] || '')) err('第一行必須是 STARTFONT 2.1');
  if ((lines[lines.length - 1] || '') !== 'ENDFONT') err('最後一行必須是 ENDFONT');

  // ---- 檔頭 ----
  let fontLine = null;
  let size = null;
  let fbb = null;
  const props = new Map();
  let declaredProps = -1;
  let actualProps = 0;
  let declaredChars = -1;
  const glyphs = [];

  const ints = (str, n) => {
    const parts = str.trim().split(/\s+/);
    if (parts.length !== n || !parts.every((p) => /^-?\d+$/.test(p))) return null;
    return parts.map(Number);
  };

  let i = 1;
  while (i < lines.length) {
    const line = lines[i];
    const kw = line.split(/\s+/, 1)[0];
    const rest = line.slice(kw.length).trim();

    if (kw === 'STARTPROPERTIES') {
      declaredProps = parseInt(rest, 10);
      i++;
      while (i < lines.length && lines[i] !== 'ENDPROPERTIES') {
        const k = lines[i].split(/\s+/, 1)[0];
        props.set(k, lines[i].slice(k.length).trim());
        actualProps++;
        i++;
      }
      i++;
      continue;
    }
    if (kw === 'FONT') fontLine = rest;
    else if (kw === 'SIZE') size = ints(rest, 3);
    else if (kw === 'FONTBOUNDINGBOX') {
      fbb = ints(rest, 4);
      if (!fbb) err(`FONTBOUNDINGBOX 格式錯誤：「${rest}」`);
    } else if (kw === 'CHARS') declaredChars = parseInt(rest, 10);
    else if (kw === 'STARTCHAR') {
      const g = { name: rest, line: i + 1, encoding: null, dwidth: null, swidth: null, bbx: null, rows: [] };
      i++;
      let inBitmap = false;
      while (i < lines.length && lines[i] !== 'ENDCHAR') {
        const l = lines[i];
        const k = l.split(/\s+/, 1)[0];
        const r = l.slice(k.length).trim();
        if (inBitmap) g.rows.push(l.trim());
        else if (k === 'ENCODING') g.encoding = ints(r, 1) ? Number(r) : (ints(r, 2) ? Number(r.split(/\s+/)[0]) : null);
        else if (k === 'DWIDTH') g.dwidth = ints(r, 2);
        else if (k === 'SWIDTH') g.swidth = ints(r, 2);
        else if (k === 'BBX') g.bbx = ints(r, 4);
        else if (k === 'BITMAP') inBitmap = true;
        i++;
      }
      glyphs.push(g);
    } else if (kw === 'ENDFONT') break;
    i++;
  }

  if (!fontLine) err('缺少 FONT 行');
  if (!size) err('缺少或格式錯誤的 SIZE 行');
  if (!fbb) err('缺少 FONTBOUNDINGBOX');

  // ---- 屬性 ----
  if (declaredProps < 0) warn('沒有 STARTPROPERTIES');
  else if (declaredProps !== actualProps) err(`STARTPROPERTIES 宣告 ${declaredProps} 個，實際有 ${actualProps} 個`);
  const propInt = (k) => (props.has(k) && /^-?\d+$/.test(props.get(k)) ? Number(props.get(k)) : null);
  const propStr = (k) => (props.has(k) ? props.get(k).replace(/^"|"$/g, '') : null);
  const ascent = propInt('FONT_ASCENT');
  const descent = propInt('FONT_DESCENT');
  if (ascent === null) err('缺少 FONT_ASCENT');
  if (descent === null) err('缺少 FONT_DESCENT');

  // ---- XLFD ----
  let xlfdFields = null;
  if (fontLine) {
    xlfdFields = fontLine.split('-');
    if (xlfdFields.length !== 15 || xlfdFields[0] !== '') {
      err(`FONT 不是 14 欄的 XLFD（以 '-' 分欄實際得到 ${xlfdFields.length - 1} 欄）：${fontLine.slice(0, 70)}`);
      xlfdFields = null;
    }
  }
  if (xlfdFields) {
    // 欄位：['', foundry, family, weight, slant, setwidth, addstyle, pixel, point, resx, resy, spacing, avg, registry, encoding]
    const [, , family, , , , , pixel, , , , spacing, avg] = xlfdFields;
    if (propInt('PIXEL_SIZE') !== null && propInt('PIXEL_SIZE') !== Number(pixel)) warn(`FONT 的像素大小 ${pixel} 與 PIXEL_SIZE ${propInt('PIXEL_SIZE')} 不一致`);
    if (propStr('SPACING') !== null && propStr('SPACING') !== spacing) warn(`FONT 的 SPACING ${spacing} 與 SPACING 屬性 ${propStr('SPACING')} 不一致`);
    if (propInt('AVERAGE_WIDTH') !== null && propInt('AVERAGE_WIDTH') !== Number(avg)) warn(`FONT 的平均字寬 ${avg} 與 AVERAGE_WIDTH ${propInt('AVERAGE_WIDTH')} 不一致`);
    if (propStr('FAMILY_NAME') !== null && propStr('FAMILY_NAME') !== family) warn(`FONT 的家族名稱「${family}」與 FAMILY_NAME「${propStr('FAMILY_NAME')}」不一致`);
    if (size) {
      const px = Number(pixel);
      const fromSize = (size[0] * size[1]) / 72;
      if (Math.abs(fromSize - px) > 0.51) warn(`SIZE（${size[0]} 點、${size[1]} dpi ≈ ${fromSize.toFixed(1)} 像素）與 FONT 的像素大小 ${px} 不一致`);
    }
  }

  // ---- 字元 ----
  if (declaredChars < 0) err('缺少 CHARS');
  else if (declaredChars !== glyphs.length) err(`CHARS 宣告 ${declaredChars} 個，實際有 ${glyphs.length} 個 STARTCHAR`);

  const seenEnc = new Set();
  const seenName = new Set();
  let prevEnc = -Infinity;
  let unsorted = 0;
  const pixelSize = xlfdFields ? Number(xlfdFields[7]) : null;
  const dwidths = new Set();
  let sumDwidth = 0;
  let inkAbove = 0;
  let inkBelow = 0;

  for (const g of glyphs) {
    const tag = `${g.name}（第 ${g.line} 行）`;
    if (g.encoding === null) { err(`${tag}：ENCODING 缺少或格式錯誤`); continue; }
    if (seenEnc.has(g.encoding) && g.encoding >= 0) err(`${tag}：ENCODING ${g.encoding} 重複`);
    seenEnc.add(g.encoding);
    if (g.encoding < prevEnc) unsorted++;
    prevEnc = g.encoding;
    if (seenName.has(g.name)) warn(`${tag}：STARTCHAR 名稱重複`);
    seenName.add(g.name);

    if (!g.dwidth) { err(`${tag}：缺少 DWIDTH`); continue; }
    if (!g.bbx) { err(`${tag}：缺少或格式錯誤的 BBX`); continue; }
    dwidths.add(g.dwidth[0]);
    sumDwidth += g.dwidth[0];
    const [w, h, xo, yo] = g.bbx;

    if (w < 0 || h < 0) err(`${tag}：BBX 寬或高為負數`);
    if (g.rows.length !== h) err(`${tag}：BBX 高 ${h}，但點陣有 ${g.rows.length} 列`);
    const hexLen = 2 * Math.ceil(w / 8);
    for (const row of g.rows) {
      if (!/^[0-9A-Fa-f]*$/.test(row) || row.length !== hexLen) { err(`${tag}：點陣列「${row}」應為 ${hexLen} 個十六進位字元`); break; }
      if (w % 8 !== 0 && hexLen > 0) {
        const lastByte = parseInt(row.slice(-2), 16);
        if (lastByte & ((1 << (8 - (w % 8))) - 1)) { err(`${tag}：點陣列「${row}」右側的補齊位元不是 0`); break; }
      }
    }

    if (g.swidth && pixelSize) {
      const expect = Math.round((g.dwidth[0] * 1000) / pixelSize);
      if (Math.abs(g.swidth[0] - expect) > 1) { warn(`${tag}：SWIDTH ${g.swidth[0]} 與 DWIDTH 換算的 ${expect} 不一致`); }
    }

    if (fbb && w > 0 && h > 0) {
      if (xo < fbb[2] || xo + w > fbb[2] + fbb[0] || yo < fbb[3] || yo + h > fbb[3] + fbb[1]) {
        err(`${tag}：BBX ${g.bbx.join(' ')} 超出 FONTBOUNDINGBOX ${fbb.join(' ')}`);
      }
      if (ascent !== null && yo + h > ascent) inkAbove++;
      if (descent !== null && yo < -descent) inkBelow++;
    }
  }
  if (unsorted > 0) warn(`有 ${unsorted} 個字元的 ENCODING 不是遞增排列（部分讀取器假設遞增）`);
  if (inkAbove > 0) warn(`${inkAbove} 個字元的墨跡超出 FONT_ASCENT 宣告的上緣（X11／FreeType 類程式會裁掉超出的部分）`);
  if (inkBelow > 0) warn(`${inkBelow} 個字元的墨跡超出 FONT_DESCENT 宣告的下緣（X11／FreeType 類程式會裁掉超出的部分）`);

  // ---- DEFAULT_CHAR、字距屬性 ----
  const defaultChar = propInt('DEFAULT_CHAR');
  if (defaultChar !== null && !seenEnc.has(defaultChar)) err(`DEFAULT_CHAR ${defaultChar} 指向不存在的字元`);

  const spacingProp = propStr('SPACING');
  if (spacingProp === 'C' || spacingProp === 'M') {
    if (dwidths.size > 1) err(`SPACING "${spacingProp}"（等寬）但 DWIDTH 不是全部相同（${[...dwidths].slice(0, 6).join('、')}…）`);
    if (fbb && dwidths.size === 1 && [...dwidths][0] !== fbb[0]) warn(`等寬字型的 DWIDTH ${[...dwidths][0]} 與 FONTBOUNDINGBOX 寬 ${fbb[0]} 不同`);
  } else if (spacingProp === 'P' && glyphs.length > 0) {
    const avgProp = propInt('AVERAGE_WIDTH');
    const avgReal = Math.round((sumDwidth / glyphs.length) * 10);
    if (avgProp !== null && Math.abs(avgProp - avgReal) > 1) warn(`AVERAGE_WIDTH ${avgProp} 與實際平均字寬 ${avgReal} 不一致`);
  }

  return { errors, warnings, glyphCount: glyphs.length };
}
