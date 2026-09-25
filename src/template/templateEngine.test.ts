import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  stripHtml,
  replaceCellVariables,
  extractRowLoop,
  expandLoopChains,
} from './templateEngine';
import { parseMarkdown } from '../parser/markdownParser';
import { TemplateError } from '../utils/errors';
import type { TemplateContext } from '../parser/types';

const SAMPLE_MD = `---
title: "テストドキュメント"
date: "2026/06/24"
author: "Yasu"
---
# ドキュメント見出し

概要の本文です。

> 概要の補足です。

## 大項目A

### 手順1

操作手順の本文

- ぶどう
- **リンゴ**
  - 赤
- オレンジ

> **期待値**
> 期待される結果

### 手順2

1. 最初
2. 次

\`\`\`sh
ls -la
\`\`\`

## 大項目B

### 手順3

本文3
`;

/** Markdownからテンプレート用のコンテキストを作る */
function ctxFrom(md: string, extra: Partial<TemplateContext> = {}): TemplateContext {
  const doc = parseMarkdown(md);
  return {
    title: doc.title,
    date: doc.date,
    update: doc.update,
    meta: doc.meta,
    root: doc.root,
    overview: doc.overview,
    ...extra,
  };
}

const SAMPLE_CTX = ctxFrom(SAMPLE_MD, { markdown: '<p>Markdown全文</p>' });

