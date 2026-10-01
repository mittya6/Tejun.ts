import { describe, it, expect } from 'vitest';
import { countLines, estimateRowHeight, type CellLayout } from './rowHeight';

/** 11pt・折り返しありのセルを作る（列幅11 → 余白を除いて半角10文字/行） */
function cell(text: string, overrides: Partial<CellLayout> = {}): CellLayout {
  return { text, columnWidth: 11, fontSize: 11, wrapText: true, ...overrides };
}

describe('countLines', () => {
  it('列幅に収まる半角テキストは1行', () => {
    expect(countLines(cell('abcdefghij'))).toBe(1);
  });

  it('列幅を超える半角テキストは折り返した行数になる', () => {
    expect(countLines(cell('abcdefghijk'))).toBe(2);
  });

  it('全角文字は半角2文字分として数える', () => {
    expect(countLines(cell('あいうえお'))).toBe(1);
    expect(countLines(cell('あいうえおか'))).toBe(2);
  });

  it('半角カタカナは半角1文字分として数える', () => {
    expect(countLines(cell('ｱｲｳｴｵｶｷｸｹｺ'))).toBe(1);
  });

  it('改行ごとに行を数え、空行も1行とする', () => {
    expect(countLines(cell('a\n\nb'))).toBe(3);
  });

  it('フォントが大きいほど1行に入る文字数が減る', () => {
    expect(countLines(cell('abcdefghij', { fontSize: 22 }))).toBe(2);
  });

  it('折り返しなしのセルは改行や長さに関係なく1行', () => {
    expect(countLines(cell('abcdefghijklmnop\nq', { wrapText: false }))).toBe(1);
  });

  it('空文字は1行', () => {
    expect(countLines(cell(''))).toBe(1);
  });
});

describe('estimateRowHeight', () => {
  it('最も行数の多いセルに合わせた高さを返す', () => {
    const oneLine = estimateRowHeight([cell('a')]);
    expect(estimateRowHeight([cell('a'), cell('a\nb\nc')])).toBe(oneLine * 3);
  });

  it('セルが無ければ0を返す', () => {
    expect(estimateRowHeight([])).toBe(0);
  });
});
