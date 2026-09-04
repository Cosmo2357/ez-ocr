# ez-ocr

画像から文字を読み取ってコピペできる、シンプルなデスクトップ OCR アプリです。  
Windows / Mac 対応。日本語と英語に対応し、オフラインで動きます。

## ダウンロード

[Releases ページ](https://github.com/Cosmo2357/ez-ocr/releases/latest) から自分の OS 用のファイルをダウンロードしてください。

| OS | ファイル |
| --- | --- |
| Windows | `ez-ocr_x.x.x_x64-setup.exe` |
| Mac (Apple Silicon / Intel 共通) | `ez-ocr_x.x.x_universal.dmg` |

### 初回起動時の警告について

このアプリは開発者証明書で署名していないため、初回だけ OS の警告が出ます。

- **Windows**: 「Windows によって PC が保護されました」→「詳細情報」→「実行」
- **Mac**: 「開発元を検証できません」と出たら、システム設定 → プライバシーとセキュリティ → 一番下の「このまま開く」。  
  それでも開けない場合はターミナルで `xattr -cr /Applications/ez-ocr.app` を実行してください。

## 使い方

1. 画像をウィンドウにドラッグ＆ドロップ（クリックしてファイル選択、Ctrl/Cmd+V で貼り付けも可）
2. 言語を選んで「文字を読み取る」
3. 「コピー」ボタンでクリップボードへ

## 自動アップデート

起動時に新しいバージョンをチェックし、あれば画面上部に「今すぐ更新」ボタンが出ます。

## 開発

```bash
npm install
npm run tauri dev     # 開発モード
npm run tauri build   # 本番ビルド（src-tauri/target/release/bundle/ に出力）
```

### 新バージョンをリリースする

1. `package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` の version を上げる
2. タグを打って push する

```bash
git commit -am "v0.2.0"
git tag v0.2.0
git push origin main --tags
```

GitHub Actions が Windows / Mac 用のビルドを行い、Releases に自動で公開します。  
`latest.json` も一緒に公開されるので、既存ユーザーには自動アップデートが届きます。

### 署名キー

アップデートの署名キーは `~/.tauri/ez-ocr.key`（パスワードは `~/.tauri/ez-ocr.key.password`）にあり、  
GitHub の Secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` に登録済みです。  
**このキーを失うと既存ユーザーへの自動アップデートができなくなる**のでバックアップしてください。

## 技術

- [Tauri 2](https://tauri.app/)（Rust + WebView）
- [tesseract.js](https://github.com/naptha/tesseract.js)（Tesseract OCR の WebAssembly 版。言語データ同梱）
