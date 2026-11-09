import fs from 'fs';
import path from 'path';
import { deleteRows, insertRows, readXlsx, toWriteSheet, writeXlsx } from 'hucre';
import type { Cell, CellStyle, FontStyle, MergeRange, Sheet, SheetImage, Workbook } from 'hucre';
import sharp from 'sharp';
import { GeneratorError } from '../utils/errors';
import { expandLoopChains, extractRowLoop, renderCell } from '../template/templateEngine';
import { isLocalImagePath, resolveImagePath } from '../utils/imageUtils';
import {
  columnWidthPx,
  DEFAULT_COLUMN_WIDTH,
  estimateTextHeightPx,
  layoutImages,
  locateInColumns,
  textRowHeightPt,
} from './excelImageLayout';
import type { ImageSize } from './excelImageLayout';
import type { TextSegment } from '../template/templateEngine';
import type { ProcedureDocument, TemplateContext } from '../parser/types';

/** 未指定時に使用するデフォルトExcelテンプレートのパス */
const DEFAULT_EXCEL_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'default.xlsx');

/** コードブロックの部分に使う等幅フォント */
const CODE_FONT_NAME = 'Consolas';

/** コードブロックの部分の文字色（RGB） */
const CODE_FONT_COLOR = 'C7254E';

/** 表の部分に使うフォント。半角と全角が1:2になり、表の列が揃う */
const TABLE_FONT_NAME = 'ＭＳ ゴシック';

/** 表の部分のフォントの文字セット（日本語） */
const TABLE_FONT_CHARSET = 128;

/** リンクの部分の文字色（RGB）。Excelのハイパーリンクの既定色に合わせる */
const LINK_FONT_COLOR = '0563C1';

/** 読み込んだ画像 */
interface LoadedImage extends ImageSize {
  data: Uint8Array;
  type: SheetImage['type'];
}

/** 画像を含むセル */
interface CellImages {
  /** 行番号（0始まり） */
  row: number;
  /** 列番号（0始まり） */
  col: number;
  /** セルに貼り付ける画像の `src`（出現順） */
  srcs: string[];
}

/**
 * ローカルの画像ファイルを読み込む
 *
 * PNG・JPEG・GIFはそのまま、それ以外（WebPなど）はPNGに変換する。
 *
 * @returns 読み込んだ画像。ローカルの画像でない、または読み込めない場合は `null`
 */
async function loadImage(src: string, basePath: string): Promise<LoadedImage | null> {
  if (!isLocalImagePath(src)) return null;
  try {
    const input = await fs.promises.readFile(resolveImagePath(src, basePath));
    const { format, width, height, pageHeight } = await sharp(input).metadata();
    const passThrough = format === 'png' || format === 'jpeg' || format === 'gif';
    // アニメーション画像は1コマ目の高さを使う
    const size = { width, height: pageHeight ?? height };
    return passThrough
      ? { data: input, type: format, ...size }
      : { data: await sharp(input).png().toBuffer(), type: 'png', ...size };
  } catch {
    console.warn(`[Tejun.ts] 画像ファイルを読み込めませんでした: ${src}`);
    return null;
  }
}

/**
 * セルの位置を `cells` のキーにする
 *
 * @param row 行番号（0始まり）
 * @param col 列番号（0始まり）
 */
function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

/**
 * セルの値をテキストとして取り出す。リッチテキストは書式を無視して断片を連結した値になる。
 *
 * @returns テキストでない値（数値・日付など）や数式の場合は `undefined`
 */
function cellText(sheet: Sheet, row: number, col: number): string | undefined {
  if (sheet.cells?.get(cellKey(row, col))?.formula !== undefined) return undefined;
  const value = sheet.rows[row]?.[col];
  return typeof value === 'string' ? value : undefined;
}

/**
 * セルの値を書き換える。書式は保ち、元のリッチテキストは取り除く。
 *
 * @param value 文字列、またはリッチテキストの断片
 */
