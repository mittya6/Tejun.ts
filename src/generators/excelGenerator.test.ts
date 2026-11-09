import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { parseCellRef, readXlsx, writeXlsx } from 'hucre';
import type { CellValue, RichTextRun, Sheet, SheetImage, WriteSheet } from 'hucre';
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

/** テンプレートのシートを .xlsx に書き出す */
async function writeTemplate(filePath: string, sheet: Omit<WriteSheet, 'name'>): Promise<void> {
  const output = await writeXlsx({ sheets: [{ name: 'テンプレート', ...sheet }] });
  await fs.promises.writeFile(filePath, output);
}

/** 出力したExcelの最初のシートを読み直す */
async function readSheet(filePath: string): Promise<Sheet> {
  const workbook = await readXlsx(await fs.promises.readFile(filePath), { readStyles: true });
  return workbook.sheets[0];
}

/** A1形式で指定したセルの値を返す */
function valueAt(sheet: Sheet, ref: string): CellValue {
  const { row, col } = parseCellRef(ref);
  return sheet.rows[row]?.[col] ?? null;
}

/** A1形式で指定したセルのリッチテキストを返す */
function richTextAt(sheet: Sheet, ref: string): RichTextRun[] | undefined {
  const { row, col } = parseCellRef(ref);
  return sheet.cells?.get(`${row},${col}`)?.richText;
}

/** 行（1始まり）の高さ（pt）を返す */
function heightOf(sheet: Sheet, row: number): number | undefined {
  return sheet.rowDefs?.get(row - 1)?.height;
}

/** 貼り付けられた画像を返す */
function imagesOf(sheet: Sheet): SheetImage[] {
  return sheet.images ?? [];
}

/** xlsx（zip）から指定したパートの内容を取り出す（セントラルディレクトリから位置を求める） */
function readZipEntry(zip: Buffer, name: string): string {
  const endOfCentralDir = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let offset = zip.readUInt32LE(endOfCentralDir + 16);
  for (let i = 0; i < zip.readUInt16LE(endOfCentralDir + 10); i++) {
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const entryName = zip.toString('utf-8', offset + 46, offset + 46 + nameLength);
    if (entryName === name) {
      const local = zip.readUInt32LE(offset + 42);
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + size);
      return (method === 0 ? data : zlib.inflateRawSync(data)).toString('utf-8');
    }
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  throw new Error(`zipに ${name} がありません`);
}

