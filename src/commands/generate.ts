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

/** プリセットテンプレートを置くディレクトリ */
const PRESET_TEMPLATE_DIR = path.join(__dirname, '..', '..', 'templates');

/** パス区切り文字 */
const PATH_SEPARATOR = /[/\\]/;

/** 出力形式ごとに使うテンプレートファイルのパス（未定義なら既定テンプレート） */
export interface TemplatePaths {
  html?: string;
  excel?: string;
}

/**
 * `--template` の値がプリセット名（拡張子もパス区切りもない値）かどうかを判定する
 *
 * @param template `--template` に指定された値
 * @returns プリセット名なら true
 */
export function isPresetName(template: string): boolean {
  return path.extname(template) === '' && !PATH_SEPARATOR.test(template);
}

/**
 * プリセット名から、指定した拡張子のテンプレートファイルのパスを求める
 *
 * @param name プリセット名（例: `simple`）
 * @param ext テンプレートの拡張子（`.html` または `.xlsx`）
 * @returns テンプレートファイルのパス
 * @throws GeneratorError プリセットのテンプレートファイルが存在しない場合
 */
function resolvePresetPath(name: string, ext: '.html' | '.xlsx'): string {
  const presetPath = path.join(PRESET_TEMPLATE_DIR, `${name}${ext}`);
  if (!fs.existsSync(presetPath)) {
    throw new GeneratorError(
      `プリセット「${name}」の${ext}テンプレートが見つかりません: ${presetPath}`,
    );
  }
  return presetPath;
}

/**
 * `--template` の値から、出力形式ごとに使うテンプレートファイルのパスを決定する
 *
 * プリセット名なら `templates/<名前>.html` / `templates/<名前>.xlsx` を使う。
 * ファイルパスなら、拡張子が合う形式にだけそのファイルを使う。
 *
 * @param template `--template` に指定された値
 * @param shouldHtml HTMLを出力するか
 * @param shouldExcel Excelを出力するか
 * @returns 出力形式ごとのテンプレートファイルのパス
 * @throws GeneratorError プリセットが見つからない、または両形式出力時に拡張子が無効な場合
 */
export function resolveTemplatePaths(
  template: string | undefined,
  shouldHtml: boolean,
  shouldExcel: boolean,
): TemplatePaths {
  if (!template) return {};

  if (isPresetName(template)) {
    return {
      html: shouldHtml ? resolvePresetPath(template, '.html') : undefined,
      excel: shouldExcel ? resolvePresetPath(template, '.xlsx') : undefined,
    };
  }

  const templateExt = path.extname(template).toLowerCase();
  const isHtmlTemplate = templateExt === '.html' || templateExt === '.htm';
  const isExcelTemplate = templateExt === '.xlsx';

  // テンプレートと出力形式の整合性チェック
  if (shouldHtml && shouldExcel && !isHtmlTemplate && !isExcelTemplate) {
    throw new GeneratorError(
      `テンプレートファイルの拡張子が無効です: ${template}\n.html または .xlsx を指定してください。`,
    );
  }

  return {
    html: isHtmlTemplate ? template : undefined,
    excel: isExcelTemplate ? template : undefined,
  };
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

  const shouldHtml = options.format === 'html' || options.format === 'both';
  const shouldExcel = options.format === 'excel' || options.format === 'both';

  const templates = resolveTemplatePaths(options.template, shouldHtml, shouldExcel);

  const results: string[] = [];

  // HTML生成
  if (shouldHtml) {
    const outPath = await generateHtml(
      doc,
      resolvedInput,
      outputDir,
      templates.html,
      outputBaseName,
    );
    console.log(`  ✅  HTML: ${outPath}`);
    results.push(outPath);
  }

  // Excel生成
  if (shouldExcel) {
    const outPath = await generateExcel(
      doc,
      resolvedInput,
      outputDir,
      templates.excel,
      outputBaseName,
    );
    console.log(`  ✅  Excel: ${outPath}`);
    results.push(outPath);
  }

  console.log(`\n✨  生成完了 (${results.length}ファイル)\n`);
}
