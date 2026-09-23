import { TemplateError } from '../utils/errors';
import type { FirstHeadings, Step, TemplateContext } from '../parser/types';

/** HTMLエスケープ対象文字 */
const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * HTMLエスケープを行う
 */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

/** 内側に別の`{{#if}}`を含まない（最も内側の）`{{#if 変数名}}...{{/if}}` ブロックにマッチする正規表現 */
const INNERMOST_IF_RE = /\{\{#if ([A-Za-z0-9_.-]+)\}\}((?:(?!\{\{#if )[\s\S])*?)\{\{\/if\}\}/g;

/**
 * `{{#if 変数名}}...{{/if}}` を展開する。変数の値が空（空白のみを含む）でなければ中身を残し、空なら取り除く。
 * 内側のブロックから順に評価するため入れ子にも対応する。
 *
 * @param template 対象文字列（`{{#if}}`と`{{/if}}`の対応がこの中で完結していること）
 * @param resolve 変数名から値を返す関数（未知の変数は空文字を返す）
 * @throws TemplateError `{{#if}}`と`{{/if}}`の対応が取れない場合
 */
function applyIfBlocks(template: string, resolve: (name: string) => string): string {
  for (;;) {
    const next = template.replace(INNERMOST_IF_RE, (_match, name: string, inner: string) =>
      resolve(name).trim() ? inner : '',
    );
    if (next === template) break;
    template = next;
  }
  if (template.includes('{{#if ') || template.includes('{{/if}}')) {
    throw new TemplateError('テンプレートの {{#if}} / {{/if}} タグが正しく対応していません。');
  }
  return template;
}

/**
 * ループの外側でも参照できる（文書全体の）変数の値を返す。未知の変数は空文字。
 * `{{#if 変数名}}` の条件判定に使う。
 */
function resolveGlobalVariable(name: string, ctx: TemplateContext): string {
  switch (name) {
    case 'document.title':
    case 'meta.title':
      return ctx.document.title;
    case 'date':
    case 'meta.date':
      return ctx.date;
    case 'update':
    case 'meta.update':
      return ctx.update ?? '';
    case 'h1.body':
      return ctx.h1Body ?? '';
    case 'h1.blockquote':
      return ctx.h1Blockquote ?? '';
  }
  if (/^h[1-6]$/.test(name)) return ctx.firstHeadings?.[name as keyof FirstHeadings] ?? '';
  if (name.startsWith('meta.')) return ctx.meta?.[name.slice('meta.'.length)] ?? '';
  return '';
}

/**
 * ステップ（H3）ごとの変数の値を返す。ステップの変数でなければ `undefined`。
 * `{{#if 変数名}}` の条件判定に使う。
 */
function resolveStepVariable(name: string, step: Step): string | undefined {
  switch (name) {
    case 'category':
    case 'h2':
      return step.category;
    case 'index':
    case 'h3_index':
    case 'h3.index':
      return String(step.index);
    case 'title':
    case 'h3':
      return step.title;
    case 'instruction':
    case 'procedure':
    case 'h3_procedure':
    case 'h3.procedure':
    case 'h3.body':
      return step.instruction;
    case 'expected':
    case 'blockquote':
    case 'h3_blockquote':
    case 'h3.blockquote':
      return step.expected;
    case 'image.src':
      return step.image?.src ?? '';
    case 'image.alt':
      return step.image?.alt ?? '';
    default:
      return undefined;
  }
}

/**
 * ステップ行（ループ内側）用の変数解決関数を作る。ステップの変数 → `{{h2.index}}` → 文書全体の変数の順に解決する。
 *
 * @param h2Index ステップが属する大項目（H2）の1始まり連番（フラットなループでは未指定）
 */
function stepResolver(
  step: Step,
  ctx: TemplateContext,
  h2Index?: number,
): (name: string) => string {
  return (name) => {
    if ((name === 'h2.index' || name === 'h2_index') && h2Index !== undefined) {
      return String(h2Index);
    }
    return resolveStepVariable(name, step) ?? resolveGlobalVariable(name, ctx);
  };
}

/**
 * `openTag`（例: `{{#each h2 steps}}`）に対応する `{{/each}}` を、内側にネストした
 * `{{#each ...}}` の深さを数えて正しく見つけ、その間の文字列を取り出す。
 *
 * @returns 見つかった場合 `{ inner, startIdx, endIdx }`（`endIdx`は閉じタグの直後）。
 *          `openTag`自体が存在しない場合は `null`。
 * @throws TemplateError 対応する `{{/each}}` が見つからない場合
 */
function extractEachBlock(
  template: string,
  openTag: string,
): { inner: string; startIdx: number; endIdx: number } | null {
  const startIdx = template.indexOf(openTag);
  if (startIdx === -1) return null;

  const contentStart = startIdx + openTag.length;
  const tagRe = /\{\{#each\b[^}]*\}\}|\{\{\/each\}\}/g;
  tagRe.lastIndex = contentStart;

  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(template))) {
    if (match[0] === '{{/each}}') {
      depth--;
      if (depth === 0) {
        return {
          inner: template.slice(contentStart, match.index),
          startIdx,
          endIdx: match.index + match[0].length,
        };
      }
    } else {
      depth++;
    }
  }

  throw new TemplateError('テンプレートの {{#each}} / {{/each}} タグが正しく対応していません。');
}

/** 大項目（category）ごとにステップをグルーピングする（ドキュメント順。連続する同一カテゴリを1グループにまとめる） */
function groupStepsByCategory(steps: Step[]): Array<{ category: string; steps: Step[] }> {
  const groups: Array<{ category: string; steps: Step[] }> = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.category === step.category) {
      last.steps.push(step);
    } else {
      groups.push({ category: step.category, steps: [step] });
    }
  }
  return groups;
}