describe('renderTemplate', () => {
  describe('文書全体の変数', () => {
    it('{{meta.title}} / {{meta.date}} / {{meta.update}} を置換する（update未指定は空文字）', () => {
      expect(renderTemplate('{{meta.title}}|{{meta.date}}|{{meta.update}}', SAMPLE_CTX)).toBe(
        'テストドキュメント|2026/06/24|',
      );
    });

    it('{{meta.プロパティ名}} でFront Matterの任意のキーを参照する（無ければ空文字）', () => {
      expect(renderTemplate('{{meta.author}}|{{meta.nothing}}', SAMPLE_CTX)).toBe('Yasu|');
    });

    it('${title} / ${date} / ${update} / ${markdown} / ${overview} を置換する', () => {
      const ctx = { ...SAMPLE_CTX, update: '2026/06/25' };
      expect(renderTemplate('${title}|${date}|${update}|${markdown}', ctx)).toBe(
        'テストドキュメント|2026/06/24|2026/06/25|<p>Markdown全文</p>',
      );
      expect(renderTemplate('${overview}', ctx)).toContain('概要の補足です。');
    });

    it('プレーンテキストの値はHTMLエスケープする', () => {
      const ctx = { ...SAMPLE_CTX, title: '<Script>alert(1)</Script>' };
      expect(renderTemplate('{{meta.title}}', ctx)).toBe('&lt;Script&gt;alert(1)&lt;/Script&gt;');
      expect(renderTemplate('${title}', ctx)).toBe('&lt;Script&gt;alert(1)&lt;/Script&gt;');
    });
  });

  describe('見出しの変数（ループの外側）', () => {
    it('{{#}} はH1の見出しテキストになる（Front Matterのtitleではない）', () => {
      expect(renderTemplate('{{#}}', SAMPLE_CTX)).toBe('ドキュメント見出し');
    });

    it('{{#.body}} / {{#.>}} / {{>}} は概要文の本文 / 最初の引用のHTMLになる', () => {
      expect(renderTemplate('{{#.body}}', SAMPLE_CTX)).toBe('<p>概要の本文です。</p>\n');
      expect(renderTemplate('{{#.>}}', SAMPLE_CTX)).toBe('<p>概要の補足です。</p>\n');
      expect(renderTemplate('{{>}}', SAMPLE_CTX)).toBe('<p>概要の補足です。</p>\n');
    });

    it('{{##}} / {{###}} は文書で最初のその見出しになり、無い見出しは空文字になる', () => {
      expect(renderTemplate('{{##}}|{{###}}|{{####}}', SAMPLE_CTX)).toBe('大項目A|手順1|');
    });

    it('どの記号もMarkdownで最初に出てくる行の要素になる（見出しの階層によらない）', () => {
      const ctx = ctxFrom(`## 前置きの大項目

# 最初のH1

## 大項目

- 最初の項目

> 最初の引用

# 次のH1

> 次の引用
`);
      expect(renderTemplate('{{#}}|{{##}}|{{-}}|{{>}}|{{#.>}}', ctx)).toBe(
        '最初のH1|前置きの大項目|最初の項目|<p>最初の引用</p>\n|<p>最初の引用</p>\n',
      );
    });
  });

  describe('{{#each 記号 steps}} ループ', () => {
    it('{{#each ### steps}} は全手順をフラットに繰り返す', () => {
      const tpl = '{{#each ### steps}}[{{###.index}}:{{###}}]{{/each}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('[1:手順1][2:手順2][3:手順3]');
    });

    it('フラットなループの内側でも {{##}} は手順が属する大項目になる', () => {
      const tpl = '{{#each ### steps}}[{{##}}]{{/each}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('[大項目A][大項目A][大項目B]');
    });

    it('{{#each ## steps}} に {{#each ### steps}} をネストすると大項目ごとの手順だけを繰り返す', () => {
      const tpl =
        '{{#each ## steps}}<{{##.index}}.{{##}}:{{#each ### steps}}({{##.index}}-{{###.index}}){{/each}}>{{/each}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('<1.大項目A:(1-1)(1-2)><2.大項目B:(2-3)>');
    });

    it('{{###.body}} は最初の引用より前の本文、{{###.>}} / {{>}} は最初の引用のHTMLになる（エスケープなし）', () => {
      const tpl = '{{#each ### steps}}{{#if >}}{{###.body}}|{{###.>}}|{{>}}{{/if}}{{/each}}';
      const html = renderTemplate(tpl, SAMPLE_CTX);
      expect(html).toContain('<p>操作手順の本文</p>');
      expect(html).toContain('<ul>');
      expect(html).toContain('|<p>期待される結果</p>\n|<p>期待される結果</p>\n');
      expect(html).not.toContain('期待値');
    });

    it('見出しテキストはHTMLエスケープする', () => {
      const ctx = ctxFrom('# T\n\n### a<b>&\n');
      expect(renderTemplate('{{#each ### steps}}{{###}}{{/each}}', ctx)).toBe('a&lt;b&gt;&amp;');
    });

    it('{{#each - steps}} はカレント要素の箇条書きの項目を繰り返す（入れ子の項目は含めない）', () => {
      const tpl =
        '{{#each ### steps}}<ul>{{#each - steps}}<li>{{-.index}}:{{-}}</li>{{/each}}</ul>{{/each}}';
      const html = renderTemplate(tpl, SAMPLE_CTX);
      expect(html).toContain('<li>1:ぶどう</li>');
      expect(html).toContain('<li>2:<strong>リンゴ</strong><ul>\n<li>赤</li>\n</ul>\n</li>');
      expect(html).toContain('<li>3:オレンジ</li>');
      // 箇条書きの無い手順では何も繰り返さない
      expect(html).toContain('<ul></ul><ul></ul>');
    });

    it('{{#each - steps}} をネストすると入れ子の項目を繰り返す', () => {
      const tpl = '{{#each - steps}}{{#each - steps}}[{{-}}]{{/each}}{{/each}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('[赤]');
    });

    it('{{#each 1. steps}} / {{#each ``` steps}} は番号付きリストの項目 / コードブロックを繰り返す', () => {
      expect(renderTemplate('{{#each 1. steps}}[{{1.}}]{{/each}}', SAMPLE_CTX)).toBe('[最初][次]');
      expect(renderTemplate('{{#each ``` steps}}{{```}}{{/each}}', SAMPLE_CTX)).toBe(
        '<pre><code class="language-sh">ls -la\n</code></pre>\n',
      );
    });

    it('{{#each > steps}} は引用を繰り返す', () => {
      expect(renderTemplate('{{#each > steps}}[{{>}}]{{/each}}', SAMPLE_CTX)).toBe(
        '[<p>概要の補足です。</p>\n][<p>期待される結果</p>\n]',
      );
    });

    it('{{#each # steps}} はH1が複数あればH1ごとに繰り返す', () => {
      const ctx = ctxFrom('# A\n\n## a1\n\n## a2\n\n# B\n\n## b1\n');
      const tpl =
        '{{#each # steps}}<{{#.index}}{{#}}:{{#each ## steps}}({{##}}){{/each}}>{{/each}}';
      expect(renderTemplate(tpl, ctx)).toBe('<1A:(a1)(a2)><2B:(b1)>');
    });

    it('要素が無いループは何も出力しない', () => {
      expect(renderTemplate('a{{#each #### steps}}x{{/each}}b', SAMPLE_CTX)).toBe('ab');
    });
  });

  describe('{{#if 式}} 条件分岐', () => {
    it('値が空でなければ中身を出力し、空なら取り除く', () => {
      const tpl = '{{#if meta.author}}A{{/if}}{{#if meta.update}}U{{/if}}{{#if ####}}H{{/if}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('A');
    });

    it('ループの内側ではカレント要素の値で判定する', () => {
      const tpl = '{{#each ### steps}}{{#if >}}[{{###}}]{{/if}}{{/each}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('[手順1]');
    });

    it('入れ子にできる', () => {
      const tpl = '{{#if #}}{{#if meta.author}}ok{{/if}}{{/if}}';
      expect(renderTemplate(tpl, SAMPLE_CTX)).toBe('ok');
    });
  });

  describe('解釈できない記法', () => {
    it('廃止した旧記法や未知の変数はそのまま出力する', () => {
      expect(renderTemplate('{{h1}}{{h3.blockquote}}{{foo}}', SAMPLE_CTX)).toBe(
        '{{h1}}{{h3.blockquote}}{{foo}}',
      );
    });
  });

  describe('異常系', () => {
    it('{{#each}} が閉じられていない場合は TemplateError をスローする', () => {
      expect(() => renderTemplate('{{#each ### steps}}x', SAMPLE_CTX)).toThrow(TemplateError);
    });

    it('対応しない {{/each}} は TemplateError をスローする', () => {
      expect(() => renderTemplate('x{{/each}}', SAMPLE_CTX)).toThrow(TemplateError);
    });

    it('{{#if}} が閉じられていない場合は TemplateError をスローする', () => {
      expect(() => renderTemplate('{{#if #}}x', SAMPLE_CTX)).toThrow(TemplateError);
    });

    it('{{#each}} と {{/if}} の対応が交差している場合は TemplateError をスローする', () => {
      expect(() =>
        renderTemplate('{{#each ## steps}}{{#if #}}{{/each}}{{/if}}', SAMPLE_CTX),
      ).toThrow(TemplateError);
    });

    it('{{#each}} の記号が解釈できない場合（旧記法の {{#each h2 steps}} など）は TemplateError をスローする', () => {
      expect(() => renderTemplate('{{#each h2 steps}}{{/each}}', SAMPLE_CTX)).toThrow(
        TemplateError,
      );
      expect(() => renderTemplate('{{#each steps}}{{/each}}', SAMPLE_CTX)).toThrow(TemplateError);
    });

    it('{{#if}} の条件が解釈できない場合は TemplateError をスローする', () => {
      expect(() => renderTemplate('{{#if h1}}x{{/if}}', SAMPLE_CTX)).toThrow(TemplateError);
    });
  });
});

