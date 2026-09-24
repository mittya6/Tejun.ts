import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdownParser';
import { findNodePaths } from './docTree';
import { ParseError } from '../utils/errors';
import type { DocNode, NodeSymbol } from './types';

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

/** `node` 配下の `symbol` の要素を文書順に返す */
function nodesOf(node: DocNode, symbol: NodeSymbol): DocNode[] {
  return findNodePaths(node, symbol).map((path) => path[path.length - 1]);
}

describe('parseMarkdown', () => {
  describe('見出しのツリー', () => {
    it('ルートは文書全体で、H1はその子になり、最初のH1がドキュメントタイトルになる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(doc.title).toBe('ユーザーログイン手順');
      expect(doc.root.symbol).toBe('root');
      expect(doc.root.children.map((n) => [n.symbol, n.content])).toEqual([
        ['#', 'ユーザーログイン手順'],
      ]);
    });

    it('H2がH1の子、H3がH2の子になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      const h2s = doc.root.children[0].children;
      expect(h2s.map((n) => [n.symbol, n.content])).toEqual([
        ['##', '1. ログイン画面へのアクセス'],
        ['##', '2. ログアウト'],
      ]);
      expect(nodesOf(h2s[0], '###').map((n) => n.content)).toEqual([
        '1.1 ブラウザの起動',
        '1.2 認証情報の入力',
      ]);
      expect(nodesOf(h2s[1], '###').map((n) => n.content)).toEqual(['2.1 ログアウト操作']);
    });

    it('見出しの連番は文書全体を通した同じレベルの連番になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(nodesOf(doc.root, '##').map((n) => n.index)).toEqual([1, 2]);
      expect(nodesOf(doc.root, '###').map((n) => n.index)).toEqual([1, 2, 3]);
    });

    it('H4〜H6も上位の見出しの子になる', () => {
      const doc = parseMarkdown(`# タイトル

### 見出し3
#### 見出し4
##### 見出し5
###### 見出し6
#### 見出し4-2
`);
      const [h3] = nodesOf(doc.root, '###');
      expect(h3.symbol).toBe('###');
      expect(h3.children.map((n) => n.content)).toEqual(['見出し4', '見出し4-2']);
      expect(h3.children[0].children[0].children[0].content).toBe('見出し6');
    });

    it('見出しの本文（body）は最初の引用より前の内容をHTML化したもの', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      const [step1, step2] = nodesOf(doc.root, '###');
      expect(step1.body).toContain('<code>https://example.com/login</code>');
      expect(step1.body).not.toContain('ログイン画面が正常に表示');
      expect(step2.body).toContain('<li>ID: <code>test_user</code></li>');
    });

    it('本文の無い見出しの body は空文字になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(nodesOf(doc.root, '##')[0].body).toBe('');
    });
  });

  describe('ブロック要素', () => {
    it('引用（>）は「期待値」ヘッダーを除いたHTMLになる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      const [quote] = nodesOf(nodesOf(doc.root, '###')[0], '>');
      expect(quote.content).toContain('ログイン画面が正常に表示');
      expect(quote.content).not.toContain('期待値');
    });

    it('箇条書き（- * +）の項目は - 、番号付きリストの項目は 1. になり、同じ親の中で連番が付く', () => {
      const doc = parseMarkdown(`# T

- ぶどう
- リンゴ

* オレンジ

1. 最初
2. 次
`);
      expect(doc.root.children[0].children.map((n) => [n.symbol, n.content, n.index])).toEqual([
        ['-', 'ぶどう', 1],
        ['-', 'リンゴ', 2],
        ['-', 'オレンジ', 3],
        ['1.', '最初', 1],
        ['1.', '次', 2],
      ]);
    });

    it('入れ子のリストの項目は外側の項目の子になる', () => {
      const doc = parseMarkdown(`# T

- 果物
  - ぶどう
  - リンゴ
`);
      const [fruit] = doc.root.children[0].children;
      expect(fruit.content).toBe('果物<ul>\n<li>ぶどう</li>\n<li>リンゴ</li>\n</ul>\n');
      expect(fruit.children.map((n) => n.content)).toEqual(['ぶどう', 'リンゴ']);
    });

    it('コードブロック（```）はHTML化され、リストの項目の中のものも子になる', () => {
      const doc = parseMarkdown(`# T

\`\`\`sh
ls
\`\`\`

1. 実行する
   \`\`\`text
   clean package
   \`\`\`
`);
      const [code, item] = doc.root.children[0].children;
      expect(code.symbol).toBe('```');
      expect(code.content).toBe('<pre><code class="language-sh">ls\n</code></pre>\n');
      expect(item.children[0].content).toContain('clean package');
    });
  });

  describe('概要文（overview）', () => {
    it('最初のH2以降の見出しより前のテキストがoverviewとして抽出される', () => {
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
    });

    it('概要文は見出しと同じルールでH1の body と最初の引用に分かれる', () => {
      const md = `# タイトル

概要の本文です。

> 補足です。

後続の文

## カテゴリ

### 手順1
本文
`;
      const doc = parseMarkdown(md);
      expect(doc.root.children[0].body).toBe('<p>概要の本文です。</p>\n');
      expect(nodesOf(doc.root, '>')[0].content).toBe('<p>補足です。</p>\n');
      expect(doc.overview).toContain('後続の文');
    });
  });

  describe('画像の抽出', () => {
    it('引用内の画像を image として抽出し、HTMLには元の位置のまま残す', () => {
      const md = `# テスト

## カテゴリ

### 手順1
操作内容

> **期待値**
> 期待される動作
> ![スクリーンショット](./images/screen.png)
`;
      const doc = parseMarkdown(md);
      const [quote] = nodesOf(doc.root, '>');
      expect(quote.image).toEqual({ src: './images/screen.png', alt: 'スクリーンショット' });
      expect(quote.content).toContain('<img src="./images/screen.png"');
    });

    it('画像の無い引用では image が undefined になる', () => {
      const doc = parseMarkdown(SAMPLE_MD);
      expect(nodesOf(doc.root, '>')[0].image).toBeUndefined();
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

    it('H1のみのMarkdownでもエラーにならず、H1の子要素0件で返る', () => {
      const md = `# タイトルのみ`;
      const doc = parseMarkdown(md);
      expect(doc.title).toBe('タイトルのみ');
      expect(doc.root.children[0].children).toHaveLength(0);
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
