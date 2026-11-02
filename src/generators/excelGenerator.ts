import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { GeneratorError } from '../utils/errors';
import {
  expandLoopChains,
  extractRowLoop,
  renderCell,
} from '../template/templateEngine';
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
import type { NodeSymbol, ProcedureDocument, TemplateContext } from '../parser/types';

/** 未指定時に使用するデフォルトExcelテンプレートのパス */
const DEFAULT_EXCEL_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'default.xlsx');

/** 1pxあたりのEMU（Excelの図形の位置の単位） */
const EMU_PER_PX = 9525;

/** コードブロックの部分に使う等幅フォント */
const CODE_FONT_NAME = 'Consolas';

/** コードブロックの部分の文字色（ARGB） */
const CODE_FONT_COLOR = 'FFC7254E';

/** 表の部分に使うフォント。半角と全角が1:2になり、表の列が揃う */
const TABLE_FONT_NAME = 'ＭＳ ゴシック';

/** 表の部分のフォントの文字セット（日本語） */
const TABLE_FONT_CHARSET = 128;

/** リンクの部分の文字色（ARGB）。Excelのハイパーリンクの既定色に合わせる */
const LINK_FONT_COLOR = 'FF0563C1';

/** シートの既定の `x14ac:dyDescent`（pt）。exceljsが各行に書く値に合わせる */
const ROW_DY_DESCENT = 0.25;

/**
 * ブックの画面設定。シートの画面設定と合わせて書かないと、Windowsの表示スケールが150%のExcelで
 * 全ての行が2/3の高さで表示され、画像がセルからはみ出す。大きさの単位はExcelの1/20pt
 */
const WORKBOOK_VIEW: ExcelJS.WorkbookView = {
  x: 0,
  y: 0,
  width: 28800,
  height: 12300,
  firstSheet: 0,
  activeTab: 0,
  visibility: 'visible',
};

/** ワークブックに追加済みの画像 */
interface WorkbookImage extends ImageSize {
  id: number;
}

/** シートに貼り付ける画像 */
interface SheetImage {
  /** ワークブックに追加済みの画像のID */
  id: number;
  /** 貼り付ける範囲 */
  range: ExcelJS.ImagePosition & { editAs: string };
}

/** 画像を含むセル */
interface CellImages {
  /** 行番号（1始まり） */
  row: number;
  /** 列番号（1始まり） */
  col: number;
  /** セルに貼り付ける画像の `src`（出現順） */
  srcs: string[];
}

/**
 * ローカルの画像ファイルを読み込んでワークブックに追加する
 *
 * PNG・JPEG・GIFはそのまま、それ以外（WebPなど）はPNGに変換して追加する。
 *
 * @returns 追加した画像。ローカルの画像でない、または読み込めない場合は `null`
 */
async function addWorkbookImage(
  workbook: ExcelJS.Workbook,
  src: string,
  basePath: string,
): Promise<WorkbookImage | null> {
  if (!isLocalImagePath(src)) return null;
  try {
    const input = await fs.promises.readFile(resolveImagePath(src, basePath));
    const { format, width, height, pageHeight } = await sharp(input).metadata();
    const passThrough = format === 'png' || format === 'jpeg' || format === 'gif';
    const id = workbook.addImage(
      passThrough
        ? { base64: input.toString('base64'), extension: format }
        : { base64: (await sharp(input).png().toBuffer()).toString('base64'), extension: 'png' },
    );
    // アニメーション画像は1コマ目の高さを使う
    return { id, width, height: pageHeight ?? height };
  } catch {
    console.warn(`[Tejun.ts] 画像ファイルを読み込めませんでした: ${src}`);
    return null;
  }
}

/**
 * セルの左上からpx単位でずらした位置を、画像の位置として指定する値を作る
 *
 * @param row 行番号（1始まり）
 * @param col 列番号（1始まり）
 * @param x セルの左端からの距離（px）
 * @param y セルの上端からの距離（px）
 */
