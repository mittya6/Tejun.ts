import fs from 'fs';
import path from 'path';
import { ParseError } from './errors';

/** ワイルドカードとして扱う文字 */
const GLOB_CHARS = /[*?[\]{}]/;

/** 変換対象とするMarkdownの拡張子 */
const MARKDOWN_EXTS = ['.md', '.markdown'];

/**
 * 引数がワイルドカードを含むかを判定する
 *
 * @param arg コマンドライン引数
 * @returns ワイルドカードを含む場合はtrue
 */
export function isGlobPattern(arg: string): boolean {
  return GLOB_CHARS.test(arg);
}

/**
 * 入力ファイル指定（ファイルパスまたはワイルドカード）を展開して、変換対象のファイルパス一覧を返す
 *
 * ワイルドカードを含まない指定はそのまま返す（存在確認は変換時に行う）。
 * ワイルドカードは一致したファイルのうち `.md` / `.markdown` のみを対象とし、名前順に並べる。
 * 同じファイルが複数の指定に一致した場合は1つにまとめる。
 *
 * @param args コマンドラインで指定された入力ファイル指定
 * @returns 変換対象のファイルパス一覧
 * @throws ParseError ワイルドカードに一致するMarkdownファイルが1つもない場合
 */
export async function expandInputFiles(args: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const arg of args) {
    if (!isGlobPattern(arg)) {
      files.push(arg);
      continue;
    }
    // Windowsのパス区切り（\）はglobではエスケープ文字になるため / に揃える
    const pattern = process.platform === 'win32' ? arg.replace(/\\/g, '/') : arg;
    const matched: string[] = [];
    for await (const file of fs.promises.glob(pattern)) {
      if (MARKDOWN_EXTS.includes(path.extname(file).toLowerCase())) {
        matched.push(file);
      }
    }
    if (matched.length === 0) {
      throw new ParseError(`指定に一致するMarkdownファイルがありません: ${arg}`);
    }
    files.push(...matched.sort());
  }

  const seen = new Set<string>();
  return files.filter((file) => {
    const resolved = path.resolve(file);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}
