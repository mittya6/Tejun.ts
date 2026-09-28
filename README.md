# Tejun.ts

![Tejun.ts](./logo/logo.png "Tejun.ts")

**Markdownで書いて、HTMLとExcelで配る。**

Tejun.ts は、Markdownで書いた手順書を **HTML** と **Excel（.xlsx）** の手順書に変換するツールです。

## こんなこと、ありませんか？

- Excelの手順書で、セルの結合や行の高さ・画像の位置合わせに時間を取られる
- 手順書を直したのに、どこを変えたのか後から分からない
- 「読む用」と「作業記録用」で、同じ手順書を2回作っている

Tejun.ts なら、手順書は **ただのテキスト（Markdown）** として書くだけです。見た目を整えるのはツールの仕事です。

## Tejun.ts でできること

- **書くのはテキストだけ**
  見出し・番号付きリスト・引用など、基本的なMarkdownだけで手順書が書けます。レイアウトに悩む時間はなくなります。
- **HTMLは1ファイルで配れる**
  画像まで1つのHTMLファイルに埋め込まれます。メールやチャットで送れば、ブラウザでそのまま読めます。目次も付きます。
- **Excelは作業記録にそのまま使える**
  「チェック・実施日・実行者」の列付きで出力されます。期待される結果の画像も、該当する手順の行に貼り付けられます。作業のエビデンスとしてそのまま残せます。
- **変更履歴が追える**
  中身はテキストなので、Gitで差分を管理できます。「いつ・誰が・どこを直したか」が一目で分かります。
- **見た目は自由に変えられる**
  HTML・Excelそれぞれのテンプレートを差し替えれば、社内の書式に合わせられます。

## Get Started（5分で体験）

スターターキットを使えば、コマンドを覚えなくても始められます。

### 1. Node.js をインストールする