/**
 * ステップ1件分のテンプレートブロックを展開する
 *
 * サポート構文:
 * - `{{{instruction}}}` / `{{{expected}}}` → 生HTML（エスケープなし）
 * - `{{procedure}}` / `{{{procedure}}}` / `{{h3.body}}` / `{{{h3.body}}}`、
 *   `{{blockquote}}` / `{{{blockquote}}}` / `{{h3.blockquote}}` / `{{{h3.blockquote}}}` → 生HTML
 *   （エスケープなし。二重括弧でも常に生HTMLになる特別扱い。詳細は下記参照）
 * - `{{#if 変数名}}...{{/if}}` → 変数の値が空でない場合のみ展開（`{{#if h3.blockquote}}` `{{#if image.src}}` など。入れ子可）
 * - `{{category}}`（`{{h2}}`と同義） `{{index}}`（`{{h3.index}}`と同義） `{{title}}`（`{{h3}}`と同義） `{{image.src}}` `{{image.alt}}` → エスケープ済み値
 * - `{{instruction}}` `{{expected}}` → エスケープ済みHTML（通常は triple-brace を使用）
 * - `{{h2}}` / `{{h3}}` は、そのステップが由来するMarkdownの見出しレベル（H2大項目 / H3手順タイトル）が
 *   分かるように用意した`{{category}}` / `{{title}}`の別名。動作は完全に同一。
 * - `{{blockquote}}` は、期待される結果が由来するMarkdown記法（`>`のblockquote）が分かるように
 *   用意した`{{expected}}`の別名だが、`{{instruction}}`/`{{expected}}`と異なり常に生HTMLとして展開される
 *   （二重括弧でもエスケープされない）。内容は常にMarkdownをHTML変換した結果であり、エスケープして
 *   タグを文字として見せる用途が無いため。三重括弧`{{{blockquote}}}`も同じ結果になる。
 * - `{{procedure}}` も同様に、H3見出し直後の操作手順本文であることが分かるように用意した
 *   `{{instruction}}`の別名で、常に生HTMLとして展開される。三重括弧`{{{procedure}}}`も同じ結果になる。
 * - `{{h3.body}}` / `{{{h3.body}}}` は、`{{h3.index}}`と同じ命名パターン（`{{見出しレベル}}.{{属性}}`という
 *   ドット区切り）で「H3ごとに繰り返される操作手順本文」であることを明示した`{{procedure}}`のさらなる別名（旧`{{h3.procedure}}` /
 *   `{{h3_procedure}}`という表記も引き続き利用可）。動作は完全に同一。
 * - `{{h3.blockquote}}` / `{{{h3.blockquote}}}` は、同じ命名パターンで「H3ごとに繰り返される期待される結果
 *   （blockquote由来）」であることを明示した`{{blockquote}}`のさらなる別名（`{{h3_blockquote}}`というアンダース
 *   コア区切りの表記も利用可）。動作は完全に同一。
 * - `{{h3.index}}` は、H3（手順）ごとに繰り返される連番であることが分かるように用意した
 *   `{{index}}`の別名（旧`{{h3_index}}`というアンダースコア区切りの表記も引き続き利用可）。動作は完全に同一。
 */
