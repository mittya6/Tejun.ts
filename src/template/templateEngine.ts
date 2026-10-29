import { TemplateError } from '../utils/errors';
import { findNodePaths } from '../parser/docTree';
import { extractImageSrcs, extractImageTags } from '../utils/imageUtils';
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
const PATH_SEGMENT_RE = /(#{1,6}|>|-|1\.|```|body|index|first|images|text)(\.|$)/y;

const EACH_MISMATCH_MESSAGE = 'テンプレートの {{#each}} / {{/each}} タグが正しく対応していません。';
const IF_MISMATCH_MESSAGE = 'テンプレートの {{#if}} / {{/if}} タグが正しく対応していません。';

/** 要素の見出しテキスト・内容以外に参照できるプロパティ */
type Property = 'body' | 'index' | 'first' | 'images';

const PROPERTIES: readonly string[] = ['body', 'index', 'first', 'images'] satisfies Property[];

/** テンプレート変数・`{{#if}}` の条件に書ける式 */
type Expr =
  | { kind: 'meta'; key: string }
  | { kind: 'rootBody' }
  | { kind: 'path'; symbols: NodeSymbol[]; property?: Property; withoutImages?: boolean };

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

/** 展開したテキストの断片 */
export interface TextSegment {
  text: string;
  /** コードブロック（`<pre>`）の内容か */
  code: boolean;
  /** リンク（`<a>`）の文字か */
  link: boolean;
}

/**
 * 改行に変換するブロックのタグにマッチする正規表現。markedがタグの後に入れる改行も含める。
 * グループ1: `<pre>` 要素の中身、グループ2: 閉じタグの `/`、グループ3: `p` / `li` / `ol` / `ul` のタグ名
 */
const BLOCK_RE = /<pre\b[^>]*>([\s\S]*?)<\/pre>\n?|<(\/?)(p|li|ol|ul)\b[^>]*>\n?|<br\s*\/?>/gi;

/** リンクの要素にマッチする正規表現。グループ1: `<a>` 要素の中身 */
const LINK_RE = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * コードブロックでないテキストの断片を返す。空文字なら断片なし。
 */
function plainSegments(text: string): TextSegment[] {
  return text ? [{ text, code: false, link: false }] : [];
}

/**
 * 断片のテキストを連結する
 */
function joinSegments(segments: TextSegment[]): string {
  return segments.map((segment) => segment.text).join('');
}

/**
 * 空の断片を取り除き、隣り合う同じ種類の断片をまとめる
 */
function mergeSegments(segments: TextSegment[]): TextSegment[] {
  const merged: TextSegment[] = [];
  for (const segment of segments) {
    if (!segment.text) continue;
    const last = merged[merged.length - 1];
    if (last?.code === segment.code && last.link === segment.link) {
      merged[merged.length - 1] = { ...last, text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
  }
  return merged;
}

/**
 * `###.>` / `-.index` / `###.body.text` のような記号の参照式を解析する。
 * `text` は末尾にだけ書け、記号または `body` の後ろに続く。
 *
 * @returns 参照式として解釈できなければ `undefined`
 */
function parsePath(source: string): Expr | undefined {
  const symbols: NodeSymbol[] = [];
  let property: Property | undefined;
  let withoutImages = false;
  let separator = '';
  PATH_SEGMENT_RE.lastIndex = 0;
  while (PATH_SEGMENT_RE.lastIndex < source.length) {
    const match = PATH_SEGMENT_RE.exec(source);
    if (!match || withoutImages) return undefined;
    if (match[1] === 'text') {
      if (property && property !== 'body') return undefined;
      withoutImages = true;
    } else if (property) {
      return undefined;
    } else if (PROPERTIES.includes(match[1])) {
      property = match[1] as Property;
    } else {
      symbols.push(match[1] as NodeSymbol);
    }
    separator = match[2];
  }
  if (symbols.length === 0 || separator === '.') return undefined;
  return withoutImages
    ? { kind: 'path', symbols, property, withoutImages }
    : { kind: 'path', symbols, property };
}

/**
 * テンプレート変数・条件の式を解析する（`meta.キー名`・`root.body` または記号の参照式）
 *
 * @returns 式として解釈できなければ `undefined`
 */
function parseExpr(source: string): Expr | undefined {
  const meta = /^meta\.([A-Za-z0-9_-]+)$/.exec(source);
  if (meta) return { kind: 'meta', key: meta[1] };
  if (source === 'root.body') return { kind: 'rootBody' };
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
  if (
    !expr ||
    expr.kind !== 'path' ||
    expr.symbols.length !== 1 ||
    expr.property ||
    expr.withoutImages
  ) {
    throw new TemplateError(
      `テンプレートの ${tag} は解釈できません。{{#each 記号 steps}} の形で書いてください。`,
    );
  }
  return expr.symbols[0];
}

/**
 * 閉じタグと対応しないときのエラーメッセージを返す
 */
function mismatchMessage(keyword: 'each' | 'if'): string {
  return keyword === 'each' ? EACH_MISMATCH_MESSAGE : IF_MISMATCH_MESSAGE;
}

/**
 * `{{#each ...}}` / `{{#if ...}}` の開きタグから、子を持つテンプレートの要素を作る
 *
 * @param tag 開きタグ全体（エラーメッセージ用）
 * @throws TemplateError 引数を解釈できない場合
 */
function createBlock(
  keyword: 'each' | 'if',
  arg: string,
  tag: string,
): Extract<TemplateNode, { kind: 'each' | 'if' }> {
  if (keyword === 'each') {
    return { kind: 'each', symbol: parseEachSymbol(arg, tag), children: [] };
  }
  const expr = parseExpr(arg.trim());
  if (!expr) throw new TemplateError(`テンプレートの ${tag} の条件は解釈できません。`);
  return { kind: 'if', expr, children: [] };
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

    const [, prefix, keywordText, arg] = control;
    const keyword = keywordText as 'each' | 'if';
    if (prefix === '/') {
      if (arg.trim() !== '' || stack[stack.length - 1]?.kind !== keyword) {
        throw new TemplateError(mismatchMessage(keyword));
      }
      stack.pop();
      continue;
    }

    const block = createBlock(keyword, arg, match[0]);
    current().push(block);
    stack.push({ kind: block.kind, children: block.children });
  }

  if (stack.length > 0) {
    throw new TemplateError(mismatchMessage(stack[stack.length - 1].kind));
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
 * `meta.キー名` の値を返す。値が無ければ空文字。
 */
function evaluateMeta(key: string, ctx: TemplateContext): string {
  if (key === 'title') return ctx.title;
  if (key === 'date') return ctx.date;
  if (key === 'update') return ctx.update ?? '';
  return ctx.meta[key] ?? '';
}

/**
 * 要素の中のHTML（見出し・ルートは本文と見出し以外の子要素、それ以外は要素の内容）を返す。
 * 子の見出しの中身は含めない。
 */
function elementHtmls(node: DocNode): string[] {
  if (node.symbol !== 'root' && !node.symbol.startsWith('#')) return [node.content];
  return [
    node.body ?? '',
    ...node.children.filter((child) => !child.symbol.startsWith('#')).flatMap(elementHtmls),
  ];
}

/**
 * 要素の中の画像の `<img>` タグを出現順に返す。本文とリストの子要素の両方に含まれる
 * 同じタグは1回だけにする。子の見出しの画像は含めない。
 */
function collectImageTags(node: DocNode): string[] {
  return [...new Set(elementHtmls(node).flatMap(extractImageTags))];
}

/**
 * 式を評価する。参照先の要素が無ければ空文字。`.text` の式はHTMLから画像を取り除く。
 *
 * @param prevChain 前の行の経路（Excelの行ループのみ。`first` の判定に使う）
 */
function evaluate(
  expr: Expr,
  chain: DocNode[],
  ctx: TemplateContext,
  prevChain?: DocNode[],
): Value {
  const value = evaluateExpr(expr, chain, ctx, prevChain);
  if (expr.kind === 'path' && expr.withoutImages && value.isHtml) {
    return { text: removeImages(value.text), isHtml: true };
  }
  return value;
}

/**
 * 式を評価する（`.text` の画像の除去はしない）。参照先の要素が無ければ空文字。
 *
 * @param prevChain 前の行の経路（Excelの行ループのみ。`first` の判定に使う）
 */
function evaluateExpr(
  expr: Expr,
  chain: DocNode[],
  ctx: TemplateContext,
  prevChain?: DocNode[],
): Value {
  if (expr.kind === 'meta') return { text: evaluateMeta(expr.key, ctx), isHtml: false };
  if (expr.kind === 'rootBody') return { text: ctx.root.body ?? '', isHtml: true };

  let found: DocNode[] | undefined = chain;
  for (const symbol of expr.symbols) {
    found = findInScope(found, symbol);
    if (!found) return { text: '', isHtml: false };
  }
  const node = found[found.length - 1];
  if (expr.property === 'index') return { text: String(node.index), isHtml: false };
  if (expr.property === 'body') return { text: node.body ?? '', isHtml: true };
  if (expr.property === 'images') return { text: collectImageTags(node).join('\n'), isHtml: true };
  if (expr.property === 'first') {
    return { text: prevChain?.includes(node) ? '' : '1', isHtml: false };
  }
  return { text: node.content, isHtml: !node.symbol.startsWith('#') };
}

/**
 * 解析済みテンプレートを展開する
 *
 * @param chain ルートからカレント要素までの経路（ループの外側ではルートのみ）
 * @param prevChain 前の行の経路（Excelの行ループのみ）
 * @param images `text` モードで、展開したHTMLに含まれる画像の `src` を出現順に追加する配列
 */
function renderNodes(
  nodes: TemplateNode[],
  chain: DocNode[],
  ctx: TemplateContext,
  mode: OutputMode,
  prevChain?: DocNode[],
  images?: string[],
): TextSegment[] {
  return mergeSegments(
    nodes.flatMap((node): TextSegment[] => {
      switch (node.kind) {
        case 'text':
          return plainSegments(node.text);
        case 'var': {
          const value = evaluate(node.expr, chain, ctx, prevChain);
          if (mode === 'html') {
            return plainSegments(value.isHtml ? value.text : escapeHtml(value.text));
          }
          if (!value.isHtml) return plainSegments(value.text);
          images?.push(...extractImageSrcs(value.text));
          return htmlToSegments(value.text);
        }
        case 'if':
          return evaluate(node.expr, chain, ctx, prevChain).text.trim()
            ? renderNodes(node.children, chain, ctx, mode, prevChain, images)
            : [];
        case 'each':
          return findNodePaths(chain[chain.length - 1], node.symbol).flatMap((path) =>
            renderNodes(node.children, [...chain, ...path], ctx, mode, prevChain, images),
          );
      }
    }),
  );
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
 * - `{{記号.images}}` → 要素の中（本文・引用・リストなど）の画像の `<img>` タグだけを改行で連結したもの（子の見出しの画像は含まない）
 * - `{{記号.text}}` / `{{記号.body.text}}` → `{{記号}}` / `{{記号.body}}` のHTMLから画像を取り除いたもの
 * - `{{root.body}}` → 最初の見出しより前（かつ最初の引用より前）の本文のHTML（エスケープなし）
 * - `{{記号.index}}` → 1始まりの連番（同じ親の中での連番。見出しも親の見出しが変わると1に戻る）
 * - `{{記号.first}}` → Excelの行ループで、要素が前の行と別の要素なら `1`、同じ要素なら空文字
 *   （`{{#if ##.first}}...{{/if}}` のように使う）。行ループの外側・HTML出力では常に `1`
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
  return joinSegments(renderNodes(parseTemplate(template), [ctx.root], ctx, 'html'))
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
 * @param prevChain 行ループの前の行の経路（`{{記号.first}}` の判定に使う。最初の行では省略）
 * @throws TemplateError `{{#each}}` / `{{#if}}` の書式が誤っている、またはセル内で閉じタグと対応しない場合
 */
export function replaceCellVariables(
  cellValue: string,
  ctx: TemplateContext,
  chain: DocNode[] = [ctx.root],
  prevChain?: DocNode[],
): string {
  return joinSegments(renderNodes(parseTemplate(cellValue), chain, ctx, 'text', prevChain));
}

/**
 * Excelテンプレート用: `replaceCellVariables` と同じくセル値の変数を置換し、
 * 置換したテキストをコードブロックとそれ以外に分けた断片と、
 * 置換したHTMLに含まれていた画像の `src`（出現順）も返す
 *
 * @param cellValue セルのテキスト値
 * @param ctx ドキュメント全体のコンテキスト
 * @param chain ルートからカレント要素までの経路（行ループの行では、その行の要素まで）
 * @param prevChain 行ループの前の行の経路（最初の行では省略）
 * @throws TemplateError `{{#each}}` / `{{#if}}` の書式が誤っている、またはセル内で閉じタグと対応しない場合
 */
export function renderCell(
  cellValue: string,
  ctx: TemplateContext,
  chain: DocNode[],
  prevChain?: DocNode[],
): { text: string; segments: TextSegment[]; images: string[] } {
  const images: string[] = [];
  const segments = renderNodes(parseTemplate(cellValue), chain, ctx, 'text', prevChain, images);
  return { text: joinSegments(segments), segments, images };
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
 * HTML文字列から画像を取り除く。画像だけの行・段落が空行として残らないよう、直後の改行ごと取り除く。
 */
function removeImages(html: string): string {
  return html.replace(/<img\b[^>]*>\n?/gi, '').replace(/<p>\s*<\/p>\n?/gi, '');
}

/**
 * HTML文字列からタグを除去してプレーンテキストに変換する（前後の空白は残す）
 */
function htmlToText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * HTML文字列からタグを除去してプレーンテキストに変換する。番号付きリストの項目には「1. 」形式の番号を付ける。
 * 画像は、画像だけの行・段落が空行として残らないよう、直後の改行ごと取り除く。
 */
export function stripHtml(html: string): string {
  return joinSegments(htmlToSegments(html));
}

/**
 * 断片の末尾の改行が `count` 個以上になるよう改行を足す。文章がまだ無ければ足さない。
 */
function appendLineBreaks(segments: TextSegment[], count: number): void {
  const text = joinSegments(segments);
  if (!text.trim()) return;
  const trailing = text.length - text.replace(/\n+$/, '').length;
  if (trailing < count) {
    segments.push({ text: '\n'.repeat(count - trailing), code: false, link: false });
  }
}

/**
 * ブロックの区切りの改行の数。リストの外では空行（改行2つ）、リストの中では改行1つ。
 */
function blockBreakCount(listDepth: number): number {
  return listDepth > 0 ? 1 : 2;
}

/**
 * `p` / `li` / `ol` / `ul` のタグの位置で、直前の文章の末尾に必要な改行の数
 *
 * @param listDepth タグを処理した後のリストの入れ子の深さ
 */
function tagBreakCount(tagName: string, closing: boolean, listDepth: number): number {
  if (!closing) return tagName === 'p' ? 0 : 1;
  return tagName === 'li' ? 1 : blockBreakCount(listDepth);
}

/**
 * コードブロックでないHTMLをプレーンテキストに変換し、リンク（`<a>`）とそれ以外の断片に分ける
 */
function inlineSegments(html: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;
  for (const match of html.matchAll(LINK_RE)) {
    segments.push({
      text: htmlToText(html.slice(lastIndex, match.index)),
      code: false,
      link: false,
    });
    segments.push({ text: htmlToText(match[1]), code: false, link: true });
    lastIndex = match.index + match[0].length;
  }
  segments.push({ text: htmlToText(html.slice(lastIndex)), code: false, link: false });
  return segments;
}

/**
 * `stripHtml` と同じくプレーンテキストに変換し、コードブロック（`<pre>`）・リンク（`<a>`）・それ以外の断片に分ける
 *
 * ブロックの区切りは、リストの外では空行（改行2つ）、リストの中では改行1つにする。
 * markedがタグの後に入れる改行は区切りと重なるため捨てる。
 */
function htmlToSegments(html: string): TextSegment[] {
  const prepared = removeImages(numberOrderedListItems(html));
  const segments: TextSegment[] = [];
  let listDepth = 0;
  let lastIndex = 0;
  for (const match of prepared.matchAll(BLOCK_RE)) {
    segments.push(...inlineSegments(prepared.slice(lastIndex, match.index)));
    lastIndex = match.index + match[0].length;
    const [, code, slash, name] = match;
    if (code !== undefined) {
      appendLineBreaks(segments, 1);
      segments.push({ text: htmlToText(code), code: true, link: false });
      appendLineBreaks(segments, blockBreakCount(listDepth));
    } else if (name === undefined) {
      // <br>
      segments.push({ text: '\n', code: false, link: false });
    } else {
      const tagName = name.toLowerCase();
      if (tagName === 'ol' || tagName === 'ul') listDepth += slash ? -1 : 1;
      appendLineBreaks(segments, tagBreakCount(tagName, slash === '/', listDepth));
    }
  }
  segments.push(...inlineSegments(prepared.slice(lastIndex)));
  return trimSegments(mergeSegments(segments));
}

/**
 * 断片を連結した文章全体の前後の空白を取り除く
 */
function trimSegments(merged: TextSegment[]): TextSegment[] {
  while (merged.length > 0 && !merged[0].text.trim()) merged.shift();
  while (merged.length > 0 && !merged[merged.length - 1].text.trim()) merged.pop();
  if (merged.length > 0) {
    const last = merged.length - 1;
    merged[0] = { ...merged[0], text: merged[0].text.trimStart() };
    merged[last] = { ...merged[last], text: merged[last].text.trimEnd() };
  }
  return merged;
}
