import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { renderTemplate } from '../template/templateEngine';
import { parseFrontMatter } from '../parser/markdownParser';
import { GeneratorError, TemplateError } from '../utils/errors';
import { embedImagesInHtml } from '../utils/imageUtils';
import type { DocNode, ProcedureDocument, TemplateContext } from '../parser/types';

/** 未指定時に使用するデフォルトHTMLテンプレートのパス */
const DEFAULT_HTML_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'default.html');

/**
 * ツリーの各要素のHTML（内容・本文）に含まれる `<img>` タグの画像をData URIに変換する
 *
 * 画像ファイルが見つからない場合は元のパスを維持する（`embedImagesInHtml` の動作に従う）。
 */
async function embedImages(node: DocNode, basePath: string): Promise<DocNode> {
  return {
    ...node,
    // 見出しの内容はプレーンテキストなので対象外
    content: node.symbol.startsWith('#')
      ? node.content
      : await embedImagesInHtml(node.content, basePath),
    body: node.body && (await embedImagesInHtml(node.body, basePath)),
    children: await Promise.all(node.children.map((child) => embedImages(child, basePath))),
  };
}

/**
 * HTML出力を生成してファイルに書き込む
 *
 * @param doc 解析済み手順書ドキュメント
 * @param inputFilePath 入力Markdownファイルのパス（画像の相対パス解決に使用）
 * @param outputDir 出力先ディレクトリ
 * @param templatePath カスタムHTMLテンプレートファイルのパス（省略時はデフォルトテンプレートを使用）
 * @returns 生成されたHTMLファイルのパス
 */
export async function generateHtml(
  doc: ProcedureDocument,
  inputFilePath: string,
  outputDir: string,
  templatePath?: string,
): Promise<string> {
  const resolvedInputPath = path.resolve(inputFilePath);
  const basePath = path.dirname(resolvedInputPath);

  // 画像をData URIに変換
  const rootWithImages = await embedImages(doc.root, basePath);
  const overviewWithImages = doc.overview
    ? await embedImagesInHtml(doc.overview, basePath)
    : doc.overview;

  // 入力Markdown全文（Front Matter除く）をHTMLに変換（テンプレートの `${markdown}` 用）
  let markdownHtml: string;
  try {
    const rawContent = await fs.promises.readFile(resolvedInputPath, 'utf-8');
    const { body } = parseFrontMatter(rawContent);
    markdownHtml = marked.parse(body) as string;
    markdownHtml = await embedImagesInHtml(markdownHtml, basePath);
  } catch (err) {
    throw new GeneratorError(
      `Markdownファイルを読み込めません: ${resolvedInputPath}\n${String(err)}`,
    );
  }

  // テンプレート文字列の取得（未指定時はデフォルトテンプレートを使用）
  const resolvedTemplatePath = templatePath ?? DEFAULT_HTML_TEMPLATE_PATH;
  let templateStr: string;
  try {
    templateStr = await fs.promises.readFile(resolvedTemplatePath, 'utf-8');
  } catch (err) {
    throw new GeneratorError(
      `HTMLテンプレートを読み込めません: ${resolvedTemplatePath}\n${String(err)}`,
    );
  }

  // テンプレートの展開
  const ctx: TemplateContext = {
    title: doc.title,
    date: doc.date,
    update: doc.update,
    meta: doc.meta,
    root: rootWithImages,
    markdown: markdownHtml,
    overview: overviewWithImages,
  };

  let html: string;
  try {
    html = renderTemplate(templateStr, ctx);
  } catch (err) {
    if (err instanceof TemplateError) throw err;
    throw new GeneratorError(`HTMLテンプレートのレンダリングに失敗しました: ${String(err)}`);
  }

  // 出力ファイルパスの決定
  const baseName = path.basename(inputFilePath, path.extname(inputFilePath));
  const outPath = path.join(outputDir, `${baseName}.html`);

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(outPath, html, 'utf-8');

  return outPath;
}