function renderStepBlock(
  template: string,
  step: Step,
  ctx: TemplateContext,
  h2Index?: number,
): string {
  template = applyIfBlocks(template, stepResolver(step, ctx, h2Index));

  // 生HTMLとして置換（{{{instruction}}} と {{procedure}}系は常に生HTML）
  template = template.replace(
    /\{\{\{instruction\}\}\}|\{\{\{procedure\}\}\}|\{\{procedure\}\}|\{\{\{h3_procedure\}\}\}|\{\{h3_procedure\}\}|\{\{\{h3\.procedure\}\}\}|\{\{h3\.procedure\}\}|\{\{\{h3\.body\}\}\}|\{\{h3\.body\}\}/g,
    step.instruction,
  );
  template = template.replace(
    /\{\{\{expected\}\}\}|\{\{\{blockquote\}\}\}|\{\{blockquote\}\}|\{\{\{h3_blockquote\}\}\}|\{\{h3_blockquote\}\}|\{\{\{h3\.blockquote\}\}\}|\{\{h3\.blockquote\}\}/g,
    step.expected,
  );

  // double-brace（エスケープあり）
  template = template.replace(/\{\{category\}\}|\{\{h2\}\}/g, escapeHtml(step.category));
  template = template.replace(
    /\{\{index\}\}|\{\{h3_index\}\}|\{\{h3\.index\}\}/g,
    String(step.index),
  );
  template = template.replace(/\{\{title\}\}|\{\{h3\}\}/g, escapeHtml(step.title));
  template = template.replace(/\{\{instruction\}\}/g, escapeHtml(step.instruction));
  template = template.replace(/\{\{expected\}\}/g, escapeHtml(step.expected));
  template = template.replace(/\{\{image\.src\}\}/g, step.image ? escapeHtml(step.image.src) : '');
  template = template.replace(/\{\{image\.alt\}\}/g, step.image ? escapeHtml(step.image.alt) : '');

  return template;
}