function setCellValue(
  sheet: Sheet,
  row: number,
  col: number,
  value: string | NonNullable<Cell['richText']>,
): void {
  const text = typeof value === 'string' ? value : value.map((run) => run.text).join('');
  const cell = sheet.cells?.get(cellKey(row, col));
  sheet.cells ??= new Map();
  sheet.cells.set(cellKey(row, col), {
    ...cell,
    value: text,
    type: typeof value === 'string' ? 'string' : 'richText',
    richText: typeof value === 'string' ? undefined : value,
  });
  sheet.rows[row][col] = text;
}

/**
 * 行の高さ（pt）を返す。未設定なら `undefined`
 *
 * @param row 行番号（0始まり）
 */
function rowHeight(sheet: Sheet, row: number): number | undefined {
  return sheet.rowDefs?.get(row)?.height;
}

/**
 * 行の高さ（pt）を設定する
 *
 * @param row 行番号（0始まり）
 */
function setRowHeight(sheet: Sheet, row: number, height: number): void {
  sheet.rowDefs ??= new Map();
  sheet.rowDefs.set(row, { ...sheet.rowDefs.get(row), height });
}

/**
 * セルが占める各列の幅（文字数、左から順）を返す。結合セルは結合範囲の全ての列を返す。
 *
 * @param row 行番号（0始まり）
 * @param col 列番号（0始まり）。結合セルの場合は左端の列
 */
function cellColumnWidths(sheet: Sheet, row: number, col: number): number[] {
  const merge = sheet.merges?.find(
    (range: MergeRange) => range.startCol === col && range.startRow <= row && row <= range.endRow,
  );
  const widths: number[] = [];
  for (let c = col; c <= (merge?.endCol ?? col); c++) {
    widths.push(sheet.columns?.[c]?.width ?? DEFAULT_COLUMN_WIDTH);
  }
  return widths;
}

/**
 * セルの文章の下に画像を縦に並べる位置を求め、行の高さを画像が収まるよう広げる
 *
 * @returns シートに貼り付ける画像（セルに並べる順）
 */
function placeImagesInCell(
  sheet: Sheet,
  row: number,
  col: number,
  images: LoadedImage[],
): SheetImage[] {
  const style = sheet.cells?.get(cellKey(row, col))?.style;
  const columnWidths = cellColumnWidths(sheet, row, col);
  const widthsPx = columnWidths.map((width) => columnWidthPx(width));
  const textHeight = estimateTextHeightPx(
    cellText(sheet, row, col) ?? '',
    columnWidths.reduce((sum, width) => sum + width, 0),
    style?.font?.size,
    style?.alignment?.wrapText,
  );
  const layout = layoutImages(
    images,
    widthsPx.reduce((sum, width) => sum + width, 0),
    textHeight,
  );
  setRowHeight(sheet, row, Math.max(rowHeight(sheet, row) ?? 0, layout.rowHeightPt));

  return layout.images.map((placed, i) => {
    // Excelは列の幅を超えるずらし量を列の幅で打ち切るため、結合セルでは位置が含まれる列を指定する
    const { index, offset } = locateInColumns(widthsPx, placed.x);
    return {
      data: images[i].data,
      type: images[i].type,
      // 右下の位置ではなく大きさで指定する。右下の位置で指定すると、Excelで行がファイルの高さより
      // 低く表示されたときに、画像がセルの下端で打ち切られて潰れるため
      anchor: { from: { row, col: col + index, colOff: offset, rowOff: placed.y } },
      width: placed.width,
      height: placed.height,
    };
  });
}

/**
 * 各セルに、そのセルの変数に含まれていた画像を貼り付ける。同じ画像は一度だけ読み込む。
 */
async function embedCellImages(sheet: Sheet, cells: CellImages[], basePath: string): Promise<void> {
  const loaded = new Map<string, Promise<LoadedImage | null>>();
  const sheetImages: SheetImage[] = [];
  for (const { row, col, srcs } of cells) {
    const images: LoadedImage[] = [];
    for (const src of srcs) {
      if (!loaded.has(src)) loaded.set(src, loadImage(src, basePath));
      const image = await loaded.get(src);
      if (image) images.push(image);
    }
    if (images.length > 0) sheetImages.push(...placeImagesInCell(sheet, row, col, images));
  }
  sheet.images = [...(sheet.images ?? []), ...sheetImages];
}

