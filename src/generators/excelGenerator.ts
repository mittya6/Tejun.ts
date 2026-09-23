import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { GeneratorError } from '../utils/errors';
import { replaceCellVariables, replaceStepCellVariables } from '../template/templateEngine';
import { isLocalImagePath, resolveImagePath } from '../utils/imageUtils';
import type { ProcedureDocument, Step, TemplateContext } from '../parser/types';

/** 未指定時に使用するデフォルトExcelテンプレートのパス */
const DEFAULT_EXCEL_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'default.xlsx');

/** exceljs でサポートされる画像拡張子 */
const SUPPORTED_IMG_EXTS = new Set(['png', 'jpeg', 'gif']);

const IMAGE_ROW_HEIGHT = 100;

/**
 * 画像ファイルを読み込んでbase64文字列と拡張子を返す
 *
 * @returns `{ base64, ext }` exceljs対応の拡張子（'png'|'jpeg'|'gif'）に変換済み
 */
async function readImageAsBase64(
  imageSrc: string,
  basePath: string,
): Promise<{ base64: string; ext: 'png' | 'jpeg' | 'gif' } | null> {
  const resolved = resolveImagePath(imageSrc, basePath);
  const rawExt = path.extname(resolved).slice(1).toLowerCase();
  const ext = rawExt === 'jpg' ? 'jpeg' : rawExt;

  if (!SUPPORTED_IMG_EXTS.has(ext)) {
    console.warn(`[Tejun.ts] サポートされていない画像形式のためスキップ: ${imageSrc} (${rawExt})`);
    return null;
  }

  try {
    const buffer = await fs.promises.readFile(resolved);
    return { base64: buffer.toString('base64'), ext: ext as 'png' | 'jpeg' | 'gif' };
  } catch {
    console.warn(`[Tejun.ts] 画像ファイルを読み込めませんでした: ${imageSrc}`);
    return null;
  }
}

/**
 * Excelのセル範囲文字列（例: "D4:E5"）を生成する
 *
 * @param col0 開始列（0始まり）
 * @param row1 開始行（1始まり）
 * @param col1End 終了列（0始まり、exclusive）
 * @param row1End 終了行（1始まり、exclusive）
 */
function cellRange(col0: number, row1: number, col1End: number, row1End: number): string {
  const colLetter = (c: number) => String.fromCharCode(65 + c);
  return `${colLetter(col0)}${row1}:${colLetter(col1End)}${row1End}`;
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
    document: { title: doc.title },
    date: doc.date,
    update: doc.update,
    steps: doc.steps,
    h1Body: doc.h1Body,
    h1Blockquote: doc.h1Blockquote,
    firstHeadings: doc.firstHeadings,
    meta: doc.meta,
  };

  // {{#each steps}}（{{#each h2 steps}} / {{#each h3 steps}}と同義）行を検出
  let templateRowNumber = -1;
  templateWs.eachRow((row, rowNum) => {
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (
        text !== undefined &&
        (text.includes('{{#each steps}}') ||
          text.includes('{{#each h2 steps}}') ||
          text.includes('{{#each h3 steps}}'))
      ) {
        templateRowNumber = rowNum;
      }
    });
  });

  // ヘッダー変数置換（ステップ行はステップごとの値で別途置換するため対象外）
  templateWs.eachRow((row, rowNum) => {
    if (rowNum === templateRowNumber) return;
    row.eachCell((cell) => {
      const text = cellText(cell.value);
      if (text === undefined || text.includes('{{#each')) return;
      const replaced = replaceCellVariables(text, ctx);
      // 変数を含まないリッチテキストはセル内の書式を保つため書き換えない
      if (replaced !== text) cell.value = replaced;
    });
  });

  if (templateRowNumber === -1) {
    const newWs = workbook.addWorksheet(templateWs.name);
    copyWorksheet(templateWs, newWs);
    return;
  }

  // テンプレート行のスタイルを保存
  const templateRow = templateWs.getRow(templateRowNumber);
  const templateCells: Array<{ value: string; style: Partial<ExcelJS.Style> }> = [];
  templateRow.eachCell({ includeEmpty: true }, (cell, colNum) => {
    templateCells[colNum] = {
      value: cellText(cell.value) ?? '',
      style: {
        font: cell.font,
        fill: cell.fill,
        alignment: cell.alignment,
        border: cell.border,
      },
    };
  });

  // テンプレート行を削除してステップ分の行を挿入
  templateWs.spliceRows(templateRowNumber, 1);

  let insertAt = templateRowNumber;
  // 大項目（H2）の連番。HTML側と同じく、連続する同一カテゴリを1グループとして数える
  let h2Index = 0;
  let prevCategory: string | undefined;
  for (const step of doc.steps) {
    if (step.category !== prevCategory) {
      h2Index++;
      prevCategory = step.category;
    }
    templateWs.spliceRows(insertAt, 0, []);
    const newRow = templateWs.getRow(insertAt);
    // テンプレート行に高さが無ければ設定せず、Excelの自動調整に任せる
    const rowHeight = step.image ? IMAGE_ROW_HEIGHT : templateRow.height;
    if (rowHeight !== undefined) newRow.height = rowHeight;

    templateCells.forEach((cellDef, colNum) => {
      if (colNum === 0) return;
      const cell = newRow.getCell(colNum);
      cell.value = replaceStepCellVariables(cellDef.value, step, h2Index, ctx);
      if (cellDef.style.font) cell.font = cellDef.style.font;
      if (cellDef.style.fill) cell.fill = cellDef.style.fill;
      if (cellDef.style.alignment) cell.alignment = cellDef.style.alignment;
      if (cellDef.style.border) cell.border = cellDef.style.border;
    });

    newRow.commit();
    insertAt++;
  }

  const newWs = workbook.addWorksheet(templateWs.name);
  copyWorksheet(templateWs, newWs);

  // 画像埋め込み
  for (const step of doc.steps) {
    if (step.image && isLocalImagePath(step.image.src)) {
      const imgData = await readImageAsBase64(step.image.src, basePath);
      if (imgData) {
        const imageId = workbook.addImage({ base64: imgData.base64, extension: imgData.ext });
        const r = templateRowNumber + step.index - 1;
        newWs.addImage(imageId, cellRange(3, r, 4, r + 1));
      }
    }
  }
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
 * @returns 生成されたExcelファイルのパス
 */
export async function generateExcel(
  doc: ProcedureDocument,
  inputFilePath: string,
  outputDir: string,
  templatePath?: string,
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

  const baseName = path.basename(inputFilePath, path.extname(inputFilePath));
  const outPath = path.join(outputDir, `${baseName}.xlsx`);

  await fs.promises.mkdir(outputDir, { recursive: true });
  await workbook.xlsx.writeFile(outPath);

  return outPath;
}

export type { Step };