/**
 * HTMLテンプレート文字列にコンテキストを適用してレンダリングする
 *
 * サポート構文:
 * - `{{document.title}}` / `${title}`（`${h1}` / `{{meta.title}}`と同義） → ドキュメントタイトル（Front Matterの`title`優先）
 * - `{{date}}` / `${date}`（`{{meta.date}}`と同義） → 生成日（Front Matterの`date`）
 * - `{{update}}` / `${update}`（`{{meta.update}}`と同義） → 更新日（Front Matterの`update`、未指定時は空文字）
 * - `{{meta.プロパティ名}}` は、Front Matterに書かれた任意のプロパティを、そのキー名でそのまま参照できる
 *   汎用構文。`{{meta.title}}` / `{{meta.date}}` / `{{meta.update}}` は特別扱いで、値の解決優先順位や
 *   自動生成のフォールバックも含めて既存の`{{document.title}}` / `{{date}}` / `{{update}}`と完全に同一。
 *   それ以外のキー（例: Front Matterに`author: "..."`と書けば`{{meta.author}}`）は、Front Matterに
 *   書かれた値をそのまま返し、キー自体が存在しなければ空文字になる。
 * - `${markdown}` → 入力Markdown全文（Front Matter除く）をHTMLに変換したもの（生HTML、エスケープなし）
 * - `${overview}` → 最初のH2より前の概要文をHTMLに変換したもの（生HTML、エスケープなし）
 * - `{{h1.body}}` / `{{h1.blockquote}}` → 概要文をH3と同じルールで分けた本文 / 最初のblockquote（常に生HTML）
 * - `{{#if 変数名}}...{{/if}}` → 変数の値が空でない場合のみ展開（`{{#if h1}}` `{{#if h1.body}}` `{{#if meta.author}}` など。入れ子可）。
 *   ループ内側では現在のステップ / 大項目の値、外側では文書全体の値で判定する。
 * - `{{#each steps}}...{{/each}}`（`{{#each h3 steps}}`と同義） → ステップ一覧のフラットなループ展開
 * - `{{#each h2 steps}}...{{/each}}` → 大項目（H2）ごとにグループ化したループ展開。内側に`{{h2}}`、
 *   `{{h2.index}}`（`{{h2_index}}`と同義。大項目の1始まり連番）、
 *   `{{#each h3 steps}}...{{/each}}`（そのグループのステップだけをループ）をネストできる。
 * - ループ内: `{{category}}`（`{{h2}}`）, `{{index}}`（`{{h3.index}}`）, `{{title}}`（`{{h3}}`）, `{{{instruction}}}`,
 *   `{{{expected}}}`, `{{procedure}}` / `{{{procedure}}}` / `{{h3.body}}`（常に生HTML）,
 *   `{{blockquote}}` / `{{{blockquote}}}` / `{{h3.blockquote}}`（常に生HTML）, `{{image.src}}`, `{{image.alt}}`
 * - **each構文の外側**に書かれた`{{h1}}`〜`{{h6}}`は、上記ループ内の`{{h2}}`/`{{h3}}`とは別の意味を持つ。
 *   ループで消費されずに残った`{{h1}}`〜`{{h6}}`は、文書全体で最初に登場したその見出しレベルのテキスト
 *   （`firstHeadings`）に置換される。Front Matterの`title`は考慮しない生の見出しテキストなので、
 *   本文に対応する見出しが無ければ空文字になる（`{{document.title}}`/`{{meta.title}}`/`${h1}`とは異なる値になりうる）。
 *
 * `{{h2}}`/`{{h3}}`は「ループ内側では現在のイテレーションの値」「ループ外側では文書内最初の見出し」という
 * 二重の意味を持つが、ループの展開が先に行われ、消費されなかったトークンだけがこの置換の対象になるため、
 * 実際には位置に応じて自動的にどちらか一方の意味になる。
 *
 * @param template テンプレート文字列
 * @param ctx レンダリングに使用するコンテキスト
 * @returns レンダリング済みHTML文字列
 * @throws TemplateError `{{#each}}`と`{{/each}}`、または`{{#if}}`と`{{/if}}`の対応が取れない場合
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  // {{#each h2 steps}}...{{/each}} の展開（大項目ごとにグループ化。内側に {{#each h3 steps}} をネスト可）
  for (;;) {
    const block = extractEachBlock(template, '{{#each h2 steps}}');
    if (!block) break;
    const groups = groupStepsByCategory(ctx.steps);
    const rendered = groups
      .map((group, groupIdx) => {
        let groupTemplate = block.inner.replace(
          /\{\{category\}\}|\{\{h2\}\}/g,
          escapeHtml(group.category),
        );
        groupTemplate = groupTemplate.replace(
          /\{\{h2_index\}\}|\{\{h2\.index\}\}/g,
          String(groupIdx + 1),
        );
        const nested = extractEachBlock(groupTemplate, '{{#each h3 steps}}');
        if (nested) {
          const stepsHtml = group.steps
            .map((step) => renderStepBlock(nested.inner, step, ctx, groupIdx + 1))
            .join('');
          groupTemplate =
            groupTemplate.slice(0, nested.startIdx) + stepsHtml + groupTemplate.slice(nested.endIdx);
        }
        // 大項目の内側（ステップループの外）の {{#if}} は、この大項目の値で判定する
        return applyIfBlocks(groupTemplate, (name) => {
          if (name === 'h2' || name === 'category') return group.category;
          if (name === 'h2.index' || name === 'h2_index') return String(groupIdx + 1);
          return resolveGlobalVariable(name, ctx);
        });
      })
      .join('');
    template = template.slice(0, block.startIdx) + rendered + template.slice(block.endIdx);
  }

  // トップレベルの {{#each h3 steps}} は {{#each steps}} の別名（グループ化されていないフラットな指定）
  template = template.replace(/\{\{#each h3 steps\}\}/g, '{{#each steps}}');

  // {{#each steps}}...{{/each}} の展開
  const eachRe = /\{\{#each steps\}\}([\s\S]*?)\{\{\/each\}\}/g;
  template = template.replace(eachRe, (_match, innerTemplate: string) => {
    if (ctx.steps.length === 0) return '';
    return ctx.steps.map((step) => renderStepBlock(innerTemplate, step, ctx)).join('');
  });

  // ループタグが閉じられていない場合はエラー
  if (template.includes('{{#each') || template.includes('{{/each}}')) {
    throw new TemplateError(
      'テンプレートの {{#each steps}} / {{/each}} タグが正しく対応していません。',
    );
  }

  // ループの外側の {{#if}} は文書全体の値で判定する
  template = applyIfBlocks(template, (name) => resolveGlobalVariable(name, ctx));

  // トップレベル変数の置換
  template = template.replace(/\{\{document\.title\}\}/g, escapeHtml(ctx.document.title));
  template = template.replace(/\{\{date\}\}/g, escapeHtml(ctx.date));
  template = template.replace(/\{\{update\}\}/g, escapeHtml(ctx.update ?? ''));
  template = template.replace(/\$\{title\}|\$\{h1\}/g, escapeHtml(ctx.document.title));
  template = template.replace(/\$\{date\}/g, escapeHtml(ctx.date));
  template = template.replace(/\$\{update\}/g, escapeHtml(ctx.update ?? ''));
  template = template.replace(/\$\{markdown\}/g, ctx.markdown ?? '');
  template = template.replace(/\$\{overview\}/g, ctx.overview ?? '');
  template = template.replace(/\{\{\{h1\.body\}\}\}|\{\{h1\.body\}\}/g, ctx.h1Body ?? '');
  template = template.replace(
    /\{\{\{h1\.blockquote\}\}\}|\{\{h1\.blockquote\}\}/g,
    ctx.h1Blockquote ?? '',
  );

  // {{meta.プロパティ名}}: Front Matterの任意のプロパティを参照する（title/date/updateは解決済みの値を優先）
  template = template.replace(/\{\{meta\.([A-Za-z0-9_-]+)\}\}/g, (_match, key: string) => {
    if (key === 'title') return escapeHtml(ctx.document.title);
    if (key === 'date') return escapeHtml(ctx.date);
    if (key === 'update') return escapeHtml(ctx.update ?? '');
    return escapeHtml(ctx.meta?.[key] ?? '');
  });

  // each構文の外側に残った {{h1}}〜{{h6}}: 文書全体で最初に登場したその見出しレベルのテキストに置換
  (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).forEach((level) => {
    const re = new RegExp(`\\{\\{${level}\\}\\}`, 'g');
    template = template.replace(re, escapeHtml(ctx.firstHeadings?.[level] ?? ''));
  });

  return template;
}

/**
 * Excelテンプレート用: セル値の変数を置換する（HTMLエスケープなし）
 *
 * `{{meta.プロパティ名}}` は、Front Matterに書かれた任意のプロパティをキー名で参照する汎用構文
 * （`{{meta.title}}` / `{{meta.date}}` / `{{meta.update}}` は既存の`{{document.title}}` / `{{date}}` /
 * `{{update}}`と完全に同一の値、それ以外はFront Matterの生の値。無ければ空文字）。
 * `{{h1}}`〜`{{h6}}`（このセルは常にステップ行の外側なので「each構文外」扱い）は、
 * `{{document.title}}`ではなく文書全体で最初に登場したその見出しレベルのテキスト（`firstHeadings`）になる。
 * `{{h1.body}}` / `{{h1.blockquote}}` は概要文の本文 / 最初のblockquote（タグを除去したテキスト）。
 * `{{#if 変数名}}...{{/if}}` はセル内で使え、変数の値が空なら中身を取り除く。
 *
 * @param cellValue セルのテキスト値
 * @param ctx ドキュメント全体のコンテキスト（step内ではない）
 * @throws TemplateError `{{#if}}`と`{{/if}}`の対応がセル内で取れない場合
 */
