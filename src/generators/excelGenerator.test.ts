import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
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
    expect(ws.getRow(1).getCell(2).value).toBe('ログイン手順');
    // 既定テンプレートの列見出し（B列から 項番|大項目|操作手順|期待される結果|チェック|実施日|実行者）
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
    expect([4, 5, 6].map((r) => ws.getRow(r).getCell(2).value)).toEqual(['1-1', '1-2', '2-1']);
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

  it('{{#if ##.first}} は同じ大項目の2行目以降を空にする', async () => {
    const templatePath = path.join(tmpDir, 'custom-first.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('テンプレート');
    ws.getRow(1).getCell(1).value = '{{#each ## steps}}';
    ws.getRow(1).getCell(2).value = '{{#each ### steps}}{{#if ##.first}}{{##}}{{/if}}';
    ws.getRow(1).getCell(3).value = '{{###}}{{/each}}{{/each}}';
    await wb.xlsx.writeFile(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const out = new ExcelJS.Workbook();
    await out.xlsx.readFile(outPath);
    const outWs = out.worksheets[0];
    expect([1, 2].map((r) => outWs.getRow(r).getCell(2).value)).toEqual(['カテゴリA', '']);
    expect([1, 2].map((r) => outWs.getRow(r).getCell(3).value)).toEqual(['手順1', '手順2']);
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

  it('コードブロックの部分だけ等幅フォント・色付きのリッチテキストにする', async () => {
    const templatePath = path.join(tmpDir, 'custom-code.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    tplWs.getRow(1).getCell(1).value = '{{#each ## steps}}{{##.body}}';
    tplWs.getRow(1).getCell(1).font = { size: 9 };
    tplWs.getRow(1).getCell(2).value = '{{##}}{{/each}}';
    await tplWb.xlsx.writeFile(templatePath);

    const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n実行する\n\n```sh\nls -la\n```\n');
    const outPath = await generateExcel(doc, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    expect(ws.getRow(1).getCell(1).value).toEqual({
      richText: [
        { text: '実行する\n\n', font: { size: 9 } },
        {
          text: 'ls -la',
          font: { size: 9, name: 'Consolas', color: { argb: 'FFC7254E' } },
        },
      ],
    });
    // コードブロックを含まないセルは文字列のまま
    expect(ws.getRow(1).getCell(2).value).toBe('手順1');
  });

  it('画像が無くても、展開した行の高さを文章の行数に合わせて広げる', async () => {
    const templatePath = path.join(tmpDir, 'custom-text-height.xlsx');
    const tplWb = new ExcelJS.Workbook();
    const tplWs = tplWb.addWorksheet('テンプレート');
    tplWs.getRow(1).getCell(1).value = '{{#each ### steps}}{{###}}';
    tplWs.getRow(1).getCell(2).value = '{{#each - steps}}・{{-}}\n{{/each}}{{/each}}';
    await tplWb.xlsx.writeFile(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];

    // 手順1は箇条書き2項目＋末尾の改行で3行、手順2は1行
    const [multiLine, singleLine] = [ws.getRow(1).height, ws.getRow(2).height];
    expect(singleLine).toBeGreaterThan(0);
    expect(multiLine).toBeGreaterThan(singleLine * 2);
    expect(ws.getImages()).toHaveLength(0);
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

  describe('画像の貼り付け', () => {
    const IMAGE_MD = `# ログイン手順

## 手順1

操作 ![本文](./body.png)

- 項目 ![リスト](./list.webp)

> 結果
> ![引用1](./quote.png)
> ![引用2](./quote.png)
`;

    /** 本文・リスト・引用の画像を書き出す */
    async function writeImages(): Promise<void> {
      const create = { width: 200, height: 100, channels: 3 as const, background: '#f00' };
      await sharp({ create }).png().toFile(path.join(tmpDir, 'body.png'));
      await sharp({ create }).webp().toFile(path.join(tmpDir, 'list.webp'));
      await fs.promises.writeFile(
        path.join(tmpDir, 'quote.png'),
        Buffer.from(TINY_PNG_BASE64, 'base64'),
      );
    }

    /** 列（1始まり）ごとに、貼り付けられた画像を上から順に返す */
    function imagesInColumn(ws: ExcelJS.Worksheet, col: number) {
      return ws
        .getImages()
        .filter((image) => image.range.tl.nativeCol === col - 1)
        .sort((a, b) => a.range.tl.nativeRowOff - b.range.tl.nativeRowOff);
    }

    it('画像を含む変数を書いたセルに、文章の下へ縦に並べて貼り付ける', async () => {
      await writeImages();
      const outPath = await generateExcel(parseMarkdown(IMAGE_MD), inputFile, outputDir);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);
      const ws = wb.worksheets[0];

      // 既定テンプレート: D列 `{{##}}\n{{##.body}}`（本文・リスト）、E列 `{{##.>}}`（引用）
      const bodyImages = imagesInColumn(ws, 4);
      const quoteImages = imagesInColumn(ws, 5);
      expect(bodyImages).toHaveLength(2);
      expect(quoteImages).toHaveLength(2);
      for (const image of [...bodyImages, ...quoteImages]) {
        expect(image.range.tl.nativeRow).toBe(3);
        expect(image.range).toHaveProperty('editAs', 'oneCell');
      }
      // 文章の下から始まり、上の画像と重ならない
      expect(bodyImages[0].range.tl.nativeRowOff).toBeGreaterThan(0);
      const [first, second] = quoteImages;
      expect(second.range.tl.nativeRowOff).toBeGreaterThan(first.range.tl.nativeRowOff);
      // 画像が収まるよう行の高さが広がる
      expect(ws.getRow(4).height).toBeGreaterThan(100 * 0.75);
    });

    it('WebPはPNGに変換し、同じ画像は一度だけ読み込む', async () => {
      await writeImages();
      const outPath = await generateExcel(parseMarkdown(IMAGE_MD), inputFile, outputDir);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);

      const media = wb.model.media as Array<{ extension: string }>;
      // body.png・list.webp（PNGに変換）・quote.png（2回使うが1つ）の3つ
      expect(media.map((m) => m.extension)).toEqual(['png', 'png', 'png']);
    });

    it('読み込めない画像は警告を出してスキップし、生成は続ける', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n> ![無い](./missing.png)\n');
      const outPath = await generateExcel(doc, inputFile, outputDir);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(outPath);

      expect(wb.worksheets[0].getImages()).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('./missing.png'));
      warn.mockRestore();
    });
  });

  it('デフォルトテンプレートの結合セルが出力後も維持される', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(outPath);
    const ws = wb.worksheets[0];
    expect(ws.getCell('B1').isMerged).toBe(true);
    expect(ws.getCell('H1').isMerged).toBe(true);
    expect(ws.getCell('B2').isMerged).toBe(true);
  });

  it('テンプレートファイルが存在しない場合は GeneratorError をスローする', async () => {
    await expect(
      generateExcel(SAMPLE_DOC, inputFile, outputDir, path.join(tmpDir, 'nope.xlsx')),
    ).rejects.toThrow(GeneratorError);
  });
});
