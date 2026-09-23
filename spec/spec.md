# Tejun.ts プロダクト仕様書 (Draft v1.0)

## 1. プロダクト概要

**Tejun.ts**は、エンジニアやオペレーターが記述したMarkdown形式のテキストファイル（`.md`）を解析し、視認性の高い「HTML形式」および、チェックリストやエビデンス記録として使いやすい「Excel形式（`.xlsx`）」の手順書・テスト仕様書へ自動変換するCLI（コマンドライン）ツールです。

**解決する課題:**

* 手順書の作成・メンテをExcelで行うとバージョン管理（Gitなど）が困難。
* Markdownで書かれたドキュメントを、非エンジニア向けに配布しづらい。
* 実行記録用のチェックリスト作成に手間がかかる。

---

## 2. システム要件

| 項目 | 仕様 |
| --- | --- |
| **提供形態** | CLIアプリケーション（コマンドラインツール） |
| **想定実行環境** | Windows, macOS, Linux |
| **開発言語** | Node.js　V22 (TypeScript)  |
| **入力フォーマット** | Markdown（CommonMark準拠 ＋ Tejun.ts独自拡張） |
| **出力フォーマット** | HTML5（CSS適用済みスタンドアロン）, Excel（`.xlsx`） |

---

## 3. 機能要件

### 3.1. パーサー機能（Markdown解析）

* 標準的なMarkdown（見出し、箇条書き、太字、リンク、画像、表）を解析する。
* 以下のようなメタ情報をmarkdownに埋め込むことができる。
```
---
title: "Front Matterについて"
date: "2024/09/20"
update: "2024/09/23"
---
```
* HTMLの場合、画像はURIスキーム化させて埋め込む。


### 3.2. Excel出力機能（`.xlsx`）

* 解析したデータから、手順書・テスト仕様書フォーマットのExcelを生成する。
* **カラム構成（デフォルト）:** `項番` | `大項目` | `操作手順` | `期待される結果` | `チェック` | `実施日` | `実行者`
* ローカルの画像ファイルパス（例: `![img](./sample.png)`）を読み込み、Excelのセル内に画像を自動貼付する。
* 印刷設定（A4横、全列を1ページに印刷等）を自動で適用する。

### 3.3. HTML出力機能（`.html`）