export function replaceCellVariables(cellValue: string, ctx: TemplateContext): string {
  let result = applyIfBlocks(cellValue, (name) => resolveGlobalVariable(name, ctx))
    .replace(/\{\{h1\.body\}\}/g, stripHtml(ctx.h1Body ?? ''))
    .replace(/\{\{h1\.blockquote\}\}/g, stripHtml(ctx.h1Blockquote ?? ''))
    .replace(/\{\{document\.title\}\}/g, ctx.document.title)
    .replace(/\{\{date\}\}/g, ctx.date)
    .replace(/\{\{update\}\}/g, ctx.update ?? '')
    .replace(/\{\{meta\.([A-Za-z0-9_-]+)\}\}/g, (_match, key: string) => {
      if (key === 'title') return ctx.document.title;
      if (key === 'date') return ctx.date;
      if (key === 'update') return ctx.update ?? '';
      return ctx.meta?.[key] ?? '';
    });

  (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const).forEach((level) => {
    const re = new RegExp(`\\{\\{${level}\\}\\}`, 'g');
    result = result.replace(re, ctx.firstHeadings?.[level] ?? '');
  });

  return result;
}

/**
 * Excelテンプレート用: ステップ行のセル値変数を置換する（HTMLエスケープなし・プレーンテキスト）
 *
 * `{{h2}}` / `{{h3}}` は `{{category}}` / `{{title}}` の別名（Markdownの見出しレベルが分かる表記）。
 * `{{blockquote}}` / `{{h3_blockquote}}` / `{{h3.blockquote}}` は `{{expected}}` の別名（期待される結果がMarkdownのblockquote由来であることが分かる表記）。
 * `{{procedure}}` / `{{h3.body}}` / `{{h3_procedure}}` / `{{h3.procedure}}` は `{{instruction}}` の別名（H3見出し直後の操作手順本文であることが分かる表記）。
 * `{{h3_index}}` / `{{h3.index}}` は `{{index}}` の別名（H3ごとに繰り返される連番であることが分かる表記）。
 * `{{h2.index}}` / `{{h2_index}}` はそのステップが属する大項目（H2）の1始まり連番。
 * Excelは1ステップ＝1行のため、`{{#each h2 steps}}` は `{{#each steps}}` と同様に取り除くだけで行分割には影響しない。
 * `{{#if 変数名}}...{{/if}}` はセル内で使え、このステップの値（無ければ文書全体の値）が空なら中身を取り除く。
 *
 * @param cellValue セルのテキスト値
 * @param step 対象ステップ
 * @param h2Index ステップが属する大項目（H2）の1始まり連番
 * @param ctx ドキュメント全体のコンテキスト（`{{#if}}`の条件判定用）
 * @throws TemplateError `{{#if}}`と`{{/if}}`の対応がセル内で取れない場合
 */
