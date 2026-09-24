import { marked } from 'marked';
import type { Token } from 'marked';
import { ParseError } from '../utils/errors';
import type { DocNode, HeadingSymbol, ImageRef, NodeSymbol, ProcedureDocument } from './types';

/** 期待値ヘッダー行にマッチする正規表現（**期待値** または 期待値） */
const EXPECTED_HEADER_RE = /^\*{0,2}期待値\*{0,2}\s*$/;

/** Front Matterブロック（先頭の `---` ～ `---`）にマッチする正規表現 */
const FRONT_MATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Front Matterから抽出したメタ情報 */
interface FrontMatter {
  title?: string;
  date?: string;
  update?: string;
  /** Front Matterに書かれた全キーと値（`title`/`date`/`update`も含む生の値。`{{meta.プロパティ名}}`用） */
  raw: Record<string, string>;
}

/**
 * Markdown先頭のFront Matter（`---`で囲まれたYAML風メタ情報）を抽出する
 *
 * キーと値の行（`key: value`）であれば任意のプロパティ名を認識する簡易パーサー。
 * ネストした構造や配列には対応しない。`title` / `date` / `update` は`ProcedureDocument`の
 * 対応フィールドとしても扱われるが、それ以外のキーも`raw`に格納され、`{{meta.プロパティ名}}`
 * で参照できる。
 *
 * @param content Markdown全文
 * @returns 抽出したFront Matterと、それを除いた本文
 */
