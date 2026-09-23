/** ステップ内で参照される画像情報 */
export interface ImageRef {
  /** ファイルパスまたはData URI */
  src: string;
  /** 代替テキスト */
  alt: string;
}

/** Markdownから解析された1つの手順ステップ */
export interface Step {
  /** 1始まりの連番 */
  index: number;
  /** 大項目（H2見出し） */
  category: string;
  /** 手順タイトル（H3見出し） */
  title: string;
  /** 操作手順の本文（HTMLまたは生テキスト） */
  instruction: string;
  /** 期待される結果（HTMLまたは生テキスト） */
  expected: string;
  /** 画像を元の位置に含めた期待される結果のHTML（HTML出力用。画像が無ければ未設定） */
  expectedInline?: string;
  /** 期待値ブロック内で検出された画像（最初の1件） */
  image?: ImageRef;
}

/** 文書全体で最初に登場した各見出しレベル（H1〜H6）のテキスト。存在しないレベルはundefined */
export interface FirstHeadings {
  h1?: string;
  h2?: string;
  h3?: string;
  h4?: string;
  h5?: string;
  h6?: string;
}

/** 解析済みの手順書ドキュメント全体 */
export interface ProcedureDocument {
  /** ドキュメントタイトル（Front Matterの`title`またはH1見出し） */
  title: string;
  /** 作成日（Front Matterの`date`、未指定時は生成時の日付） */
  date: string;
  /** 更新日（Front Matterの`update`、未指定時はundefined） */
  update?: string;
  /** 最初のH2見出しより前に書かれた概要文をHTML化したもの（存在しない場合はundefined） */
  overview?: string;
  /** 概要文のうち最初のblockquoteより前の本文をHTML化したもの（`{{h1.body}}`用。存在しない場合はundefined） */
  h1Body?: string;
  /** 概要文の最初のblockquoteをHTML化したもの（`{{h1.blockquote}}`用。存在しない場合はundefined） */
  h1Blockquote?: string;
  /** 文書全体で最初に登場した各見出しレベル（H1〜H6）のテキスト（`{{h1}}`〜`{{h6}}`のeach構文外用途） */
  firstHeadings: FirstHeadings;
  /** Front Matterに書かれた全プロパティ（`title`/`date`/`update`も含む生の値。`{{meta.プロパティ名}}`用） */
  meta: Record<string, string>;
  /** 全ステップ一覧 */
  steps: Step[];
}

/** テンプレートエンジンに渡すコンテキスト */
export interface TemplateContext {
  document: {
    title: string;
  };
  date: string;
  update?: string;
  steps: Step[];
  /** 入力Markdown全文（Front Matter除く）をHTMLに変換したもの（`${markdown}`用、HTML出力時のみ使用） */
  markdown?: string;
  /** 最初のH2見出しより前の概要文をHTMLに変換したもの（`${overview}`用） */
  overview?: string;
  /** 概要文のうち最初のblockquoteより前の本文HTML（`{{h1.body}}`用） */
  h1Body?: string;
  /** 概要文の最初のblockquoteのHTML（`{{h1.blockquote}}`用） */
  h1Blockquote?: string;
  /** 文書全体で最初に登場した各見出しレベル（H1〜H6）のテキスト（each構文外の`{{h1}}`〜`{{h6}}`用） */
  firstHeadings?: FirstHeadings;
  /** Front Matterに書かれた全プロパティ（`{{meta.プロパティ名}}`用。`title`/`date`/`update`は専用フィールドを優先して参照する） */
  meta?: Record<string, string>;
}