/**
 * 断片のフォントを返す
 *
 * @param font テンプレートのセルのフォント。コードブロックの部分はこれのフォント名と色を、
 *   表の部分はフォント名を、リンクの部分は色と下線を変える
 */
function segmentFont(segment: TextSegment, font: FontStyle | undefined): FontStyle | undefined {
  if (segment.code) return { ...font, name: CODE_FONT_NAME, color: { rgb: CODE_FONT_COLOR } };
  if (segment.table) {
    // テーマのフォントの指定（scheme）が残っているとフォント名より優先され、列が揃わなくなる
    return { ...font, name: TABLE_FONT_NAME, charset: TABLE_FONT_CHARSET, scheme: undefined };
  }
  if (segment.link) return { ...font, color: { rgb: LINK_FONT_COLOR }, underline: true };
  return font;
}

/**
 * 行ループのセルの値を作る。コードブロックや表、リンクを含む場合は、その部分だけ書式を変えたリッチテキストにする。
 * リンクは見た目だけで、クリックしてもジャンプしない（Excelのハイパーリンクは1セルに1つしか付けられないため）。
 *
 * @param font テンプレートのセルのフォント
 */
function toCellValue(
  text: string,
  segments: TextSegment[],
  font: FontStyle | undefined,
): string | NonNullable<Cell['richText']> {
  if (!segments.some((segment) => segment.code || segment.link || segment.table)) return text;
  return segments.map((segment) => ({ text: segment.text, font: segmentFont(segment, font) }));
}

/**
 * テンプレートのシートを手順書の内容で埋める（シートを直接書き換える）
 */
async function fillTemplateSheet(
  sheet: Sheet,
  doc: ProcedureDocument,
  basePath: string,
): Promise<void> {
  const ctx: TemplateContext = {
    title: doc.title,
    date: doc.date,
    update: doc.update,
    meta: doc.meta,
    root: doc.root,
  };

  // セルをまたぐ {{#each 記号 steps}} ... {{/each}} がある最初の行を、行ループの行として検出
  let templateRowNumber = -1;
  let rowLoop: ReturnType<typeof extractRowLoop>;
  for (let row = 0; row < sheet.rows.length && !rowLoop; row++) {
    rowLoop = extractRowLoop(sheet.rows[row].map((_, col) => cellText(sheet, row, col) ?? ''));
    if (rowLoop) templateRowNumber = row;
  }

  // ヘッダー変数置換（行ループの行は行ごとの値で別途置換するため対象外）
  const headerImages: CellImages[] = [];
  sheet.rows.forEach((values, row) => {
    if (row === templateRowNumber) return;
    values.forEach((_, col) => {
      const text = cellText(sheet, row, col);
      if (text === undefined) return;
      const { text: replaced, images } = renderCell(text, ctx, [ctx.root]);
      // 変数を含まないリッチテキストはセル内の書式を保つため書き換えない
      if (replaced === text) return;
      setCellValue(sheet, row, col, replaced);
      if (images.length > 0) headerImages.push({ row, col, srcs: images });
      // 文章が収まるよう行を広げる（テンプレート行の高さより低くはしない）
      const style = sheet.cells?.get(cellKey(row, col))?.style;
      const textHeightPx = estimateTextHeightPx(
        replaced,
        cellColumnWidths(sheet, row, col).reduce((sum, width) => sum + width, 0),
        style?.font?.size,
        style?.alignment?.wrapText,
      );
      setRowHeight(sheet, row, Math.max(rowHeight(sheet, row) ?? 0, textRowHeightPt(textHeightPx)));
    });
  });

  if (!rowLoop) {
    await embedCellImages(sheet, headerImages, basePath);
    return;
  }

  // テンプレート行の高さとスタイルを保存
  const templateHeight = rowHeight(sheet, templateRowNumber);
  const loopCells = rowLoop.cells;
  const templateStyles: Array<CellStyle | undefined> = loopCells.map(
    (_, col) => sheet.cells?.get(cellKey(templateRowNumber, col))?.style,
  );

  // テンプレート行を削除して行ループの要素分の行を挿入
  const chains = expandLoopChains([ctx.root], rowLoop.symbols);
  deleteRows(sheet, templateRowNumber, 1);
  insertRows(sheet, templateRowNumber, chains.length);

  // 行ループより下の行は、展開した行の分だけ下にずれる
  const cellImages: CellImages[] = headerImages.map((cell) =>
    cell.row > templateRowNumber ? { ...cell, row: cell.row + chains.length - 1 } : cell,
  );
  chains.forEach((chain, i) => {
    const row = templateRowNumber + i;
    if (templateHeight !== undefined) setRowHeight(sheet, row, templateHeight);

    let textHeightPx = 0;
    loopCells.forEach((template, col) => {
      const style = templateStyles[col];
      const { text, segments, images } = renderCell(template, ctx, chain, chains[i - 1]);
      sheet.cells ??= new Map();
      sheet.cells.set(cellKey(row, col), { value: null, type: 'empty', style });
      setCellValue(sheet, row, col, toCellValue(text, segments, style?.font));
      textHeightPx = Math.max(
        textHeightPx,
        estimateTextHeightPx(
          text,
          sheet.columns?.[col]?.width,
          style?.font?.size,
          style?.alignment?.wrapText,
        ),
      );
      if (images.length > 0) cellImages.push({ row, col, srcs: images });
    });
    // 文章が収まるよう行を広げる（テンプレート行の高さより低くはしない。画像を貼り付ける行は後でさらに広げる）
    if (textHeightPx > 0) {
      setRowHeight(sheet, row, Math.max(rowHeight(sheet, row) ?? 0, textRowHeightPt(textHeightPx)));
    }
  });

  await embedCellImages(sheet, cellImages, basePath);
}