describe('replaceCellVariables', () => {
  it('HTMLのタグを除去したプレーンテキストで置換する（エスケープなし）', () => {
    expect(replaceCellVariables('{{#.body}}', SAMPLE_CTX)).toBe('概要の本文です。');
    const ctx = ctxFrom('# a<b>\n');
    expect(replaceCellVariables('{{#}}', ctx)).toBe('a<b>');
  });

  it('カレント要素までの経路を渡すと、その要素を起点に解決する', () => {
    const [chain] = expandLoopChains([SAMPLE_CTX.root], ['##', '###']);
    expect(
      replaceCellVariables('{{##.index}}-{{###.index}} {{###}}: {{>}}', SAMPLE_CTX, chain),
    ).toBe('1-1 手順1: 期待される結果');
  });

  it('セル内で閉じたループや条件を展開する', () => {
    const [chain] = expandLoopChains([SAMPLE_CTX.root], ['###']);
    expect(
      replaceCellVariables(
        '{{#each - steps}}・{{-}}\n{{/each}}{{#if ```}}code{{/if}}',
        SAMPLE_CTX,
        chain,
      ),
    ).toBe('・ぶどう\n・リンゴ\n赤\n・オレンジ\n');
  });
});

describe('extractRowLoop', () => {
  it('セルをまたぐ {{#each}} / {{/each}} を行ループとして取り除き、記号を外側から返す', () => {
    const result = extractRowLoop([
      '',
      '{{#each ## steps}}',
      '{{#each ### steps}}{{###.index}}',
      '{{#each - steps}}{{-}}{{/each}}',
      '{{/each}}{{/each}}',
    ]);
    expect(result).toEqual({
      symbols: ['##', '###'],
      cells: ['', '', '{{###.index}}', '{{#each - steps}}{{-}}{{/each}}', ''],
    });
  });

  it('行末まで閉じられていない {{#each}} も行ループとみなす', () => {
    expect(extractRowLoop(['{{#each ### steps}}', '{{###}}'])).toEqual({
      symbols: ['###'],
      cells: ['', '{{###}}'],
    });
  });

  it('セル内で閉じたループしか無い行は行ループなし（undefined）', () => {
    expect(extractRowLoop(['{{#each - steps}}{{-}}{{/each}}', '{{meta.title}}'])).toBeUndefined();
  });

  it('対応する開始タグの無い {{/each}} は TemplateError をスローする', () => {
    expect(() => extractRowLoop(['{{/each}}'])).toThrow(TemplateError);
  });

  it('記号が解釈できない行ループは TemplateError をスローする', () => {
    expect(() => extractRowLoop(['{{#each steps}}', '{{/each}}'])).toThrow(TemplateError);
  });
});

