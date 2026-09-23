import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdownParser';
import { ParseError } from '../utils/errors';

const SAMPLE_MD = `
# ユーザーログイン手順

## 1. ログイン画面へのアクセス

### 1.1 ブラウザの起動
Google Chromeを起動し、以下のURLにアクセスする。
\`https://example.com/login\`

> **期待値**
> ログイン画面が正常に表示され、IDとパスワードの入力フォームが存在すること。

### 1.2 認証情報の入力
以下のテストアカウント情報を入力し、「ログイン」ボタンをクリックする。
* ID: \`test_user\`
* PASS: \`password123\`

> **期待値**
> ダッシュボード画面へ遷移し、右上に「ようこそ test_user」と表示されること。

## 2. ログアウト

### 2.1 ログアウト操作
画面右上のユーザー名をクリックし、「ログアウト」を選択する。

> **期待値**
> ログイン画面へ遷移すること。
`;

describe('parseMarkdown', () => {
  describe('正常系', () => {
    it('ドキュメントタイトル（H1）を正しく解析する', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.title).toBe('ユーザーログイン手順');
    });

    it('ステップ数を正しく解析する', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps).toHaveLength(3);
    });

    it('各ステップに1始まりの連番が付与される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps[0].index).toBe(1);
      expect(doc.steps[1].index).toBe(2);
      expect(doc.steps[2].index).toBe(3);
    });

    it('大項目（H2）が各ステップに正しく設定される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps[0].category).toBe('1. ログイン画面へのアクセス');
      expect(doc.steps[1].category).toBe('1. ログイン画面へのアクセス');
      expect(doc.steps[2].category).toBe('2. ログアウト');
    });

    it('手順タイトル（H3）が正しく設定される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps[0].title).toBe('1.1 ブラウザの起動');
      expect(doc.steps[1].title).toBe('1.2 認証情報の入力');
    });

    it('操作手順本文がHTMLとして生成される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      // コード要素が含まれていること
      expect(doc.steps[0].instruction).toContain('<code>');
      expect(doc.steps[0].instruction).toContain('https://example.com/login');
    });

    it('期待値がHTMLとして生成される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps[0].expected).toContain('ログイン画面が正常に表示');
      // 「期待値」ヘッダーが除去されていること
      expect(doc.steps[0].expected).not.toContain('期待値');
    });

    it('生成日が設定される', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.date).toBeTruthy();
      expect(typeof doc.date).toBe('string');
    });
  });

  describe('firstHeadings（文書全体で最初に登場した各見出しレベル）', () => {
    it('H1〜H3それぞれ最初の1件だけを記録し、2件目以降は無視する', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.firstHeadings.h1).toBe('ユーザーログイン手順');
      expect(doc.firstHeadings.h2).toBe('1. ログイン画面へのアクセス');
      expect(doc.firstHeadings.h3).toBe('1.1 ブラウザの起動');
    });

    it('登場しない見出しレベル（H4〜H6）はundefinedになる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.firstHeadings.h4).toBeUndefined();
      expect(doc.firstHeadings.h5).toBeUndefined();
      expect(doc.firstHeadings.h6).toBeUndefined();
    });

    it('H4〜H6が実際に含まれる場合はそれぞれ記録される', () => {
      const md = `# タイトル

#### 見出し4
##### 見出し5
###### 見出し6
`;
      const doc = parseMarkdown(md);
      expect(doc.firstHeadings.h4).toBe('見出し4');
      expect(doc.firstHeadings.h5).toBe('見出し5');
      expect(doc.firstHeadings.h6).toBe('見出し6');
    });
  });

  describe('概要文（overview）', () => {
    it('最初のH2より前のテキストがoverviewとして抽出される', () => {
      const md = `---
title: "テスト"
---

これは概要文です。

## カテゴリ

### 手順1
本文

> **期待値**
> 結果
`;
      const doc = parseMarkdown(md);
      expect(doc.overview).toContain('これは概要文です。');
    });

    it('概要文がない場合はundefinedになる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.overview).toBeUndefined();
      expect(doc.h1Body).toBeUndefined();
      expect(doc.h1Blockquote).toBeUndefined();
    });

    it('概要文はH3と同じルールで h1Body（最初のblockquoteより前）と h1Blockquote（最初のblockquote）に分かれる', () => {
      const md = `# タイトル

概要の本文です。

> 補足です。

後続の文

## カテゴリ

### 手順1
本文
`;
      const doc = parseMarkdown(md);
      expect(doc.h1Body).toBe('<p>概要の本文です。</p>\n');
      expect(doc.h1Blockquote).toBe('<p>補足です。</p>\n');
      expect(doc.overview).toContain('後続の文');
    });
  });

  describe('画像の抽出', () => {
    it('blockquote内の画像を image フィールドとして抽出する', () => {
      const md = `# テスト

## カテゴリ

### 手順1
操作内容

> **期待値**
> 期待される動作
> ![スクリーンショット](./images/screen.png)
`;
      const doc = parseMarkdown(md);
      expect(doc.steps[0].image).toBeDefined();
      expect(doc.steps[0].image?.src).toBe('./images/screen.png');
      expect(doc.steps[0].image?.alt).toBe('スクリーンショット');
    });

    it('画像のないステップでは image が undefined になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.steps[0].image).toBeUndefined();
    });

    it('期待値内の画像URLが expected HTML から除去される', () => {
      const md = `# テスト

## カテゴリ

### 手順1
操作内容

> **期待値**
> 期待テキスト
> ![img](./img.png)
`;
      const doc = parseMarkdown(md);
      // expected に img タグが混入しないこと（画像は image フィールドで管理）
      expect(doc.steps[0].expected).not.toContain('./img.png');
    });
  });

  describe('異常系', () => {
    it('H1タイトルがない場合は ParseError をスローする', () => {
      const md = `## カテゴリ\n### 手順\n本文`;
      expect(() => parseMarkdown(md)).toThrow(ParseError);
    });

    it('空文字でも ParseError をスローする', () => {
      expect(() => parseMarkdown('')).toThrow(ParseError);
    });

    it('H1のみのMarkdownでもエラーにならず、ステップ数0で返る', () => {
      const md = `# タイトルのみ`;
      const doc = parseMarkdown(md);
      expect(doc.title).toBe('タイトルのみ');
      expect(doc.steps).toHaveLength(0);
    });
  });

  describe('Front Matter', () => {
    it('title / date / update を解析し、H1より優先される', () => {
      const md = `---
title: "Front Matterについて"
date: "2024/09/20"
update: "2024/09/23"
---

# 本文中のH1タイトル

## カテゴリ

### 手順1
本文

> **期待値**
> 結果
`;
      const doc = parseMarkdown(md);
      expect(doc.title).toBe('Front Matterについて');
      expect(doc.date).toBe('2024/09/20');
      expect(doc.update).toBe('2024/09/23');
    });

    it('Front Matterにtitleが無い場合はH1にフォールバックする', () => {
      const md = `---
date: "2024/09/20"
---

# H1タイトル

## カテゴリ

### 手順1
本文

> **期待値**
> 結果
`;
      const doc = parseMarkdown(md);
      expect(doc.title).toBe('H1タイトル');
      expect(doc.date).toBe('2024/09/20');
    });

    it('Front Matterが無い場合は date が自動生成され update は undefined になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.date).toBeTruthy();
      expect(doc.update).toBeUndefined();
    });

    it('Front MatterもH1も無い場合は ParseError をスローする', () => {
      const md = `---
date: "2024/09/20"
---

## カテゴリ
### 手順
本文
`;
      expect(() => parseMarkdown(md)).toThrow(ParseError);
    });

    it('title/date/update以外の任意のプロパティも meta に格納される（{{meta.プロパティ名}}用）', () => {
      const md = `---
title: "テスト"
overview: "オーバービューです。"
author: "Yasu"
---

## カテゴリ
### 手順1
本文

> **期待値**
> 結果
`;
      const doc = parseMarkdown(md);
      expect(doc.meta.overview).toBe('オーバービューです。');
      expect(doc.meta.author).toBe('Yasu');
      expect(doc.meta.title).toBe('テスト');
    });

    it('Front Matterが無い場合 meta は空オブジェクトになる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.meta).toEqual({});
    });
  });
});
