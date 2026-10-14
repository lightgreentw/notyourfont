# Not Your FONT｜點陣字型轉換工具

在瀏覽器裡把 **TTF／OTF／TTC／WOFF2** 向量字型轉成 **BDF 點陣字型**。全部在本機瀏覽器執行，字型檔不會上傳到任何伺服器。

取樣用的是編譯成 WebAssembly 的 **FreeType 2.13.3** 原生引擎（也可切換成瀏覽器 Canvas 引擎），所以點陣的判定行為跟桌面版 FreeType 一致。

<img src=".\screenshot_01.png" alt="not your Font 畫面展示" width="80%">
<sup>(示範字型是芫荽開源字型)</sup>

<br>
<br>

- 直接線上使用
https://lightgreentw.github.io/notyourfont/

## Not Your FONT 象徵什麼

向量字型固然平滑且精緻，但點陣字型卻擁有無可取代的復古粒線美感與微縮靈魂。不隨波逐流於無窮放大的平滑曲線，而是透過這套轉檔工具，落實為一格格帶有微小瑕疵卻極具質感的點陣微粒。


## 適合拿來做什麼

- 為嵌入式裝置、OLED／LCD 小螢幕、復古遊戲引擎、終端機、X11 工具鏈，把現成的向量字型轉成固定尺寸的點陣字型。
- 製作 CJK（中日韓）點陣字型，並可選擇輸出編碼（Unicode／UTF-8／Big5／自訂對照表）。
- 同一支字型一次輸出**全形**（CJK、全形英數符號）與**半形**（ASCII）兩種 BDF，半形可選等寬或不等寬。
- 在轉檔前先看預覽、逐項微調，轉檔後自動做 BDF 規格檢查。

## 功能一覽

### 取樣與預覽
- **兩種取樣引擎**：FreeType（預設）、Canvas。
- **即時點陣預覽**：每個點陣像素直接畫成格子，紅色格線、綠色虛線標示基準線（`FONT_ASCENT`）。
- **全形／半形切換**（預覽文字框前的 radio）：
  - 格高 = 取樣字高；全形格寬 = 字高；半形格寬 = 字高 ÷ 2，**奇數字高無條件進位**（7→4、9→5、11→6、13→7、15→8）。
  - 全形、半形各自記錄各自的預覽文字，切換不會互相污染。預設全形預覽字「微風輕彿，舒體通暢「！…；？）」，半形「ABCMW123pqijy@#,{]」。
  - 文字框內容與目前模式不符（全形模式輸入 ASCII，或半形模式輸入 CJK／全形字）時會提示，並附一鍵切換按鈕。
- 預覽標籤會標出缺字、模式不符、被裁切（超寬／超高）、不等寬的字寬與加寬量。

### 微調點陣字
**全形與半形的微調參數分開記錄，轉檔時各自套用。** 面板標題旁的徽章顯示目前正在編輯哪一組。

| 類別 | 參數 |
|---|---|
| 尺寸 | 取樣尺寸（字高）、輸出尺寸（字高）；取樣與輸出可不同，輸出較大時多出來的列仍會保留墨跡 |
| 位置偏移 | X／Y 偏移；全形可選「CJK／非 CJK 鎖定一起偏移」，半形永遠只有一組（該選項停用） |
| 基準線 | 「字元對齊基準線」（預設開啟）：所有字貼齊 `FONT_ASCENT` 那一列 |
| 共通後製 | 二值化門檻、粗細調整（膨脹／侵蝕）、反相輸出 |
| Canvas 專屬 | Gamma、對比度、反鋸齒、超取樣倍率 |
| FreeType 專屬 | 提示模式（字型內建／強制自動提示／停用）、渲染目標、優先使用內嵌點陣圖 |

### 半形：等寬與不等寬
切到「半形」後，微調面板出現「字寬」選項：

- **等寬**：每個字同寬，每個字的 `BBX` 為整個字格。輸出檔名 `*_ascii.bdf`。
- **不等寬**：每個字有自己的 `DWIDTH`，`BBX` 貼緊墨跡（BDF 標準做法），`SPACING "P"`。輸出檔名 `*_ascii_prop.bdf`。
  - **寬度來源**：字型內建 advance，或「墨跡寬度 + 間距」。
  - **advance 取整**：四捨五入／進位／捨去。
  - **字距調整**、**最小／最大字寬**、**空白字寬**。
  - **墨跡超出字寬框時**：**自動加寬**（預設，最大字寬為上限）或**裁切**。
  - **例外覆寫**：例如 `i=3, W=10, space=4`，可寫字元本身、`U+0049` 或 `space`。例外覆寫與空白字寬是精確指定，不受字距、上下限與自動加寬影響。
  - 位置偏移 X 的語意是「墨跡在自己的字寬框內平移」。

