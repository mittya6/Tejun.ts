import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { runGenerate, resolveOutputBaseName } from './generate';
import { parseMarkdown } from '../parser/markdownParser';
import { generateHtml } from '../generators/htmlGenerator';
import { generateExcel } from '../generators/excelGenerator';
import { ParseError, GeneratorError } from '../utils/errors';
import type { ProcedureDocument } from '../parser/types';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    promises: {
      readFile: vi.fn(),
      mkdir: vi.fn(),
    },
  },
}));

vi.mock('../parser/markdownParser', () => ({
  parseMarkdown: vi.fn(),
}));

vi.mock('../generators/htmlGenerator', () => ({
  generateHtml: vi.fn(),
}));

vi.mock('../generators/excelGenerator', () => ({
  generateExcel: vi.fn(),
}));

const SAMPLE_DOC: ProcedureDocument = {
  title: 'サンプル手順書',
  date: '2026/06/24',
  meta: {},
  root: { symbol: 'root', content: '', index: 1, children: [] },
};

describe('runGenerate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.promises.readFile).mockResolvedValue('# サンプル手順書');
    vi.mocked(parseMarkdown).mockReturnValue(SAMPLE_DOC);
    vi.mocked(generateHtml).mockResolvedValue('/out/sample.html');
    vi.mocked(generateExcel).mockResolvedValue('/out/sample.xlsx');
  });

  describe('異常系', () => {
    it('入力ファイルが存在しない場合は ParseError をスローする', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      await expect(runGenerate('missing.md', { format: 'both', out: '.' })).rejects.toThrow(
        ParseError,
      );
    });

    it('拡張子が .md / .markdown 以外の場合は ParseError をスローする', async () => {
      await expect(runGenerate('input.txt', { format: 'both', out: '.' })).rejects.toThrow(
        ParseError,
      );
    });

    it('bothフォーマット指定時にテンプレート拡張子が不正だと GeneratorError をスローする', async () => {
      await expect(
        runGenerate('input.md', { format: 'both', out: '.', template: 'template.docx' }),
      ).rejects.toThrow(GeneratorError);
    });

    it('--name のプロパティがFront Matterにない場合は ParseError をスローし何も生成しない', async () => {
      await expect(
        runGenerate('input.md', { format: 'both', out: '.', name: 'meta.filename' }),
      ).rejects.toThrow(ParseError);
      expect(generateHtml).not.toHaveBeenCalled();
      expect(generateExcel).not.toHaveBeenCalled();
    });
  });

  describe('正常系', () => {
    it('format=html の場合は generateHtml のみを呼び出す', async () => {
      await runGenerate('input.md', { format: 'html', out: '.' });
      expect(generateHtml).toHaveBeenCalledTimes(1);
      expect(generateExcel).not.toHaveBeenCalled();
    });

    it('format=excel の場合は generateExcel のみを呼び出す', async () => {
      await runGenerate('input.md', { format: 'excel', out: '.' });
      expect(generateExcel).toHaveBeenCalledTimes(1);
      expect(generateHtml).not.toHaveBeenCalled();
    });

    it('format=both の場合は両方を呼び出す', async () => {
      await runGenerate('input.md', { format: 'both', out: '.' });
      expect(generateHtml).toHaveBeenCalledTimes(1);
      expect(generateExcel).toHaveBeenCalledTimes(1);
    });

    it('.htmlテンプレート指定時、generateHtmlにテンプレートパスが渡される', async () => {
      await runGenerate('input.md', {
        format: 'html',
        out: '.',
        template: 'my-template.html',
      });
      expect(generateHtml).toHaveBeenCalledWith(
        SAMPLE_DOC,
        expect.any(String),
        expect.any(String),
        'my-template.html',
        undefined,
      );
    });

    it('--name 指定時、Front Matterの値が出力ファイル名として両方の生成に渡される', async () => {
      vi.mocked(parseMarkdown).mockReturnValue({ ...SAMPLE_DOC, meta: { filename: '手順書_v1' } });
      await runGenerate('input.md', { format: 'both', out: '.', name: 'meta.filename' });
      expect(generateHtml).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
        '手順書_v1',
      );
      expect(generateExcel).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        expect.any(String),
        undefined,
        '手順書_v1',
      );
    });

    it('--name 未指定時は出力ファイル名を渡さない', async () => {
      await runGenerate('input.md', { format: 'html', out: '.' });
      expect(vi.mocked(generateHtml).mock.calls[0][4]).toBeUndefined();
    });

    it('.xlsxテンプレート指定時、generateExcelにテンプレートパスが渡される', async () => {
      await runGenerate('input.md', {
        format: 'excel',
        out: '.',
        template: 'my-template.xlsx',
      });
      expect(generateExcel).toHaveBeenCalledWith(
        SAMPLE_DOC,
        expect.any(String),
        expect.any(String),
        'my-template.xlsx',
        undefined,
      );
    });
  });
});

describe('resolveOutputBaseName', () => {
  it('meta.プロパティ名 で指定した値を返す（前後の空白は除く）', () => {
    expect(resolveOutputBaseName({ filename: ' 手順書_v1 ' }, 'meta.filename')).toBe('手順書_v1');
  });

  it('meta. で始まらない指定は ParseError をスローする', () => {
    expect(() => resolveOutputBaseName({ filename: 'a' }, 'filename')).toThrow(ParseError);
    expect(() => resolveOutputBaseName({ filename: 'a' }, 'meta.')).toThrow(ParseError);
  });

  it('値が未定義または空の場合は ParseError をスローする', () => {
    expect(() => resolveOutputBaseName({}, 'meta.filename')).toThrow(ParseError);
    expect(() => resolveOutputBaseName({ filename: '  ' }, 'meta.filename')).toThrow(ParseError);
  });

  it.each(['../evil', 'a/b', 'a\b', 'a:b', 'a*b', 'a?b', '..'])(
    'ファイル名に使えない値 %s は ParseError をスローする',
    (value) => {
      expect(() => resolveOutputBaseName({ filename: value }, 'meta.filename')).toThrow(ParseError);
    },
  );
});
