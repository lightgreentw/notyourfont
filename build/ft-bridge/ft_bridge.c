// ft_bridge.c
//
// 這個檔案是 WinForms 版 FreeTypeGlyphRasterizer.cs 的逐行 C 移植版本，
// 直接呼叫真正的 FreeType C API（跟原本 FreeTypeSharp 綁定呼叫的是同一顆函式庫），
// 使用完全相同的載入旗標（FT_LOAD_RENDER / FT_LOAD_TARGET_MONO 等）與相同的
// 定位公式（前進寬度置中 + bitmap_left/bitmap_top + ascender 基準線），
// 因此在同一個 FreeType 版本下，輸出的點陣應與 WinForms 版本逐像素一致。
//
// 刻意不在這裡做 BoldAdjust（粗細調整）與 Invert（反相），這兩個步驟在
// C# 原始版本中是共用的 BitmapMorphology 靜態類別，GDI+ 與 FreeType 兩個引擎
// 共用同一份實作；網頁版比照辦理，把這兩步搬到 JS 的共用模組，兩個引擎
// （Canvas 版 GDI+ 替代品、這裡的 FreeType-WASM）都呼叫同一份 JS 實作，
// 確保「粗細調整」這個機制跟 WinForm 版本完全一致，不會因為在 C 跟 JS
// 各自重複實作一次而出現差異。

#include <ft2build.h>
#include FT_FREETYPE_H
#include <stdlib.h>
#include <string.h>
#include <emscripten.h>

typedef struct {
    FT_Library library;
    FT_Face face;
    unsigned char *font_buffer;
    int loaded_pixel_size;
} FTContext;

// ---- 生命週期 ----

EMSCRIPTEN_KEEPALIVE
FTContext *ft_create_face(const unsigned char *data, int length) {
    FTContext *ctx = (FTContext *)malloc(sizeof(FTContext));
    if (!ctx) return NULL;
    ctx->loaded_pixel_size = -1;
    ctx->face = NULL;
    ctx->font_buffer = NULL;

    if (FT_Init_FreeType(&ctx->library) != 0) {
        free(ctx);
        return NULL;
    }

    ctx->font_buffer = (unsigned char *)malloc((size_t)length);
    if (!ctx->font_buffer) {
        FT_Done_FreeType(ctx->library);
        free(ctx);
        return NULL;
    }
    memcpy(ctx->font_buffer, data, (size_t)length);

    // 固定載入第 0 個字型面（TTC 僅支援第一個），與 C# 版本行為一致。
    if (FT_New_Memory_Face(ctx->library, ctx->font_buffer, length, 0, &ctx->face) != 0) {
        FT_Done_FreeType(ctx->library);
        free(ctx->font_buffer);
        free(ctx);
        return NULL;
    }

    return ctx;
}

EMSCRIPTEN_KEEPALIVE
void ft_destroy_face(FTContext *ctx) {
    if (!ctx) return;
    if (ctx->face) FT_Done_Face(ctx->face);
    if (ctx->library) FT_Done_FreeType(ctx->library);
    if (ctx->font_buffer) free(ctx->font_buffer);
    free(ctx);
}

// 家族名稱：回傳指向 FreeType 內部緩衝的指標，呼叫端（JS）在字型存活期間讀取即可，
// 不需要另外釋放。
EMSCRIPTEN_KEEPALIVE
const char *ft_family_name(FTContext *ctx) {
    if (!ctx || !ctx->face || !ctx->face->family_name) return "";
    return ctx->face->family_name;
}

EMSCRIPTEN_KEEPALIVE
unsigned int ft_get_char_index(FTContext *ctx, unsigned int codepoint) {
    if (!ctx || !ctx->face) return 0;
    return (unsigned int)FT_Get_Char_Index(ctx->face, codepoint);
}

