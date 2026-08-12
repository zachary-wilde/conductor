# Third-party notices

Reigen is licensed under the MIT License — see [LICENSE](./LICENSE)
(`Copyright (c) 2026 Zack Wilde`).

This file identifies the load-bearing third-party components Reigen depends on and
points to where each one's full license text lives in the installed tree. **Every
component listed below is MIT-licensed**, as stated in its own package metadata and
license file (copyright notices are quoted verbatim from those files; nothing here is
invented). The complete dependency tree, with resolved versions, is in
`package-lock.json`; each package's license file is at `node_modules/<package>/LICENSE`
(or the variant named below).

---

## node-pty — `1.1.0`

Fork pseudoterminals; powers Conductor's terminal sessions and the agent CLIs' PTY
spawns. © Microsoft Corporation. MIT.

Copyright notices (from `node_modules/node-pty/LICENSE`):

- `Copyright (c) 2012-2015, Christopher Jeffrey (https://github.com/chjj/)`
- `Copyright (c) 2016, Daniel Imms (http://www.growingwiththeweb.com)`
- `Copyright (c) 2018 - present Microsoft Corporation`

**Bundled third-party code** (separate licenses, both MIT, retained by node-pty):

- **winpty** — the legacy Windows pseudo-console fallback, in `node_modules/node-pty/deps/winpty/`.
  `Copyright (c) 2011-2016 Ryan Prichard` — see `deps/winpty/LICENSE`.
- **Microsoft ConPTY** binaries (`OpenConsole.exe`, `conpty.dll`) — in
  `node_modules/node-pty/third_party/conpty/`, distributed by Microsoft under the
  ConPTY license terms accompanying those binaries.

## koffi — `3.1.2`

Dynamic C FFI for Node.js; used for native Windows interop (e.g. DWM acrylic).
© Niels Martignène. MIT.

- `Copyright (C) 2026  Niels Martignène <niels.martignene@protonmail.com>`
- Full text: `node_modules/koffi/LICENSE.txt` (note the `.txt` extension).

## monaco-editor — `0.56.0`

The code editor that backs Conductor's in-app editor (the VS Code editor component).
© Microsoft Corporation. MIT.

- `Copyright (c) 2016 - present Microsoft Corporation`
- Full text: `node_modules/monaco-editor/LICENSE`

## @xterm/xterm — `5.5.0` (plus addons)

The terminal emulator rendered in Conductor's terminal panels. The addons
`@xterm/addon-fit`, `@xterm/addon-search`, and `@xterm/addon-web-links` are part of the
same project and carry the same license. © The xterm.js authors. MIT.

Copyright notices (from `node_modules/@xterm/xterm/LICENSE`):

- `Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js)`
- `Copyright (c) 2014-2016, SourceLair Private Company (https://www.sourcelair.com)`
- `Copyright (c) 2012-2013, Christopher Jeffrey (https://github.com/chjj/)`

## electron — `31.7.7`

The cross-platform desktop framework Conductor is built on (and whose binary, in Node
mode, also runs the standalone Core). © Electron contributors / GitHub Inc. MIT.

Copyright notices (from `node_modules/electron/LICENSE`):

- `Copyright (c) Electron contributors`
- `Copyright (c) 2013-2020 GitHub Inc.`

---

## Notes

- Electron itself bundles Chromium, Node.js and V8, each under their own licenses
  (BSD/MIT-style). Those are surfaced by the Electron project; Conductor does not
  redistribute them separately.
- If you are packaging or redistributing Conductor, resolve the full transitive set
  from `package-lock.json` and include each package's own license file — this notice
  covers the components the release plan names, not every transitive dependency.
