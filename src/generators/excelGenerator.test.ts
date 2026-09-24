import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ExcelJS from 'exceljs';
import { generateExcel } from './excelGenerator';
import { GeneratorError } from '../utils/errors';
import { parseMarkdown } from '../parser/markdownParser';
import type { ProcedureDocument } from '../parser/types';

/** 1x1透明PNG（テスト用フィクスチャ） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SAMPLE_MD = `---
date: "2026/06/24"
---
# ログイン手順

## カテゴリA

### 手順1

操作内容1

- ぶどう
- リンゴ

> 期待結果1

### 手順2

操作内容2

> 期待結果2
`;

const SAMPLE_DOC: ProcedureDocument = parseMarkdown(SAMPLE_MD);

/** 行ループの行を1行持つ最小限のカスタムテンプレートを作成する */
async function writeCustomTemplate(filePath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('テンプレート');
  ws.getRow(1).getCell(1).value = '{{meta.title}}';
  ws.getRow(2).getCell(1).value = '{{#each ### steps}}';
  ws.getRow(2).getCell(2).value = '{{##}}';
  ws.getRow(2).getCell(3).value = '{{###}}';
  ws.getRow(2).getCell(4).value = '{{###.body}}';
  ws.getRow(2).getCell(5).value = '{{/each}}';
  await wb.xlsx.writeFile(filePath);
}

describe('generateExcel', () => {
  let tmpDir: string;
  let inputFile: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tejun-excel-'));
    inputFile = path.join(tmpDir, 'input.md');
    outputDir = path.join(tmpDir, 'out');
    await fs.promises.writeFile(inputFile, '# ログイン手順', 'utf-8');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('デフォルトテンプレートでExcelファイルを生成する', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(path.basename(outPath)).toBe('input.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('ログイン手順');
    // 既定テンプレートの列見出し（項番(H2)|項番(H3)|大項目|操作手順|期待される結果|チェック|実施日|実行者）
    const headerRow = ws.getRow(3);
    expect(headerRow.getCell(6).value).toBe('チェック');
    expect(headerRow.getCell(7).value).toBe('実施日');
    expect(headerRow.getCell(8).value).toBe('実行者');
  });

  it('ステップ数分の行が展開される', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    // 行4・行5に手順1・手順2が展開されているはず
    expect(ws.getRow(4).getCell(4).value).toContain('手順1');
    expect(ws.getRow(5).getCell(4).value).toContain('手順2');
  });

  it('デフォルトテンプレートの {{##.index}} は大項目ごとの連番に置換される', async () => {
    const doc = parseMarkdown(`${SAMPLE_MD}\n## カテゴリB\n\n### 手順3\n`);
    const outPath = await generateExcel(doc, inputFile, outputDir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    expect([4, 5, 6].map((r) => ws.getRow(r).getCell(2).value)).toEqual(['1-1', '2-1', '3-2']);
  });

  it('カスタムテンプレートの行ループの行を展開する', async () => {
    const templatePath = path.join(tmpDir, 'custom.xlsx');
    await writeCustomTemplate(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(1).getCell(1).value).toBe('ログイン手順');
    expect(ws.getRow(2).getCell(2).value).toBe('カテゴリA');
    expect(ws.getRow(2).getCell(3).value).toBe('手順1');
    expect(ws.getRow(3).getCell(3).value).toBe('手順2');
  });

  it('セル内で閉じた {{#each - steps}} はセル内で箇条書きの項目を繰り返す', async () => {
    const templatePath = path.join(tmpDir, 'custom-list.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    tplWs.getRow(1).getCell(1).value = '{{#each ### steps}}{{###}}';
    tplWs.getRow(1).getCell(2).value = '{{#each - steps}}・{{-}}\n{{/each}}';
    tplWs.getRow(1).getCell(3).value = '{{/each}}';
    await tplWb.xlsx.writeFile(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(1).getCell(1).value).toBe('手順1');
    expect(ws.getRow(1).getCell(2).value).toBe('・ぶどう\n・リンゴ\n');
    expect(ws.getRow(2).getCell(1).value).toBe('手順2');
    expect(ws.getRow(2).getCell(2).value).toBe('');
  });

  it('行ループの記号が解釈できない（旧記法の {{#each steps}} など）場合は GeneratorError をスローする', async () => {
    const templatePath = path.join(tmpDir, 'custom-old.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    tplWs.getRow(1).getCell(1).value = '{{#each steps}}';
    tplWs.getRow(1).getCell(2).value = '{{/each}}';
    await tplWb.xlsx.writeFile(templatePath);

    await expect(generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath)).rejects.toThrow(
      GeneratorError,
    );
  });

  it('リッチテキストのセルに含まれる変数も置換される', async () => {
    const templatePath = path.join(tmpDir, 'custom-richtext.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    // 書式の異なる断片に変数がまたがっていても置換されること
    tplWs.getRow(1).getCell(1).value = {
      richText: [
        { font: { name: 'Noto Sans JP' }, text: '出力日: {{meta.' },
        { font: { name: 'Cambria' }, text: 'date}}' },
      ],
    };
    tplWs.getRow(2).getCell(1).value = {
      richText: [{ font: { bold: true }, text: '{{#each ### steps}}' }],
    };
    tplWs.getRow(2).getCell(2).value = { richText: [{ font: { bold: true }, text: '{{###}}' }] };
    await tplWb.xlsx.writeFile(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(1).getCell(1).value).toBe('出力日: 2026/06/24');
    expect(ws.getRow(2).getCell(2).value).toBe('手順1');
    expect(ws.getRow(3).getCell(2).value).toBe('手順2');
  });

  it('テンプレートのステップ行に高さが無ければ展開した行の高さも設定しない（Excelの自動調整に任せる）', async () => {
    const templatePath = path.join(tmpDir, 'custom.xlsx');
    await writeCustomTemplate(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(2).height).toBeUndefined();
    expect(ws.getRow(3).height).toBeUndefined();
  });

  it('テンプレートのステップ行に高さがあれば展開した行にも同じ高さを設定する', async () => {
    const templatePath = path.join(tmpDir, 'custom-height.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    tplWs.getRow(1).getCell(1).value = '{{#each ### steps}}';
    tplWs.getRow(1).getCell(2).value = '{{###}}';
    tplWs.getRow(1).height = 55;
    await tplWb.xlsx.writeFile(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(1).height).toBe(55);
    expect(ws.getRow(2).height).toBe(55);
  });

  it('ローカル画像を埋め込む', async () => {
    const imagePath = path.join(tmpDir, 'screen.png');
    await fs.promises.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const docWithImage = parseMarkdown(`# ログイン手順

## カテゴリA

### 手順1

> ![スクリーンショット](./screen.png)
`);

    const outPath = await generateExcel(docWithImage, inputFile, outputDir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    expect(ws.getImages().length).toBeGreaterThan(0);
  });

  it('デフォルトテンプレートの結合セルが出力後も維持される', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    expect(ws.getCell('A1').isMerged).toBe(true);
    expect(ws.getCell('B1').isMerged).toBe(true);
    expect(ws.getCell('A2').isMerged).toBe(true);
  });

  it('テンプレートファイルが存在しない場合は GeneratorError をスローする', async () => {
    await expect(
      generateExcel(SAMPLE_DOC, inputFile, outputDir, path.join(tmpDir, 'nope.xlsx')),
    ).rejects.toThrow(GeneratorError);
  });
});
