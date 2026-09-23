import { marked } from 'marked';
import type { Token } from 'marked';
import { ParseError } from '../utils/errors';
import type { FirstHeadings, ImageRef, ProcedureDocument, Step } from './types';

/** 画像参照にマッチする正規表現 */
const IMAGE_LINE_RE = /^!\[/;

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
 * blockquoteのrawテキストから期待値テキストと画像参照を抽出する
 *
 * ブロッククォートの生テキスト（`> ` プレフィックス付き）を受け取り、
 * - 「期待値」ヘッダー行を除去
 * - 画像行を除去（画像は別フィールドで管理）
 * - 残りをHTMLにレンダリング
 */
function processBlockquote(blockquoteToken: Extract<Token, { type: 'blockquote' }>): {
  expectedHtml: string;
  expectedInline: string | undefined;
  image: ImageRef | undefined;
} {
  const image = findFirstImage(blockquoteToken.tokens);

  // rawテキストから "> " プレフィックスを除去し、不要行を削除
  const innerLines = blockquoteToken.raw
    .split('\n')
    .map((line) => line.replace(/^>\s?/, ''))
    .filter((line) => !EXPECTED_HEADER_RE.test(line.trim()));

  const renderLines = (lines: string[]): string => {
    const markdown = lines.join('\n').trim();
    return markdown ? (marked.parse(markdown) as string) : '';
  };

  const expectedHtml = renderLines(innerLines.filter((line) => !IMAGE_LINE_RE.test(line.trim())));
  // 画像行を残したまま描画し、元の記述順を保つ
  const expectedInline = image ? renderLines(innerLines) : undefined;

  return { expectedHtml, expectedInline, image };
}

/**
 * Markdown文字列を解析し、手順書ドキュメントとして構造化して返す
 *
 * 記述ルール:
 * - 先頭のFront Matter (`---`...`---`) → `title` / `date` / `update` メタ情報
 * - H1 (`#`) → ドキュメントタイトル（Front Matterに`title`があればそちらを優先）
 * - 最初のH2より前に書かれたテキスト・コード・リスト → 概要文（overview）
 *   - 概要文のうち最初のblockquoteより前 → `h1Body`、最初のblockquote → `h1Blockquote`（H3と同じ分け方）
 * - H2 (`##`) → 大項目（category）
 * - H3 (`###`) → 手順タイトル（title）
 * - H3直後のテキスト・コード・リスト → 操作手順本文（instruction）
 * - H3直後のblockquote (`>`) → 期待される結果（expected）
 * - 文書全体で最初に登場したH1〜H6それぞれのテキストを`firstHeadings`として収集する
 *   （each構文外の`{{h1}}`〜`{{h6}}`用。`title`/`category`/`title`と異なりFront Matterやループ文脈を考慮しない生の値）
 *
 * @param content Markdownファイルの文字列
 * @returns 構造化された手順書ドキュメント
 * @throws ParseError Front Matterの`title`もH1タイトルも存在しない場合
 */
export function parseMarkdown(content: string): ProcedureDocument {
  const { frontMatter, body } = parseFrontMatter(content);
  const tokens = marked.lexer(body);

  let title = '';
  let currentCategory = '';
  const rawSteps: Array<Omit<Step, 'index'>> = [];

  // 文書全体で最初に登場した各見出しレベル（H1〜H6）のテキスト
  const firstHeadings: FirstHeadings = {};

  // 最初のH2より前のテキストを収集する（概要文）
  const overviewParts: string[] = [];
  let enteredSteps = false;
  // 概要文をH3と同じルールで分割する（最初のblockquoteより前 → h1.body、最初のblockquote → h1.blockquote）
  const h1BodyParts: string[] = [];
  let h1Blockquote: string | undefined;

  // 現在構築中のステップ状態
  let stepTitle = '';
  let instructionParts: string[] = [];
  let expectedHtml = '';
  let expectedInline: string | undefined;
  let image: ImageRef | undefined;
  let inStep = false;
  let expectedFound = false;

  /** 現在のステップを確定してrawStepsに追加する */
  function finalizeStep(): void {
    if (!inStep) return;
    const instructionMarkdown = instructionParts.join('\n\n');
    rawSteps.push({
      category: currentCategory,
      title: stepTitle,
      instruction: instructionMarkdown ? (marked.parse(instructionMarkdown) as string) : '',
      expected: expectedHtml,
      expectedInline,
      image,
    });
    stepTitle = '';
    instructionParts = [];
    expectedHtml = '';
    expectedInline = undefined;
    image = undefined;
    inStep = false;
    expectedFound = false;
  }

  for (const token of tokens) {
    if (token.type === 'heading') {
      const headingKey = `h${token.depth}` as keyof FirstHeadings;
      if (firstHeadings[headingKey] === undefined) {
        firstHeadings[headingKey] = token.text;
      }

      if (token.depth === 1) {
        title = token.text;
      } else if (token.depth === 2) {
        finalizeStep();
        currentCategory = token.text;
        enteredSteps = true;
      } else if (token.depth === 3) {
        finalizeStep();
        stepTitle = token.text;
        inStep = true;
        expectedFound = false;
        enteredSteps = true;
      }
      continue;
    }

    if (!enteredSteps) {
      if (token.type !== 'space') overviewParts.push(token.raw.trim());
      if (token.type === 'blockquote' && h1Blockquote === undefined) {
        const result = processBlockquote(token as Extract<Token, { type: 'blockquote' }>);
        h1Blockquote = result.expectedInline ?? result.expectedHtml;
      } else if (h1Blockquote === undefined && token.type !== 'space') {
        h1BodyParts.push(token.raw.trim());
      }
      continue;
    }

    if (!inStep) continue;

    if (token.type === 'blockquote' && !expectedFound) {
      // 型ガードでblockquoteトークンとして処理
      const bq = token as Extract<Token, { type: 'blockquote' }>;
      const result = processBlockquote(bq);
      expectedHtml = result.expectedHtml;
      expectedInline = result.expectedInline;
      image = result.image;
      expectedFound = true;
    } else if (!expectedFound && token.type !== 'space') {
      // blockquoteが来る前のテキスト・コード・リストは手順本文として収集
      instructionParts.push(token.raw.trim());
    }
  }

  finalizeStep();

  const resolvedTitle = frontMatter.title || title;
  if (!resolvedTitle) {
    throw new ParseError(
      'MarkdownドキュメントにはFront Matterの`title`またはH1タイトル（# タイトル）が必要です。',
    );
  }

  const steps: Step[] = rawSteps.map((s, i) => ({ ...s, index: i + 1 }));

  const overviewMarkdown = overviewParts.join('\n\n').trim();
  const h1BodyMarkdown = h1BodyParts.join('\n\n').trim();

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
    h1Body: h1BodyMarkdown ? (marked.parse(h1BodyMarkdown) as string) : undefined,
    h1Blockquote: h1Blockquote || undefined,
    firstHeadings,
    meta: frontMatter.raw,
    steps,
  };
}
