import { describe, it, expect } from 'vitest';
import { columnWidthPx, estimateTextHeightPx, layoutImages } from './excelImageLayout';

/** 1ptあたりのpx */
const PX_PER_PT = 96 / 72;

describe('columnWidthPx', () => {
  it('列幅（文字数）をpxに換算する', () => {
    expect(columnWidthPx(10)).toBe(75);
  });

  it('未設定ならExcelの既定の列幅を使う', () => {
    expect(columnWidthPx()).toBe(64);
  });
});

describe('estimateTextHeightPx', () => {
  /** 11ptの文章の1行の高さ（px） */
  const LINE = 11 * 1.5 * PX_PER_PT;

  it('空文字は高さ0', () => {
    expect(estimateTextHeightPx('', 10)).toBe(0);
  });

  it('改行の数だけ行が増える', () => {
    expect(estimateTextHeightPx('a\nb\nc', 10)).toBeCloseTo(LINE * 3);
  });

  it('折り返しが有効なら、列幅を超える行を折り返した行数で数える（全角は2文字分）', () => {
    expect(estimateTextHeightPx('あいうえおかきくけこ', 10, 11, true)).toBeCloseTo(LINE * 2);
    expect(estimateTextHeightPx('abcdefghij', 10, 11, true)).toBeCloseTo(LINE);
  });

  it('折り返しが無効なら、長い行も1行で数える', () => {
    expect(estimateTextHeightPx('あいうえおかきくけこ', 10, 11, false)).toBeCloseTo(LINE);
  });

  it('フォントが大きいほど1行に入る文字が減り、行も高くなる', () => {
    expect(estimateTextHeightPx('abcdefghij', 10, 22, true)).toBeCloseTo(22 * 1.5 * PX_PER_PT * 2);
  });
});

describe('layoutImages', () => {
  it('文章の下に画像を縦に並べてセルの中央に置き、行の高さを全体が収まる高さにする', () => {
    const { images, rowHeightPt } = layoutImages(
      [
        { width: 100, height: 50 },
        { width: 80, height: 40 },
      ],
      300,
      20,
    );
    expect(images).toEqual([
      { x: 30, y: 24, width: 240, height: 120 },
      { x: 30, y: 148, width: 240, height: 120 },
    ]);
    expect(rowHeightPt).toBeCloseTo(272 / PX_PER_PT);
  });

  it('セルの幅の80%より大きい画像は縦横比を保って縮小し、中央に置く', () => {
    const { images } = layoutImages([{ width: 400, height: 200 }], 250, 0);
    expect(images[0]).toEqual({ x: 25, y: 4, width: 200, height: 100 });
  });

  it('セルの幅の80%より小さい画像は縦横比を保って拡大し、中央に置く', () => {
    const { images } = layoutImages([{ width: 50, height: 25 }], 250, 0);
    expect(images[0]).toEqual({ x: 25, y: 4, width: 200, height: 100 });
  });

  it('行の高さの上限（409pt）を超える場合は全ての画像を同じ比率で縮小する', () => {
    const { images, rowHeightPt } = layoutImages(
      [
        { width: 100, height: 400 },
        { width: 100, height: 400 },
      ],
      1000,
      0,
    );
    expect(images[0].height).toBe(images[1].height);
    expect(images[0].height).toBeLessThan(400);
    expect(images[0].width / images[0].height).toBeCloseTo(0.25, 1);
    expect(rowHeightPt).toBeLessThanOrEqual(409);
  });
});
