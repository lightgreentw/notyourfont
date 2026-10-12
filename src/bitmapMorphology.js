// bitmapMorphology.js
//
// 逐行對應原始 WinForms 專案的 BitmapMorphology.cs。
// 這一份是「粗細調整」與「反相」的唯一實作，Canvas 引擎與 FreeType 引擎
// 都呼叫這裡，不各自重複寫一次——原始 C# 版本也是同一個靜態類別被
// GdiGlyphRasterizer / FreeTypeGlyphRasterizer 共用，網頁版比照辦理，
// 確保這個機制的輸出跟 WinForm 版本完全一致。
//
// 點陣圖的資料表示法：{ width, height, data }，data 是長度 width*height 的
// Uint8Array，值為 0 或 1，索引方式為 data[y * width + x]（對應 C# 的 bool[y, x]）。
// 全形格 width === height；半形格 width = ceil(height / 2)，所以不能再假設是正方形。
// 另外可能帶一個 clipped 欄位（取樣引擎回報的「墨跡被格子裁掉」旗標，見
// freetypeRasterizer.js），這裡的函式一律原樣往下傳，不去動它。

/** 正值做膨脹（加粗），負值做侵蝕（變細），重複 |steps| 次，每次以 3x3 鄰域判斷。 */
export function adjustBitmap(width, height, data, steps) {
  if (steps === 0) return data;

  let current = data;
  const iterations = Math.abs(steps);
  const dilate = steps > 0;

  for (let it = 0; it < iterations; it++) {
    const next = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let any = false;
        let all = true;
        for (let dy = -1; dy <= 1; dy++) {
          const ny = y + dy;
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const v = ny >= 0 && ny < height && nx >= 0 && nx < width && current[ny * width + nx] !== 0;
            any = any || v;
            all = all && v;
          }
        }
        next[y * width + x] = (dilate ? any : all) ? 1 : 0;
      }
    }
    current = next;
  }
  return current;
}

/** 反相輸出（黑白互換）。 */
export function invertBitmap(data) {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ? 0 : 1;
  return out;
}

/**
 * 三種引擎共用的最終後製步驟：先做粗細調整，再做反相。
 * 對應 Form1.cs 裡 RasterizeChar 呼叫端在拿到取樣器輸出後的處理順序。
 */
export function postProcess(bitmap, settings) {
  const { width, height } = bitmap;
  let { data } = bitmap;
  if (settings.boldAdjust !== 0) {
    data = adjustBitmap(width, height, data, settings.boldAdjust);
  }
  if (settings.invert) {
    data = invertBitmap(data);
  }
  // 其他欄位（clipped、sampleWidth／sampleHeight…）原樣往下傳。
  return { ...bitmap, data };
}

/**
 * 從 src 左上角對齊調整成 newWidth x newHeight：
 * 比原本小 = 裁切（超出部分捨棄）；比原本大 = 補白（多出來的右側/下側維持空白，
 * Uint8Array 預設就是 0）。寬、高各自獨立判斷（半形格寬是高的一半）。
 * 對應 Form1.cs 的 ResizeTopLeft。
 */
export function resizeTopLeft(bitmap, newWidth, newHeight) {
  const { width, height, data } = bitmap;
  if (width === newWidth && height === newHeight) return bitmap;
  const dst = new Uint8Array(newWidth * newHeight);
  const copyW = Math.min(width, newWidth);
  const copyH = Math.min(height, newHeight);
  for (let y = 0; y < copyH; y++) {
    for (let x = 0; x < copyW; x++) {
      dst[y * newWidth + x] = data[y * width + x];
    }
  }
  return { ...bitmap, width: newWidth, height: newHeight, data: dst };
}
