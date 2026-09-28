import fs from 'fs';
import path from 'path';
import { parseMarkdown } from '../parser/markdownParser';
import { findNodePaths } from '../parser/docTree';
import { generateHtml } from '../generators/htmlGenerator';
import { generateExcel } from '../generators/excelGenerator';
import { ParseError, GeneratorError } from '../utils/errors';

/** generate コマンドに渡されるオプション */
export interface GenerateOptions {
  format: 'html' | 'excel' | 'both';
  out: string;
  template?: string;
  /** 出力ファイル名に使うFront Matterのプロパティ（例: `meta.filename`） */
  name?: string;
}

/** `--name` で指定するプロパティの接頭辞 */
const META_PREFIX = 'meta.';

/** ファイル名に使えない文字（Windowsの禁止文字・パス区切り・制御文字） */
const INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1f]/;

/**
 * `--name` で指定されたFront Matterのプロパティから、出力ファイル名（拡張子なし）を決定する
 *
 * @param meta Front Matterの全プロパティ
 * @param nameProperty `meta.プロパティ名` 形式のプロパティ指定
 * @returns 出力ファイル名（拡張子なし）
 * @throws ParseError 指定形式が不正、値が未定義・空、またはファイル名に使えない文字を含む場合
 */
export function resolveOutputBaseName(meta: Record<string, string>, nameProperty: string): string {
  if (!nameProperty.startsWith(META_PREFIX) || nameProperty.length === META_PREFIX.length) {
    throw new ParseError(
      `--name には meta.プロパティ名 の形式で指定してください（例: meta.filename）: ${nameProperty}`,
    );
  }
  const key = nameProperty.slice(META_PREFIX.length);
  const value = meta[key]?.trim();
  if (!value) {
    throw new ParseError(`Front Matterにファイル名のプロパティ「${key}」が定義されていません。`);
  }
  if (INVALID_FILENAME_CHARS.test(value) || value === '.' || value === '..') {
    throw new ParseError(`プロパティ「${key}」の値はファイル名に使用できません: ${value}`);
  }
  return value;
}

/**
 * generate コマンドの実行本体
 *
 * Markdownファイルを解析し、指定フォーマットのファイルを生成する。
 * 画像処理・テンプレート適用を含む全処理を担当する。
 *
 * @param inputFile 変換対象のMarkdownファイルパス
 * @param options CLIオプション
 */
export async function runGenerate(inputFile: string, options: GenerateOptions): Promise<void> {
  const resolvedInput = path.resolve(inputFile);

  // 入力ファイルの存在確認
  if (!fs.existsSync(resolvedInput)) {
    throw new ParseError(`入力ファイルが見つかりません: ${resolvedInput}`);
  }

  const ext = path.extname(resolvedInput).toLowerCase();
  if (ext !== '.md' && ext !== '.markdown') {
    throw new ParseError(
      `入力ファイルはMarkdown形式（.md / .markdown）である必要があります: ${resolvedInput}`,
    );
  }

  // Markdownの読み込みと解析
  const content = await fs.promises.readFile(resolvedInput, 'utf-8');
  const doc = parseMarkdown(content);
  const outputBaseName = options.name ? resolveOutputBaseName(doc.meta, options.name) : undefined;

  console.log(`\n📄  ${doc.title}`);
  console.log(
    `    ステップ数: ${findNodePaths(doc.root, '###').length}  /  出力先: ${path.resolve(options.out)}\n`,
  );

  const outputDir = path.resolve(options.out);

  // テンプレートの形式チェック
  const templateExt = options.template ? path.extname(options.template).toLowerCase() : '';

  const shouldHtml = options.format === 'html' || options.format === 'both';
  const shouldExcel = options.format === 'excel' || options.format === 'both';

  if (options.template) {
    // テンプレートと出力形式の整合性チェック
    if (shouldHtml && shouldExcel && templateExt !== '') {
      const isHtmlTemplate = templateExt === '.html' || templateExt === '.htm';
      const isExcelTemplate = templateExt === '.xlsx';
      if (!isHtmlTemplate && !isExcelTemplate) {
        throw new GeneratorError(
          `テンプレートファイルの拡張子が無効です: ${options.template}\n.html または .xlsx を指定してください。`,
        );
      }
    }
  }

  const results: string[] = [];

  // HTML生成
  if (shouldHtml) {
    const htmlTemplate =
      options.template && (templateExt === '.html' || templateExt === '.htm')
        ? options.template
        : undefined;
    const outPath = await generateHtml(doc, resolvedInput, outputDir, htmlTemplate, outputBaseName);
    console.log(`  ✅  HTML: ${outPath}`);
    results.push(outPath);
  }

  // Excel生成
  if (shouldExcel) {
    const excelTemplate =
      options.template && templateExt === '.xlsx' ? options.template : undefined;
    const outPath = await generateExcel(
      doc,
      resolvedInput,
      outputDir,
      excelTemplate,
      outputBaseName,
    );
    console.log(`  ✅  Excel: ${outPath}`);
    results.push(outPath);
  }

  console.log(`\n✨  生成完了 (${results.length}ファイル)\n`);
}
