# ez-ocr

A tiny desktop app that pulls text out of images so you can copy & paste it.  
Works on Windows and Mac, runs fully offline. English by default, Japanese optional.

## Download

Grab the file for your OS from the [latest release](https://github.com/Cosmo2357/ez-ocr/releases/latest).

| OS | File |
| --- | --- |
| Windows | `ez-ocr_x.x.x_x64-setup.exe` |
| Mac (Apple Silicon & Intel) | `ez-ocr_x.x.x_universal.dmg` |

### First-launch warning

The app is not signed with a developer certificate, so the OS shows a warning the first time.

- **Windows**: "Windows protected your PC" → click **More info** → **Run anyway**
- **Mac**: If you see "cannot be opened because the developer cannot be verified", open  
  **System Settings → Privacy & Security**, scroll down and click **Open Anyway**.  
  If that does not work, run `xattr -cr /Applications/ez-ocr.app` in Terminal.

## How to use

1. Drag & drop an image into the window (or click to pick a file, or paste with Ctrl/Cmd+V)
2. Text is extracted automatically. Change the language and hit **Read again** if needed
3. Click **Copy**

## Auto update

On launch the app checks GitHub for a newer version. If there is one, an **Update now** button appears at the top.

## Development

```bash
npm install
npm run tauri dev     # dev mode
npm run tauri build   # release build → src-tauri/target/release/bundle/
```

### Publishing a new version

1. Bump `version` in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
2. Commit, tag and push

```bash
git commit -am "v0.2.0"
git tag v0.2.0
git push origin main --tags
```

GitHub Actions builds Windows and Mac installers and publishes them on the Releases page,  
together with `latest.json` so existing installs get the auto-update prompt.

### Update signing key

The updater signing key lives at `~/.tauri/ez-ocr.key` (password in `~/.tauri/ez-ocr.key.password`)  
and is registered as the GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.  
**If the key is lost, existing installs can no longer auto-update.** Back it up.

## Built with

- [Tauri 2](https://tauri.app/) (Rust + WebView)
- [tesseract.js](https://github.com/naptha/tesseract.js) (Tesseract OCR compiled to WebAssembly, language data bundled)