/** 行ループの行を1行持つ最小限のカスタムテンプレートを作成する */
async function writeCustomTemplate(filePath: string): Promise<void> {
  await writeTemplate(filePath, {
    rows: [
      ['{{meta.title}}'],
      ['{{#each ### steps}}', '{{##}}', '{{###}}', '{{###.body}}', '{{/each}}'],
    ],
  });
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

    const ws = await readSheet(outPath);
    expect(valueAt(ws, 'B1')).toBe('ログイン手順');
    // 既定テンプレートの列見出し（B列から 項番|大項目|操作手順|期待される結果|チェック|実施日|実行者）
    expect(valueAt(ws, 'F3')).toBe('チェック');
    expect(valueAt(ws, 'G3')).toBe('実施日');
    expect(valueAt(ws, 'H3')).toBe('実行者');
  });

  it('ステップ数分の行が展開される', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    const ws = await readSheet(outPath);
    // 行4・行5に手順1・手順2が展開されているはず
    expect(valueAt(ws, 'D4')).toContain('手順1');
    expect(valueAt(ws, 'D5')).toContain('手順2');
  });

  it('デフォルトテンプレートの {{##.index}} は大項目ごとの連番に置換される', async () => {
    const doc = parseMarkdown(`${SAMPLE_MD}\n## カテゴリB\n\n### 手順3\n`);
    const outPath = await generateExcel(doc, inputFile, outputDir);
    const ws = await readSheet(outPath);
    expect(['B4', 'B5', 'B6'].map((ref) => valueAt(ws, ref))).toEqual(['1-1', '1-2', '2-1']);
  });

  it('カスタムテンプレートの行ループの行を展開する', async () => {
    const templatePath = path.join(tmpDir, 'custom.xlsx');
    await writeCustomTemplate(templatePath);

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    expect(valueAt(ws, 'A1')).toBe('ログイン手順');
    expect(valueAt(ws, 'B2')).toBe('カテゴリA');
    expect(valueAt(ws, 'C2')).toBe('手順1');
    expect(valueAt(ws, 'C3')).toBe('手順2');
  });

  it('{{#if ##.first}} は同じ大項目の2行目以降を空にする', async () => {
    const templatePath = path.join(tmpDir, 'custom-first.xlsx');
    await writeTemplate(templatePath, {
      rows: [
        [
          '{{#each ## steps}}',
          '{{#each ### steps}}{{#if ##.first}}{{##}}{{/if}}',
          '{{###}}{{/each}}{{/each}}',
        ],
      ],
    });

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);
    expect(['B1', 'B2'].map((ref) => valueAt(ws, ref))).toEqual(['カテゴリA', '']);
    expect(['C1', 'C2'].map((ref) => valueAt(ws, ref))).toEqual(['手順1', '手順2']);
  });

  it('セル内で閉じた {{#each - steps}} はセル内で箇条書きの項目を繰り返す', async () => {
    const templatePath = path.join(tmpDir, 'custom-list.xlsx');
    await writeTemplate(templatePath, {
      rows: [['{{#each ### steps}}{{###}}', '{{#each - steps}}・{{-}}\n{{/each}}', '{{/each}}']],
    });

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    expect(valueAt(ws, 'A1')).toBe('手順1');
    expect(valueAt(ws, 'B1')).toBe('・ぶどう\n・リンゴ\n');
    expect(valueAt(ws, 'A2')).toBe('手順2');
    expect(valueAt(ws, 'B2')).toBe('');
  });

  it('行ループの記号が解釈できない（旧記法の {{#each steps}} など）場合は GeneratorError をスローする', async () => {
    const templatePath = path.join(tmpDir, 'custom-old.xlsx');
    await writeTemplate(templatePath, { rows: [['{{#each steps}}', '{{/each}}']] });

    await expect(generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath)).rejects.toThrow(
      GeneratorError,
    );
  });

  it('リッチテキストのセルに含まれる変数も置換される', async () => {
    const templatePath = path.join(tmpDir, 'custom-richtext.xlsx');
    // 書式の異なる断片に変数がまたがっていても置換されること
    const richText = (runs: RichTextRun[]) => ({
      value: runs.map((run) => run.text).join(''),
      type: 'richText' as const,
      richText: runs,
    });
    await writeTemplate(templatePath, {
      rows: [
        [
          richText([
            { font: { name: 'Noto Sans JP' }, text: '出力日: {{meta.' },
            { font: { name: 'Cambria' }, text: 'date}}' },
          ]),
        ],
        [
          richText([{ font: { bold: true }, text: '{{#each ### steps}}' }]),
          richText([{ font: { bold: true }, text: '{{###}}' }]),
        ],
      ],
    });

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    expect(valueAt(ws, 'A1')).toBe('出力日: 2026/06/24');
    expect(richTextAt(ws, 'A1')).toBeUndefined();
    expect(valueAt(ws, 'B2')).toBe('手順1');
    expect(valueAt(ws, 'B3')).toBe('手順2');
  });

  it('コードブロックの部分だけ等幅フォント・色付きのリッチテキストにする', async () => {
    const templatePath = path.join(tmpDir, 'custom-code.xlsx');
    await writeTemplate(templatePath, {
      rows: [
        [
          { value: '{{#each ## steps}}{{##.body}}', style: { font: { size: 9 } } },
          '{{##}}{{/each}}',
        ],
      ],
    });

    const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n実行する\n\n```sh\nls -la\n```\n');
    const outPath = await generateExcel(doc, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    const runs = richTextAt(ws, 'A1');
    expect(runs?.map((run) => run.text)).toEqual(['実行する\n\n', 'ls -la']);
    expect(runs?.[0].font).toMatchObject({ size: 9 });
    expect(runs?.[1].font).toMatchObject({ size: 9, name: 'Consolas', color: { rgb: 'C7254E' } });
    // コードブロックを含まないセルは文字列のまま
    expect(valueAt(ws, 'B1')).toBe('手順1');
    expect(richTextAt(ws, 'B1')).toBeUndefined();
  });

  it('表の部分だけMS ゴシックのリッチテキストにする', async () => {
    const templatePath = path.join(tmpDir, 'custom-table.xlsx');
    await writeTemplate(templatePath, {
      rows: [
        [
          {
            value: '{{#each ## steps}}{{##.body}}',
            style: { font: { size: 9, name: 'Calibri', scheme: 'minor', charset: 1 } },
          },
          '{{##}}{{/each}}',
        ],
      ],
    });

    const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n設定する\n\n| 名前 |\n|---|\n| a |\n');
    const outPath = await generateExcel(doc, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    const runs = richTextAt(ws, 'A1');
    expect(runs?.map((run) => run.text)).toEqual([
      '設定する\n\n',
      '┌───┐\n│ 名前 │\n├───┤\n│ a    │\n└───┘',
    ]);
    expect(runs?.[0].font).toMatchObject({ size: 9, name: 'Calibri', scheme: 'minor', charset: 1 });
    expect(runs?.[1].font).toMatchObject({ size: 9, name: 'ＭＳ ゴシック', charset: 128 });
    // テーマのフォントの指定が残るとフォント名より優先されるため、取り除く
    expect(runs?.[1].font?.scheme).toBeUndefined();
  });

  it('リンクの部分だけ青字・下線のリッチテキストにする', async () => {
    const templatePath = path.join(tmpDir, 'custom-link.xlsx');
    await writeTemplate(templatePath, {
      rows: [
        [
          { value: '{{#each ## steps}}{{##.body}}', style: { font: { size: 9 } } },
          '{{##}}{{/each}}',
        ],
      ],
    });

    const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n[手順書](https://example.com) を見る\n');
    const outPath = await generateExcel(doc, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    const runs = richTextAt(ws, 'A1');
    expect(runs?.map((run) => run.text)).toEqual(['手順書', ' を見る']);
    expect(runs?.[0].font).toMatchObject({ size: 9, color: { rgb: '0563C1' }, underline: true });
    expect(runs?.[1].font).toMatchObject({ size: 9 });
    expect(runs?.[1].font?.underline).toBeFalsy();
  });

  it('画像が無くても、展開した行の高さを文章の行数に合わせて広げる', async () => {
    const templatePath = path.join(tmpDir, 'custom-text-height.xlsx');
    await writeTemplate(templatePath, {
      rows: [['{{#each ### steps}}{{###}}', '{{#each - steps}}・{{-}}\n{{/each}}{{/each}}']],
    });

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    // 手順1は箇条書き2項目＋末尾の改行で3行、手順2は1行
    const [multiLine, singleLine] = [heightOf(ws, 1)!, heightOf(ws, 2)!];
    expect(singleLine).toBeGreaterThan(0);
    expect(multiLine).toBeGreaterThan(singleLine * 2);
    expect(imagesOf(ws)).toHaveLength(0);
  });

  it('テンプレートのステップ行に高さがあれば展開した行にも同じ高さを設定する', async () => {
    const templatePath = path.join(tmpDir, 'custom-height.xlsx');
    await writeTemplate(templatePath, {
      rows: [['{{#each ### steps}}', '{{###}}']],
      rowDefs: new Map([[0, { height: 55 }]]),
    });

    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const ws = await readSheet(outPath);

    expect(heightOf(ws, 1)).toBe(55);
    expect(heightOf(ws, 2)).toBe(55);
  });

  it('シートの x14ac:dyDescent を55にしない', async () => {
    const outPath = await generateExcel(parseMarkdown('# 見出し\n'), inputFile, outputDir);
    const sheetXml = readZipEntry(await fs.promises.readFile(outPath), 'xl/worksheets/sheet1.xml');

    expect(sheetXml).not.toContain('dyDescent="55"');
  });

  it('ブックとシートの画面設定を書き出す（無いと表示スケール150%のExcelで行が2/3の高さになる）', async () => {
    const outPath = await generateExcel(parseMarkdown('# 見出し\n'), inputFile, outputDir);
    const zip = await fs.promises.readFile(outPath);

    expect(readZipEntry(zip, 'xl/workbook.xml')).toMatch(/<bookViews><workbookView\b/);
    expect(readZipEntry(zip, 'xl/worksheets/sheet1.xml')).toMatch(/<sheetViews><sheetView\b/);
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

    /** 列（A1形式の列名）ごとに、貼り付けられた画像を上から順に返す */
    function imagesInColumn(ws: Sheet, column: string): SheetImage[] {
      const { col } = parseCellRef(`${column}1`);
      return imagesOf(ws)
        .filter((image) => image.anchor.from.col === col)
        .sort((a, b) => (a.anchor.from.rowOff ?? 0) - (b.anchor.from.rowOff ?? 0));
    }

    it('画像を含む変数を書いたセルに、文章の下へ縦に並べて貼り付ける', async () => {
      await writeImages();
      const outPath = await generateExcel(parseMarkdown(IMAGE_MD), inputFile, outputDir);
      const ws = await readSheet(outPath);

      // 既定テンプレート: D列 `{{##}}\n{{##.body}}`（本文・リスト）、E列 `{{##.>}}`（引用）
      const bodyImages = imagesInColumn(ws, 'D');
      const quoteImages = imagesInColumn(ws, 'E');
      expect(bodyImages).toHaveLength(2);
      expect(quoteImages).toHaveLength(2);
      for (const image of [...bodyImages, ...quoteImages]) {
        expect(image.anchor.from.row).toBe(3);
        // 大きさで指定する（右下の位置で指定しない）
        expect(image.anchor.to).toBeUndefined();
      }
      // 文章の下から始まり、上の画像と重ならない
      expect(bodyImages[0].anchor.from.rowOff).toBeGreaterThan(0);
      const [first, second] = quoteImages;
      expect(second.anchor.from.rowOff).toBeGreaterThan(first.anchor.from.rowOff ?? 0);
      // 画像が収まるよう行の高さが広がる
      expect(heightOf(ws, 4)).toBeGreaterThan(100 * 0.75);
    });

    it('WebPはPNGに変換し、同じ画像は一度だけ読み込む', async () => {
      await writeImages();
      const readFile = vi.spyOn(fs.promises, 'readFile');
      const outPath = await generateExcel(parseMarkdown(IMAGE_MD), inputFile, outputDir);
      const quoteReads = readFile.mock.calls.filter(([file]) => String(file).endsWith('quote.png'));
      readFile.mockRestore();

      expect(imagesOf(await readSheet(outPath)).map((image) => image.type)).toEqual([
        'png',
        'png',
        'png',
        'png',
      ]);
      // quote.png は2回使うが1回だけ読み込む
      expect(quoteReads).toHaveLength(1);
    });

    it('{{記号.text}} のセルには画像を貼らず、{{記号.images}} のセルに貼り付ける', async () => {
      await writeImages();
      const templatePath = path.join(tmpDir, 'custom-images.xlsx');
      await writeTemplate(templatePath, {
        rows: [['{{#each ## steps}}{{##.body.text}}', '{{##.>.text}}', '{{##.images}}{{/each}}']],
      });

      const outPath = await generateExcel(
        parseMarkdown(IMAGE_MD),
        inputFile,
        outputDir,
        templatePath,
      );
      const ws = await readSheet(outPath);

      expect(imagesInColumn(ws, 'A')).toHaveLength(0);
      expect(imagesInColumn(ws, 'B')).toHaveLength(0);
      // 本文・リスト・引用2つ。画像だけのセルは上端（余白8px）から貼り付ける
      const images = imagesInColumn(ws, 'C');
      expect(images).toHaveLength(4);
      expect(images[0].anchor.from.rowOff).toBe(8);
      expect(valueAt(ws, 'C1')).toBe('');
      // 大きさで指定し（Excelで行が低く表示されても潰れない）、ファイルの行の高さには収まる
      const rowHeightPx = heightOf(ws, 1)! / 0.75;
      for (const image of images) {
        expect(image.height).toBeGreaterThan(0);
        expect((image.anchor.from.rowOff ?? 0) + image.height!).toBeLessThan(rowHeightPx);
      }
    });

    it('同じ画像を離れた手順で使い、別の画像を続けて使っても、枠と画像の比率が一致する', async () => {
      const sizes = { 'a.png': [200, 600], 'b.png': [300, 300], 'c.png': [600, 200] };
      for (const [name, [width, height]] of Object.entries(sizes)) {
        const create = { width, height, channels: 3 as const, background: '#f00' };
        await sharp({ create }).png().toFile(path.join(tmpDir, name));
      }
      const md = ['a.png', 'b.png', 'a.png', 'c.png', 'c.png']
        .map((name, i) => `## 手順${i}\n\n![図](./${name})\n`)
        .join('\n');

      const outPath = await generateExcel(parseMarkdown(`# 見出し\n\n${md}`), inputFile, outputDir);

      const images = imagesOf(await readSheet(outPath));
      expect(images).toHaveLength(5);
      for (const image of images) {
        const { width, height } = await sharp(image.data).metadata();
        expect(image.width! / image.height!).toBeCloseTo(width / height, 1);
      }
    });

    describe('行ループ外のセル', () => {
      /** 前文の画像（横長）を書き出す */
      async function writeRootImage(): Promise<void> {
        const create = { width: 300, height: 100, channels: 3 as const, background: '#f00' };
        await sharp({ create }).png().toFile(path.join(tmpDir, 'root.png'));
      }

      /** テンプレートを書き出してExcelを生成し、出力を読み直す */
      async function generate(template: Omit<WriteSheet, 'name'>, md: string): Promise<Sheet> {
        const templatePath = path.join(tmpDir, 'custom-root.xlsx');
        await writeTemplate(templatePath, template);
        const outPath = await generateExcel(parseMarkdown(md), inputFile, outputDir, templatePath);
        return readSheet(outPath);
      }

      const ROOT_MD = '前文 ![図](./root.png)\n\n# 見出し\n\n## 手順1\n\n本文\n';

      it('結合セルの {{root.body}} の画像を結合範囲の幅で中央に置き、行を広げる', async () => {
        await writeRootImage();
        const ws = await generate(
          {
            rows: [['{{root.body}}']],
            columns: [{ width: 20 }, { width: 30 }, { width: 40 }],
            rowDefs: new Map([[0, { height: 20 }]]),
            merges: ['A1:C1'],
          },
          ROOT_MD,
        );

        const [image] = imagesOf(ws);
        // 列の幅は 145, 215, 285px で合計645px。画像の幅は80%の516px
        expect(image.anchor.from.col).toBe(0);
        expect(image.width).toBe(516);
        expect(image.anchor.from.colOff).toBe(65);
        expect(image.width! / image.height!).toBeCloseTo(3, 1);
        expect((image.anchor.from.rowOff ?? 0) + image.height!).toBeLessThan(
          heightOf(ws, 1)! / 0.75,
        );
      });

      it('行ループが無いテンプレートでも画像を貼り付ける', async () => {
        await writeRootImage();
        const ws = await generate({ rows: [['{{root.body}}']] }, ROOT_MD);

        expect(imagesOf(ws)).toHaveLength(1);
      });

      it('行ループより下の行の画像は、展開後の行に貼り付ける', async () => {
        await writeRootImage();
        const ws = await generate(
          { rows: [['{{#each ## steps}}{{##}}'], ['{{root.body}}']] },
          '前文 ![図](./root.png)\n\n# 見出し\n\n## 手順1\n\n## 手順2\n\n## 手順3\n',
        );

        const [image] = imagesOf(ws);
        expect(image.anchor.from.row).toBe(3);
        expect(valueAt(ws, 'A4')).toContain('前文');
        expect(heightOf(ws, 4)! / 0.75).toBeGreaterThan(
          (image.anchor.from.rowOff ?? 0) + image.height!,
        );
      });

      it('文章に合わせて行を広げるが、変数の無いセルの行とテンプレートより低い高さには変えない', async () => {
        const wrap = { alignment: { wrapText: true } };
        const ws = await generate(
          {
            rows: [
              [{ value: '{{root.body}}', style: wrap }],
              [{ value: '{{root.body}}', style: wrap }],
              ['変数の無い\n長い\n文章'],
            ],
            columns: [{ width: 20 }],
            rowDefs: new Map([
              [1, { height: 300 }],
              [2, { height: 15 }],
            ]),
          },
          `${'長い前文です。'.repeat(20)}\n\n# 見出し\n`,
        );

        expect(heightOf(ws, 1)).toBeGreaterThan(15);
        expect(heightOf(ws, 2)).toBe(300);
        expect(heightOf(ws, 3)).toBe(15);
      });
    });

    it('読み込めない画像は警告を出してスキップし、生成は続ける', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const doc = parseMarkdown('# 見出し\n\n## 手順1\n\n> ![無い](./missing.png)\n');
      const outPath = await generateExcel(doc, inputFile, outputDir);

      expect(imagesOf(await readSheet(outPath))).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('./missing.png'));
      warn.mockRestore();
    });
  });

  it('デフォルトテンプレートの結合セルが出力後も維持される', async () => {
    const outPath = await generateExcel(SAMPLE_DOC, inputFile, outputDir);
    const ws = await readSheet(outPath);
    // B1:I1（タイトル）と B2:I2（出力日・前文）
    expect(ws.merges).toContainEqual({ startRow: 0, startCol: 1, endRow: 0, endCol: 8 });
    expect(ws.merges).toContainEqual({ startRow: 1, startCol: 1, endRow: 1, endCol: 8 });
  });

  it('テンプレートファイルが存在しない場合は GeneratorError をスローする', async () => {
    await expect(
      generateExcel(SAMPLE_DOC, inputFile, outputDir, path.join(tmpDir, 'nope.xlsx')),
    ).rejects.toThrow(GeneratorError);
  });
});
