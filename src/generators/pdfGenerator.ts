import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { renderHtml } from './htmlGenerator';
import { GeneratorError } from '../utils/errors';
import type { ProcedureDocument } from '../parser/types';

/** ページの余白（上下はフッターの高さを含む） */
const PAGE_MARGIN = { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' };

/** フッター（中央にページ番号「1 / 10」を表示する。Chromeがクラス名の位置に番号を差し込む） */
const FOOTER_TEMPLATE =
  '<div style="width:100%;text-align:center;font-size:9px;color:#666">' +
  '<span class="pageNumber"></span> / <span class="totalPages"></span></div>';

/** ヘッダー（表示しない。空文字だとChromeの既定のヘッダーになるため空要素を指定する） */
const HEADER_TEMPLATE = '<span></span>';

/**
 * 実行環境でよく使われるEdge / Chromeのインストール先の一覧を返す（先頭ほど優先）
 *
 * @param platform 実行環境のOS（`process.platform` の値）
 * @param env 環境変数（Windowsのインストール先フォルダの解決に使用）
 * @returns ブラウザの実行ファイルのパスの候補
 */
export function browserCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string[] {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES(X86)'], env.PROGRAMFILES, env.LOCALAPPDATA].filter(
      (root): root is string => !!root,
    );
    return [
      ...roots.map((root) =>
        path.win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      ),
      ...roots.map((root) =>
        path.win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
  ];
}

/**
 * PDF出力に使うブラウザの実行ファイルを決定する
 *
 * @param browserPath `--browser` で指定されたパス（省略時はインストール先を自動で探す）
 * @returns ブラウザの実行ファイルのパス
 * @throws GeneratorError 指定されたパスが存在しない、またはブラウザが見つからない場合
 */
export function findBrowser(browserPath?: string): string {
  if (browserPath) {
    if (!fs.existsSync(browserPath)) {
      throw new GeneratorError(`--browser に指定したブラウザが見つかりません: ${browserPath}`);
    }
    return browserPath;
  }

  const found = browserCandidates(process.platform, process.env).find((p) => fs.existsSync(p));
  if (!found) {
    throw new GeneratorError(
      'PDF出力に使うブラウザ（Edge または Chrome）が見つかりません。\n' +
        'ブラウザをインストールするか、--browser でブラウザの実行ファイルのパスを指定してください。',
    );
  }
  return found;
}

/**
 * HTMLをブラウザで印刷してPDFを生成する
 *
 * A4縦で、フッター中央にページ番号を入れ、見出しからしおりを作る。
 * テンプレート内のJavaScriptは実行しない。
 *
 * @param html 印刷するHTML
 * @param executablePath ブラウザの実行ファイルのパス
 * @returns PDFのデータ
 * @throws GeneratorError ブラウザの起動または印刷に失敗した場合
 */
async function printPdf(html: string, executablePath: string): Promise<Uint8Array> {
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath });
  } catch (err) {
    throw new GeneratorError(
      `ブラウザを起動できません: ${executablePath}\n` +
        `--browser で別のブラウザを指定してください。\n${String(err)}`,
    );
  }

  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: PAGE_MARGIN,
      displayHeaderFooter: true,
      headerTemplate: HEADER_TEMPLATE,
      footerTemplate: FOOTER_TEMPLATE,
      outline: true,
    });
  } catch (err) {
    throw new GeneratorError(`PDFの生成に失敗しました: ${String(err)}`);
  } finally {
    await browser.close();
  }
}

/**
 * PDF出力を生成してファイルに書き込む
 *
 * HTMLテンプレートを展開したHTMLを、PCにインストール済みのEdge / Chromeで印刷する。
 *
 * @param doc 解析済み手順書ドキュメント
 * @param inputFilePath 入力Markdownファイルのパス（画像の相対パス解決に使用）
 * @param outputDir 出力先ディレクトリ
 * @param templatePath カスタムHTMLテンプレートファイルのパス（省略時はデフォルトテンプレートを使用）
 * @param outputBaseName 出力ファイル名（拡張子なし。省略時は入力ファイル名を使用）
 * @param browserPath ブラウザの実行ファイルのパス（省略時はインストール先を自動で探す）
 * @returns 生成されたPDFファイルのパス
 */
export async function generatePdf(
  doc: ProcedureDocument,
  inputFilePath: string,
  outputDir: string,
  templatePath?: string,
  outputBaseName?: string,
  browserPath?: string,
): Promise<string> {
  const executablePath = findBrowser(browserPath);
  const html = await renderHtml(doc, inputFilePath, templatePath);
  const pdf = await printPdf(html, executablePath);

  const baseName = outputBaseName ?? path.basename(inputFilePath, path.extname(inputFilePath));
  const outPath = path.join(outputDir, `${baseName}.pdf`);

  await fs.promises.mkdir(outputDir, { recursive: true });
  await fs.promises.writeFile(outPath, pdf);

  return outPath;
}
