import { TemplateError } from '../utils/errors';
import { findNodePaths } from '../parser/docTree';
import type { DocNode, NodeSymbol, TemplateContext } from '../parser/types';

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

/** `{{...}}` のタグにマッチする正規表現 */
const TAG_RE = /\{\{([^{}]*)\}\}/g;

/** `{{#each ...}}` / `{{/each}}` のタグにマッチする正規表現 */
const EACH_TAG_RE = /\{\{#each\b([^{}]*)\}\}|\{\{\/each\}\}/g;

/** 参照式の1区切り（記号またはプロパティ）と、その後ろの区切りの `.` にマッチする正規表現 */
const PATH_SEGMENT_RE = /(#{1,6}|>|-|1\.|```|body|index)(\.|$)/y;

const EACH_MISMATCH_MESSAGE = 'テンプレートの {{#each}} / {{/each}} タグが正しく対応していません。';
const IF_MISMATCH_MESSAGE = 'テンプレートの {{#if}} / {{/if}} タグが正しく対応していません。';

/** 要素の見出しテキスト・内容以外に参照できるプロパティ */
type Property = 'body' | 'index';

/** テンプレート変数・`{{#if}}` の条件に書ける式 */
type Expr =
  | { kind: 'meta'; key: string }
  | { kind: 'path'; symbols: NodeSymbol[]; property?: Property };

/** 解析済みテンプレートの要素 */
type TemplateNode =
  | { kind: 'text'; text: string }
  | { kind: 'var'; expr: Expr }
  | { kind: 'each'; symbol: NodeSymbol; children: TemplateNode[] }
  | { kind: 'if'; expr: Expr; children: TemplateNode[] };

/** 評価した式の値 */
interface Value {
  text: string;
  /** `text` がHTMLか（見出しテキストやメタ情報はプレーンテキスト） */
  isHtml: boolean;
}

/** 出力形式。`html` はプレーンテキストをHTMLエスケープ、`text` はHTMLのタグを除去する */
type OutputMode = 'html' | 'text';

/**
 * `###.>` / `-.index` のような記号の参照式を解析する
 *
 * @returns 参照式として解釈できなければ `undefined`
 */
function parsePath(source: string): Expr | undefined {
  const symbols: NodeSymbol[] = [];
  let property: Property | undefined;
  let separator = '';
  PATH_SEGMENT_RE.lastIndex = 0;
  while (PATH_SEGMENT_RE.lastIndex < source.length) {
    const match = PATH_SEGMENT_RE.exec(source);
    if (!match || property) return undefined;
    if (match[1] === 'body' || match[1] === 'index') {
      property = match[1];
    } else {
      symbols.push(match[1] as NodeSymbol);
    }
    separator = match[2];
  }
  if (symbols.length === 0 || separator === '.') return undefined;
  return { kind: 'path', symbols, property };
}

/**
 * テンプレート変数・条件の式を解析する（`meta.キー名` または記号の参照式）
 *
 * @returns 式として解釈できなければ `undefined`
 */
function parseExpr(source: string): Expr | undefined {
  const meta = /^meta\.([A-Za-z0-9_-]+)$/.exec(source);
  if (meta) return { kind: 'meta', key: meta[1] };
  return parsePath(source);
}

/**
 * `{{#each 記号 steps}}` の引数（`#each` より後ろ）から記号を取り出す
 *
 * @throws TemplateError 記号として解釈できない場合
 */
function parseEachSymbol(arg: string, tag: string): NodeSymbol {
  const match = /^\s+(\S+)\s+steps\s*$/.exec(arg);
  const expr = match ? parsePath(match[1]) : undefined;
  if (!expr || expr.kind !== 'path' || expr.symbols.length !== 1 || expr.property) {
    throw new TemplateError(
      `テンプレートの ${tag} は解釈できません。{{#each 記号 steps}} の形で書いてください。`,
    );
  }
  return expr.symbols[0];
}

/**
 * テンプレート文字列を解析する。解釈できない `{{...}}` は文字列としてそのまま残す。
 *
 * @throws TemplateError `{{#each}}` / `{{#if}}` の書式が誤っている、または閉じタグと対応しない場合
 */
function parseTemplate(template: string): TemplateNode[] {
  const root: TemplateNode[] = [];
  const stack: Array<{ kind: 'each' | 'if'; children: TemplateNode[] }> = [];
  const current = (): TemplateNode[] => stack[stack.length - 1]?.children ?? root;

  let lastIndex = 0;
  for (const match of template.matchAll(TAG_RE)) {
    if (match.index > lastIndex) {
      current().push({ kind: 'text', text: template.slice(lastIndex, match.index) });
    }
    lastIndex = match.index + match[0].length;
    const inner = match[1];

    const control = /^([#/])(each|if)\b(.*)$/s.exec(inner);
    if (!control) {
      const expr = parseExpr(inner.trim());
      current().push(expr ? { kind: 'var', expr } : { kind: 'text', text: match[0] });
      continue;
    }

    const [, prefix, keyword, arg] = control;
    const mismatch = keyword === 'each' ? EACH_MISMATCH_MESSAGE : IF_MISMATCH_MESSAGE;
    if (prefix === '/') {
      if (arg.trim() !== '' || stack[stack.length - 1]?.kind !== keyword) {
        throw new TemplateError(mismatch);
      }
      stack.pop();
      continue;
    }

    const children: TemplateNode[] = [];
    if (keyword === 'each') {
      current().push({ kind: 'each', symbol: parseEachSymbol(arg, match[0]), children });
      stack.push({ kind: 'each', children });
    } else {
      const expr = parseExpr(arg.trim());
      if (!expr) throw new TemplateError(`テンプレートの ${match[0]} の条件は解釈できません。`);
      current().push({ kind: 'if', expr, children });
      stack.push({ kind: 'if', children });
    }
  }

  if (stack.length > 0) {
    throw new TemplateError(
      stack[stack.length - 1].kind === 'each' ? EACH_MISMATCH_MESSAGE : IF_MISMATCH_MESSAGE,
    );
  }
  if (lastIndex < template.length) root.push({ kind: 'text', text: template.slice(lastIndex) });
  return root;
}

/**
 * 記号 `symbol` の要素を、カレント要素（`chain` の末尾）から探す
 *
 * カレント要素とその祖先に同じ記号の要素があればそれを、無ければカレント要素の子孫のうち
 * 最初の要素（直下の子を優先）を返す。
 *
 * @param chain ルートからカレント要素までの経路
 * @returns ルートから見つかった要素までの経路。見つからなければ `undefined`
 */
function findInScope(chain: DocNode[], symbol: NodeSymbol): DocNode[] | undefined {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (chain[i].symbol === symbol) return chain.slice(0, i + 1);
  }
  const current = chain[chain.length - 1];
  const child = current.children.find((node) => node.symbol === symbol);
  if (child) return [...chain, child];
  const path = findNodePaths(current, symbol)[0];
  return path ? [...chain, ...path] : undefined;
}

/**
 * 式を評価する。参照先の要素が無ければ空文字。
 */
function evaluate(expr: Expr, chain: DocNode[], ctx: TemplateContext): Value {
  if (expr.kind === 'meta') {
    if (expr.key === 'title') return { text: ctx.title, isHtml: false };
    if (expr.key === 'date') return { text: ctx.date, isHtml: false };
    if (expr.key === 'update') return { text: ctx.update ?? '', isHtml: false };
    return { text: ctx.meta[expr.key] ?? '', isHtml: false };
  }

  let found: DocNode[] | undefined = chain;
  for (const symbol of expr.symbols) {
    found = findInScope(found, symbol);
    if (!found) return { text: '', isHtml: false };
  }
  const node = found[found.length - 1];
  if (expr.property === 'index') return { text: String(node.index), isHtml: false };
  if (expr.property === 'body') return { text: node.body ?? '', isHtml: true };
  return { text: node.content, isHtml: !node.symbol.startsWith('#') };
}

/**
 * 解析済みテンプレートを展開する
 *
 * @param chain ルートからカレント要素までの経路（ループの外側ではルートのみ）
 */
function renderNodes(
  nodes: TemplateNode[],
  chain: DocNode[],
  ctx: TemplateContext,
  mode: OutputMode,
): string {
  return nodes
    .map((node) => {
      switch (node.kind) {
        case 'text':
          return node.text;
        case 'var': {
          const value = evaluate(node.expr, chain, ctx);
          if (mode === 'html') return value.isHtml ? value.text : escapeHtml(value.text);
          return value.isHtml ? stripHtml(value.text) : value.text;
        }
        case 'if':
          return evaluate(node.expr, chain, ctx).text.trim()
            ? renderNodes(node.children, chain, ctx, mode)
            : '';
        case 'each':
          return findNodePaths(chain[chain.length - 1], node.symbol)
            .map((path) => renderNodes(node.children, [...chain, ...path], ctx, mode))
            .join('');
      }
    })
    .join('');
}

/**
 * HTMLテンプレート文字列にコンテキストを適用してレンダリングする
 *
 * 要素はMarkdownの文頭に書く記号（`#`〜`######` / `>` / `-` / `1.` / ```` ``` ````）で指定する。
 * - `{{記号}}` → カレント要素（一番内側の `{{#each}}` の要素。外側では文書全体）とその祖先から
 *   その記号の要素を探し、無ければカレント要素の子孫の最初の要素を使う。見出しは見出しテキスト
 *   （エスケープあり）、それ以外は要素の内容のHTML（エスケープなし）。`{{#each}}` の外側では
 *   Markdownで最初に出現するその記号の要素になる
 * - `{{記号.記号}}` → 左の要素を起点に右の要素を探す（例: `{{###.>}}` は手順の最初の引用）
 * - `{{記号.body}}` → 見出し直下の最初の引用より前の本文のHTML（エスケープなし）
 * - `{{記号.index}}` → 1始まりの連番（見出しは文書全体を通した連番、それ以外は同じ親の中での連番）
 * - `{{meta.プロパティ名}}` → Front Matterのプロパティ（`title` / `date` / `update` は解決済みの値）
 * - `{{#each 記号 steps}}...{{/each}}` → カレント要素の中のその記号の要素ごとに繰り返す（入れ子可）
 * - `{{#if 式}}...{{/if}}` → 式の値が空でない場合のみ展開（入れ子可）
 * - `${title}` / `${date}` / `${update}` → `{{meta.title}}` などと同じ値
 * - `${markdown}` / `${overview}` → Markdown全文 / 概要文のHTML（エスケープなし）
 *
 * 解釈できない `{{...}}` はそのまま出力される。
 *
 * @param template テンプレート文字列
 * @param ctx レンダリングに使用するコンテキスト
 * @returns レンダリング済みHTML文字列
 * @throws TemplateError `{{#each}}` / `{{#if}}` の書式が誤っている、または閉じタグと対応しない場合
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return renderNodes(parseTemplate(template), [ctx.root], ctx, 'html')
    .replace(/\$\{title\}/g, () => escapeHtml(ctx.title))
    .replace(/\$\{date\}/g, () => escapeHtml(ctx.date))
    .replace(/\$\{update\}/g, () => escapeHtml(ctx.update ?? ''))
    .replace(/\$\{markdown\}/g, () => ctx.markdown ?? '')
    .replace(/\$\{overview\}/g, () => ctx.overview ?? '');
}

/**
 * Excelテンプレート用: セル値の変数を置換する（HTMLエスケープなし・HTMLのタグを除去したプレーンテキスト）
 *
 * 構文は `renderTemplate` と同じ（`${...}` を除く）。セル内で閉じている `{{#each}}` / `{{#if}}` も使える。
 *
 * @param cellValue セルのテキスト値
 * @param ctx ドキュメント全体のコンテキスト
 * @param chain ルートからカレント要素までの経路（行ループの行では、その行の要素まで）
 * @throws TemplateError `{{#each}}` / `{{#if}}` の書式が誤っている、またはセル内で閉じタグと対応しない場合
 */
export function replaceCellVariables(
  cellValue: string,
  ctx: TemplateContext,
  chain: DocNode[] = [ctx.root],
): string {
  return renderNodes(parseTemplate(cellValue), chain, ctx, 'text');
}

/**
 * Excelテンプレート用: 行の複数セルにまたがる `{{#each 記号 steps}}` / `{{/each}}`（行ループ）を取り除く
 *
 * 開始タグと閉じタグが別のセルにある組と、行末まで閉じられていない開始タグを行ループとみなす。
 * 同じセル内で閉じている組はセル内のループなので残す。
 *
 * @param cells 行の各セルのテキスト
 * @returns 行ループの記号（外側から順）と、行ループのタグを取り除いたセルのテキスト。行ループが無ければ `undefined`
 * @throws TemplateError 対応する開始タグの無い `{{/each}}` がある、または記号が解釈できない場合
 */
export function extractRowLoop(
  cells: string[],
): { symbols: NodeSymbol[]; cells: string[] } | undefined {
  interface TagPos {
    cell: number;
    start: number;
    end: number;
  }
  const opens: Array<TagPos & { tag: string; arg: string }> = [];
  const loopOpens: Array<TagPos & { symbol: NodeSymbol }> = [];
  const removals: TagPos[] = [];

  cells.forEach((text, cell) => {
    for (const match of text.matchAll(EACH_TAG_RE)) {
      const pos = { cell, start: match.index, end: match.index + match[0].length };
      if (match[1] !== undefined) {
        opens.push({ ...pos, tag: match[0], arg: match[1] });
        continue;
      }
      const open = opens.pop();
      if (!open) throw new TemplateError(EACH_MISMATCH_MESSAGE);
      if (open.cell !== cell) {
        loopOpens.push({ ...open, symbol: parseEachSymbol(open.arg, open.tag) });
        removals.push(open, pos);
      }
    }
  });
  for (const open of opens) {
    loopOpens.push({ ...open, symbol: parseEachSymbol(open.arg, open.tag) });
    removals.push(open);
  }
  if (loopOpens.length === 0) return undefined;

  loopOpens.sort((a, b) => a.cell - b.cell || a.start - b.start);
  removals.sort((a, b) => b.start - a.start);
  const stripped = [...cells];
  for (const { cell, start, end } of removals) {
    stripped[cell] = stripped[cell].slice(0, start) + stripped[cell].slice(end);
  }
  return { symbols: loopOpens.map((open) => open.symbol), cells: stripped };
}

/**
 * 行ループの記号を外側から順にたどり、1行ごとにルートからその行の要素までの経路を返す
 *
 * 内側の記号の要素を持たない外側の要素は、その要素までの経路を1行として返す
 * （例: `###` の無い `##` も1行になる）。
 *
 * @param chain 起点の経路（通常はルートのみ）
 * @param symbols 行ループの記号（外側から順）
 */
export function expandLoopChains(chain: DocNode[], symbols: NodeSymbol[]): DocNode[][] {
  if (symbols.length === 0) return [chain];
  const [symbol, ...rest] = symbols;
  return findNodePaths(chain[chain.length - 1], symbol).flatMap((path) => {
    const chains = expandLoopChains([...chain, ...path], rest);
    return chains.length > 0 ? chains : [[...chain, ...path]];
  });
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
 * 画像は、画像だけの行・段落が空行として残らないよう、直後の改行ごと取り除く。
 */
export function stripHtml(html: string): string {
  return numberOrderedListItems(html)
    .replace(/<img\b[^>]*>\n?/gi, '')
    .replace(/<p>\s*<\/p>\n?/gi, '')
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