export function parseFrontMatter(content: string): { frontMatter: FrontMatter; body: string } {
  const match = content.match(FRONT_MATTER_RE);
  if (!match) {
    return { frontMatter: { raw: {} }, body: content };
  }

  const raw: Record<string, string> = {};
  const lines = match[1].split('\n');
  for (const line of lines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    if (!key) continue;
    const rawValue = line.slice(colonIndex + 1).trim();
    const value = rawValue.replace(/^["'](.*)["']$/, '$1');
    if (value) raw[key] = value;
  }

  const frontMatter: FrontMatter = {
    title: raw.title,
    date: raw.date,
    update: raw.update,
    raw,
  };

  return { frontMatter, body: content.slice(match[0].length) };
}

/**
 * トークンツリーを再帰的に探索して最初の画像トークンを返す
 */
function findFirstImage(tokens: Token[]): ImageRef | undefined {
  for (const token of tokens) {
    if (token.type === 'image') {
      return { src: token.href, alt: token.text };
    }

    // tokens を持つブロック・インライントークンを再帰探索
    if (
      token.type === 'paragraph' ||
      token.type === 'heading' ||
      token.type === 'blockquote' ||
      token.type === 'strong' ||
      token.type === 'em' ||
      token.type === 'link' ||
      token.type === 'list_item'
    ) {
      if (token.tokens && token.tokens.length > 0) {
        const found = findFirstImage(token.tokens);
        if (found) return found;
      }
    }

    if (token.type === 'list') {
      for (const item of token.items) {
        const found = findFirstImage(item.tokens ?? []);
        if (found) return found;
      }
    }
  }
  return undefined;
}

/**
 * blockquoteトークンから引用の内容のHTMLと最初の画像を取り出す
 *
 * 先頭などにある「期待値」ヘッダー行は取り除く。画像は元の記述順のままHTMLに残す。
 */
function processBlockquote(blockquoteToken: Extract<Token, { type: 'blockquote' }>): {
  html: string;
  image: ImageRef | undefined;
} {
  // rawテキストから "> " プレフィックスを除去し、期待値ヘッダー行を削除
  const markdown = blockquoteToken.raw
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .filter((line) => !EXPECTED_HEADER_RE.test(line.trim()))
    .join('\n')
    .trim();

  return {
    html: markdown ? (marked.parse(markdown) as string) : '',
    image: findFirstImage(blockquoteToken.tokens),
  };
}

/**
 * 子要素を作成して `parent` に追加する。連番は同じ親の中での同じ種類の要素の連番。
 */
function appendChild(parent: DocNode, symbol: NodeSymbol, content: string): DocNode {
  const node: DocNode = {
    symbol,
    content,
    index: parent.children.filter((child) => child.symbol === symbol).length + 1,
    children: [],
  };
  parent.children.push(node);
  return node;
}

/**
 * 見出し以外のブロックトークンから、引用・リスト項目・コードブロックの要素を作って `parent` に追加する。
 * 引用とリスト項目の中身も再帰的にたどる。
 */
function appendBlocks(parent: DocNode, tokens: Token[]): void {
  for (const token of tokens) {
    if (token.type === 'blockquote') {
      const { html, image } = processBlockquote(token as Extract<Token, { type: 'blockquote' }>);
      const node = appendChild(parent, '>', html);
      if (image) node.image = image;
      appendBlocks(node, token.tokens ?? []);
    } else if (token.type === 'list') {
      for (const item of token.items) {
        const html = marked.parser(item.tokens);
        appendBlocks(appendChild(parent, token.ordered ? '1.' : '-', html), item.tokens);
      }
    } else if (token.type === 'code') {
      appendChild(parent, '```', marked.parser([token]));
    }
  }
}

/** 解析中の見出し（ルートを含む）の状態 */
interface Section {
  node: DocNode;
  level: number;
  /** 最初の引用より前の本文（Markdown） */
  bodyParts: string[];
  quoteFound: boolean;
}

/**
 * Markdown文字列を解析し、手順書ドキュメントとして構造化して返す
 *
 * 記述ルール:
 * - 先頭のFront Matter (`---`...`---`) → `title` / `date` / `update` などのメタ情報
 * - ツリーのルートは文書全体（記号 `root`）。最初の見出しより前の内容はルートの子・本文になる
 * - H1〜H6 → 次に同じか上位の見出しが現れるまでの内容を子に持つ要素
 * - 最初のH1 (`#`) → ドキュメントタイトル（Front Matterに`title`があればそちらを優先）
 * - 見出し直下の最初のblockquoteより前のテキスト・コード・リスト → その見出しの本文（body）
 * - blockquote (`>`)・リストの項目（`-` / `1.`）・コードブロック（```` ``` ````） → 見出しの子要素
 * - 最初のH2以降の見出しより前に書かれた内容 → 概要文（overview）
 *
 * @param content Markdownファイルの文字列
 * @returns 構造化された手順書ドキュメント
 * @throws ParseError Front Matterの`title`もH1タイトルも存在しない場合
 */
export function parseMarkdown(content: string): ProcedureDocument {
  const { frontMatter, body } = parseFrontMatter(content);
  const tokens = marked.lexer(body);

  const root: DocNode = { symbol: 'root', content: '', index: 1, children: [] };
  const rootSection: Section = { node: root, level: 0, bodyParts: [], quoteFound: false };
  const sections: Section[] = [rootSection];
  // 現在の見出しの入れ子（先頭はルート）
  const stack: Section[] = [rootSection];
  // 見出しレベルごとの文書全体での出現数（添字がレベル）
  const headingCounts = [0, 0, 0, 0, 0, 0, 0];
  let firstH1: string | undefined;
  let enteredSections = false;
  const overviewParts: string[] = [];

  for (const token of tokens) {
    if (token.type === 'heading') {
      if (token.depth === 1) firstH1 ??= token.text;
      while (stack[stack.length - 1].level >= token.depth) stack.pop();
      headingCounts[token.depth]++;
      const node: DocNode = {
        symbol: '#'.repeat(token.depth) as HeadingSymbol,
        content: token.text,
        index: headingCounts[token.depth],
        children: [],
      };
      stack[stack.length - 1].node.children.push(node);
      const section: Section = { node, level: token.depth, bodyParts: [], quoteFound: false };
      sections.push(section);
      stack.push(section);
      if (token.depth >= 2) enteredSections = true;
      continue;
    }

    if (token.type === 'space') continue;
    if (!enteredSections) overviewParts.push(token.raw.trim());

    const section = stack[stack.length - 1];
    if (token.type === 'blockquote') {
      section.quoteFound = true;
    } else if (!section.quoteFound) {
      section.bodyParts.push(token.raw.trim());
    }
    appendBlocks(section.node, [token]);
  }

  for (const section of sections) {
    const bodyMarkdown = section.bodyParts.join('\n\n');
    section.node.body = bodyMarkdown ? (marked.parse(bodyMarkdown) as string) : '';
  }

  const resolvedTitle = frontMatter.title || firstH1;
  if (!resolvedTitle) {
    throw new ParseError(
      'MarkdownドキュメントにはFront Matterの`title`またはH1タイトル（# タイトル）が必要です。',
    );
  }

  const overviewMarkdown = overviewParts.join('\n\n');

  return {
    title: resolvedTitle,
    date:
      frontMatter.date ||
      new Date().toLocaleDateString('ja-JP', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }),
    update: frontMatter.update,
    overview: overviewMarkdown ? (marked.parse(overviewMarkdown) as string) : undefined,
    meta: frontMatter.raw,
    root,
  };
}