// ---- 點陣渲染：逐行對應 FreeTypeGlyphRasterizer.cs 的 RasterizeChar ----
//
// 格子是 cell_w x cell_h（寬、高分開）：
//   - 全形：cell_w == cell_h（跟舊版 cell_size x cell_size 完全相同）。
//   - 半形（ASCII）：cell_w = ceil(cell_h / 2)，由呼叫端（JS）算好傳進來。
// FreeType 的像素尺寸（FT_Set_Pixel_Sizes）永遠以「字高 cell_h」為準——字體大小
// 由高度決定，寬度只是這個格子最後裁出多寬的範圍，跟 BDF 的 SIZE／PIXEL_SIZE
// 的語意一致。
//
// hinting_mode: 0=Default(字型內建提示) 1=ForceAutohint 2=NoHinting
// target:       0=Mono(預設)            1=Normal         2=Light
// ascender_override: -1 表示使用字型本身的 ascender（原本行為）；
//                     >=0 則改用這個值當作基準線列（「字元對齊基準線」功能，
//                     見 main.js 的 computeAscenderOverride()）。
// out_grid 必須是呼叫端配置好的 buf_w*buf_h bytes 緩衝區（buf 與 cell 的分工見 rasterize_impl 上方），
// 內容為 0/1（1=黑），對應 BoldAdjust/Invert 之前的原始判定結果。
//
// 回傳值：
//   負值 = 發生錯誤（-1 參數錯誤、-2 FT_Set_Pixel_Sizes 失敗、-3 記憶體不足）。
//   >= 0 = 成功（含「字型不支援此字碼 → 全空白格」與「空白字元」等正常情況），
//          且數值是「裁切旗標」的位元組合：
//            bit0 (1) = 有「會被判成黑點」的墨跡因為超出格子左/右邊界而被丟棄
//            bit1 (2) = 有「會被判成黑點」的墨跡因為超出格子上/下邊界而被丟棄
//          舊版回傳值永遠是 0，呼叫端如果不看回傳值，行為跟以前完全一樣。
//          半形格比較窄，M / W / @ 這類寬字很容易被擠出邊界，JS 端靠這個旗標
//          在預覽與轉檔報告裡提醒使用者。
//
// 內部實作：ft_rasterize_char（全形／半形等寬）與 ft_rasterize_prop（半形不等寬）
// 共用同一份渲染邏輯，只差在水平方向怎麼決定筆位（pen_x）：
//   use_fixed_pen = 0：把「字寬（advance 與墨跡寬取大者）」置中在 cell_w 裡
//                       （原本的行為，全形與半形等寬都走這條，輸出與舊版逐像素相同）。
//   use_fixed_pen = 1：筆位固定在 fixed_pen_x（不置中），字貼著自己的自然原點，
//                       讓 JS 端自己依 advance／bearing 決定要裁哪一段（不等寬用）。
// 畫布大小 buf_w x buf_h 與「取樣格」cell_w x cell_h 分開：
//   cell_h = 取樣字高 = FreeType 的像素尺寸（字體大小）；cell_w 只用來把字置中（use_fixed_pen = 0 時）。
//   buf_w x buf_h = 實際的畫布與裁切邊界，呼叫端傳 max(取樣, 輸出)。這樣「輸出尺寸比取樣尺寸大」時，
//   落在多出來那幾列／欄裡的墨跡（例如取樣 23、輸出 24 時，第 24 列的下降部）會保留下來，
//   而不是被取樣格的邊界丟掉再補一列空白。buf == cell 時（取樣＝輸出）行為與舊版逐像素相同。
// out_info（可為 NULL）：int[3]，成功載入字形後填入
//   [0] = slot->advance.x（26.6 定點數；NoHinting 時是未取整的實際字寬）
//   [1] = slot->bitmap_left   [2] = slot->bitmap_top
// 字型不支援此字碼或載入失敗時維持呼叫端給的初始值（JS 端會先清成 0）。
static int rasterize_impl(
    FTContext *ctx,
    unsigned int codepoint,
    int cell_w,
    int cell_h,
    int buf_w,
    int buf_h,
    int hinting_mode,
    int prefer_embedded_bitmap,
    int target,
    int offset_x,
    int offset_y,
    int threshold,
    int ascender_override,
    unsigned char *out_grid,
    int use_fixed_pen,
    int fixed_pen_x,
    int *out_info
) {
    if (!ctx || !ctx->face || !out_grid) return -1;

    if (cell_w <= 0 || cell_h <= 0 || buf_w <= 0 || buf_h <= 0) return -1;

    memset(out_grid, 0, (size_t)(buf_w * buf_h));

    if (ctx->loaded_pixel_size != cell_h) {
        if (FT_Set_Pixel_Sizes(ctx->face, 0, (FT_UInt)cell_h) != 0) return -2;
        ctx->loaded_pixel_size = cell_h;
    }

    FT_UInt glyph_index = FT_Get_Char_Index(ctx->face, codepoint);
    if (glyph_index == 0) return 0; // 字型不支援此字碼 -> 全空白格

    FT_Int32 flags = FT_LOAD_RENDER;
    switch (hinting_mode) {
        case 1: flags |= FT_LOAD_FORCE_AUTOHINT; break;
        case 2: flags |= FT_LOAD_NO_HINTING; break;
        default: break; // 字型內建提示，若無則 FreeType 自動退回自動提示
    }
    if (!prefer_embedded_bitmap) {
        flags |= FT_LOAD_NO_BITMAP;
    }

    FT_Int32 target_flag;
    switch (target) {
        case 1: target_flag = FT_LOAD_TARGET_NORMAL; break;
        case 2: target_flag = FT_LOAD_TARGET_LIGHT; break;
        default: target_flag = FT_LOAD_TARGET_MONO; break;
    }
    flags |= target_flag;

    if (FT_Load_Glyph(ctx->face, glyph_index, flags) != 0) return 0;

    FT_GlyphSlot slot = ctx->face->glyph;
    FT_Bitmap bitmap = slot->bitmap;

    if (out_info) {
        out_info[0] = (int)slot->advance.x;
        out_info[1] = (int)slot->bitmap_left;
        out_info[2] = (int)slot->bitmap_top;
    }

    int bw = (int)bitmap.width;
    int bh = (int)bitmap.rows;
    if (bw <= 0 || bh <= 0 || bitmap.buffer == NULL) return 0; // 空白字元（例如空格）

    int advance_x = (int)(slot->advance.x >> 6);
    int ascender_px = (ascender_override >= 0)
        ? ascender_override
        : (int)(ctx->face->size->metrics.ascender >> 6);

    int max_adv = advance_x > bw ? advance_x : bw;
    int pen_x = use_fixed_pen ? (fixed_pen_x + offset_x) : ((cell_w - max_adv) / 2 + offset_x);
    int origin_x = pen_x + slot->bitmap_left;
    int origin_y = ascender_px - slot->bitmap_top + offset_y;

    int pitch = bitmap.pitch;
    int abs_pitch = pitch < 0 ? -pitch : pitch;
    unsigned char *buffer_base = bitmap.buffer;
    int bottom_up = pitch < 0;

    int is_mono_bitmap = (bitmap.pixel_mode == FT_PIXEL_MODE_MONO);

    unsigned char *ink_gray = (unsigned char *)calloc((size_t)(buf_w * buf_h), 1);
    if (!ink_gray) return -3;

    int clip_flags = 0;
    // 灰階模式下「會被判成黑點」的墨色下限：brightness = 255 - v <= threshold
    // 也就是 v >= 255 - threshold。裁切旗標只計算「真的會變成黑點」的像素，
    // 抗鋸齒邊緣的極淡灰階掉到格子外面不算（不然幾乎每個字都會誤報）。
    int ink_min = is_mono_bitmap ? 1 : (255 - threshold);
    if (ink_min < 1) ink_min = 1;

    for (int row = 0; row < bh; row++) {
        int dest_y = origin_y + row;
        int y_out = (dest_y < 0 || dest_y >= buf_h);

        int source_row = bottom_up ? (bh - 1 - row) : row;
        unsigned char *row_ptr = buffer_base + (long)source_row * abs_pitch;

        for (int col = 0; col < bw; col++) {
            int dest_x = origin_x + col;
            int x_out = (dest_x < 0 || dest_x >= buf_w);

            unsigned char ink_value;
            if (is_mono_bitmap) {
                int byte_index = col >> 3;
                int bit_index = 7 - (col & 7);
                ink_value = (row_ptr[byte_index] & (1 << bit_index)) ? 255 : 0;
            } else {
                ink_value = row_ptr[col];
            }

            if (x_out || y_out) {
                if (ink_value >= ink_min) {
                    if (x_out) clip_flags |= 1;
                    if (y_out) clip_flags |= 2;
                }
                continue;
            }

            unsigned char *cell = &ink_gray[dest_y * buf_w + dest_x];
            if (ink_value > *cell) *cell = ink_value;
        }
    }

    for (int y = 0; y < buf_h; y++) {
        for (int x = 0; x < buf_w; x++) {
            unsigned char v = ink_gray[y * buf_w + x];
            int black;
            if (is_mono_bitmap) {
                black = v != 0;
            } else {
                int brightness = 255 - v;
                black = brightness <= threshold;
            }
            out_grid[y * buf_w + x] = black ? 1 : 0;
        }
    }

    free(ink_gray);
    return clip_flags;
}

