import { describe, expect, it } from 'vitest';
import { formatTextTable } from './textTable';
import type { TableAlign, TableCell } from './textTable';

/**
 * 文字列の配列からセルの配列を作る
 */
function cells(texts: string[], align: TableAlign = 'left'): TableCell[] {
  return texts.map((text) => ({ text, align }));
}

describe('formatTextTable', () => {
  it('全角と半角が混ざった表の列を揃える（列の幅は偶数に切り上げる）', () => {
    expect(formatTextTable([cells(['設定名', 'abc']), cells(['ホスト', 'x'])])).toBe(
      ['┌────┬───┐', '│ 設定名 │ abc  │', '├────┼───┤', '│ ホスト │ x    │', '└────┴───┘'].join(
        '\n',
      ),
    );
  });

  it('左揃え・中央揃え・右揃えを反映する', () => {
    const rows = [
      cells(['abcdef', 'abcdef', 'abcdef']),
      [
        { text: 'x', align: 'left' as const },
        { text: 'xx', align: 'center' as const },
        { text: 'x', align: 'right' as const },
      ],
    ];
    expect(formatTextTable(rows).split('\n')[3]).toBe('│ x      │   xx   │      x │');
  });

  it('半角カタカナは半角幅として数える', () => {
    expect(formatTextTable([cells(['ｱｲ']), cells(['ab'])]).split('\n')[1]).toBe('│ ｱｲ │');
  });

  it('見出しの行だけの表には区切り線を入れない', () => {
    expect(formatTextTable([cells(['ab'])])).toBe(['┌──┐', '│ ab │', '└──┘'].join('\n'));
  });

  it('セルの数が足りない行は空のセルで埋める', () => {
    expect(formatTextTable([cells(['ab', 'cd']), cells(['x'])]).split('\n')[3]).toBe('│ x  │    │');
  });

  it('行が無ければ空文字を返す', () => {
    expect(formatTextTable([])).toBe('');
  });
});
