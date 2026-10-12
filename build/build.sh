#!/usr/bin/env bash
# build.sh —— 從官方 FreeType 原始碼重新編譯 wasm/freetype.wasm + wasm/freetype.mjs。
#
# 這個腳本記錄了 wasm/ 目錄下那兩個檔案是「怎麼來的」，讓任何人都能在自己的機器上
# （或 CI）重新產生一模一樣的成品，不必相信/依賴我事先編好的二進位檔。
#
# 用法：
#   bash build/build.sh
#
# 執行環境：Ubuntu 24.04（GitHub Actions 的 ubuntu-latest 目前就是這個版本）。
# 全部相依套件都來自 Ubuntu 官方 apt 來源（archive.ubuntu.com）與官方 FreeType
# GitHub 專案，不需要另外安裝 emsdk。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK_DIR="$(mktemp -d)"
FREETYPE_TAG="VER-2-13-3"
# google/woff2 跟 google/brotli 沒有適合釘選的近期 release tag（本來就是很少更動
# 的穩定參考實作），改成直接釘住測試過、確認可行的 commit SHA，一樣能保證
# 重新建置時原始碼是同一份，不會因為對方 repo 之後有新 commit 而跑出不同結果。
WOFF2_COMMIT="fb9c3379f2605b10f3e8f1d9636664ab5576775c"
BROTLI_COMMIT="8e10eeb3378f6c459dbaf033ca6727e9816afccb"

echo "== 1/6 安裝 emscripten / binaryen / cmake / ninja（來自 Ubuntu apt） =="

if command -v emcc >/dev/null && command -v cmake >/dev/null && command -v ninja >/dev/null && command -v wasm-opt >/dev/null; then
  echo "   （emcc / cmake / ninja / binaryen 都已經存在，略過安裝步驟。"
  echo "    這個檢查很重要：emscripten 這個 apt 套件裝好之後會刻意留著 node-acorn"
  echo "    這個「未滿足」的相依關係（見下面的說明），如果每次都重跑 apt-get install，"
  echo "    apt 會重新檢查到這個已知的未滿足狀態而直接失敗，所以已經裝好就不要再跑。）"
else
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || true

CORE_PACKAGES="binaryen cmake ninja-build git ca-certificates"

if apt-get install -y --no-install-recommends $CORE_PACKAGES emscripten; then
  echo "   （標準安裝成功）"
else
  echo "   （標準安裝失敗，多半是系統上已有其他來源安裝的 nodejs，"
  echo "    導致 emscripten 套件的 node-acorn 相依性檢查卡住。改用以下流程："
  echo "    1) 先裝好 emscripten 以外的其他套件（含它們各自的傳遞相依）；"
  echo "    2) 最後單獨用 dpkg 強制安裝 emscripten 本體，並且不再對它跑"
  echo "       apt-get -f install，避免 apt 的自動修復把它當成無解而移除。）"

  apt-get install -y --no-install-recommends $CORE_PACKAGES
  apt-get install -f -y   # 補齊 CORE_PACKAGES 自己的傳遞相依（沒有 node 相關衝突，可以安全修復）

  DL_DIR="$(mktemp -d)"
  ( cd "$DL_DIR" && apt-get download emscripten )
  dpkg -i --force-depends "$DL_DIR"/emscripten_*.deb
  rm -rf "$DL_DIR"
  # 到此為止刻意不再呼叫 apt-get -f install：emscripten 唯一缺的相依是 node-acorn，
  # 而 emcc 實際上不需要系統安裝的 node-acorn 套件（用 npm 裝的 acorn 一樣能用，
  # 見下面的 NODE_PATH 設定），留著這個「未滿足」的狀態不影響建置。
fi
fi

command -v emcc >/dev/null || { echo "emcc 仍然找不到，安裝失敗。" >&2; exit 1; }

# Ubuntu 的 emscripten 套件依賴 node-acorn，而系統上如果已經裝了較新版本的
# nodejs（例如 NodeSource 提供的版本），apt 的相依性檢查有時會卡住。
# 這裡改用 npm 安裝 acorn 並加進 NODE_PATH，兩種安裝方式都能滿足 emcc 需要的
# JS 最佳化工具鏈（acorn-optimizer）。
if ! node -e "require('acorn')" 2>/dev/null; then
  echo "   （系統缺少 acorn，改用 npm 安裝）"
  npm install -g acorn
fi
export NODE_PATH="$(npm root -g):${NODE_PATH:-}"

echo "== 2/6 下載 FreeType $FREETYPE_TAG 原始碼 =="
git clone --depth 1 --branch "$FREETYPE_TAG" https://github.com/freetype/freetype.git "$WORK_DIR/ft-src"

echo "== 3/6 用 emscripten 編譯 FreeType（不含 zlib/png/harfbuzz/brotli） =="
mkdir -p "$WORK_DIR/ft-src/build-wasm"
cd "$WORK_DIR/ft-src/build-wasm"
emcmake cmake .. \
  -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DFT_DISABLE_ZLIB=TRUE \
  -DFT_DISABLE_BZIP2=TRUE \
  -DFT_DISABLE_PNG=TRUE \
  -DFT_DISABLE_HARFBUZZ=TRUE \
  -DFT_DISABLE_BROTLI=TRUE \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_C_FLAGS="-O3"
