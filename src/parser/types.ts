/** 引用内で参照される画像情報 */
export interface ImageRef {
  /** ファイルパスまたはData URI */
  src: string;
  /** 代替テキスト */
  alt: string;
}

/** 見出しを表すMarkdownの文頭記号 */
export type HeadingSymbol = '#' | '##' | '###' | '####' | '#####' | '######';

/**
 * テンプレートで参照できるMarkdownのブロック要素を、文頭に書く記号で表したもの
 *
 * - `#`〜`######`: 見出し
 * - `>`: 引用
 * - `-`: 箇条書きの項目（Markdownの `*` / `+` も含む）
 * - `1.`: 番号付きリストの項目
 * - ```` ``` ````: コードブロック
 */
export type NodeSymbol = HeadingSymbol | '>' | '-' | '1.' | '```';

/**
 * Markdownを解析したツリーの1要素
 *
 * ルート（記号 `root`）は文書全体を表し、見出しは次に同じか上位の見出しが現れるまでの内容を子に持つ。
 * 引用・リスト項目は、その中の引用・リスト項目・コードブロックを子に持つ。
 */
export interface DocNode {
  /** 要素の記号。文書全体を表すルートだけは `root` */
  symbol: NodeSymbol | 'root';
  /** 見出しは見出しテキスト（プレーンテキスト）、それ以外は要素の内容をHTML化したもの */
  content: string;
  /** 見出しとルートのみ: 直下の最初の引用より前に書かれた本文のHTML */
  body?: string;
  /**
   * 1始まりの連番。見出しは文書全体を通した同じレベルの見出しの連番、
   * それ以外は同じ親の中での同じ種類の要素の連番
   */
  index: number;
  /** 引用のみ: 引用内で最初に見つかった画像 */
  image?: ImageRef;
  /** 子要素（文書順） */
  children: DocNode[];
}

/** 解析済みの手順書ドキュメント全体 */
export interface ProcedureDocument {
  /** ドキュメントタイトル（Front Matterの`title`またはH1見出し） */
  title: string;
  /** 作成日（Front Matterの`date`、未指定時は生成時の日付） */
  date: string;
  /** 更新日（Front Matterの`update`、未指定時はundefined） */
  update?: string;
  /** 最初のH2以降の見出しより前に書かれた概要文をHTML化したもの（存在しない場合はundefined） */
  overview?: string;
  /** Front Matterに書かれた全プロパティ（`title`/`date`/`update`も含む生の値。`{{meta.プロパティ名}}`用） */
  meta: Record<string, string>;
  /** 文書のツリー（ルートは文書全体。H1〜H6はその下の要素） */
  root: DocNode;
}

/** テンプレートエンジンに渡すコンテキスト */
export interface TemplateContext {
  /** ドキュメントタイトル（Front Matterの`title`優先） */
  title: string;
  date: string;
  update?: string;
  /** Front Matterに書かれた全プロパティ（`{{meta.プロパティ名}}`用。`title`/`date`/`update`は専用フィールドを優先して参照する） */
  meta: Record<string, string>;
  /** 文書のツリー */
  root: DocNode;
  /** 入力Markdown全文（Front Matter除く）をHTMLに変換したもの（`${markdown}`用、HTML出力時のみ使用） */
  markdown?: string;
  /** 概要文をHTMLに変換したもの（`${overview}`用、HTML出力時のみ使用） */
  overview?: string;
}
