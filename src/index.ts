#!/usr/bin/env node
import { Command } from 'commander';
import { runGenerate } from './commands/generate';
import { ParseError, GeneratorError, TemplateError } from './utils/errors';
import { expandInputFiles } from './utils/inputFiles';

/**
 * エラー内容を標準エラー出力に表示する
 *
 * @param err 捕捉したエラー
 */
function reportError(err: unknown): void {
  if (err instanceof ParseError || err instanceof GeneratorError || err instanceof TemplateError) {
    console.error(`\n❌  ${err.name}: ${err.message}\n`);
  } else {
    console.error('\n❌  予期しないエラーが発生しました:');
    console.error(err);
  }
}

const program = new Command();

program
  .name('tejun')
  .description('Tejun.ts — Markdownの手順書をHTML・Excelに自動変換するCLIツール')
  .version('1.0.0')
  .argument(
    '<files...>',
    '変換対象のMarkdownファイルパス（複数指定・ワイルドカード可。例: "docs/*.md"）',
  )
  .option(
    '-f, --format <format>',
    '出力形式: html | excel | both',
    (val: string) => {
      if (!['html', 'excel', 'both'].includes(val)) {
        console.error(`エラー: --format には html / excel / both のいずれかを指定してください。`);
        process.exit(1);
      }
      return val as 'html' | 'excel' | 'both';
    },
    'both',
  )
  .option('-o, --out <directory>', '出力先ディレクトリ', '.')
  .option('-t, --template <file>', 'カスタムテンプレートファイル（.html または .xlsx）')
  .option(
    '-n, --name <property>',
    '出力ファイル名に使うFront Matterのプロパティ（例: meta.filename）',
  )
  .action(
    async (
      fileArgs: string[],
      options: {
        format: 'html' | 'excel' | 'both';
        out: string;
        template?: string;
        name?: string;
      },
    ) => {
      let files: string[];
      try {
        files = await expandInputFiles(fileArgs);
      } catch (err) {
        reportError(err);
        process.exit(1);
      }

      // 1ファイルが失敗しても残りのファイルは変換を続ける
      const failed: string[] = [];
      for (const file of files) {
        try {
          await runGenerate(file, options);
        } catch (err) {
          reportError(err);
          failed.push(file);
        }
      }

      if (files.length > 1) {
        console.log(`📚  ${files.length}件中 ${files.length - failed.length}件を変換しました。`);
      }
      if (failed.length > 0) {
        console.error(`❌  変換に失敗したファイル:\n${failed.map((f) => `    ${f}`).join('\n')}\n`);
        process.exit(1);
      }
    },
  );

program.parse();