[Node.js](https://nodejs.org/) の **22 以上** をインストールします（インストール済みなら不要です）。

### 2. スターターキットをダウンロードする

[starter-kit.zip](https://github.com/mittya6/Tejun.ts/releases/latest/download/starter-kit.zip) をダウンロードして、好きな場所に展開します。中身は次のとおりです。

```text
starter-kit/
├─ 手順書サンプル.md   … 書き方の説明コメント付きのサンプル
├─ images/             … 画像の置き場所
├─ 変換.bat            … ダブルクリックで変換
└─ 出力例/             … サンプルを変換したHTML・Excel
```

先に `出力例/` のHTMLとExcelを開いてみると、完成形のイメージがつかめます。

### 3. 変換.bat をダブルクリックする

フォルダ内の `.md` ファイルがすべて変換され、`output/` フォルダにHTMLとExcelができます。

> [!NOTE]
> 初回はツールのダウンロードがあるため、少し時間がかかります。

特定のファイルだけ変換したいときは、`.md` ファイルを `変換.bat` にドラッグ＆ドロップします。

### 4. 自分の手順書を書く

`手順書サンプル.md` をコピーして、中身を書き換えます。書き方はファイル内のコメントで説明しています。書き終わったら、もう一度 `変換.bat` をダブルクリックします。

**コピーして、書き換えて、ダブルクリック。** これだけです。

## 手順書の書き方

見出しのレベルで手順書の構造を表します。

````markdown
---
title: "共有フォルダをネットワークドライブに割り当てる手順"
date: "2026/09/28"
update: "2026/09/28"
author: "山田"
---

この手順書では、社内の共有フォルダを Z ドライブとして使えるようにする方法を説明します。

# ネットワークドライブの割り当て

## ドライブを割り当てる

1. コマンドプロンプトで次のコマンドを入力し、**Enter** キーを押します。
   ```
   net use Z: \\fileserver\share /persistent:yes
   ```

> **期待値**
> 「コマンドは正常に終了しました。」と表示されること。

## エクスプローラーで確認する

1. エクスプローラーを開き、**Z:** ドライブをダブルクリックします。

> **期待値**
> 共有フォルダの中身が表示されること。
> ![エクスプローラーの画面](./images/sample.png)
````

| 書き方 | 意味 |
| --- | --- |
| 先頭の `---` 〜 `---`（Front Matter） | 文書の情報。`title`（タイトル）、`date`（作成日）、`update`（更新日）のほか、`author` など好きな項目を `キー: 値` の形で書けます |
| 最初の `#` より前の文章 | 前書き（概要） |
| `#`（H1） | 大項目 |
| `##`（H2） | 手順（1つの `##` が1ステップ＝Excelの1行になります） |
| `##` の直後の文章・リスト・コード | 操作手順 |
| `##` の後の最初の引用（`>`） | 期待される結果。先頭の「期待値」「**期待値**」という行は見出しとして取り除かれます |

- タイトルは必須です。Front Matterの `title` を書いてください（`title` がない場合は、最初のH1がタイトルになります）。
- `date` を省略すると、変換した日の日付が入ります。
- 画像は相対パスで書けます。パスはMarkdownファイルの場所が基準です。
  - HTMLでは、画像はData URIとしてファイルに埋め込まれます。
  - Excelでは、期待される結果の中の最初の画像が、そのステップの行に貼り付けられます。対応形式はPNG・JPEG・GIFです。

実際の例は [starter-kit/](starter-kit/) と [examples/](examples/) にあります。

## もっと使いこなす

### コマンドで使う

スターターキットの `変換.bat` の中身は、`tejun` コマンドの呼び出しです。コマンドを直接使うと、出力形式やテンプレートを細かく指定できます。

#### インストール

使いたいプロジェクトで次のコマンドを実行します。インストール時に自動でビルドされます。

```bash
npm install git+https://github.com/mittya6/Tejun.ts.git
npx tejun ./procedure.md -o ./output
```

インストールせずに1回だけ使うこともできます。

```bash
npx github:mittya6/Tejun.ts ./procedure.md -o ./output
```

ソースから使う場合は、次のようにします。`npm install` のときにビルドも行われるので、`node dist/index.js` で実行できます。`npm link` しておくと `tejun` コマンドとして使えます。

```bash
git clone https://github.com/mittya6/Tejun.ts.git
cd Tejun.ts
npm install
```

#### 使い方

```bash
tejun <Markdownファイル...> [オプション]
```

| オプション | 説明 | 既定値 |
| --- | --- | --- |
| `-f, --format <format>` | 出力形式。`html` / `excel` / `both` | `both` |
| `-o, --out <directory>` | 出力先ディレクトリ | `.`（カレントディレクトリ） |
| `-t, --template <file\|name>` | テンプレートファイル（`.html` または `.xlsx`）、またはプリセット名（例: `simple`） | `templates/default.html` / `templates/default.xlsx` |
| `-n, --name <property>` | 出力ファイル名に使うFront Matterのプロパティ（例: `meta.filename`） | なし（入力ファイル名を使用） |

```bash
# HTMLとExcelの両方を ./output に出力する
tejun ./procedure.md -o ./output

# プリセット「simple」のテンプレート（templates/simple.html・templates/simple.xlsx）で出力する
tejun ./procedure.md -t simple

# 自作のExcelテンプレートを使ってExcelだけ出力する
tejun ./procedure.md -f excel -t ./my-template.xlsx -o ./output

# Front Matterの filename の値を出力ファイル名にする
tejun ./procedure.md -n meta.filename

# docs 配下（サブフォルダも含む）のMarkdownをまとめて変換する
tejun "docs/**/*.md" -o ./output
```

- **複数ファイル・ワイルドカード:** Markdownファイルは複数指定でき、ワイルドカード（`*` / `**` / `?` / `[]` / `{}`）も使えます。ワイルドカードはツール側で展開するので、PowerShellやコマンドプロンプトでも使えます。bashなどでクォートせずに書いた場合は、シェルが展開したファイル一覧がそのまま渡されます。どちらの書き方でも結果は同じです。
  - 一致したファイルのうち、`.md` / `.markdown` だけが変換対象です。
  - `node_modules` フォルダの中は、パターンに `node_modules` を明示しない限り探索しません。
  - 1つも一致しない場合はエラーになります。
  - 途中のファイルで変換に失敗しても、残りのファイルの変換は続けます。最後に失敗したファイルを表示し、終了コード1で終わります。
- **出力ファイル名:** 入力ファイル名の拡張子を `.html` / `.xlsx` に変えたものになります。`-n meta.filename` と指定すると、Front Matterの `filename` の値に拡張子を付けたものになります（例: `filename: サーバー構築手順_v1`）。指定したプロパティが未定義・空の場合や、ファイル名に使えない文字（`/ \ : * ? " < > |`）を含む場合はエラーになります。
- **テンプレートの指定:**
  - `-f both` で `-t` を指定した場合、テンプレートは拡張子が合う形式にだけ使われます。もう一方の形式は既定のテンプレートで出力されます。
  - `-t` の値に拡張子もパス区切り（`/` `\`）もない場合は、プリセット名として扱います。プリセットはツールの `templates/` フォルダにある `<名前>.html` / `<名前>.xlsx` で、HTML・Excelの両方にそれぞれのファイルが使われます。出力する形式のファイルがプリセットにない場合はエラーになります。

### テンプレートで見た目を変える

HTML・Excelの見た目は、テンプレートを自作して変えられます。[templates/default.html](templates/default.html) / [templates/default.xlsx](templates/default.xlsx) をコピーして編集し、`-t` で指定します。

```bash
tejun ./procedure.md -t ./my-template.xlsx
```

テンプレートの書き方は [テンプレートリファレンス](spec/template_reference.md) を参照してください。

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
| `starter-kit/` | 配布用のスターターキット |
| `spec/` | 仕様書 |
