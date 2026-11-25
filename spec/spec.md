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
| **出力フォーマット** | HTML5（CSS適用済みスタンドアロン）, Excel（`.xlsx`）, PDF |

---

## 3. 機能要件

| 章 | ドキュメント |
| --- | --- |
| 3.1. パーサー機能（Markdown解析） | [parser.md](parser.md) |
| 3.2. Excel出力機能（`.xlsx`） | [output-excel.md](output-excel.md) |
| 3.3. HTML出力機能（`.html`） | [output-html.md](output-html.md) |
| 3.3.1. PDF出力機能（`.pdf`） | [output-pdf.md](output-pdf.md) |
| 3.4. テンプレート変数・制御タグ（HTML/Excel共通） | [template-syntax.md](template-syntax.md) |

## 4. テンプレートの適用方法

`-t` / `--template` オプションと `-f` オプションの説明は [template-syntax.md](template-syntax.md#4-テンプレートの適用方法) を参照。

テンプレートの書き方の実例は [template_reference.md](template_reference.md) を参照。

---

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

