import { describe, it, expect } from 'vitest';
import {
  renderTemplate,
  stripHtml,
  replaceStepCellVariables,
  replaceCellVariables,
} from './templateEngine';
import { TemplateError } from '../utils/errors';
import type { TemplateContext, Step } from '../parser/types';

const SAMPLE_STEP: Step = {
  index: 1,
  category: '大項目A',
  title: '手順1',
  instruction: '<p>操作手順の本文</p>',
  expected: '<p>期待される結果</p>',
};

const SAMPLE_CTX: TemplateContext = {
  document: { title: 'テストドキュメント' },
  date: '2026/06/24',
  steps: [SAMPLE_STEP],
  markdown: '<p>Markdown全文</p>',
};

describe('renderTemplate', () => {
  describe('トップレベル変数の置換', () => {
    it('{{document.title}} を置換する', () => {
      const result = renderTemplate('<title>{{document.title}}</title>', SAMPLE_CTX);
      expect(result).toContain('テストドキュメント');
      expect(result).not.toContain('{{document.title}}');
    });

    it('{{date}} を置換する', () => {
      const result = renderTemplate('<span>{{date}}</span>', SAMPLE_CTX);
      expect(result).toContain('2026/06/24');
    });

    it('特殊文字をHTMLエスケープする', () => {
      const ctx: TemplateContext = {
        ...SAMPLE_CTX,
        document: { title: '<Script>alert(1)</Script>' },
      };
      const result = renderTemplate('{{document.title}}', ctx);
      expect(result).toContain('&lt;Script&gt;');
      expect(result).not.toContain('<Script>');
    });

    it('{{update}} を置換する', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, update: '2026/06/25' };
      const result = renderTemplate('<span>{{update}}</span>', ctx);
      expect(result).toContain('2026/06/25');
    });

    it('update が未指定の場合 {{update}} は空文字になる', () => {
      const result = renderTemplate('<span>{{update}}</span>', SAMPLE_CTX);
      expect(result).toBe('<span></span>');
    });

    it('${markdown} をMarkdown全文のHTMLに置換する（生HTML、エスケープなし）', () => {
      const result = renderTemplate('<div>${markdown}</div>', SAMPLE_CTX);
      expect(result).toBe('<div><p>Markdown全文</p></div>');
    });

    it('${title} を置換する', () => {
      const result = renderTemplate('<title>${title}</title>', SAMPLE_CTX);
      expect(result).toContain('テストドキュメント');
    });

    it('${date} を置換する', () => {
      const result = renderTemplate('<span>${date}</span>', SAMPLE_CTX);
      expect(result).toContain('2026/06/24');
    });

    it('${update} を置換する', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, update: '2026/06/25' };
      const result = renderTemplate('<span>${update}</span>', ctx);
      expect(result).toContain('2026/06/25');
    });

    it('update が未指定の場合 ${update} は空文字になる', () => {
      const result = renderTemplate('<span>${update}</span>', SAMPLE_CTX);
      expect(result).toBe('<span></span>');
    });

    it('${title} も特殊文字をHTMLエスケープする', () => {
      const ctx: TemplateContext = {
        ...SAMPLE_CTX,
        document: { title: '<Script>alert(1)</Script>' },
      };
      const result = renderTemplate('${title}', ctx);
      expect(result).toContain('&lt;Script&gt;');
      expect(result).not.toContain('<Script>');
    });

    it('${h1} は ${title} と同じ値に置換される', () => {
      const result = renderTemplate('${h1}', SAMPLE_CTX);
      expect(result).toBe('テストドキュメント');
    });

    it('{{meta.title}} / {{meta.date}} / {{meta.update}} はFront Matterのキー名で参照できる', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, update: '2026/06/25' };
      const result = renderTemplate('{{meta.title}}/{{meta.date}}/{{meta.update}}', ctx);
      expect(result).toBe('テストドキュメント/2026/06/24/2026/06/25');
    });

    it('update が未指定の場合 {{meta.update}} は空文字になる', () => {
      const result = renderTemplate('<span>{{meta.update}}</span>', SAMPLE_CTX);
      expect(result).toBe('<span></span>');
    });

    it('{{meta.プロパティ名}} はFront Matterの任意のキーを汎用的に参照できる', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, meta: { overview: 'オーバービューです。', author: 'Yasu' } };
      const result = renderTemplate('{{meta.overview}} / {{meta.author}}', ctx);
      expect(result).toBe('オーバービューです。 / Yasu');
    });

    it('meta に存在しないプロパティを参照すると空文字になる', () => {
      const result = renderTemplate('[{{meta.unknown}}]', SAMPLE_CTX);
      expect(result).toBe('[]');
    });

    it('{{meta.プロパティ名}} の値もHTMLエスケープされる', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, meta: { author: '<b>Yasu</b>' } };
      const result = renderTemplate('{{meta.author}}', ctx);
      expect(result).toBe('&lt;b&gt;Yasu&lt;/b&gt;');
    });
  });

  describe('each構文外の {{h1}}〜{{h6}}（文書全体で最初に登場した見出し）', () => {
    const CTX_WITH_HEADINGS: TemplateContext = {
      ...SAMPLE_CTX,
      firstHeadings: { h1: '見出し1', h2: '見出し2', h4: '見出し4' },
    };

    it('each構文外の {{h1}}〜{{h6}} は firstHeadings の値に置換される（無ければ空文字）', () => {
      const tmpl = '{{h1}}/{{h2}}/{{h3}}/{{h4}}/{{h5}}/{{h6}}';
      const result = renderTemplate(tmpl, CTX_WITH_HEADINGS);
      expect(result).toBe('見出し1/見出し2//見出し4//');
    });

    it('firstHeadings が無い場合はすべて空文字になる', () => {
      const result = renderTemplate('[{{h1}}][{{h4}}]', SAMPLE_CTX);
      expect(result).toBe('[][]');
    });

    it('{{h1}} は {{document.title}}（Front Matter優先）とは異なり得る', () => {
      const result = renderTemplate('{{h1}} / {{document.title}}', CTX_WITH_HEADINGS);
      expect(result).toBe('見出し1 / テストドキュメント');
    });

    it('ループ内で消費された {{h2}}/{{h3}} には影響しない（ループ側の値が優先される）', () => {
      const ctx: TemplateContext = { ...CTX_WITH_HEADINGS, steps: [SAMPLE_STEP] };
      const tmpl = '{{#each steps}}[{{h2}}/{{h3}}]{{/each}} outside:{{h2}}';
      const result = renderTemplate(tmpl, ctx);
      expect(result).toBe('[大項目A/手順1] outside:見出し2');
    });
  });

  describe('{{#each steps}} ループの展開', () => {
    it('ステップ数分ループを展開する', () => {
      const ctx: TemplateContext = {
        ...SAMPLE_CTX,
        steps: [
          { ...SAMPLE_STEP, index: 1, title: '手順1' },
          { ...SAMPLE_STEP, index: 2, title: '手順2' },
        ],
      };
      const tmpl = '{{#each steps}}<div>{{title}}</div>{{/each}}';
      const result = renderTemplate(tmpl, ctx);
      expect(result).toContain('<div>手順1</div>');
      expect(result).toContain('<div>手順2</div>');
    });

    it('{{index}} に正しい連番が入る', () => {
      const tmpl = '{{#each steps}}<span>{{index}}</span>{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('<span>1</span>');
    });

    it('{{h3_index}} は {{index}} と同じ値に置換される', () => {
      const tmpl = '{{#each steps}}<span>{{h3_index}}</span>{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('<span>1</span>');
    });

    it('{{h3.index}} は {{index}} と同じ値に置換される（ドット区切り表記）', () => {
      const tmpl = '{{#each steps}}<span>{{h3.index}}</span>{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('<span>1</span>');
    });

    it('{{{instruction}}} は生HTMLとして出力される（エスケープなし）', () => {
      const tmpl = '{{#each steps}}{{{instruction}}}{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('<p>操作手順の本文</p>');
    });

    it('{{instruction}} はエスケープされる', () => {
      const tmpl = '{{#each steps}}{{instruction}}{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('&lt;p&gt;');
    });

    it('ステップが0件でも正常に動作する', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, steps: [] };
      const result = renderTemplate('{{#each steps}}<div>{{title}}</div>{{/each}}', ctx);
      expect(result).toBe('');
    });

    it('{{h2}} / {{h3}} は {{category}} / {{title}} と同じ値に置換される', () => {
      const tmpl = '{{#each steps}}<span>{{h2}}/{{h3}}</span>{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toContain('<span>大項目A/手順1</span>');
    });

    it('{{blockquote}} は {{{expected}}} と同じ生HTMLに置換される（二重括弧でもエスケープされない）', () => {
      const result = renderTemplate('{{#each steps}}{{blockquote}}{{/each}}', SAMPLE_CTX);
      expect(result).toBe('<p>期待される結果</p>');
    });

    it('{{{blockquote}}} も同じ生HTMLに置換される', () => {
      const result = renderTemplate('{{#each steps}}{{{blockquote}}}{{/each}}', SAMPLE_CTX);
      expect(result).toBe('<p>期待される結果</p>');
    });

    it('{{procedure}} は {{{instruction}}} と同じ生HTMLに置換される（二重括弧でもエスケープされない）', () => {
      const result = renderTemplate('{{#each steps}}{{procedure}}{{/each}}', SAMPLE_CTX);
      expect(result).toBe('<p>操作手順の本文</p>');
    });

    it('{{{procedure}}} も同じ生HTMLに置換される', () => {
      const result = renderTemplate('{{#each steps}}{{{procedure}}}{{/each}}', SAMPLE_CTX);
      expect(result).toBe('<p>操作手順の本文</p>');
    });

    it('{{h3_procedure}} / {{{h3_procedure}}} も {{procedure}} と同じ生HTMLに置換される', () => {
      const escaped = renderTemplate('{{#each steps}}{{h3_procedure}}{{/each}}', SAMPLE_CTX);
      expect(escaped).toBe('<p>操作手順の本文</p>');
      const triple = renderTemplate('{{#each steps}}{{{h3_procedure}}}{{/each}}', SAMPLE_CTX);
      expect(triple).toBe('<p>操作手順の本文</p>');
    });

    it('{{h3.procedure}} / {{{h3.procedure}}} も {{procedure}} と同じ生HTMLに置換される（ドット区切り表記）', () => {
      const escaped = renderTemplate('{{#each steps}}{{h3.procedure}}{{/each}}', SAMPLE_CTX);
      expect(escaped).toBe('<p>操作手順の本文</p>');
      const triple = renderTemplate('{{#each steps}}{{{h3.procedure}}}{{/each}}', SAMPLE_CTX);
      expect(triple).toBe('<p>操作手順の本文</p>');
    });

    it('{{h3.body}} / {{{h3.body}}} も {{procedure}} と同じ生HTMLに置換される', () => {
      const escaped = renderTemplate('{{#each steps}}{{h3.body}}{{/each}}', SAMPLE_CTX);
      expect(escaped).toBe('<p>操作手順の本文</p>');
      const triple = renderTemplate('{{#each steps}}{{{h3.body}}}{{/each}}', SAMPLE_CTX);
      expect(triple).toBe('<p>操作手順の本文</p>');
    });

    it('{{h3_blockquote}} / {{h3.blockquote}}（二重・三重括弧とも）も {{blockquote}} と同じ生HTMLに置換される', () => {
      expect(renderTemplate('{{#each steps}}{{h3_blockquote}}{{/each}}', SAMPLE_CTX)).toBe(
        '<p>期待される結果</p>',
      );
      expect(renderTemplate('{{#each steps}}{{{h3_blockquote}}}{{/each}}', SAMPLE_CTX)).toBe(
        '<p>期待される結果</p>',
      );
      expect(renderTemplate('{{#each steps}}{{h3.blockquote}}{{/each}}', SAMPLE_CTX)).toBe(
        '<p>期待される結果</p>',
      );
      expect(renderTemplate('{{#each steps}}{{{h3.blockquote}}}{{/each}}', SAMPLE_CTX)).toBe(
        '<p>期待される結果</p>',
      );
    });

    it('旧名 {{instruction}} / {{expected}}（二重括弧）は従来通りエスケープされる', () => {
      const result = renderTemplate('{{#each steps}}{{instruction}}/{{expected}}{{/each}}', SAMPLE_CTX);
      expect(result).toBe('&lt;p&gt;操作手順の本文&lt;/p&gt;/&lt;p&gt;期待される結果&lt;/p&gt;');
    });

    it('{{#each h3 steps}} は {{#each steps}} と同じ値に置換される（フラットな別名）', () => {
      const tmpl = '{{#each h3 steps}}<div>{{title}}</div>{{/each}}';
      const result = renderTemplate(tmpl, SAMPLE_CTX);
      expect(result).toBe('<div>手順1</div>');
    });
  });

  describe('{{#each h2 steps}} 大項目ごとのグループ化ループ', () => {
    const GROUPED_CTX: TemplateContext = {
      ...SAMPLE_CTX,
      steps: [
        { ...SAMPLE_STEP, index: 1, category: 'カテゴリA', title: '手順1' },
        { ...SAMPLE_STEP, index: 2, category: 'カテゴリA', title: '手順2' },
        { ...SAMPLE_STEP, index: 3, category: 'カテゴリB', title: '手順3' },
      ],
    };

    it('{{h2.index}} / {{h2_index}} は大項目の1始まり連番になり、ネストした{{#each h3 steps}}内でも参照できる', () => {
      const tmpl =
        '{{#each h2 steps}}<h2>{{h2.index}}:{{h2}}</h2>{{#each h3 steps}}<div>{{h2_index}}-{{h3.index}}</div>{{/each}}{{/each}}';
      const result = renderTemplate(tmpl, GROUPED_CTX);
      // {{h3.index}}（=既存の{{index}}）はグループ内リセットではなく、全体を通した連番のまま
      expect(result).toBe(
        '<h2>1:カテゴリA</h2><div>1-1</div><div>1-2</div><h2>2:カテゴリB</h2><div>2-3</div>',
      );
    });

    it('大項目ごとに1回だけグループを展開し、内側で{{#each h3 steps}}がそのグループのステップだけをループする', () => {
      const tmpl =
        '{{#each h2 steps}}<h2>{{h2}}</h2>{{#each h3 steps}}<div>{{h3_index}}:{{h3}}</div>{{/each}}{{/each}}';
      const result = renderTemplate(tmpl, GROUPED_CTX);
      expect(result).toBe(
        '<h2>カテゴリA</h2><div>1:手順1</div><div>2:手順2</div><h2>カテゴリB</h2><div>3:手順3</div>',
      );
    });

    it('ネストした{{#each h3 steps}}が無い場合はグループの内容をそのまま展開する', () => {
      const tmpl = '{{#each h2 steps}}<h2>{{h2}}</h2>{{/each}}';
      const result = renderTemplate(tmpl, GROUPED_CTX);
      expect(result).toBe('<h2>カテゴリA</h2><h2>カテゴリB</h2>');
    });

    it('ステップが0件でも正常に動作する', () => {
      const ctx: TemplateContext = { ...GROUPED_CTX, steps: [] };
      const tmpl = '{{#each h2 steps}}<h2>{{h2}}</h2>{{#each h3 steps}}{{h3}}{{/each}}{{/each}}';
      expect(renderTemplate(tmpl, ctx)).toBe('');
    });
  });

  describe('{{#if 変数名}} 条件分岐', () => {
    it('ループ外: 値がある変数はブロックを表示し、空の変数は非表示にする', () => {
      const ctx: TemplateContext = {
        ...SAMPLE_CTX,
        firstHeadings: { h1: '見出し1' },
        h1Body: '<p>概要</p>',
      };
      const tmpl =
        '{{#if h1}}[h1]{{/if}}{{#if h1.body}}[body]{{/if}}{{#if h1.blockquote}}[bq]{{/if}}{{#if meta.author}}[author]{{/if}}';
      expect(renderTemplate(tmpl, ctx)).toBe('[h1][body]');
    });

    it('ループ内: 現在のステップの値で判定する', () => {
      const ctx: TemplateContext = {
        ...SAMPLE_CTX,
        steps: [
          { ...SAMPLE_STEP, title: '手順1' },
          { ...SAMPLE_STEP, index: 2, title: '手順2', expected: '' },
        ],
      };
      const tmpl = '{{#each steps}}{{h3}}{{#if h3.blockquote}}(結果あり){{/if}};{{/each}}';
      expect(renderTemplate(tmpl, ctx)).toBe('手順1(結果あり);手順2;');
    });

    it('ループ内でも文書全体の変数で判定できる', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, meta: { author: 'Yasu' } };
      const tmpl = '{{#each steps}}{{#if meta.author}}{{meta.author}}{{/if}}{{/each}}';
      expect(renderTemplate(tmpl, ctx)).toBe('Yasu');
    });

    it('{{#each h2 steps}} の内側では大項目の値で判定する', () => {
      const tmpl = '{{#each h2 steps}}{{#if h2}}<h2>{{h2}}</h2>{{/if}}{{#each h3 steps}}{{h3}}{{/each}}{{/each}}';
      expect(renderTemplate(tmpl, SAMPLE_CTX)).toBe('<h2>大項目A</h2>手順1');
    });

    it('入れ子にできる', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, firstHeadings: { h1: '見出し1' } };
      const tmpl = '{{#if h1}}A{{#if h1.body}}B{{/if}}C{{/if}}';
      expect(renderTemplate(tmpl, ctx)).toBe('AC');
    });

    it('{{#if}} が閉じられていない場合は TemplateError をスローする', () => {
      expect(() => renderTemplate('{{#if h1}}本文', SAMPLE_CTX)).toThrow(TemplateError);
    });
  });

  describe('{{h1.body}} / {{h1.blockquote}}', () => {
    it('二重括弧でも生HTMLとして置換される（無ければ空文字）', () => {
      const ctx: TemplateContext = { ...SAMPLE_CTX, h1Body: '<p>概要</p>' };
      expect(renderTemplate('{{h1.body}}|{{{h1.body}}}|{{h1.blockquote}}', ctx)).toBe(
        '<p>概要</p>|<p>概要</p>|',
      );
    });
  });

  describe('異常系', () => {
    it('{{#each}} が閉じられていない場合は TemplateError をスローする', () => {
      // 不完全なテンプレート（各行にeachタグが残る）
      const tmpl = '{{#each steps}}未閉鎖';
      // このケースでは eachRe がマッチしないため {{#each が残りエラー
      expect(() => renderTemplate(tmpl, SAMPLE_CTX)).toThrow(TemplateError);
    });
  });
});

