import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import { runGenerate } from './generate';
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
      );
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
      );
    });
  });
});