function cellAnchor(row: number, col: number, x: number, y: number): ExcelJS.Anchor {
  // exceljsは `nativeCol` などがあればそちらを使う（`col` / `row` の小数ではpx単位のずらし量を指定できない）
  const anchor: ExcelJS.IAnchor = {
    col: col - 1,
    row: row - 1,
    nativeCol: col - 1,
    nativeColOff: x * EMU_PER_PX,
    nativeRow: row - 1,
    nativeRowOff: y * EMU_PER_PX,
  };
  // 型定義は `Anchor` クラスを要求するが、実行時は位置だけを渡せばよい（クラスはexportされていない）
  return anchor as ExcelJS.Anchor;
}

/**
 * セルが占める各列の幅（文字数、左から順）を返す。結合セルは結合範囲の全ての列を返す。
 *
 * @param row 行番号（1始まり）
 * @param col 列番号（1始まり）。結合セルの場合は左端の列
 */
function cellColumnWidths(ws: ExcelJS.Worksheet, row: number, col: number): number[] {
  const wsRow = ws.getRow(row);
  const master = wsRow.getCell(col);
  const widths = [ws.getColumn(col).width ?? DEFAULT_COLUMN_WIDTH];
  for (let c = col + 1; wsRow.getCell(c).master === master; c++) {
    widths.push(ws.getColumn(c).width ?? DEFAULT_COLUMN_WIDTH);
  }
  return widths;
}

/**
 * セルの文章の下に画像を縦に並べる位置を求め、行の高さを画像が収まるよう広げる
 *
 * @returns シートに貼り付ける画像（セルに並べる順）
 */
function placeImagesInCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  images: WorkbookImage[],
): SheetImage[] {
  const wsRow = ws.getRow(row);
  const cell = wsRow.getCell(col);
  const columnWidths = cellColumnWidths(ws, row, col);
  const widthsPx = columnWidths.map((width) => columnWidthPx(width));
  const textHeight = estimateTextHeightPx(
    cellText(cell.value) ?? '',
    columnWidths.reduce((sum, width) => sum + width, 0),
    cell.font?.size,
    cell.alignment?.wrapText,
  );
  const layout = layoutImages(
    images,
    widthsPx.reduce((sum, width) => sum + width, 0),
    textHeight,
  );
  wsRow.height = Math.max(wsRow.height ?? 0, layout.rowHeightPt);

  return layout.images.map((placed, i) => {
    // Excelは列の幅を超えるずらし量を列の幅で打ち切るため、結合セルでは位置が含まれる列を指定する
    const { index, offset } = locateInColumns(widthsPx, placed.x);
    return {
      id: images[i].id,
      // 右下の位置ではなく大きさで指定する。右下の位置で指定すると、Excelで行がファイルの高さより
      // 低く表示されたときに、画像がセルの下端で打ち切られて潰れるため
      range: {
        tl: cellAnchor(row, col + index, offset, placed.y),
        ext: { width: placed.width, height: placed.height },
        editAs: 'oneCell',
      },
    };
  });
}

/**
 * 各セルに、そのセルの変数に含まれていた画像を貼り付ける。同じ画像は一度だけ読み込む。
 */
async function embedCellImages(
  workbook: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  cells: CellImages[],
  basePath: string,
): Promise<void> {
  const loaded = new Map<string, Promise<WorkbookImage | null>>();
  const sheetImages: SheetImage[] = [];
  for (const { row, col, srcs } of cells) {
    const images: WorkbookImage[] = [];
    for (const src of srcs) {
      if (!loaded.has(src)) loaded.set(src, addWorkbookImage(workbook, src, basePath));
      const image = await loaded.get(src);
      if (image) images.push(image);
    }
    if (images.length > 0) sheetImages.push(...placeImagesInCell(ws, row, col, images));
  }
  // exceljsは同じ画像が続くと「画像IDと同じ番号のリンク」を使い回す。同じ画像を離れた位置で使うと
  // 番号がずれて別の画像を指し、枠の比率に引き伸ばされるため、ID順に追加して番号を一致させる
  sheetImages.sort((a, b) => a.id - b.id);
  for (const { id, range } of sheetImages) ws.addImage(id, range);
}

/**
 * セルの値をテキストとして取り出す。リッチテキストは書式を無視して断片を連結する。
 *
 * @returns テキストでない値（数値・日付・数式など）の場合は `undefined`
 */
function cellText(value: ExcelJS.CellValue): string | undefined {
  if (typeof value === 'string') return value;
  if (value !== null && typeof value === 'object' && 'richText' in value) {
    return value.richText.map((part) => part.text).join('');
  }
  return undefined;
}

