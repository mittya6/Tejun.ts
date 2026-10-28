import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer-core';
import { browserCandidates, findBrowser, generatePdf } from './pdfGenerator';
import { renderHtml } from './htmlGenerator';
import { GeneratorError } from '../utils/errors';
import type { ProcedureDocument } from '../parser/types';

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(),
    promises: {
      mkdir: vi.fn(),
      writeFile: vi.fn(),
    },
  },
}));

vi.mock('puppeteer-core', () => ({
  default: { launch: vi.fn() },
}));

vi.mock('./htmlGenerator', () => ({
  renderHtml: vi.fn(),
}));

const SAMPLE_DOC: ProcedureDocument = {
  title: 'サンプル手順書',
  date: '2026/06/24',
  meta: {},
  root: { symbol: 'root', content: '', index: 1, children: [] },
};

const PDF_DATA = new Uint8Array([1, 2, 3]);

/** puppeteer のブラウザ・ページのモックを作る */
function mockBrowser(pdf: () => Promise<Uint8Array> = () => Promise.resolve(PDF_DATA)) {
  const page = {
    setJavaScriptEnabled: vi.fn(),
    setContent: vi.fn(),
    pdf: vi.fn(pdf),
  };
  const browser = { newPage: vi.fn().mockResolvedValue(page), close: vi.fn() };
  vi.mocked(puppeteer.launch).mockResolvedValue(browser as never);
  return { page, browser };
}

describe('browserCandidates', () => {
  it('Windowsでは、Edge → Chrome の順にインストール先の候補を返す', () => {
    const candidates = browserCandidates('win32', {
      'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
      PROGRAMFILES: 'C:\\Program Files',
    });
    expect(candidates).toEqual([
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    ]);
  });

  it('Linuxでは、Chrome / Chromium の候補を返す', () => {
    expect(browserCandidates('linux', {})).toContain('/usr/bin/google-chrome');
    expect(browserCandidates('linux', {})).toContain('/usr/bin/chromium');
  });
});

describe('findBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('--browser で指定したパスが存在すればそれを返す', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(findBrowser('/opt/chrome')).toBe('/opt/chrome');
  });

  it('--browser で指定したパスが存在しない場合は GeneratorError をスローする', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => findBrowser('/opt/chrome')).toThrow(GeneratorError);
  });

  it('未指定の場合は、存在する最初の候補を返す', () => {
    const [, second] = browserCandidates(process.platform, process.env);
    vi.mocked(fs.existsSync).mockImplementation((p) => p === second);
    expect(findBrowser()).toBe(second);
  });

  it('未指定でブラウザが見つからない場合は GeneratorError をスローする', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(() => findBrowser()).toThrow(/--browser/);
  });
});

describe('generatePdf', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(renderHtml).mockResolvedValue('<html></html>');
  });

  describe('正常系', () => {
    it('HTMLをJavaScript無効で読み込み、A4・ページ番号・しおり付きで印刷して書き込む', async () => {
      const { page, browser } = mockBrowser();
      const outPath = await generatePdf(
        SAMPLE_DOC,
        '/in/sample.md',
        '/out',
        'my.html',
        undefined,
        '/opt/chrome',
      );

      expect(renderHtml).toHaveBeenCalledWith(SAMPLE_DOC, '/in/sample.md', 'my.html');
      expect(puppeteer.launch).toHaveBeenCalledWith({ executablePath: '/opt/chrome' });
      expect(page.setJavaScriptEnabled).toHaveBeenCalledWith(false);
      expect(page.setContent).toHaveBeenCalledWith('<html></html>', expect.anything());
      expect(page.pdf).toHaveBeenCalledWith(
        expect.objectContaining({
          format: 'A4',
          outline: true,
          displayHeaderFooter: true,
          footerTemplate: expect.stringContaining('pageNumber'),
        }),
      );
      expect(outPath).toBe(path.join('/out', 'sample.pdf'));
      expect(fs.promises.writeFile).toHaveBeenCalledWith(outPath, PDF_DATA);
      expect(browser.close).toHaveBeenCalled();
    });

    it('出力ファイル名の指定があればそれを使う', async () => {
      mockBrowser();
      const outPath = await generatePdf(
        SAMPLE_DOC,
        '/in/sample.md',
        '/out',
        undefined,
        '手順書_v1',
      );
      expect(outPath).toBe(path.join('/out', '手順書_v1.pdf'));
    });
  });

  describe('異常系', () => {
    it('ブラウザを起動できない場合は GeneratorError をスローする', async () => {
      vi.mocked(puppeteer.launch).mockRejectedValue(new Error('spawn failed'));
      await expect(generatePdf(SAMPLE_DOC, '/in/sample.md', '/out')).rejects.toThrow(
        GeneratorError,
      );
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });

    it('印刷に失敗した場合は GeneratorError をスローし、ブラウザを閉じる', async () => {
      const { browser } = mockBrowser(() => Promise.reject(new Error('print failed')));
      await expect(generatePdf(SAMPLE_DOC, '/in/sample.md', '/out')).rejects.toThrow(
        GeneratorError,
      );
      expect(browser.close).toHaveBeenCalled();
      expect(fs.promises.writeFile).not.toHaveBeenCalled();
    });
  });
});
