# public/vendor — pinned browser libraries

The dashboard loads every third-party script from this folder rather than a
CDN, so its Content-Security-Policy can say `script-src 'self'` (src/csp.js).
DOMPurify and marked must stay here: together they are the sanitizer
that renders untrusted session output (public/render-safe.js).

`VERSIONS.json` lists each library with the npm tarball it came from, the
tarball's registry `dist.integrity` (sha512), which files were copied, and the
sha384 of each entry file.

| Library | Version | Folder | License | Files copied |
|---|---|---|---|---|
| @xterm/xterm | 5.5.0 | `xterm-5.5.0/` | MIT | `lib/xterm.js`, `css/xterm.css` |
| @xterm/addon-fit | 0.10.0 (last for xterm 5) | `addon-fit-0.10.0/` | MIT | `lib/addon-fit.js` |
| @xterm/addon-web-links | 0.11.0 (last for xterm 5) | `addon-web-links-0.11.0/` | MIT | `lib/addon-web-links.js` |
| marked | 18.1.2 | `marked-18.1.2/` | MIT | `lib/marked.umd.js` (global `marked`) |
| dompurify | 3.4.17 | `dompurify-3.4.17/` | MPL-2.0 OR Apache-2.0 | `dist/purify.min.js` |
| d3 | 7.9.0 | `d3-7.9.0/` | ISC | `dist/d3.min.js` |
| mathjax | 3.2.2 | `mathjax-3.2.2/` | Apache-2.0 | `es5/tex-mml-chtml.js` plus the trees it loads on demand: `es5/input/` (TeX extensions), `es5/output/chtml/` (woff-v2 fonts), `es5/ui/` (menu), `es5/a11y/` and `es5/sre/` (menu accessibility options) |
| monaco-editor | 0.52.2 | `monaco-editor-0.52.2/` | MIT | `min/vs/` without the `nls.messages.*.js` translations (the editor runs in English) |

Every folder keeps the package's `LICENSE` (Monaco also `ThirdPartyNotices.txt`).
The files are byte-identical to the tarball's.

## Updating a library

1. `npm pack <name>@<version>` in an empty temp directory.
2. Check the tarball against the registry:
   `npm view <name>@<version> dist.integrity` must equal
   `sha512-$(openssl dgst -sha512 -binary <file>.tgz | base64 -w0)`.
3. Extract it, copy the files listed above into a new `<lib>-<version>/`
   folder, delete the old folder, and update the path in `public/index.html`
   (Monaco: also the `vs` path in core.js, directories.js, mcp.js, rules.js).
4. Update `VERSIONS.json` (version, tarball, integrity, sha384).
5. `npm test` (test/csp.test.js checks that every script loads from here),
   then load the dashboard and look for CSP violations in the console.
