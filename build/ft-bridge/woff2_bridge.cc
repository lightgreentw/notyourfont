// woff2_bridge.cc
//
// 包裝 Google 官方 woff2 函式庫（https://github.com/google/woff2）的解碼功能，
// 編譯成 WebAssembly 供瀏覽器端使用。WOFF2 本質上就是 TTF/OTF 用 Brotli
// 壓縮、外加對 glyf/loca 表做過重新編碼的容器格式；解壓縮之後拿到的資料
// 在位元層級上跟原始 TTF/OTF 完全相同，光柵化品質不會因為來源是 WOFF2 而
// 有任何差異——這裡的目的單純是「支援讀取這種容器格式」，不是「改善轉檔
// 品質」。
//
// 用 WOFF2StringOut（動態成長的 std::string 緩衝區）接解碼輸出，而不是
// 事先呼叫 ComputeWOFF2FinalSize() 配置固定大小的緩衝——WOFF2 官方文件
// 特別註明 ComputeWOFF2FinalSize 在某些邊緣情況下可能跟實際解壓後的大小
// 對不上，用會自動成長的字串緩衝更穩妥，不會因為預估錯誤而截斷資料。

#include <woff2/decode.h>
#include <woff2/output.h>
#include <emscripten.h>
#include <string>
#include <cstring>
#include <cstdlib>

// 模組層級的暫存輸出緩衝：每次呼叫 woff2_decode 會先清空重用。
// 因為 JS 端呼叫完 woff2_decode 後會立刻讀取 woff2_get_output_ptr() 指到的
// 資料、複製成自己的 Uint8Array，所以不需要每次呼叫都重新配置一塊記憶體，
// 也不需要呼叫端手動釋放。
static std::string g_output;

extern "C" {

// 解碼 WOFF2 資料成 SFNT（TTF/OTF）格式。
// 回傳值：解碼成功時是輸出資料的 byte 長度（一定 > 0）；
//        0 表示解碼失敗——資料不是合法的 WOFF2、或者資料已損毀。
// 呼叫端流程：
//   1. n = woff2_decode(dataPtr, dataLen)
//   2. 若 n > 0，呼叫 woff2_get_output_ptr() 拿到指標，從 wasm heap 讀 n bytes
//      出來複製成自己的資料（複製出來後就跟這個模組的記憶體生命週期無關了）。
EMSCRIPTEN_KEEPALIVE
size_t woff2_decode(const uint8_t* data, size_t length) {
    g_output.clear();
    woff2::WOFF2StringOut out(&g_output);
    // kDefaultMaxSize（128MB）已經是很寬鬆的上限，一般字型檔不可能解壓到這麼大，
    // 這裡沿用函式庫預設值，不做額外限制。
    bool ok = woff2::ConvertWOFF2ToTTF(data, length, &out);
    if (!ok) {
        g_output.clear();
        return 0;
    }
    return g_output.size();
}

EMSCRIPTEN_KEEPALIVE
const uint8_t* woff2_get_output_ptr() {
    return reinterpret_cast<const uint8_t*>(g_output.data());
}

// 給 JS 端配置輸入緩衝區用（把要解碼的 WOFF2 原始 bytes 複製進 wasm heap）。
EMSCRIPTEN_KEEPALIVE
uint8_t* woff2_alloc_input(size_t size) {
    return (uint8_t*)malloc(size);
}

EMSCRIPTEN_KEEPALIVE
void woff2_free_input(uint8_t* ptr) {
    free(ptr);
}

} // extern "C"
