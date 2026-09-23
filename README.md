# Tejun.ts

Markdownで書いた手順書を、**HTML** と **Excel（.xlsx）** の手順書に変換するCLIツールです。

- 手順書はMarkdownで書くので、Gitで差分管理ができます。
- HTMLは画像まで1ファイルに埋め込まれるので、そのまま配布できます。
- Excelは「チェック・実施日・実行者」の列付きで出力されるので、作業記録やエビデンスとして使えます。
- 出力の見た目は、HTML・Excelそれぞれのテンプレートで自由に変えられます。

## 必要な環境

- Node.js 22 以上

## インストール

```bash
npm install
npm run build
```

ビルド後は `node dist/index.js` で実行できます。`npm link` しておくと `tejun` コマンドとして使えます。

## 使い方

```bash
tejun <Markdownファイル> [オプション]
```

| オプション | 説明 | 既定値 |
| --- | --- | --- |
| `-f, --format <format>` | 出力形式。`html` / `excel` / `both` | `both` |
| `-o, --out <directory>` | 出力先ディレクトリ | `.`（カレントディレクトリ） |
| `-t, --template <file>` | テンプレートファイル（`.html` または `.xlsx`） | `templates/default.html` / `templates/default.xlsx` |

出力ファイル名は、入力ファイル名の拡張子を `.html` / `.xlsx` に変えたものになります。

```bash
# HTMLとExcelの両方を ./output に出力する
tejun ./procedure.md -o ./output

# 自作のExcelテンプレートを使ってExcelだけ出力する
tejun ./procedure.md -f excel -t ./my-template.xlsx -o ./output
```

`-f both` で `-t` を指定した場合、テンプレートは拡張子が合う形式にだけ使われ、もう一方の形式は既定のテンプレートで出力されます。

## 手順書の書き方

見出しのレベルで手順書の構造を表します。

```markdown
---
title: "Webアプリのデプロイ手順"
date: "2026/07/08"
update: "2026/07/10"
author: "山田"
---
# Webアプリのデプロイ手順

この手順書では、WARファイルをTomcatにデプロイする方法を説明します。

## ビルド

### WARファイルを作成する

1. プロジェクトを右クリックします。
2. **実行** > **Maven ビルド** を選択します。

> **期待値**
> `target` フォルダにWARファイルが生成されていること。
> ![ビルド結果](./images/build.png)

## デプロイ

### WARファイルを配置する

WARファイルを `webapps` フォルダにコピーします。

> コピーしたファイルが `webapps` フォルダにあること。
```

| 書き方 | 意味 |
| --- | --- |
| 先頭の `---` 〜 `---`（Front Matter） | 文書の情報。`title`（タイトル）、`date`（作成日）、`update`（更新日）のほか、`author` など好きな項目を `キー: 値` の形で書けます |
| `#`（H1） | 文書のタイトル。Front Matterに `title` があればそちらが優先されます |
| H1と最初の `##` の間の文章 | 概要文 |
| `##`（H2） | 大項目 |
| `###`（H3） | 手順（1つの `###` が1ステップ＝Excelの1行になります） |
| `###` の直後の文章・リスト・コード | 操作手順 |
| `###` の後の最初の引用（`>`） | 期待される結果。先頭の「期待値」「**期待値**」という行は見出しとして取り除かれます |

- タイトルは必須です。Front Matterの `title` もH1もない場合はエラーになります。
- `date` を省略すると、変換した日の日付が入ります。
- 画像は相対パスで書けます。パスはMarkdownファイルの場所が基準です。
  - HTMLでは、画像はData URIとしてファイルに埋め込まれます。
  - Excelでは、期待される結果の中の最初の画像が、そのステップの行に貼り付けられます。対応形式はPNG・JPEG・GIFです。

実際の例は [examples/](examples/) にあります。

## テンプレート

テンプレートの中に `{{変数名}}` と書くと、手順書の内容に置き換わります。変数はHTMLとExcelで共通です。

### 文書全体の変数

