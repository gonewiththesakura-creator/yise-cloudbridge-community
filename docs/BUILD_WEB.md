# Control-plane build and offline regression checks

Validated toolchain: Node.js 24.19.0, npm 11.9.0, Linux x64. The selected Node
version is in `.node-version` and `.nvmrc`. Older Node versions are not part of
this reviewed build target; `node:sqlite` is required and currently emits an
experimental-feature warning. Use an official Node.js distribution.

From this directory:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
```

Installation contacts only the public npm registry to obtain dependencies.
Tests use temporary local SQLite databases, generated test-only keys and
loopback HTTP/TLS servers. They do not need any deployment settings, S-UI
account, live device identity, proxy core, or paid service. OpenSSL must be
available for real certificate/mTLS tests. Do not point tests at a production
`.env`; the test runner does not load `.env`.

All six direct versions now match the existing lockfile exactly. No dependency
upgrade was made. All 65 non-root locked packages were compared with the
corresponding official npm version metadata, including integrity hashes. The
mirror URLs were replaced with the verified official registry tarball URLs.
`docs/npm-dependencies.json` records the results. Lifecycle scripts are disabled
for installation; the tested frontend builds without running them.

`npm run build` emits `dist/`. Build outputs and installed packages are excluded
from the source review archive. Fixed versions and integrity checks make inputs
reproducible, not a claim that Windows code signing, runtime publishing, or
builds across different operating systems are byte-identical. The verification
report states the actual checks and any repeated-build comparison.

## Local development

Copy `.env.example` to `.env` and set a fresh local encryption key and setup token.
`npm run dev` loads `.env` for the API and binds both services to loopback by
default. Vite is at `http://127.0.0.1:5173`; the API is at
`http://127.0.0.1:8787`. The console uses same-origin `/api/` calls and Vite forwards
only that path to the local API. Use `COOKIE_SECURE=false` for this isolated HTTP
development setup. Do not expose the development server publicly.

After building, `npm start` serves the API and built console. Follow
[SELF_HOSTING.md](SELF_HOSTING.md) for the explicit TLS/deployment configuration.
