# Nokia SR Linux & SR OS Language Server

A VS Code language server extension for Nokia SR OS and SR Linux configuration files which uses the [srpls](https://github.com/srl-labs/srpls) language server.

## Features

- Syntax highlighting for:
  - `*.sros.cfg`
  - `*.srl.cfg`
- Flatten/unflatten conifg on-demand for SR Linux
- Automatic configuration keyword suggestions based on the YANG model.

## Quickstart

### SR Linux / SR OS

1. Create a file named `myconfig.srl.cfg`.
2. Add the platform on the first line:

```cfg
# platform=ixr-d3l
```

3. Save and start typing config. Suggestions should appear automatically.

## FAQ

### Q: Where is the srpls binary installed?

The `srpls` language server binary is by default installed into the following locations (dependant on OS):

- `~/.srpls` (Linux & MacOS)
- `%USERPROFILE%\.srpls` (Windows)

## Development

```bash
npm install
npm run compile
npm run lint
```
