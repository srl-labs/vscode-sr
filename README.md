# vscode-sr

VS Code extension for Nokia SR OS and SR Linux configuration files.

## Features

- Syntax highlighting for:
  - `*.sros.cfg`
  - `*.srl.cfg`
- Language Server Protocol (LSP) support via `srpls`
- Toggle Flat/Brace command for SR Linux configs
- Auto-suggestions triggered on space and Enter in SR config contexts

## srpls Binary

On startup, the extension downloads the pinned `srpls` release binary into:

- `~/.srpls/` (Linux/macOS)
- `%USERPROFILE%\\.srpls\\` (Windows)

## Quickstart

### SR Linux / SR OS

1. Create a file named `myconfig.srl.cfg`.
2. Add the platform on the first line:

```cfg
# platform=ixr-d3l
```

3. Save and start typing config. Suggestions should appear automatically.


## Development

```bash
npm install
npm run compile
npm run lint
```