> 像 Noto Sans TC 這類字型，ASCII 本來就是比例字形（字高 16 時字寬約 4–14），固定的半形格一定會裁到 `M`、`W`、`m` 等字，建議選「不等寬」。

### 字型度量
- `FONT_ASCENT`／`FONT_DESCENT` 自動換算：上緣度量優先取 **OS/2 的 sTypoAscender**，沒有才用 hhea，按「全形」輸出字高縮放，`FONT_DESCENT = 字高 − FONT_ASCENT`，兩者相加剛好等於字高；可手動覆寫。
- 全形、半形共用同一組度量，基準線一致。
- 兩者相加與輸出字高不一致時會用紅字警示；宣告值比墨跡實際延伸的範圍小時，轉檔會自動放大並在報告提示。

### 字碼範圍與輸出
- **字碼範圍**：☑ 半形（ASCII U+0020–007E，共 95 字）、☑ 全形（其下可分別勾選 **CJK** 與 **非 CJK**，預設全勾）。
  - ASCII 可顯示字元只放在半形檔，全形檔不含 ASCII。
  - 進階：可再用十六進位碼位範圍限定全形輸出。
  - 僅轉 BMP（U+0000–FFFF）；控制字元與非字元碼位不輸出，字型中 BMP 以外的字數會在報告中告知。
- **輸出編碼**：Unicode、UTF-8、Big5（使用瀏覽器內建對照表）、自訂對照表（匯入文字檔，每行「目標碼　Unicode 碼」，例如 `0xA140 0x3000`，可用於 CP950、Big5-2003、Big5-HKSCS 等變體）。目標編碼沒有對應碼位的字會略過並回報數量。
- **換行字元**：LF（預設）或 CRLF。
- 一次轉檔可同時產出全形檔與半形檔，各有下載連結。

### BDF 輸出與規格
- 純 ASCII、`STARTFONT 2.1`，字元依 `ENCODING` 遞增排列，`CHARS`、`STARTPROPERTIES` 計數正確。
- `FONT` 為合法的 14 欄 XLFD（家族名稱只保留英數字），並補齊對應屬性：`FOUNDRY`、`FAMILY_NAME`、`WEIGHT_NAME`、`SLANT`、`SETWIDTH_NAME`、`ADD_STYLE_NAME`、`PIXEL_SIZE`、`POINT_SIZE`、`RESOLUTION_X/Y`、`SPACING`、`AVERAGE_WIDTH`、`CHARSET_REGISTRY/ENCODING`。
- 解析度 72 dpi，`SIZE`、`POINT_SIZE`、`SWIDTH` 三者自洽。
- `BBX` 的垂直位置以 `FONT_ASCENT` 為基準線計算。
- 半形（ASCII）使用標準字形名（`space`、`exclam`、`A`…）；全形使用 `uniXXXX`。
- `DEFAULT_CHAR` 一定指向實際存在的字元。
- 來源字型的著作權聲明會帶進 `COPYRIGHT`，過長部分折成 `COMMENT`，授權文字不會在轉檔後遺失。
- **轉檔後自動規格檢查**：檢查實際要下載的檔案內容（純 ASCII、行長、XLFD、屬性與計數、ENCODING 唯一遞增、點陣列數與補齊位元、BBX 與 `FONTBOUNDINGBOX`、墨跡與 ASCENT／DESCENT、`DEFAULT_CHAR`、等寬字型的 DWIDTH 一致性），結果列在轉檔報告。

## 操作簡介

1. **讀取字型**：按「更換字型」或拖入檔案，支援 `.ttf`、`.otf`、`.ttc`（僅第一個字型面）、`.woff2`。專案內附 `fonts/Cubic_11.woff2` 作為示範。
2. **預覽**：在「點陣預覽」輸入文字，用文字框前的 radio 選全形或半形。看到「模式不符」提示時，點提示上的按鈕切換。
3. **微調**（「微調點陣字」面板）：
   - 先設定**取樣尺寸**與**輸出尺寸**（字高，7–32）。
   - 用**位置偏移**、**粗細調整**、**門檻**調到字形清楚。
   - 建議保持「字元對齊基準線」開啟。
   - 全形、半形各調各的；半形可選等寬或不等寬。
   - 像素字型建議使用字型的原生字高或其整數倍，字形最乾淨。
