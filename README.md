# Nokia SR Linux & SR OS Language Server

[![VS Code][vsc-badge]][vsc-link]

A VS Code language server extension for Nokia SR OS and SR Linux configuration files which uses the [srpls](https://github.com/srl-labs/srpls) language server.

[vsc-badge]: https://gitlab.com/-/project/80925782/uploads/dd535a18a0c647bf6aa4c0c50e51bf71/rect1.svg
[vsc-link]: vscode:extension/srl-labs.sr-vscode

## Features

- Syntax highlighting for:
  - `*.sros.cfg`
  - `*.srl.cfg`
- Flatten/unflatten conifg on-demand for SR Linux
- Automatic configuration keyword suggestions based on the YANG model.

### SR Linux frontpanel view

See the location of the physical port on the box by higlighting the port in the config file.

https://github.com/user-attachments/assets/74d6e501-0e54-4f17-996c-9ac752ac637f

### Version aware

Based on the SR Linux & SR OS (model-driven) YANG Models, check the config against the YANG model for any given software release.

https://github.com/user-attachments/assets/4010ebd3-8497-4dc6-a095-baff0d1fa820

### Quick search

Use the flat config path syntax to jump to positions in a braced-format config file. Makes working with huge config files easy.

https://github.com/user-attachments/assets/af0da4e2-9a9c-46d0-9d6d-bafeb7bbc015

### Flatten/Unflatten

Easily convert the config file between flat/braced formats.

https://github.com/user-attachments/assets/93efae67-ae7e-4663-848e-7beee9be3323

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
