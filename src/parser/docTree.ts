import type { DocNode, NodeSymbol } from './types';

/**
 * `node` の子孫から `symbol` の要素を文書順に集め、`node` の子からその要素までの経路として返す
 *
 * 見つかった要素のさらに内側にある同じ記号の要素は含めない（入れ子のリストは、
 * 外側の項目の子として別途たどる）。
 *
 * @param node 探索の起点（自身は含めない）
 * @param symbol 探す要素の記号
 * @returns 各要素について、`node` の子から要素自身までの配列
 */
export function findNodePaths(node: DocNode, symbol: NodeSymbol): DocNode[][] {
  const paths: DocNode[][] = [];
  for (const child of node.children) {
    if (child.symbol === symbol) {
      paths.push([child]);
    } else {
      for (const path of findNodePaths(child, symbol)) paths.push([child, ...path]);
    }
  }
  return paths;
}