4. **確認度量**（「字型度量與轉檔」）：檢查 `FONT_ASCENT`／`FONT_DESCENT`，必要時手動調整。
5. **選字碼範圍與編碼**：勾選半形／全形（及 CJK／非 CJK），選輸出編碼與換行字元。
6. **產生 BDF**：按「轉換」，完成後分別下載。檔名範例：

   | 檔案 | 內容 |
   |---|---|
   | `字型名-16px.bdf` | 全形 |
   | `字型名-16px_ascii.bdf` | 半形等寬 |
   | `字型名-16px_ascii_prop.bdf` | 半形不等寬 |

7. **看報告**：缺字、被裁切的字、被自動加寬的字、編碼略過數量，以及 BDF 規格檢查結果都在報告裡。

### 常見狀況
| 狀況 | 建議 |
|---|---|
| 半形等寬時 `M`、`W` 等被裁切 | 字格寬 = 字高 ÷ 2，調取樣尺寸無法解決；改用「不等寬」，或用位置偏移／粗細調整，或換等寬的 ASCII 字型 |
| `g j p q y` 等下降部被切 | 基準線下方的列數不夠，調整 `FONT_ASCENT`／`FONT_DESCENT` 或位置偏移 Y |
| 全形字整體偏下或掉出字格 | 確認「字元對齊基準線」已開啟，並檢查 `FONT_ASCENT` |
| 目標程式讀不到 BDF | 先確認換行字元（X11 工具通常需要 LF），再看轉檔報告的規格檢查 |

## 本機執行

專案是純前端（ES Module + WebAssembly），不需要建置步驟，但不能直接用 `file://` 開啟，請用任一靜態伺服器：

```bash
# 在專案根目錄
python3 -m http.server 8000
# 瀏覽器開啟 http://localhost:8000
```

部署到 **GitHub Pages**（Deploy from a branch）即可，不需要 GitHub Actions。

## 重新編譯 WebAssembly

`wasm/freetype.wasm`、`wasm/woff2.wasm` 可從原始碼重現，不必信任預先編好的二進位檔：

```bash
bash build/build.sh    # Ubuntu 24.04；FreeType 固定 VER-2-13-3，woff2／brotli 固定 commit SHA
```

- C 橋接層在 `build/ft-bridge/`：`ft_bridge.c`（FreeType）、`woff2_bridge.cc`（WOFF2 解碼）。
- `.github/workflows/verify-wasm-build.yml` 只能手動觸發，用來驗證重編結果與已提交的 wasm 一致；只有修改橋接層或升級 FreeType 時才需要跑。

## 專案結構

```
index.html            介面
src/main.js           介面邏輯、預覽、轉檔流程
src/renderSettings.js 全形／半形各自的參數預設值
src/glyphGeometry.js  全形／半形規則、ASCII 字形名、不輸出的碼位
src/proportional.js   半形不等寬（字寬、加寬、BBX）
src/freetypeRasterizer.js / canvasRasterizer.js   兩種取樣引擎
src/bitmapMorphology.js   粗細調整、反相、裁切／補白
src/bdfWriter.js      BDF 輸出
src/bdfValidator.js   BDF 規格檢查
src/sfntFontInfo.js   解析字型度量、cmap、name 表
src/encodingSchemes.js 輸出編碼
build/                wasm 建置腳本與 C 橋接層
wasm/                 編譯好的 FreeType、WOFF2
```

## 已知限制

- 僅轉 BMP（U+0000–FFFF）。
- TTC 只解析第一個字型面。
- cmap format 4 在 `idRangeOffset ≠ 0` 的區段簡化為「視為有支援」，個別字型可能把沒有字形的碼位算進去。
- 半形片假名（U+FF61–FF9F）、Latin-1 補充字元（é、ß…）歸在「全形」，不在 `_ascii` 檔裡。
- BDF 沒有字偶間距（kerning），`AV`、`To` 這類配對調整在轉檔時會遺失。
- 可變字型（如 Noto Sans TC）以預設字重取樣。
- 不等寬模式下，目標程式必須支援每字不同的 `DWIDTH`。

## 授權與致謝

- 取樣使用 [FreeType](https://freetype.org/)、WOFF2 解碼使用 [google/woff2](https://github.com/google/woff2) 與 [google/brotli](https://github.com/google/brotli)，授權條款見 `licenses/`。
- 轉換後的 BDF 是來源字型的衍生物，請遵守來源字型自身的授權（如 OFL），工具會把著作權聲明寫進輸出檔。
- 本專案程式碼以 [Apache 2.0](LICENSE) 授權；見 `licenses/`。
