@echo off
rem ============================================================
rem  手順書（.md）を HTML と Excel に変換します。
rem
rem  ・ダブルクリック         … このフォルダの .md をすべて変換
rem  ・.md をドラッグ＆ドロップ … ドロップしたファイルだけ変換
rem
rem  変換結果は「output」フォルダに出力されます。
rem  必要な環境: Node.js 22 以上
rem ============================================================
setlocal
cd /d "%~dp0"

rem tejun を npm install -g 済みの場合は「set TEJUN=tejun」に変えると速くなります。
set TEJUN=npx --yes github:mittya6/Tejun.ts

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js が見つかりません。Node.js 22 以上をインストールしてください。
  echo https://nodejs.org/
  pause
  exit /b 1
)

if "%~1"=="" (
  call %TEJUN% "*.md" -o output
) else (
  call %TEJUN% %* -o output
)

if errorlevel 1 (
  echo.
  echo 変換に失敗しました。上のメッセージを確認してください。
) else (
  echo.
  echo 変換が完了しました。output フォルダを確認してください。
)
pause
