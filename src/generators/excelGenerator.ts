import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import { GeneratorError } from '../utils/errors';
import {
  expandLoopChains,
  extractRowLoop,
  renderCell,
  replaceCellVariables,
} from '../template/templateEngine';
import { isLocalImagePath, resolveImagePath } from '../utils/imageUtils';
import { columnWidthPx, estimateTextHeightPx, layoutImages } from './excelImageLayout';
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

/** ワークブックに追加済みの画像 */
interface WorkbookImage extends ImageSize {
  id: number;
}

/** 行ループの行のうち、画像を含むセル */
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
 * セルの文章の下に画像を縦に並べて貼り付け、行の高さを画像が収まるよう広げる
 */
function placeImagesInCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  images: WorkbookImage[],
): void {
  const wsRow = ws.getRow(row);
  const cell = wsRow.getCell(col);
  const columnWidth = ws.getColumn(col).width;
  const textHeight = estimateTextHeightPx(
    cellText(cell.value) ?? '',
    columnWidth,
    cell.font?.size,
    cell.alignment?.wrapText,
  );
  const layout = layoutImages(images, columnWidthPx(columnWidth), textHeight);
  wsRow.height = Math.max(wsRow.height ?? 0, layout.rowHeightPt);

  layout.images.forEach((placed, i) => {
    // exceljsは `nativeCol` などがあればそちらを使う（`col` / `row` の小数ではpx単位のずらし量を指定できない）
    const tl = {
      col: col - 1,
      row: row - 1,
      nativeCol: col - 1,
      nativeColOff: placed.x * EMU_PER_PX,
      nativeRow: row - 1,
      nativeRowOff: placed.y * EMU_PER_PX,
    };
    ws.addImage(images[i].id, {
      tl,
      ext: { width: placed.width, height: placed.height },
      editAs: 'oneCell',
    });
  });
}

/**
 * 行ループの各セルに、そのセルの変数に含まれていた画像を貼り付ける。同じ画像は一度だけ読み込む。
 */
async function embedCellImages(
  workbook: ExcelJS.Workbook,
  ws: ExcelJS.Worksheet,
  cells: CellImages[],
  basePath: string,
): Promise<void> {
  const loaded = new Map<string, Promise<WorkbookImage | null>>();
  for (const { row, col, srcs } of cells) {
    const images: WorkbookImage[] = [];
    for (const src of srcs) {
      if (!loaded.has(src)) loaded.set(src, addWorkbookImage(workbook, src, basePath));
      const image = await loaded.get(src);
      if (image) images.push(image);
    }
    if (images.length > 0) placeImagesInCell(ws, row, col, images);
  }
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
 * 行ループのセルの値を作る。コードブロックを含む場合は、その部分だけ等幅フォント・色付きにしたリッチテキストにする。
 *
 * @param font テンプレートのセルのフォント。コードブロック以外の部分はこのフォントのまま、
 *   コードブロックの部分はこれのフォント名と色だけを変える
 */
function toCellValue(
  text: string,
  segments: TextSegment[],
  font: Partial<ExcelJS.Font> | undefined,
): ExcelJS.CellValue {
  if (!segments.some((segment) => segment.code)) return text;
  return {
    richText: segments.map((segment) => ({
      text: segment.text,
      font: segment.code
        ? { ...font, name: CODE_FONT_NAME, color: { argb: CODE_FONT_COLOR } }
        : font,
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
  templateWs.eachRow((row, rowNum) => {
    if (rowNum === templateRowNumber) return;
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (text === undefined) return;
      const replaced = replaceCellVariables(text, ctx);
      // 変数を含まないリッチテキストはセル内の書式を保つため書き換えない
      if (replaced !== text) cell.value = replaced;
    });
  });

  if (!rowLoop) {
    const newWs = workbook.addWorksheet(templateWs.name);
    copyWorksheet(templateWs, newWs);
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
  const cellImages: CellImages[] = [];
  let insertAt = templateRowNumber;
  chains.forEach((chain, i) => {
    templateWs.spliceRows(insertAt, 0, []);
    const newRow = templateWs.getRow(insertAt);
    // テンプレート行に高さが無ければ設定せず、Excelの自動調整に任せる（画像を貼り付ける行は後で広げる）
    if (templateRow.height !== undefined) newRow.height = templateRow.height;

    templateCells.forEach((cellDef, colNum) => {
      if (colNum === 0) return;
      const cell = newRow.getCell(colNum);
      const { text, segments, images } = renderCell(cellDef.value, ctx, chain, chains[i - 1]);
      cell.value = toCellValue(text, segments, cellDef.style.font);
      if (images.length > 0) cellImages.push({ row: insertAt, col: colNum, srcs: images });
      if (cellDef.style.font) cell.font = cellDef.style.font;
      if (cellDef.style.fill) cell.fill = cellDef.style.fill;
      if (cellDef.style.alignment) cell.alignment = cellDef.style.alignment;
      if (cellDef.style.border) cell.border = cellDef.style.border;
    });

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