// 全形／半形（等寬）：格子是 cell_w x cell_h，字置中在格子裡。行為與重構前完全相同。
EMSCRIPTEN_KEEPALIVE
int ft_rasterize_char(
    FTContext *ctx,
    unsigned int codepoint,
    int cell_w,
    int cell_h,
    int buf_w,
    int buf_h,
    int hinting_mode,
    int prefer_embedded_bitmap,
    int target,
    int offset_x,
    int offset_y,
    int threshold,
    int ascender_override,
    unsigned char *out_grid
) {
    return rasterize_impl(ctx, codepoint, cell_w, cell_h, buf_w, buf_h, hinting_mode,
                          prefer_embedded_bitmap, target, offset_x, offset_y, threshold,
                          ascender_override, out_grid, 0, 0, NULL);
}

// 半形（不等寬）：在一塊比較寬的暫存格（scratch_w x scratch_h，scratch_h >= cell_h）裡，把字的原點固定放在
// x = pen_x（不置中），並回報這個字的 advance／bitmap_left／bitmap_top（out_info，int[3]，
// 說明見 rasterize_impl）。JS 端再依 advance 決定要從暫存格裡裁出哪一段、算出貼緊墨跡的 BBX。
// 水平偏移不在這裡處理（offset_x 固定當 0）：偏移的語意是「墨跡在字寬框內平移」，
// 由 JS 端平移裁切視窗達成，不需要 C 端參與。
// 回傳值與 ft_rasterize_char 相同（負值 = 錯誤；其餘為裁切旗標，但相對的是暫存格邊界，
// 不等寬模式的水平裁切由 JS 端自己判斷，只有 bit1（上下）有參考價值）。
EMSCRIPTEN_KEEPALIVE
int ft_rasterize_prop(
    FTContext *ctx,
    unsigned int codepoint,
    int scratch_w,
    int cell_h,
    int scratch_h,
    int pen_x,
    int hinting_mode,
    int prefer_embedded_bitmap,
    int target,
    int offset_y,
    int threshold,
    int ascender_override,
    unsigned char *out_grid,
    int *out_info
) {
    // 暫存格高 scratch_h = max(取樣字高, 輸出字高)，原因見 rasterize_impl 的說明。
    return rasterize_impl(ctx, codepoint, scratch_w, cell_h, scratch_w, scratch_h, hinting_mode,
                          prefer_embedded_bitmap, target, 0, offset_y, threshold,
                          ascender_override, out_grid, 1, pen_x, out_info);
}

// 配置/釋放給 JS 端使用的暫存緩衝區（避免每次呼叫都要在 JS 端手動管理 HEAPU8 offset）。
EMSCRIPTEN_KEEPALIVE
unsigned char *ft_alloc_buffer(int size) {
    return (unsigned char *)malloc((size_t)size);
}

EMSCRIPTEN_KEEPALIVE
void ft_free_buffer(unsigned char *ptr) {
    free(ptr);
}
