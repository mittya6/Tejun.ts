---
name: eslint
description: eslintを実行します。
---

## 実行方法

```
npm run lint
```

自動修正可能なものは `npm run lint:fix` で修正する。

## Cognitive Complexity の基準

- `eslint-plugin-sonarjs` の `sonarjs/cognitive-complexity` ルールで計測する（設定は `eslint.config.js`）。
- **1関数あたりの上限は 15**。超えた場合は `error` となる。
- 上限を超えた場合は、ルールを無効化（`eslint-disable`）したり閾値を上げたりせず、以下の方法でリファクタリングして解消すること。
  - 早期リターン（ガード節）でネストを浅くする
  - 意味のある単位で処理をヘルパー関数に切り出す
  - 複雑な条件式を名前付きの変数・関数に置き換える
- リファクタリング後は `npm test` でテストが通ることを確認する。
