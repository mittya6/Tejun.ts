import fs from 'fs';
import path from 'path';
import { marked } from 'marked';
import { renderTemplate } from '../template/templateEngine';
import { parseFrontMatter } from '../parser/markdownParser';
import { GeneratorError, TemplateError } from '../utils/errors';
import { embedImagesInHtml, isLocalImagePath, readImageAsDataUri } from '../utils/imageUtils';
import type { ProcedureDocument, Step, TemplateContext } from '../parser/types';

/** 未指定時に使用するデフォルトHTMLテンプレートのパス */
const DEFAULT_HTML_TEMPLATE_PATH = path.join(__dirname, '..', '..', 'templates', 'default.html');

/**
 * ステップ内の画像パスをData URIに変換する
 *
 * `step.image`（期待値ブロック内で検出された画像）に加え、`instruction` / `expected` の
 * HTML本文中に含まれる `<img>` タグの画像も対象とする。画像ファイルが見つからない場合は
 * ログを出力して元のパスを維持する。
 */
async function embedImages(steps: Step[], basePath: string): Promise<Step[]> {
  return Promise.all(
    steps.map(async (step) => {
      const instruction = await embedImagesInHtml(step.instruction, basePath);
      // 期待値内の画像は元の記述順を保つため、画像を含む版を本文として使う
      const expected = await embedImagesInHtml(step.expectedInline ?? step.expected, basePath);

      // 画像は本文内に埋め込み済みなので、テンプレート側の `{{image.*}}` での二重表示を避ける
      if (step.expectedInline !== undefined) {
        return { ...step, instruction, expected, image: undefined };
      }
      if (!step.image || !isLocalImagePath(step.image.src)) {
        return { ...step, instruction, expected };
      }
      try {
        const dataUri = await readImageAsDataUri(step.image.src, basePath);
        return { ...step, instruction, expected, image: { ...step.image, src: dataUri } };
      } catch {
        console.warn(`[Tejun.ts] 画像を読み込めませんでした: ${step.image.src}`);
        return { ...step, instruction, expected };
      }
    }),
  );
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
  const stepsWithImages = await embedImages(doc.steps, basePath);
  const overviewWithImages = doc.overview
    ? await embedImagesInHtml(doc.overview, basePath)
    : doc.overview;
  const h1BodyWithImages = doc.h1Body ? await embedImagesInHtml(doc.h1Body, basePath) : doc.h1Body;
  const h1BlockquoteWithImages = doc.h1Blockquote
    ? await embedImagesInHtml(doc.h1Blockquote, basePath)
    : doc.h1Blockquote;
  const docWithImages: ProcedureDocument = {
    ...doc,
    steps: stepsWithImages,
    overview: overviewWithImages,
    h1Body: h1BodyWithImages,
    h1Blockquote: h1BlockquoteWithImages,
  };

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
    document: { title: docWithImages.title },
    date: docWithImages.date,
    update: docWithImages.update,
    steps: docWithImages.steps,
    markdown: markdownHtml,
    overview: docWithImages.overview,
    h1Body: docWithImages.h1Body,
    h1Blockquote: docWithImages.h1Blockquote,
    firstHeadings: docWithImages.firstHeadings,
    meta: docWithImages.meta,
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
