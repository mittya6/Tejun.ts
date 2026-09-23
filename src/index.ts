#!/usr/bin/env node
import { Command } from 'commander';
import { runGenerate } from './commands/generate';
import { ParseError, GeneratorError, TemplateError } from './utils/errors';

const program = new Command();

program
  .name('tejun')
  .description('Tejun.ts — Markdownの手順書をHTML・Excelに自動変換するCLIツール')
  .version('1.0.0')
  .argument('<file>', '変換対象のMarkdownファイルパス')
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
  .action(
    async (
      file: string,
      options: { format: 'html' | 'excel' | 'both'; out: string; template?: string },
    ) => {
      try {
        await runGenerate(file, options);
      } catch (err) {
        if (
          err instanceof ParseError ||
          err instanceof GeneratorError ||
          err instanceof TemplateError
        ) {
          console.error(`\n❌  ${err.name}: ${err.message}\n`);
        } else {
          console.error('\n❌  予期しないエラーが発生しました:');
          console.error(err);
        }
        process.exit(1);
      }
    },
  );

program.parse();