/**
 * 断片のフォントを返す
 *
 * @param font テンプレートのセルのフォント。コードブロックの部分はこれのフォント名と色を、
 *   表の部分はフォント名を、リンクの部分は色と下線を変える
 */
function segmentFont(
  segment: TextSegment,
  font: Partial<ExcelJS.Font> | undefined,
): Partial<ExcelJS.Font> | undefined {
  if (segment.code) return { ...font, name: CODE_FONT_NAME, color: { argb: CODE_FONT_COLOR } };
  if (segment.table) {
    // テーマのフォントの指定（scheme）が残っているとフォント名より優先され、列が揃わなくなる
    return { ...font, name: TABLE_FONT_NAME, charset: TABLE_FONT_CHARSET, scheme: undefined };
  }
  if (segment.link) return { ...font, color: { argb: LINK_FONT_COLOR }, underline: true };
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
  font: Partial<ExcelJS.Font> | undefined,
): ExcelJS.CellValue {
  if (!segments.some((segment) => segment.code || segment.link || segment.table)) return text;
  return {
    richText: segments.map((segment) => ({
      text: segment.text,
      font: segmentFont(segment, font),
    })),
  };
}

/**
 * カスタムExcelテンプレートを使用してワークシートを構築する
 */
async function buildFromTemplate(
  workbook: ExcelJS.Workbook,
  doc: ProcedureDocument,
  basePath: string,
  templatePath: string,
): Promise<void> {
  const templateWorkbook = new ExcelJS.Workbook();
  await templateWorkbook.xlsx.readFile(templatePath);

  const templateWs = templateWorkbook.worksheets[0];
  if (!templateWs) {
    throw new GeneratorError('テンプレートExcelにワークシートが見つかりません。');
  }

  const ctx: TemplateContext = {
    title: doc.title,
    date: doc.date,
    update: doc.update,
    meta: doc.meta,
    root: doc.root,
  };

  // セルをまたぐ {{#each 記号 steps}} ... {{/each}} がある最初の行を、行ループの行として検出
  let templateRowNumber = -1;
  let rowLoop: { symbols: NodeSymbol[]; cells: string[] } | undefined;
  templateWs.eachRow((row, rowNum) => {
    if (rowLoop) return;
    const texts = [''];
    for (let col = 1; col <= row.cellCount; col++) {
      texts.push(cellText(row.getCell(col).value) ?? '');
    }
    rowLoop = extractRowLoop(texts);
    if (rowLoop) templateRowNumber = rowNum;
  });

  // ヘッダー変数置換（行ループの行は行ごとの値で別途置換するため対象外）
  const headerImages: CellImages[] = [];
  templateWs.eachRow((row, rowNum) => {
    if (rowNum === templateRowNumber) return;
    row.eachCell((cell, colNum) => {
      const text = cellText(cell.value);
      if (text === undefined) return;
      const { text: replaced, images } = renderCell(text, ctx, [ctx.root]);
      // 変数を含まないリッチテキストはセル内の書式を保つため書き換えない
      if (replaced === text) return;
      cell.value = replaced;
      if (images.length > 0) headerImages.push({ row: rowNum, col: colNum, srcs: images });
      // 文章が収まるよう行を広げる（テンプレート行の高さより低くはしない）
      const textHeightPx = estimateTextHeightPx(
        replaced,
        cellColumnWidths(templateWs, rowNum, colNum).reduce((sum, width) => sum + width, 0),
        cell.font?.size,
        cell.alignment?.wrapText,
      );
      row.height = Math.max(row.height ?? 0, textRowHeightPt(textHeightPx));
    });
  });

  if (!rowLoop) {
    const newWs = workbook.addWorksheet(templateWs.name);
    copyWorksheet(templateWs, newWs);
    await embedCellImages(workbook, newWs, headerImages, basePath);
    return;
  }

  // テンプレート行のスタイルを保存
  const templateRow = templateWs.getRow(templateRowNumber);
  const templateCells: Array<{ value: string; style: Partial<ExcelJS.Style> }> = [];
  const loopCells = rowLoop.cells;
  templateRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    templateCells[colNum] = {
      value: loopCells[colNum] ?? '',
      style: {
        font: cell.font,
        fill: cell.fill,
        alignment: cell.alignment,
        border: cell.border,
      },
    };
  });

  // テンプレート行を削除して行ループの要素分の行を挿入
  templateWs.spliceRows(templateRowNumber, 1);

  const chains = expandLoopChains([ctx.root], rowLoop.symbols);
  // 行ループより下の行は、展開した行の分だけ下にずれる
  const cellImages: CellImages[] = headerImages.map((cell) =>
    cell.row > templateRowNumber ? { ...cell, row: cell.row + chains.length - 1 } : cell,
  );
  let insertAt = templateRowNumber;
  chains.forEach((chain, i) => {
    templateWs.spliceRows(insertAt, 0, []);
    const newRow = templateWs.getRow(insertAt);
    if (templateRow.height !== undefined) newRow.height = templateRow.height;

    let textHeightPx = 0;
    templateCells.forEach((cellDef, colNum) => {
      if (colNum === 0) return;
      const cell = newRow.getCell(colNum);
      const { text, segments, images } = renderCell(cellDef.value, ctx, chain, chains[i - 1]);
      cell.value = toCellValue(text, segments, cellDef.style.font);
      textHeightPx = Math.max(
        textHeightPx,
        estimateTextHeightPx(
          text,
          templateWs.getColumn(colNum).width,
          cellDef.style.font?.size,
          cellDef.style.alignment?.wrapText,
        ),
      );
      if (images.length > 0) cellImages.push({ row: insertAt, col: colNum, srcs: images });
      if (cellDef.style.font) cell.font = cellDef.style.font;
      if (cellDef.style.fill) cell.fill = cellDef.style.fill;
      if (cellDef.style.alignment) cell.alignment = cellDef.style.alignment;
      if (cellDef.style.border) cell.border = cellDef.style.border;
    });
    // 文章が収まるよう行を広げる（テンプレート行の高さより低くはしない。画像を貼り付ける行は後でさらに広げる）
    if (textHeightPx > 0) {
      newRow.height = Math.max(newRow.height ?? 0, textRowHeightPt(textHeightPx));
    }

    newRow.commit();
    insertAt++;
  });

  const newWs = workbook.addWorksheet(templateWs.name);
  copyWorksheet(templateWs, newWs);
  await embedCellImages(workbook, newWs, cellImages, basePath);
}

