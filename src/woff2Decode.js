// woff2Decode.js
//
// 包裝 wasm/woff2.wasm（由 build/woff2-bridge/woff2_bridge.cc 編譯而成，
// 連結的是 Google 官方 woff2 函式庫的解碼器本體）。
//
// WOFF2 本質上是 TTF/OTF 用 Brotli 壓縮、外加對 glyf/loca 表重新編碼的容器
// 格式，解壓縮後的資料在位元層級上跟原始 TTF/OTF 完全相同——不會因為來源
// 是 WOFF2 就讓點陣轉換的品質有任何差異，這裡純粹是「支援讀取這種容器格式」。
//
// 這一層刻意設計成「透明通過」：呼叫 decodeIfWoff2() 時，如果傳入的資料不是
// WOFF2（沒有 'wOF2' 開頭簽章），直接原封不動把同一個 ArrayBuffer 傳回去，
// 不會多做任何事、也不會載入 wasm 模組。這樣 main.js 可以無條件對每個載入的
// 字型檔都呼叫這個函式，不用自己先判斷格式。

let modulePromise = null;
function getModule() {
  if (!modulePromise) {
    modulePromise = import('../wasm/woff2.mjs').then((m) => m.default());
  }
  return modulePromise;
}

const WOFF2_SIGNATURE = 0x774f4632; // 'wOF2'，big-endian 讀法

/** @param {ArrayBuffer} buffer @returns {boolean} */
export function isWoff2(buffer) {
  if (buffer.byteLength < 4) return false;
  const dv = new DataView(buffer);
  return dv.getUint32(0, false) === WOFF2_SIGNATURE;
}

/**
 * 如果傳入的是 WOFF2，解碼成 SFNT（TTF/OTF）格式回傳；不是 WOFF2 就原封不動
 * 傳回同一個 ArrayBuffer（不複製、不檢查其他格式），呼叫端可以無條件使用。
 * @param {ArrayBuffer} buffer
 * @returns {Promise<ArrayBuffer>}
 */
export async function decodeIfWoff2(buffer) {
  if (!isWoff2(buffer)) return buffer;

  const Module = await getModule();
  const input = new Uint8Array(buffer);
  const inPtr = Module._malloc(input.length);
  Module.HEAPU8.set(input, inPtr);

  let outSize;
  try {
    outSize = Module.ccall(
      'woff2_decode',
      'number',
      ['number', 'number'],
      [inPtr, input.length],
    );
  } finally {
    Module._free(inPtr);
  }

  if (outSize === 0) {
    throw new Error('WOFF2 解碼失敗：檔案可能已損毀，或不是合法的 WOFF2 格式。');
  }

  const outPtr = Module.ccall('woff2_get_output_ptr', 'number', [], []);
  const view = Module.HEAPU8.subarray(outPtr, outPtr + outSize);
  // 複製出來，脫離 wasm heap 生命週期（下一次呼叫 woff2_decode 會覆寫這塊記憶體）。
  return view.slice().buffer;
}