export function replaceStepCellVariables(
  cellValue: string,
  step: Step,
  h2Index: number,
  ctx: TemplateContext,
): string {
  return applyIfBlocks(cellValue, stepResolver(step, ctx, h2Index))
    .replace(/\{\{#each steps\}\}|\{\{#each h2 steps\}\}|\{\{#each h3 steps\}\}/g, '')
    .replace(/\{\{\/each\}\}/g, '')
    .replace(/\{\{h2_index\}\}|\{\{h2\.index\}\}/g, String(h2Index))
    .replace(/\{\{category\}\}|\{\{h2\}\}/g, step.category)
    .replace(/\{\{index\}\}|\{\{h3_index\}\}|\{\{h3\.index\}\}/g, String(step.index))
    .replace(/\{\{title\}\}|\{\{h3\}\}/g, step.title)
    .replace(
      /\{\{instruction\}\}|\{\{procedure\}\}|\{\{h3_procedure\}\}|\{\{h3\.procedure\}\}|\{\{h3\.body\}\}/g,
      stripHtml(step.instruction),
    )
    .replace(
      /\{\{expected\}\}|\{\{blockquote\}\}|\{\{h3_blockquote\}\}|\{\{h3\.blockquote\}\}/g,
      stripHtml(step.expected),
    )
    .replace(/\{\{image\.src\}\}/g, step.image?.src ?? '')
    .replace(/\{\{image\.alt\}\}/g, step.image?.alt ?? '');
}

/**
 * 番号付きリスト（`<ol>`）の各 `<li>` の直後に「1. 」形式の番号を挿入する。
 * 入れ子のリストはリストごとに番号を数え、`start` 属性があればその番号から始める。
 */
function numberOrderedListItems(html: string): string {
  // 開いているリストのスタック。`<ol>` は次に振る番号、`<ul>` は null
  const counters: Array<number | null> = [];
  return html.replace(
    /<(\/?)(ol|ul|li)\b([^>]*)>/gi,
    (tag, slash: string, name: string, attrs: string) => {
      const tagName = name.toLowerCase();
      if (tagName === 'li') {
        const next = counters[counters.length - 1];
        if (slash || next === undefined || next === null) return tag;
        counters[counters.length - 1] = next + 1;
        return `${tag}${next}. `;
      }
      if (slash) {
        counters.pop();
        return tag;
      }
      const start = /\bstart\s*=\s*["']?(\d+)/i.exec(attrs);
      counters.push(tagName === 'ol' ? (start ? Number(start[1]) : 1) : null);
      return tag;
    },
  );
}

/**
 * HTML文字列からタグを除去してプレーンテキストに変換する。番号付きリストの項目には「1. 」形式の番号を付ける。
 */
export function stripHtml(html: string): string {
  return numberOrderedListItems(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