describe('expandLoopChains', () => {
  it('行ループの記号を外側から順にたどり、1行ごとの経路を返す', () => {
    const chains = expandLoopChains([SAMPLE_CTX.root], ['##', '###']);
    expect(chains.map((chain) => chain.slice(-2).map((node) => node.content))).toEqual([
      ['大項目A', '手順1'],
      ['大項目A', '手順2'],
      ['大項目B', '手順3'],
    ]);
  });

  it('内側の記号の要素が無い外側の要素も1行として返す', () => {
    const ctx = ctxFrom('# 表題\n\n## 大項目A\n\n本文A\n\n## 大項目B\n\n### 手順1\n');
    const chains = expandLoopChains([ctx.root], ['##', '###']);
    expect(chains.map((chain) => chain.slice(1).map((node) => node.content))).toEqual([
      ['表題', '大項目A'],
      ['表題', '大項目B', '手順1'],
    ]);
    expect(replaceCellVariables('{{##}}|{{##.body}}|{{###}}', ctx, chains[0])).toBe(
      '大項目A|本文A|',
    );
  });

  it('記号が無ければ起点の経路だけを返す', () => {
    expect(expandLoopChains([SAMPLE_CTX.root], [])).toEqual([[SAMPLE_CTX.root]]);
  });
});

describe('stripHtml', () => {
  it('HTMLタグを除去してプレーンテキストにする', () => {
    expect(stripHtml('<p>テキスト</p>')).toBe('テキスト');
  });

  it('<br>を改行に変換する', () => {
    expect(stripHtml('行1<br>行2')).toBe('行1\n行2');
  });

  it('HTMLエンティティをデコードする', () => {
    expect(stripHtml('&amp;')).toBe('&');
    expect(stripHtml('&lt;')).toBe('<');
  });

  it('空文字列を正しく処理する', () => {
    expect(stripHtml('')).toBe('');
  });

  it('画像だけの行・段落を空行として残さない', () => {
    expect(stripHtml('<p>行1\n<img src="a.png" alt="a">\n行2</p>')).toBe('行1\n行2');
    expect(stripHtml('<p>前</p>\n<p><img src="a.png" alt="a"></p>\n<p>後</p>')).toBe('前\n\n後');
  });

  it('番号付きリストの各項目に番号を付ける', () => {
    expect(stripHtml('<ol>\n<li>手順A</li>\n<li>手順B</li>\n</ol>')).toBe('1. 手順A\n\n2. 手順B');
  });

  it('番号付きリストの start 属性の番号から数え始める', () => {
    expect(stripHtml('<ol start="3"><li>手順C</li><li>手順D</li></ol>')).toBe('3. 手順C\n4. 手順D');
  });

  it('入れ子の番号付きリストはリストごとに番号を数える', () => {
    expect(stripHtml('<ol><li>親1<ol><li>子1</li><li>子2</li></ol></li><li>親2</li></ol>')).toBe(
      '1. 親11. 子1\n2. 子2\n\n2. 親2',
    );
  });

  it('番号なしリストの項目には番号を付けない', () => {
    expect(stripHtml('<ul><li>項目A</li><li>項目B</li></ul>')).toBe('項目A\n項目B');
  });
});
