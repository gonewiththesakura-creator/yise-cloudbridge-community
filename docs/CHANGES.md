# Review changes, not a production patch

## Architecture

- Server: extracted configuration, HTTP helpers, version/update policy, member
  eligibility, request validation and per-instance login limiter. `app.mjs` is
  reduced from 903 to 611 lines. Routes now reuse explicit policy/config modules.
- Frontend: extracted session/API transport and formatting from React composition.
  Same-origin API requests reject redirects, and isolated clients do not share
  CSRF state. The UI layout and feature set remain intact.
- Windows: extracted immutable non-WPF configuration. Startup requires an explicit
  HTTPS origin before constructing the window or identities, checking updates or
  registering. No private production address remains.

## Correctness and security boundaries

- PUT update policy now requires CSRF; unsupported mutating methods cannot bypass
  the generic session mutation check.
- Failed login attempts in one app no longer lock out a separate app instance.
- Adapter credentials are snapshotted at startup instead of read on each request.
- S-UI token requests reject redirects and remote plaintext HTTP. Test fixtures
  explicitly isolate environment variables and use no production integrations.
- Deployment helpers default to offline plans, require explicit changes, validate
  inputs and verify effective S-UI security-critical fields after saves.
- nginx's canonical authority handles default HTTPS port 443 and nondefault 8443.
- Certificate hostname and expiry checks run separately, avoiding OpenSSL's
  combined-option early exit. Wrong-host certificates fail before installation.

## Build and delivery

- Six direct npm dependencies pinned to original resolved versions; 65 locked
  package hashes verified with official npm metadata. Mirror URLs normalized to
  official tarballs; no dependency upgrade.
- Tested Node/npm versions pinned, `.env` loading explicit, development loopback-only.
- Windows SDK pinned and official NuGet source explicit; updater always built
  first. Runtime/core/rule hashes and notice files are required for packaging.
- Private operations, history, data, runtime binaries and unpinned rules excluded.
  Retained source is functional architecture, not a replacement mock application.
- Added honest self-hosting, build, provenance, security-boundary and test reports.

## Intentional limits

This is not a total rewrite. MainWindow and remaining routes/UI still contain
substantial orchestration. Existing backup CBC encryption is not authenticated;
that limitation is documented rather than silently claiming a cryptographic
migration. Windows/NuGet/runtime/S-UI/deployment remain unverified technical gates. The
v2 candidate adopts GPL-3.0-or-later for first-party code; publication and final
redistribution-rights approval remain separate. No public release or remote
commit has been made.

## Candidate v2: licensing and documentation only

On 2026-10-23 the source-only candidate gained a project GPL-3.0-or-later
notice, the unchanged standard GPLv3 text, matching npm license metadata,
public-facing project documentation and an exact publication-scope manifest.
No application logic or dependency version changed from phase one. Original
third-party notices are preserved byte-for-byte. The earlier review ZIP remains
unchanged; this is a separate candidate, not authorization to publish it.
