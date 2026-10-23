# 壹色云桥 / Yise CloudBridge

Yise CloudBridge is a small-scale, self-hosted device-access application: a
Windows WPF client, React administration console, and Node.js/SQLite control
plane. It manages member access and device enrollment around the separately
maintained sing-box proxy core and S-UI API. It is not a new proxy protocol or a
replacement implementation of those upstream projects.

This is a **source-only public review candidate**, prepared from an existing
private application and first published on 2026-10-23 in the
[community repository](https://github.com/gonewiththesakura-creator/yise-cloudbridge-community).
It is not a prebuilt Windows installer. Runtime components and compatibility
limits are listed below.

`PUBLICATION_SCOPE.json` and `SOURCE_MANIFEST.json` are historical pre-publication
records, preserved unchanged. Their status fields describe preparation time, and
the recorded hashes apply to the approved candidate in the
[initial publication commit](https://github.com/gonewiththesakura-creator/yise-cloudbridge-community/commit/8b1a109bc0becbdb5e9065009cad76c30b688e88),
not to subsequent documentation-only corrections.

## Features

- Member lifecycle, one-use activation codes, single-device enrollment and
  P-256 challenge signatures.
- Short-lived device/transport certificates, mTLS access checks, member status,
  expiry, quotas and connection limits.
- Administration sessions, CSRF checks, password rotation, audit records and
  per-member traffic history.
- Windows WPF interface, TPM/CNG-first device identity, VLESS mTLS and optional
  TUIC paths, routing modes, traffic display and an updater.
- S-UI policy/usage integration, parameterized deployment templates and
  loopback-only regression tests using temporary SQLite databases and keys.

The Windows client requires an explicit HTTPS control-service origin. Missing or
invalid configuration exits before device identity, update or enrollment work.
There is no built-in private production endpoint.

## Components

- `client/`: WPF client, device identity, API transport and proxy orchestration.
- `updater/`: standalone Windows updater.
- `server/`: HTTP routes, configuration, member/update policies, credentials,
  certificate issuance, mTLS gateway and S-UI adapter.
- `src/`: React console, API/session boundary and traffic visualization.
- `tests/`: offline unit, API and loopback protocol-integration tests.
- `deploy/`: explicit plan/status/apply helpers and templates, not an installer.

## Build the console and control plane

Tested with Node.js 24.19.0 and npm 11.9.0 on Linux x64. OpenSSL is needed for the
certificate/mTLS tests. Dependency versions and integrity values are locked.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm test
npm run build
```

For isolated local development, copy `.env.example` to `.env`, supply your own
local setup token/encryption key, and use `COOKIE_SECURE=false` only for local
HTTP. `npm run dev` serves the console at `http://127.0.0.1:5173` and forwards its
`/api/` calls to the local API at `http://127.0.0.1:8787`. Both bind to loopback by
default. Do not expose the development server publicly.

See [BUILD_WEB.md](docs/BUILD_WEB.md) for the complete reproducible-input workflow
and [SELF_HOSTING.md](docs/SELF_HOSTING.md) for topology and template boundaries.

## Windows source and external dependencies

The client targets .NET 10/WPF; SDK 10.0.402 and the official NuGet source are
specified. [BUILD_WINDOWS.md](docs/BUILD_WINDOWS.md) describes configuration, the
fake-HTTP C# harness and explicit updater-first packaging.

This snapshot intentionally omits `sing-box.exe`, `geoip-cn.srs` and
`geosite-cn.srs`. The original sing-box version/source and official archive hash
are documented in [EXTERNAL_COMPONENTS.md](docs/EXTERNAL_COMPONENTS.md). The
original rule files' generation/data provenance remains unresolved. Supply
independently reviewed runtime artifacts and hashes before attempting a complete
Windows package; the packaging script fails clearly when required inputs are
missing. There is no claim that a fresh clone is a ready-to-run Windows client.

## Verification status

- 60 Node tests passed, including a real loopback HTTP activation → signed
  renewal → ephemeral certificate → TLS 1.3 forwarding → revocation flow.
- Seven of those tests are explicitly Windows **source assertions**, not C# or
  WPF execution. They must not be interpreted as Windows acceptance tests.
- Frontend production builds passed. A clean source copy with the same Linux
  toolchain produced byte-identical output files.
- Windows build/UI, C# harness, PowerShell packaging, TPM/TUN, system-proxy
  behavior, real S-UI compatibility and production deployment remain unverified.

See [VERIFICATION.md](docs/VERIFICATION.md) for evidence and limits. This is a
bounded maintainability pass, not a security certification or a complete rewrite.

## Security boundaries

Device identity and transport credentials have different properties. The
TPM/CNG-first identity key is non-exportable; short-lived transport material can
be exportable and temporarily written for the proxy core. Device binding cannot
prevent an authorized user deliberately relaying an active connection. Read
[SECURITY_MODEL.md](docs/SECURITY_MODEL.md) before operating the application.

## License and provenance

Project-authored code, scripts, tests and documentation are licensed under
**GPL-3.0-or-later**. See [LICENSE](LICENSE) for the unchanged GPLv3 text and
[NOTICE](NOTICE) for the explicit “or later” grant and scope. Separately identified
third-party material retains its own copyrights, licenses and notices.

The source originated as a private application maintained around upstream
sing-box and S-UI. Private product use is not evidence of adoption of this release
candidate. No stars, independent deployments, community history or support
commitments are claimed. See [PROVENANCE.md](docs/PROVENANCE.md),
[LICENSE_PROVENANCE.md](docs/LICENSE_PROVENANCE.md) and [CHANGES.md](docs/CHANGES.md).