/**
 * Excelテンプレートを読み込む
 *
 * @throws GeneratorError テンプレートにワークシートが無い場合
 */
async function readTemplate(templatePath: string): Promise<{ workbook: Workbook; sheet: Sheet }> {
  const workbook = await readXlsx(await fs.promises.readFile(templatePath), { readStyles: true });
  const sheet = workbook.sheets[0];
  if (!sheet) {
    throw new GeneratorError('テンプレートExcelにワークシートが見つかりません。');
  }
  return { workbook, sheet };
}

/**
 * Excelファイル（.xlsx）を生成してファイルに書き込む
 *
 * テンプレートの最初のシートだけを出力する。
 *
 * @param doc 解析済み手順書ドキュメント
 * @param inputFilePath 入力Markdownファイルのパス
 * @param outputDir 出力先ディレクトリ
 * @param templatePath カスタムExcelテンプレートのパス（省略時はデフォルトテンプレートを使用）
 * @param outputBaseName 出力ファイル名（拡張子なし。省略時は入力ファイル名を使用）
 * @returns 生成されたExcelファイルのパス
 */
export async function generateExcel(
  doc: ProcedureDocument,
  inputFilePath: string,
  outputDir: string,
  templatePath?: string,
  outputBaseName?: string,
): Promise<string> {
  const basePath = path.dirname(path.resolve(inputFilePath));

  let output: Uint8Array;
  try {
    const { workbook, sheet } = await readTemplate(templatePath ?? DEFAULT_EXCEL_TEMPLATE_PATH);
    await fillTemplateSheet(sheet, doc, basePath);
    // hucreはブックとシートの画面設定（bookViews、sheetViews）を必ず書き出す。
    // 無いと、Windowsの表示スケールが150%のExcelで全ての行が2/3の高さで表示され、画像がセルからはみ出す
    output = await writeXlsx({
      sheets: [toWriteSheet(sheet)],
      defaultFont: workbook.defaultFont,
      properties: { creator: 'Tejun.ts', created: new Date() },
    });
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError(`Excelの生成に失敗しました: ${String(err)}`);
  }

  const baseName = outputBaseName ?? path.basename(inputFilePath, path.extname(inputFilePath));
  const outPath = path.join(outputDir, `${baseName}.xlsx`);

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(outPath, output);

  return outPath;
}
