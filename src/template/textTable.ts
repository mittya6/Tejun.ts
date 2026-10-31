/** 表のセルの文字揃え */
export type TableAlign = 'left' | 'center' | 'right';

/** 表のセル */
export interface TableCell {
  text: string;
  align: TableAlign;
}

/** 半角幅とみなす文字コードの上限（Latin-1まで） */
const NARROW_CHAR_MAX_CODE = 0xff;

/** 半角カタカナの文字コードの範囲 */
const HALF_WIDTH_KANA_MIN_CODE = 0xff61;
const HALF_WIDTH_KANA_MAX_CODE = 0xff9f;

/** 空のセルを表す値（行のセルの数が列の数より少ない場合に使う） */
const EMPTY_CELL: TableCell = { text: '', align: 'left' };

/**
 * 文字列の表示幅を、半角を1、全角を2として返す（半角と全角が1:2になるフォントでの幅）
 */
function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const narrow =
      code <= NARROW_CHAR_MAX_CODE ||
      (code >= HALF_WIDTH_KANA_MIN_CODE && code <= HALF_WIDTH_KANA_MAX_CODE);
    width += narrow ? 1 : 2;
  }
  return width;
}

/**
 * セルの文字を、文字揃えに合わせて空白で列の幅まで埋める
 *
 * @param width 列の幅
 */
function padCell({ text, align }: TableCell, width: number): string {
  const space = width - textWidth(text);
  if (align === 'right') return ' '.repeat(space) + text;
  const left = align === 'center' ? Math.floor(space / 2) : 0;
  return ' '.repeat(left) + text + ' '.repeat(space - left);
}

/**
 * 表を、罫線文字を使った複数行のテキストに変換する
 *
 * 半角と全角が1:2になる等幅フォント（MS ゴシックなど）で表示すると列が揃う。これらのフォントでは
 * 罫線文字が全角幅のため、列の幅を偶数に切り上げて罫線の長さと文字の幅を一致させる。
 *
 * @param rows 表の行（先頭の行を見出しとして、その下に区切り線を入れる）
 * @returns 表のテキスト（末尾の改行なし）。行が無ければ空文字
 */
export function formatTextTable(rows: TableCell[][]): string {
  if (rows.length === 0) return '';
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = Array.from({ length: columnCount }, (_, col) => {
    const width = Math.max(...rows.map((row) => textWidth(row[col]?.text ?? '')));
    return width + (width % 2);
  });

  const ruleLine = (left: string, middle: string, right: string): string =>
    left + widths.map((width) => '─'.repeat(width / 2 + 1)).join(middle) + right;
  const rowLine = (row: TableCell[]): string =>
    `│ ${widths.map((width, col) => padCell(row[col] ?? EMPTY_CELL, width)).join(' │ ')} │`;

  const [header, ...body] = rows;
  return [
    ruleLine('┌', '┬', '┐'),
    rowLine(header),
    ...(body.length > 0 ? [ruleLine('├', '┼', '┤')] : []),
    ...body.map(rowLine),
    ruleLine('└', '┴', '┘'),
  ].join('\n');
}
