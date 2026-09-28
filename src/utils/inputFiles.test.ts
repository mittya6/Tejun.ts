import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { expandInputFiles, isGlobPattern } from './inputFiles';
import { ParseError } from './errors';

vi.mock('fs', () => ({
  default: {
    promises: {
      glob: vi.fn(),
    },
  },
}));

/**
 * fs.promises.glob の戻り値（非同期イテレータ）を作る
 *
 * @param files globが返すファイルパス
 * @returns ファイルパスを順に返す非同期イテレータ
 */
async function* globResult(files: string[]): AsyncGenerator<string> {
  for (const file of files) yield file;
}

describe('isGlobPattern', () => {
  it.each(['*.md', 'docs/**/*.md', 'a?.md', '[ab].md', '{a,b}.md'])(
    '%s はワイルドカードと判定する',
    (arg) => {
      expect(isGlobPattern(arg)).toBe(true);
    },
  );

  it('通常のファイルパスはワイルドカードと判定しない', () => {
    expect(isGlobPattern('docs/procedure.md')).toBe(false);
  });
});

describe('expandInputFiles', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('正常系', () => {
    it('ワイルドカードを含まない指定はglobを使わずそのまま返す', async () => {
      expect(await expandInputFiles(['a.md', 'b.md'])).toEqual(['a.md', 'b.md']);
      expect(fs.promises.glob).not.toHaveBeenCalled();
    });

    it('ワイルドカードに一致したMarkdownファイルだけを名前順に返す', async () => {
      vi.mocked(fs.promises.glob).mockReturnValue(
        globResult(['docs/b.md', 'docs/image.png', 'docs/a.MARKDOWN']),
      );
      expect(await expandInputFiles(['docs/*'])).toEqual(['docs/a.MARKDOWN', 'docs/b.md']);
    });

    it('node_modules フォルダを探索から除外する', async () => {
      vi.mocked(fs.promises.glob).mockReturnValue(globResult(['a.md']));
      await expandInputFiles(['./**/*.md']);
      const options = vi.mocked(fs.promises.glob).mock.calls[0][1];
      const exclude = options?.exclude;
      if (typeof exclude !== 'function') throw new Error('exclude が関数ではありません');
      expect(exclude('node_modules')).toBe(true);
      expect(exclude('sub/node_modules')).toBe(true);
      expect(exclude('docs')).toBe(false);
    });

    it('パターンに node_modules を明示した場合は除外しない', async () => {
      vi.mocked(fs.promises.glob).mockReturnValue(globResult(['node_modules/pkg/a.md']));
      await expandInputFiles(['node_modules/pkg/*.md']);
      expect(vi.mocked(fs.promises.glob).mock.calls[0][1]?.exclude).toBeUndefined();
    });

    it('複数の指定に一致した同じファイルは1つにまとめる', async () => {
      vi.mocked(fs.promises.glob).mockReturnValue(globResult(['docs/a.md', 'docs/b.md']));
      expect(await expandInputFiles(['docs/a.md', 'docs/*.md'])).toEqual([
        'docs/a.md',
        'docs/b.md',
      ]);
    });
  });

  describe('異常系', () => {
    it('ワイルドカードに一致するMarkdownファイルがない場合は ParseError をスローする', async () => {
      vi.mocked(fs.promises.glob).mockReturnValue(globResult(['docs/image.png']));
      await expect(expandInputFiles(['docs/*'])).rejects.toThrow(ParseError);
    });
  });
});