* ブラウザで閲覧しやすいモダンなデザインのHTMLを生成する。
* CSS/JavaScriptをインライン化し、1つのHTMLファイルとして出力する（ポータビリティの向上）。画像はData URIスキームで埋め込む。
* ダークモード/ライトモードの切り替え機能、チェックボックスのクリック連動（進捗バー表示など）をサポートする。
* HTMLテンプレート内に `${markdown}` と記述すると、入力Markdown全文（Front Matterを除く）をHTMLに変換したテキストがその位置に埋め込まれる。
* HTMLテンプレート内に `${title}` / `${date}` / `${update}` と記述すると、Front Matterの`title` / `date` / `update`の値がその位置に埋め込まれる（`update`未指定時は空文字）。同じ値は `{{meta.title}}` / `{{meta.date}}` / `{{meta.update}}`（Front Matterのキー名がそのまま分かる書き方。HTML/Excel共通）でも埋め込める。
* `{{meta.プロパティ名}}` は`title`/`date`/`update`に限らず、Front Matterに書かれた**任意のプロパティ**をそのキー名で参照できる汎用構文（HTML/Excel共通）。例えばFront Matterに`author: "..."`と書けば`{{meta.author}}`で埋め込める。存在しないプロパティを参照した場合は空文字になる（Front Matterで認識されるプロパティ数の制限は無くなった）。
* **each構文の外側**に書かれた `{{h1}}`〜`{{h6}}` は、`{{meta.title}}`（Front Matter優先）とは異なり、文書全体で最初に登場したそのレベルの見出し（`#`〜`######`）のテキストにそのまま置換される（該当する見出しが無ければ空文字。HTML/Excel共通）。ループ内側の`{{h2}}`/`{{h3}}`（大項目/手順タイトルのループ変数）はループ処理が先に解決するため、この規則の影響を受けない。
* HTMLテンプレート内に `${overview}` と記述すると、最初のH2見出しより前に書かれた概要文をHTMLに変換したテキストがその位置に埋め込まれる。概要文はH3と同じルールで分けて参照することもでき、最初のblockquoteより前の本文を `{{h1.body}}`、最初のblockquoteを `{{h1.blockquote}}` で埋め込める（HTMLでは常に生HTML、Excelではタグを除去したテキスト）。
* `{{#if 変数名}}...{{/if}}` と書くと、その変数の値が空でない場合だけ中身を出力する（HTML/Excel共通。Excelはセル内で完結させる）。変数名には `{{h1}}` / `{{h1.body}}` / `{{h1.blockquote}}` / `{{h2}}` / `{{h3.body}}` / `{{h3.blockquote}}` / `{{image.src}}` / `{{meta.author}}` など、テンプレートで使える変数をそのまま書ける。ループの内側では現在のステップ（`{{#each h2 steps}}`の内側では現在の大項目）の値、外側では文書全体の値で判定する。入れ子にでき、`{{#if}}`と`{{/if}}`の対応が取れない場合はエラーになる。従来の`{{#if image}}` / `{{#if overview}}`は廃止した（`{{#if image.src}}` / `{{#if h1.body}}`などで代替する）。
* テンプレート変数は、どのMarkdown記法に対応するか分かるよう `{{h1}}`（ドキュメントタイトル）/ `{{h2}}`（大項目）/ `{{h3}}`（手順タイトル）/ `{{blockquote}}`（期待される結果、H3ごとに繰り返されることを明示した`{{h3.blockquote}}`という書き方も可）/ `{{procedure}}`（操作手順本文、H3ごとに繰り返されることを明示した`{{h3.body}}`という書き方も可）/ `{{h3.index}}`（H3ごとに繰り返される連番）という別名でも記述できる（HTML/Excel共通。`${h1}`もHTML側で使用可）。`{{document.title}}` / `{{category}}` / `{{title}}` / `{{expected}}` / `{{instruction}}` / `{{index}}` という従来の名称も引き続き利用できる。`{{h3.index}}` / `{{h3.body}}` / `{{h3.blockquote}}` は `{{image.src}}` と同じドット区切りの表記で、旧来の`{{h3_index}}` / `{{h3_procedure}}` / `{{h3_blockquote}}`というアンダースコア区切りの表記や、`{{h3.body}}`の旧名`{{h3.procedure}}`も引き続き利用できる。
* HTML出力において `{{procedure}}` / `{{blockquote}}`（`{{h3.body}}` / `{{h3.blockquote}}`を含む）は、常にMarkdownをHTML変換した結果を生HTML（エスケープなし）として埋め込む特別な変数で、三重括弧で書いても同じ結果になる（従来名`{{instruction}}` / `{{expected}}`は二重括弧＝エスケープあり、三重括弧＝生HTMLという通常のルールのまま）。
* HTMLテンプレート内のステップループは、`{{#each steps}}...{{/each}}`（`{{#each h3 steps}}`と同義）で全ステップをフラットに展開するほか、`{{#each h2 steps}}...{{/each}}` で大項目（H2）ごとにグループ化して展開できる。グループ化ループの内側では `{{h2}}` がそのグループの大項目名、`{{h2.index}}`（`{{h2_index}}`と同義）が大項目の1始まり連番になり、さらに `{{#each h3 steps}}...{{/each}}` をネストするとそのグループに属するステップだけをループできる（`{{h2.index}}`はネストした内側でも参照可能）。Excel出力は1ステップ＝1行のまま行分割は従来通りフラットで、ステップ行の`{{#each h2 steps}}`は`{{#each steps}}`と同様にステップ行の目印として扱われ、`{{h2.index}}`はそのステップが属する大項目の1始まり連番に置換される。なお `{{h3.index}}`（＝`{{index}}`）はグループ内で1から数え直すのではなく、常にドキュメント全体を通した連番のままである点に注意。

---


## 4. テンプレートの適用方法

作成したテンプレートは、Tejun.ts実行時に `-t` または `--template` オプションで指定します。

```bash
# Excelテンプレートを指定する場合
$ npx Tejun ./procedure.md -f excel -t ./my-excel-template.xlsx

# HTMLテンプレートを指定する場合
$ npx Tejun ./procedure.md -f html -t ./my-html-template.html


# 開発環境で実施する場合
$ npx ts-node src/index.ts ./examples/20260708.md -f html -t ./templates/default.html -o ./examples/output

$ npx ts-node src/index.ts ./examples/20260708.md -f excel -t ./templates/default.xlsx -o ./examples/output

```
- f：フォーマットを指定します。excelかhtmlになります。
- t：テンプレートを指定します。無指定の場合、デフォルトのテンプレートファイルを読み込みます。


# ビルド・実行・テストコマンド
Claude Codeが自律的にタスクの実行・検証・修正を行えるよう、主要なコマンドを定義します。

* **依存関係のインストール**: `npm install`
* **開発モードでの実行**: `npm run dev`
* **プロダクションビルド**: `npm run build`
* **静的解析 (Lintチェック)**: `npm run lint`
* **コード整形チェック**: `npm run format:check`
* **コード整形実行**: `npm run format`
* **単体テストの実行 (一括)**: `npm run test`
* **単体テストの実行 (ウォッチモード)**: `npm run test:watch`
* **テストカバレッジの確認**: `npm run test:coverage`