/**
 * ワークシートの内容を別のワークシートにコピーする
 */
function copyWorksheet(src: ExcelJS.Worksheet, dest: ExcelJS.Worksheet): void {
  dest.properties.dyDescent = ROW_DY_DESCENT;
  dest.views = [{ state: 'normal' }];
  dest.pageSetup = { ...src.pageSetup };
  src.columns.forEach((col, i) => {
    if (col.width) dest.getColumn(i + 1).width = col.width;
  });
  src.eachRow({ includeEmpty: true }, (row, rowNum) => {
    const destRow = dest.getRow(rowNum);
    if (row.height) destRow.height = row.height;
    row.eachCell({ includeEmpty: true }, (cell, colNum) => {
      const destCell = destRow.getCell(colNum);
      destCell.value = cell.value;
      if (cell.font) destCell.font = cell.font;
      if (cell.fill) destCell.fill = cell.fill;
      if (cell.alignment) destCell.alignment = cell.alignment;
      if (cell.border) destCell.border = cell.border;
    });
    destRow.commit();
  });
  src.model.merges.forEach((range) => dest.mergeCells(range));
}

/**
 * Excelファイル（.xlsx）を生成してファイルに書き込む
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
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Tejun.ts';
  workbook.created = new Date();
  workbook.views = [WORKBOOK_VIEW];

  try {
    await buildFromTemplate(workbook, doc, basePath, templatePath ?? DEFAULT_EXCEL_TEMPLATE_PATH);
  } catch (err) {
    if (err instanceof GeneratorError) throw err;
    throw new GeneratorError(`Excelの生成に失敗しました: ${String(err)}`);
  }

  const baseName = outputBaseName ?? path.basename(inputFilePath, path.extname(inputFilePath));
  const outPath = path.join(outputDir, `${baseName}.xlsx`);

  await fs.promises.mkdir(outputDir, { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  return outPath;
}