| 変数 | 内容 |
| --- | --- |
| `{{meta.title}}` | 文書のタイトル（Front Matterの `title`、なければH1） |
| `{{meta.date}}` | 作成日 |
| `{{meta.update}}` | 更新日（未指定なら空） |
| `{{meta.キー名}}` | Front Matterに書いた任意の項目（例: `{{meta.author}}`）。未指定なら空 |
| `{{h1.body}}` | 概要文のうち、最初の引用より前の部分 |
| `{{h1.blockquote}}` | 概要文の最初の引用 |

### 手順ごとの変数（ループの中で使う）

| 変数 | 内容 |
| --- | --- |
| `{{h2}}` | 大項目名 |
| `{{h2.index}}` | 大項目の連番（1から） |
| `{{h3}}` | 手順のタイトル |
| `{{h3.index}}` | 手順の連番（文書全体を通した連番。大項目ごとには戻りません） |
| `{{h3.body}}` | 操作手順 |
| `{{h3.blockquote}}` | 期待される結果 |
| `{{image.src}}` / `{{image.alt}}` | 期待される結果の中の最初の画像のパス / 代替テキスト |

### ループと条件分岐

```text
{{#each h2 steps}}          大項目ごとに繰り返す
  {{h2}}
  {{#each h3 steps}}        その大項目の手順ごとに繰り返す
    {{h2.index}}-{{h3.index}} {{h3}}
  {{/each}}
{{/each}}

{{#each steps}}...{{/each}}          全手順を大項目で分けずに繰り返す
{{#if meta.author}}作成者: {{meta.author}}{{/if}}   値が空でないときだけ出力する
```

`{{category}}` や `{{title}}` など、旧名称の変数も引き続き使えます。すべての変数と細かな仕様は [spec/spec.md](spec/spec.md) を参照してください。

### HTMLテンプレート

[templates/default.html](templates/default.html) を元に作るのが簡単です。

- `{{h3.body}}` / `{{h3.blockquote}}` / `{{h1.body}}` / `{{h1.blockquote}}` は、MarkdownをHTMLに変換した結果がそのまま入ります。
- それ以外の変数の値は、HTMLエスケープされて入ります。
- HTML専用の変数として、`${markdown}`（Markdown全文をHTMLにしたもの）と `${overview}`（概要文をHTMLにしたもの）があります。

### Excelテンプレート

[templates/default.xlsx](templates/default.xlsx) を元に作るのが簡単です。読み込まれるのは最初のシートだけです。

- **ステップ行:** どこかのセルに `{{#each steps}}`（または `{{#each h2 steps}}` / `{{#each h3 steps}}`）を書いた行が、手順の数だけ複製されます。書式（フォント・塗りつぶし・罫線・配置）も各行に引き継がれます。
- **それ以外の行:** タイトルや日付などの文書全体の変数を使えます。
- **セルの値:** HTMLタグを取り除いたテキストが入ります。番号付きリストには `1.` `2.` … の番号が付きます。
- **書式付きのセル:** セル内で一部だけフォントを変えた（リッチテキストの）セルでも、変数は置き換わります。ただし、変数を含むセルは置き換え後にセル全体が同じ書式になります。
- **ステップ行の高さ:**
  - テンプレートのステップ行に高さが設定されていれば、その高さで固定されます。
  - 設定されていなければ、Excelが内容に合わせて自動調整します（既定テンプレートはこちらです）。
  - Excelでテンプレートを編集して保存すると、行に高さが記録されて固定の高さになることがあります。
  - 画像を貼り付ける行は、常に固定の高さになります。

## 開発

```bash
npm run dev -- ./examples/20260708.md -o ./examples/output   # ビルドせずに実行
npm run test          # テスト
npm run lint          # ESLint
npm run format:check  # Prettierのチェック
```

| ディレクトリ | 内容 |
| --- | --- |
| `src/parser/` | Markdownの解析 |
| `src/template/` | テンプレート変数の置き換え |
| `src/generators/` | HTML・Excelの生成 |
| `src/commands/` | CLIコマンドの処理 |
| `templates/` | 既定のテンプレート |
| `examples/` | サンプルの手順書と出力例 |
| `spec/` | 仕様書 |
