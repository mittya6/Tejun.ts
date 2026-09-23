import fs from 'fs';
import path from 'path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
};

/**
 * 画像ファイルかどうか判定する（Data URI・外部URLは対象外）
 */
export function isLocalImagePath(src: string): boolean {
  if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(src).toLowerCase());
}

/**
 * 画像ファイルを読み込んでData URI文字列に変換する
 * @param imageSrc Markdownに記述された画像パス（相対パス可）
 * @param basePath 解決の基準ディレクトリ（入力Markdownファイルのディレクトリ）
 */
export async function readImageAsDataUri(imageSrc: string, basePath: string): Promise<string> {
  const resolved = path.resolve(basePath, imageSrc);
  const ext = path.extname(resolved).toLowerCase();
  const mimeType = MIME_MAP[ext] ?? 'application/octet-stream';
  const buffer = await fs.promises.readFile(resolved);
  return `data:${mimeType};base64,${buffer.toString('base64')}`;
}

/** HTML文字列中の `<img src="...">` を検出する正規表現の元パターン（`src`属性の前後をキャプチャ） */
const IMG_SRC_PATTERN = /(<img\b[^>]*\bsrc=")([^"]*)("[^>]*>)/;

/**
 * HTML文字列中の全ての `<img>` タグを走査し、ローカル画像パスをData URIに変換して埋め込む
 *
 * 画像ファイルが見つからない場合はログを出力して元のパスを維持する。
 *
 * @param html 変換対象のHTML文字列
 * @param basePath 解決の基準ディレクトリ（入力Markdownファイルのディレクトリ）
 */
export async function embedImagesInHtml(html: string, basePath: string): Promise<string> {
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  // `g`付き正規表現の`lastIndex`は状態を持つため、並列呼び出しで干渉しないよう呼び出しごとに生成する
  const imgSrcRe = new RegExp(IMG_SRC_PATTERN.source, 'gi');
  while ((match = imgSrcRe.exec(html))) {
    const [full, prefix, src, suffix] = match;
    result += html.slice(lastIndex, match.index);

    if (isLocalImagePath(src)) {
      try {
        const dataUri = await readImageAsDataUri(src, basePath);
        result += prefix + dataUri + suffix;
      } catch {
        console.warn(`[Tejun.ts] 画像を読み込めませんでした: ${src}`);
        result += full;
      }
    } else {
      result += full;
    }

    lastIndex = match.index + full.length;
  }
  result += html.slice(lastIndex);

  return result;
}

/**
 * 画像ファイルのBufferと拡張子を取得する（Excel埋め込み用）
 * @param imageSrc Markdownに記述された画像パス（相対パス可）
 * @param basePath 解決の基準ディレクトリ
 */
export async function readImageBuffer(
  imageSrc: string,
  basePath: string,
): Promise<{ buffer: Buffer; ext: string }> {
  const resolved = path.resolve(basePath, imageSrc);
  const ext = path.extname(resolved).slice(1).toLowerCase();
  const buffer = await fs.promises.readFile(resolved);
  return { buffer, ext };
}

/**
 * 画像パスをベースディレクトリから解決して絶対パスを返す
 */
export function resolveImagePath(imageSrc: string, basePath: string): string {
  return path.resolve(basePath, imageSrc);
}
