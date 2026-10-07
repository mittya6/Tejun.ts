import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  isLocalImagePath,
  readImageAsDataUri,
  readImageBuffer,
  resolveImagePath,
  wrapImagesForZoom,
} from './imageUtils';

vi.mock('fs', () => ({
  default: {
    promises: {
      readFile: vi.fn(),
    },
  },
}));

describe('wrapImagesForZoom', () => {
  it('全ての <img> を拡大表示用の <label> とチェックボックスで囲む', () => {
    const html = '<p><img src="a.png" alt="a">と<IMG src="b.png"></p>';
    expect(wrapImagesForZoom(html)).toBe(
      '<p><label class="img-zoom"><input type="checkbox" hidden><img src="a.png" alt="a"></label>' +
        'と<label class="img-zoom"><input type="checkbox" hidden><IMG src="b.png"></label></p>',
    );
  });

  it('<img> が無いHTMLはそのまま返す', () => {
    expect(wrapImagesForZoom('<p>テキスト</p>')).toBe('<p>テキスト</p>');
  });
});

describe('isLocalImagePath', () => {
  it('ローカルの画像パスを true と判定する', () => {
    expect(isLocalImagePath('./images/screen.png')).toBe(true);
    expect(isLocalImagePath('screen.JPG')).toBe(true);
  });

  it('Data URI を false と判定する', () => {
    expect(isLocalImagePath('data:image/png;base64,AAAA')).toBe(false);
  });

  it('外部URL（http/https）を false と判定する', () => {
    expect(isLocalImagePath('http://example.com/a.png')).toBe(false);
    expect(isLocalImagePath('https://example.com/a.png')).toBe(false);
  });

  it('画像拡張子でないパスを false と判定する', () => {
    expect(isLocalImagePath('./document.pdf')).toBe(false);
  });
});

describe('resolveImagePath', () => {
  it('相対パスをbasePath基準の絶対パスに解決する', () => {
    const resolved = resolveImagePath('./a.png', '/base/dir');
    expect(resolved).toContain('a.png');
    expect(resolved.startsWith('/base/dir') || resolved.includes('base')).toBe(true);
  });

  it('URLエンコードされた日本語パスをデコードして解決する', () => {
    const resolved = resolveImagePath('./%E7%94%BB%E5%83%8F/%E3%83%86%E3%82%B9%E3%83%88.webp', '/base');
    expect(resolved).toBe(path.resolve('/base', '画像', 'テスト.webp'));
  });

  it('デコードできない不正な % を含むパスはそのまま解決する（異常系）', () => {
    const resolved = resolveImagePath('./100%.png', '/base');
    expect(resolved).toBe(path.resolve('/base', '100%.png'));
  });
});

describe('readImageAsDataUri', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('画像ファイルをData URIに変換する（正常系）', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('fake-image-bytes'));

    const result = await readImageAsDataUri('./screen.png', '/base');

    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(result).toContain(Buffer.from('fake-image-bytes').toString('base64'));
  });

  it('拡張子から正しいMIMEタイプを設定する', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('x'));
    const result = await readImageAsDataUri('./a.jpg', '/base');
    expect(result).toMatch(/^data:image\/jpeg;base64,/);
  });

  it('未知の拡張子は application/octet-stream になる', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('x'));
    const result = await readImageAsDataUri('./a.svg', '/base');
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('URLエンコードされた日本語ファイル名をデコードして読み込む', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('x'));
    await readImageAsDataUri('./%E3%83%86%E3%82%B9%E3%83%88.webp', '/base');
    expect(fs.promises.readFile).toHaveBeenCalledWith(path.resolve('/base', 'テスト.webp'));
  });

  it('ファイル読み込みに失敗した場合は例外を伝播する（異常系）', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('ENOENT'));
    await expect(readImageAsDataUri('./missing.png', '/base')).rejects.toThrow('ENOENT');
  });
});

describe('readImageBuffer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Bufferと拡張子を返す（正常系）', async () => {
    vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('data'));
    const result = await readImageBuffer('./a.PNG', '/base');
    expect(result.ext).toBe('png');
    expect(result.buffer.toString()).toBe('data');
  });

  it('ファイル読み込みに失敗した場合は例外を伝播する（異常系）', async () => {
    vi.mocked(fs.promises.readFile).mockRejectedValue(new Error('EACCES'));
    await expect(readImageBuffer('./a.png', '/base')).rejects.toThrow('EACCES');
  });
});
