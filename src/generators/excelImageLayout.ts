/** 画像の大きさ（px） */
export interface ImageSize {
  width: number;
  height: number;
}

/** セル内に置く画像の位置と大きさ（px）。位置はセルの左上からの距離 */
export interface PlacedImage extends ImageSize {
  x: number;
  y: number;
}

/** Excelの行の高さの上限（pt） */
const MAX_ROW_HEIGHT_PT = 409;

/** 1ptあたりのpx */
const PX_PER_PT = 96 / 72;

/** 列幅が未設定のときのExcelの既定の列幅（文字数） */
const DEFAULT_COLUMN_WIDTH = 8.43;

/** フォントサイズが未設定のときの既定値（pt）。列幅の1文字分はこのサイズの文字の幅 */
const DEFAULT_FONT_SIZE = 11;

/** 1行の高さのフォントサイズに対する比率。日本語フォントでも文章と画像が重ならないよう広めに取る */
const LINE_HEIGHT_RATIO = 1.5;

/** セルの枠と画像、文章と画像、画像同士の間隔（px） */
const IMAGE_MARGIN_PX = 4;

/** 画像の幅のセル幅に対する比率 */
const IMAGE_WIDTH_RATIO = 0.8;

/** 全角文字を判定する文字コードの下限。これ以上の文字は半角2文字分の幅とみなす */
const WIDE_CHAR_MIN_CODE = 0x100;

/**
 * Excelの列幅（文字数）をpxに換算する
 *
 * @param width 列幅（文字数）。未設定ならExcelの既定の列幅
 */
export function columnWidthPx(width = DEFAULT_COLUMN_WIDTH): number {
  return Math.round(width * 7 + 5);
}

/**
 * 全角文字を2、それ以外を1として文字列の表示幅を返す
 */
function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) width += (ch.codePointAt(0) ?? 0) >= WIDE_CHAR_MIN_CODE ? 2 : 1;
  return width;
}

/**
 * セルの文章の高さを、改行と折り返しから概算する（実際の高さはフォントによって変わる）
 *
 * @param text セルの文章
 * @param columnWidth 列幅（文字数）。未設定ならExcelの既定の列幅
 * @param fontSize フォントサイズ（pt）。未設定なら11pt
 * @param wrapText セルの「折り返して全体を表示する」が有効か
 * @returns 文章の高さ（px）
 */
export function estimateTextHeightPx(
  text: string,
  columnWidth = DEFAULT_COLUMN_WIDTH,
  fontSize = DEFAULT_FONT_SIZE,
  wrapText = false,
): number {
  if (!text) return 0;
  const charsPerLine = Math.max(1, Math.floor((columnWidth * DEFAULT_FONT_SIZE) / fontSize));
  const lines = text
    .split('\n')
    .reduce(
      (sum, line) =>
        sum + (wrapText ? Math.max(1, Math.ceil(displayWidth(line) / charsPerLine)) : 1),
      0,
    );
  return lines * fontSize * LINE_HEIGHT_RATIO * PX_PER_PT;
}

/**
 * セルの文章の下に画像を縦に並べる位置と大きさ、必要な行の高さを求める
 *
 * 画像は縦横比を保ったまま、幅がセルの幅の80%になるよう拡大・縮小し、セルの横方向の中央に置く。
 * 行の高さがExcelの上限を超える場合は、上限に収まるよう全ての画像を同じ比率で縮小する。
 *
 * @param sizes 画像の元の大きさ（並べる順）
 * @param cellWidthPx セルの幅（px）
 * @param textHeightPx セルの文章の高さ（px）
 */
export function layoutImages(
  sizes: ImageSize[],
  cellWidthPx: number,
  textHeightPx: number,
): { images: PlacedImage[]; rowHeightPt: number } {
  const targetWidth = cellWidthPx * IMAGE_WIDTH_RATIO;
  const fitted = sizes.map(({ width, height }) => {
    const scale = targetWidth / width;
    return { width: width * scale, height: height * scale };
  });

  const top = textHeightPx + IMAGE_MARGIN_PX;
  const available = MAX_ROW_HEIGHT_PT * PX_PER_PT - top - IMAGE_MARGIN_PX * sizes.length;
  const totalHeight = fitted.reduce((sum, size) => sum + size.height, 0);
  const shrink = Math.min(1, Math.max(0, available) / totalHeight);

  let y = top;
  const images = fitted.map(({ width, height }) => {
    const placedWidth = Math.round(width * shrink);
    const placed = {
      x: Math.round((cellWidthPx - placedWidth) / 2),
      y: Math.round(y),
      width: placedWidth,
      height: Math.round(height * shrink),
    };
    y += placed.height + IMAGE_MARGIN_PX;
    return placed;
  });
  return { images, rowHeightPt: Math.min(MAX_ROW_HEIGHT_PT, y / PX_PER_PT) };
}
