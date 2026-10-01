/** Excelの列幅の基準となるフォントサイズ（pt）。列幅はこのサイズの半角文字数で表される */
const BASE_FONT_SIZE = 11;

/** フォントサイズ1ptあたりの1行の高さ（pt）。日本語フォントの行間を見込んで標準（15/11）より大きめにする */
const LINE_HEIGHT_PER_FONT_SIZE = 1.5;

/** セル左右の余白として列幅から差し引く半角文字数 */
const CELL_PADDING_CHARS = 1;

/** 半角カタカナの範囲（全角扱いしない） */
const HALF_WIDTH_KATAKANA_START = 0xff61;
const HALF_WIDTH_KATAKANA_END = 0xff9f;

/** 1バイト文字の上限コードポイント */
const SINGLE_BYTE_MAX = 0xff;

/** 高さの見積もりに必要なセルの情報 */
export interface CellLayout {
  /** セルに表示されるテキスト */
  text: string;
  /** 列幅（Excelの列幅単位 = 基準フォントの半角文字数） */
  columnWidth: number;
  /** フォントサイズ（pt） */
  fontSize: number;
  /** 折り返して全体を表示するか */
  wrapText: boolean;
}

/**
 * 文字の表示幅を半角1、全角2として返す
 */
function charWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  if (code <= SINGLE_BYTE_MAX) return 1;
  if (code >= HALF_WIDTH_KATAKANA_START && code <= HALF_WIDTH_KATAKANA_END) return 1;
  return 2;
}

/**
 * セルを表示するのに必要な行数を見積もる。折り返しなしのセルは常に1行。
 */
export function countLines(cell: CellLayout): number {
  if (!cell.wrapText) return 1;
  const scale = BASE_FONT_SIZE / cell.fontSize;
  const charsPerLine = Math.max(1, (cell.columnWidth - CELL_PADDING_CHARS) * scale);
  return cell.text.split('\n').reduce((sum, line) => {
    const width = [...line].reduce((w, ch) => w + charWidth(ch), 0);
    return sum + Math.max(1, Math.ceil(width / charsPerLine));
  }, 0);
}

/**
 * 行内のセルをすべて表示するのに必要な行の高さ（pt）を見積もる
 *
 * @returns 最も行数の多いセルに合わせた高さ。セルが無ければ 0
 */
export function estimateRowHeight(cells: CellLayout[]): number {
  return cells.reduce(
    (max, cell) =>
      Math.max(max, countLines(cell) * cell.fontSize * LINE_HEIGHT_PER_FONT_SIZE),
    0,
  );
}
