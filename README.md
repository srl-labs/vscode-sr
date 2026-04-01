# Nokia SR Linux & SR OS Language Server

A VS Code language server extension for Nokia SR OS and SR Linux configuration files which uses the [srpls](https://github.com/srl-labs/srpls) language server.

## Features

- Syntax highlighting for:
  - `*.sros.cfg`
  - `*.srl.cfg`
- Flatten/unflatten conifg on-demand for SR Linux
- Automatic configuration keyword suggestions based on the YANG model.

### SR Linux frontpanel view

See the location of the physical port on the box by higlighting the port in the config file.

![](https://gitlab.com/kaelemc/wiki/-/wikis/uploads/00ce27c1e30921ce37546b0076b8d4d9/s3.gif)

### Version aware

Based on the SR Linux & SR OS (model-driven) YANG Models, check the config against the YANG model for any given software release.

![](https://gitlab.com/kaelemc/wiki/-/wikis/uploads/ce2c2393d7fa77d08f1b53610e16a3aa/s4.gif)

### Quick search

Use the flat config path syntax to jump to positions in a braced-format config file. Makes working with huge config files easy.

![](https://gitlab.com/kaelemc/wiki/-/wikis/uploads/7139b6889f382285f147ad32e70930c1/s1.gif)

### Flatten/Unflatten

Easily convert the config file between flat/braced formats.

![](https://gitlab.com/kaelemc/wiki/-/wikis/uploads/796c4520704e64ddcd39f7b6cb138647/s2.gif)

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