describe('stripHtml', () => {
  it('HTMLタグを除去してプレーンテキストにする', () => {
    expect(stripHtml('<p>テキスト</p>')).toBe('テキスト');
  });

  it('<br>を改行に変換する', () => {
    expect(stripHtml('行1<br>行2')).toContain('行1');
    expect(stripHtml('行1<br>行2')).toContain('行2');
  });

  it('HTMLエンティティをデコードする', () => {
    expect(stripHtml('&amp;')).toBe('&');
    expect(stripHtml('&lt;')).toBe('<');
  });

  it('空文字列を正しく処理する', () => {
    expect(stripHtml('')).toBe('');
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

describe('replaceStepCellVariables', () => {
  it('セル内の {{#if}} をステップの値で判定する', () => {
    const noExpected: Step = { ...SAMPLE_STEP, expected: '' };
    const cell = '{{#if h3.blockquote}}結果: {{h3.blockquote}}{{/if}}';
    expect(replaceStepCellVariables(cell, SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('結果: 期待される結果');
    expect(replaceStepCellVariables(cell, noExpected, 1, SAMPLE_CTX)).toBe('');
  });

  it('{{#each h2 steps}} を取り除き、{{h2.index}} / {{h2_index}} を大項目の連番に置換する', () => {
    expect(replaceStepCellVariables('{{#each h2 steps}}{{h2.index}}', SAMPLE_STEP, 2, SAMPLE_CTX)).toBe('2');
    expect(replaceStepCellVariables('{{h2_index}}', SAMPLE_STEP, 3, SAMPLE_CTX)).toBe('3');
  });

  it('{{category}} を置換する', () => {
    const result = replaceStepCellVariables('{{category}}', SAMPLE_STEP, 1, SAMPLE_CTX);
    expect(result).toBe('大項目A');
  });

  it('{{index}} を置換する', () => {
    const result = replaceStepCellVariables('{{index}}', SAMPLE_STEP, 1, SAMPLE_CTX);
    expect(result).toBe('1');
  });

  it('{{instruction}} がHTMLなしのプレーンテキストになる', () => {
    const result = replaceStepCellVariables('{{instruction}}', SAMPLE_STEP, 1, SAMPLE_CTX);
    expect(result).toBe('操作手順の本文');
    expect(result).not.toContain('<p>');
  });

  it('{{#each steps}} と {{/each}} タグを除去する', () => {
    const result = replaceStepCellVariables('{{#each steps}}{{category}}{{/each}}', SAMPLE_STEP, 1, SAMPLE_CTX);
    expect(result).toBe('大項目A');
  });

  it('{{h2}} / {{h3}} を置換する', () => {
    expect(replaceStepCellVariables('{{h2}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('大項目A');
    expect(replaceStepCellVariables('{{h3}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('手順1');
  });

  it('{{blockquote}} を置換する（{{expected}}と同値）', () => {
    expect(replaceStepCellVariables('{{blockquote}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('期待される結果');
  });

  it('{{procedure}} を置換する（{{instruction}}と同値）', () => {
    expect(replaceStepCellVariables('{{procedure}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('操作手順の本文');
  });

  it('{{h3_procedure}} を置換する（{{procedure}}と同値）', () => {
    expect(replaceStepCellVariables('{{h3_procedure}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('操作手順の本文');
  });

  it('{{h3_index}} を置換する（{{index}}と同値）', () => {
    expect(replaceStepCellVariables('{{h3_index}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('1');
  });

  it('{{h3.procedure}} / {{h3.index}} を置換する（ドット区切り表記）', () => {
    expect(replaceStepCellVariables('{{h3.procedure}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('操作手順の本文');
    expect(replaceStepCellVariables('{{h3.index}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('1');
  });

  it('{{h3.body}} を置換する（{{procedure}}と同値）', () => {
    expect(replaceStepCellVariables('{{h3.body}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('操作手順の本文');
  });

  it('{{h3_blockquote}} / {{h3.blockquote}} を置換する（{{blockquote}}と同値）', () => {
    expect(replaceStepCellVariables('{{h3_blockquote}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('期待される結果');
    expect(replaceStepCellVariables('{{h3.blockquote}}', SAMPLE_STEP, 1, SAMPLE_CTX)).toBe('期待される結果');
  });
});

describe('replaceCellVariables', () => {
  it('セル内の {{#if}} を文書全体の値で判定し、{{h1.body}} はタグを除去して置換する', () => {
    const ctx: TemplateContext = { ...SAMPLE_CTX, h1Body: '<p>概要</p>' };
    expect(replaceCellVariables('{{#if h1.body}}概要: {{h1.body}}{{/if}}', ctx)).toBe('概要: 概要');
    expect(replaceCellVariables('{{#if h1.blockquote}}あり{{/if}}', ctx)).toBe('');
  });

  it('{{document.title}} と {{date}} を置換する', () => {
    const result = replaceCellVariables('{{document.title}} / {{date}}', SAMPLE_CTX);
    expect(result).toBe('テストドキュメント / 2026/06/24');
  });

  it('{{update}} を置換する', () => {
    const ctx: TemplateContext = { ...SAMPLE_CTX, update: '2026/06/25' };
    const result = replaceCellVariables('{{update}}', ctx);
    expect(result).toBe('2026/06/25');
  });

  it('update が未指定の場合 {{update}} は空文字になる', () => {
    const result = replaceCellVariables('{{update}}', SAMPLE_CTX);
    expect(result).toBe('');
  });

  it('{{meta.title}} / {{meta.date}} / {{meta.update}} を置換する', () => {
    const ctx: TemplateContext = { ...SAMPLE_CTX, update: '2026/06/25' };
    const result = replaceCellVariables('{{meta.title}}/{{meta.date}}/{{meta.update}}', ctx);
    expect(result).toBe('テストドキュメント/2026/06/24/2026/06/25');
  });

  it('{{meta.プロパティ名}} で任意のFront Matterプロパティを参照する（無ければ空文字）', () => {
    const ctx: TemplateContext = { ...SAMPLE_CTX, meta: { author: 'Yasu' } };
    expect(replaceCellVariables('{{meta.author}}', ctx)).toBe('Yasu');
    expect(replaceCellVariables('{{meta.unknown}}', ctx)).toBe('');
  });

  it('{{h1}}〜{{h6}} は firstHeadings の値に置換される（document.titleではない）', () => {
    const ctx: TemplateContext = { ...SAMPLE_CTX, firstHeadings: { h1: '見出し1' } };
    expect(replaceCellVariables('{{h1}}', ctx)).toBe('見出し1');
    expect(replaceCellVariables('{{h1}}', SAMPLE_CTX)).toBe('');
    expect(replaceCellVariables('{{document.title}}', SAMPLE_CTX)).toBe('テストドキュメント');
  });
});
