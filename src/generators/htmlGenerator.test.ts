import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { generateHtml } from './htmlGenerator';
import { GeneratorError } from '../utils/errors';
import { parseMarkdown } from '../parser/markdownParser';
import type { ProcedureDocument } from '../parser/types';

/** 1x1透明PNG（テスト用フィクスチャ） */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SAMPLE_DOC: ProcedureDocument = parseMarkdown(`---
date: "2026/06/24"
update: "2026/06/25"
---
# ログイン手順

## カテゴリA

### 手順1

操作内容

> 期待結果
`);

/** 期待される結果に画像を含む手順書を作る */
function docWithImage(src: string): ProcedureDocument {
  return parseMarkdown(`# ログイン手順

## カテゴリA

### 手順1

> 期待結果
> ![スクリーンショット](${src})
`);
}

describe('generateHtml', () => {
  let tmpDir: string;
  let inputFile: string;
  let outputDir: string;

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'tejun-html-'));
    inputFile = path.join(tmpDir, 'input.md');
    outputDir = path.join(tmpDir, 'out');
    await fs.promises.writeFile(inputFile, '# ログイン手順', 'utf-8');
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
  });

  it('デフォルトテンプレートでHTMLファイルを生成する', async () => {
    const outPath = await generateHtml(SAMPLE_DOC, inputFile, outputDir);
    expect(fs.existsSync(outPath)).toBe(true);
    expect(path.basename(outPath)).toBe('input.html');

    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toContain('ログイン手順');
    expect(html).toContain('カテゴリA');
    expect(html).toContain('操作内容');
    expect(html).toContain('期待結果');
  });

  it('${markdown} を入力Markdown全文のHTMLに置換する', async () => {
    await fs.promises.writeFile(inputFile, '# ログイン手順\n\n本文テキスト', 'utf-8');
    const templatePath = path.join(tmpDir, 'custom.html');
    await fs.promises.writeFile(templatePath, '<div>${markdown}</div>', 'utf-8');

    const outPath = await generateHtml(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toContain('<h1>ログイン手順</h1>');
    expect(html).toContain('<p>本文テキスト</p>');
  });

  it('${title} / ${date} をFront Matterの値に置換する', async () => {
    const templatePath = path.join(tmpDir, 'custom.html');
    await fs.promises.writeFile(templatePath, '<h1>${title}</h1><span>${date}</span>', 'utf-8');

    const outPath = await generateHtml(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toBe('<h1>ログイン手順</h1><span>2026/06/24</span>');
  });

  it('カスタムテンプレートを使用してHTMLを生成する', async () => {
    const templatePath = path.join(tmpDir, 'custom.html');
    await fs.promises.writeFile(
      templatePath,
      '<h1>{{meta.title}}</h1>{{#each ### steps}}<p>{{###}}</p>{{/each}}',
      'utf-8',
    );

    const outPath = await generateHtml(SAMPLE_DOC, inputFile, outputDir, templatePath);
    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toBe('<h1>ログイン手順</h1><p>手順1</p>');
  });

  it('ローカル画像パスをData URIに変換して埋め込む', async () => {
    const imagePath = path.join(tmpDir, 'screen.png');
    await fs.promises.writeFile(imagePath, Buffer.from(TINY_PNG_BASE64, 'base64'));

    const outPath = await generateHtml(docWithImage('./screen.png'), inputFile, outputDir);
    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('./screen.png');
  });

  it('画像ファイルが存在しない場合は元のパスのまま処理を継続する', async () => {
    const outPath = await generateHtml(docWithImage('./missing.png'), inputFile, outputDir);
    const html = await fs.promises.readFile(outPath, 'utf-8');
    expect(html).toContain('./missing.png');
  });

  it('テンプレートファイルが存在しない場合は GeneratorError をスローする', async () => {
    await expect(
      generateHtml(SAMPLE_DOC, inputFile, outputDir, path.join(tmpDir, 'nope.html')),
    ).rejects.toThrow(GeneratorError);
  });
});