ninja

echo "== 4/6 編譯橋接層（ft_bridge.c）並與 libfreetype.a 連結成最終 wasm 模組 =="
mkdir -p "$REPO_ROOT/wasm"
emcc "$SCRIPT_DIR/ft-bridge/ft_bridge.c" \
  -I "$WORK_DIR/ft-src/include" \
  -I "$WORK_DIR/ft-src/build-wasm/include" \
  "$WORK_DIR/ft-src/build-wasm/libfreetype.a" \
  -O3 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createFreeTypeModule \
  -s EXPORTED_FUNCTIONS=_ft_create_face,_ft_destroy_face,_ft_family_name,_ft_get_char_index,_ft_rasterize_char,_ft_rasterize_prop,_ft_alloc_buffer,_ft_free_buffer,_malloc,_free \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,UTF8ToString,HEAPU8 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -o "$REPO_ROOT/wasm/freetype.mjs"

echo "== 5/6 下載 WOFF2（$WOFF2_COMMIT）與 Brotli（$BROTLI_COMMIT）原始碼並編譯 =="
# WOFF2 本質上是 TTF/OTF 用 Brotli 壓縮、外加對 glyf/loca 表做過重新編碼的容器格式，
# 這裡編官方 woff2 函式庫的「解碼」部分（不需要 encoder），加上它依賴的 Brotli
# 解壓縮器，兩者都只取用到到必要的原始檔，不透過各自的 CMake/bazel 建置系統
# （那些是為了產生完整的命令列工具跟共用函式庫設計的，直接用 emcc 指定檔案
# 編譯更單純、更好控制產出）。
git clone --quiet "https://github.com/google/woff2.git" "$WORK_DIR/woff2-src"
git -C "$WORK_DIR/woff2-src" checkout --quiet "$WOFF2_COMMIT"
git clone --quiet "https://github.com/google/brotli.git" "$WORK_DIR/brotli-src"
git -C "$WORK_DIR/brotli-src" checkout --quiet "$BROTLI_COMMIT"

# woff2_bridge.cc 在 repo 裡可能放在 build/woff2-bridge/（原本設計）或跟 ft_bridge.c 同一個
# build/ft-bridge/ 資料夾，兩個位置都接受，避免因為放錯資料夾而整個建置失敗。
if [ -f "$SCRIPT_DIR/woff2-bridge/woff2_bridge.cc" ]; then
  WOFF2_BRIDGE_SRC="$SCRIPT_DIR/woff2-bridge/woff2_bridge.cc"
else
  WOFF2_BRIDGE_SRC="$SCRIPT_DIR/ft-bridge/woff2_bridge.cc"
fi

BROTLI_SRC="$WORK_DIR/brotli-src"
WOFF2_SRC="$WORK_DIR/woff2-src"

emcc \
  "$BROTLI_SRC"/c/common/constants.c \
  "$BROTLI_SRC"/c/common/context.c \
  "$BROTLI_SRC"/c/common/dictionary.c \
  "$BROTLI_SRC"/c/common/platform.c \
  "$BROTLI_SRC"/c/common/shared_dictionary.c \
  "$BROTLI_SRC"/c/common/transform.c \
  "$BROTLI_SRC"/c/dec/bit_reader.c \
  "$BROTLI_SRC"/c/dec/decode.c \
  "$BROTLI_SRC"/c/dec/huffman.c \
  "$BROTLI_SRC"/c/dec/prefix.c \
  "$BROTLI_SRC"/c/dec/state.c \
  "$BROTLI_SRC"/c/dec/static_init.c \
  "$WOFF2_SRC"/src/woff2_dec.cc \
  "$WOFF2_SRC"/src/woff2_common.cc \
  "$WOFF2_SRC"/src/table_tags.cc \
  "$WOFF2_SRC"/src/variable_length.cc \
  "$WOFF2_SRC"/src/woff2_out.cc \
  "$WOFF2_BRIDGE_SRC" \
  -I "$BROTLI_SRC/c/include" \
  -I "$WOFF2_SRC/include" \
  -I "$WOFF2_SRC/src" \
  -O3 \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME=createWoff2Module \
  -s EXPORTED_FUNCTIONS=_woff2_decode,_woff2_get_output_ptr,_woff2_alloc_input,_woff2_free_input,_malloc,_free \
  -s EXPORTED_RUNTIME_METHODS=ccall,cwrap,HEAPU8 \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s ENVIRONMENT=web \
  -o "$REPO_ROOT/wasm/woff2.mjs"

echo "== 6/6 清理暫存目錄 =="
rm -rf "$WORK_DIR"

echo ""
echo "完成！輸出檔案："
ls -la "$REPO_ROOT/wasm/freetype.mjs" "$REPO_ROOT/wasm/freetype.wasm" "$REPO_ROOT/wasm/woff2.mjs" "$REPO_ROOT/wasm/woff2.wasm"
