# Windows client: configuration, tests and packaging

This is a **source-only snapshot**, not a runnable Windows release. It excludes
`sing-box.exe`, `geosite-cn.srs` and `geoip-cn.srs`. Nothing in this workflow
downloads or starts those runtime components. Do not distribute a partial build.

## Explicit control-plane configuration

There is no built-in API server and no production fallback. The client reads:

1. `CLOUDBRIDGE_API_BASE_URL` from the process environment, if present.
2. Otherwise, `%LOCALAPPDATA%\CloudBridge\settings.json`, with exactly one string
   field named `apiBaseUrl` (other fields are ignored).

An example is supplied in `client/settings.example.json`. Replace its reserved
`.invalid` hostname with an administrator-confirmed origin before use:

```json
{"apiBaseUrl":"https://api.example.invalid:8443/"}
```

Only an absolute HTTPS origin, optionally with a port and trailing `/`, is
accepted. Credentials, non-root paths, query strings, fragments, whitespace and
backslashes are rejected. HTTPS development origins (including localhost or
IPv6) still require a normally trusted TLS certificate; there is no insecure TLS
switch. Control-plane redirects are rejected, so configure the final origin.

A present but invalid environment value **does not fall back** to local settings.
Malformed, duplicate `apiBaseUrl`, unreadable or missing settings fail closed.
The application shows a Chinese message identifying the setting/file to fix,
then exits **before constructing the window, device identities, HTTP transport,
or starting update checks and registration**. Valid configuration is shown in
the initial footer, with the source and full origin in its tooltip.

Configuration is read once at startup. Restart after changing it. An environment
variable set in one PowerShell session is inherited only by processes launched
from that session; use the per-user settings file for consistent Explorer starts.
The local settings file is outside the installation directory and is not part of
the update package. It is intentionally not overwritten by this build workflow.

Only configure a trusted service. Registration/renewal send an activation code,
device name, fingerprint hash and public keys/signatures to that service. Changing
the origin does not migrate an existing device registration. Check with the
administrator before changing it; do not copy device credentials for testing.

## Tests

Source assertions, executable with the repository's supported Node.js version:

```sh
node --test tests/client-source.test.mjs
```

These are deliberately labeled **source assertions**, not C# or WPF runtime
tests. They check configuration wiring, startup order, dependency/package
requirements, and preservation of the original notice bytes.

On a machine with the pinned .NET SDK 10.0.402, the separate dependency-free console harness
compiles the real non-UI configuration and API code:

```powershell
dotnet run --project client/tests/CloudBridge.Configuration.Tests.csproj -c Release
```

The harness checks absent/invalid settings, precedence, malformed and duplicate
JSON, local I/O errors, origin normalization, and API request destinations. HTTP
is intercepted by an in-memory handler. It does not compile WPF, use device
credentials, contact a service, execute the proxy/updater, or change network
settings. The client project excludes the harness's source files from its build.

## Build prerequisites

- Windows 10/11 x64 and the exact .NET SDK 10.0.402 from `global.json`, with the
  normal WPF build prerequisites. The script changes to the repository directory
  before invoking `dotnet` so the SDK pin applies even when invoked elsewhere.
- PowerShell 5.1 or later. `dotnet publish` may restore official NuGet/runtime
  packages; provision and approve those build dependencies normally.
- A separately obtained and reviewed `sing-box.exe` matching the original
  `THIRD_PARTY_NOTICES.txt` executable hash.
- A reviewed, compatible pair of China rule sets plus their independently
  recorded SHA-256 hashes. Their original revisions/provenance remain unresolved
  in this snapshot; no compatible pair is claimed to have been verified here.

See `docs/external-components.json` for the source revision, official archive
metadata and remaining provenance gaps. The official ZIP hash differs from the
extracted executable hash. The executable hash is preserved historical evidence,
not an independently revalidated binary. Verifying a file against that hash does
not establish the file's authenticity or redistribution rights on its own.

The old `THIRD_PARTY_NOTICES.txt` describes historical bundles; it and
`LICENSE-sing-box.txt` are preserved byte-for-byte. The runtime files described
there are **not present now**. The original upstream notice is separately
preserved at `third_party/LICENSE-sing-box-upstream.txt`; the complete GPL body is
at `third_party/COPYING-GPL-3.0.txt`. Both are required in any package.
The upstream files do not change upstream licensing. The first-party
GPL-3.0-or-later selection is recorded in the root NOTICE and LICENSE; public
publication still requires separate approval.

## Build a package from reviewed inputs

Place reviewed dependencies in an external directory (or `client/core/`) with
these exact names, then run from the repository root:

```powershell
.\scripts\build-windows.ps1 `
  -CoreDirectory 'C:\reviewed-cloudbridge-runtime' `
  -OutputDirectory 'C:\build-output\cloudbridge-new' `
  -GeositeSha256 '<independently-reviewed-64-hex-hash>' `
  -GeoipSha256 '<independently-reviewed-64-hex-hash>'
```

The output directory must not already exist. The script:

1. Checks platform, dependency files, hashes, notices and SDK availability.
2. Runs the C# configuration/API harness, without real network or device access.
3. Explicitly publishes this source's self-contained updater first.
4. Publishes the WPF client with that exact updater and dependency directory.
5. Verifies expected runtime and notice files and writes `SHA256SUMS.txt`.

The script neither starts the built programs nor signs or uploads anything.
Package the **entire** output directory, not only the main `.exe`. If publish
fails, the incomplete output is left for diagnosis and must not be distributed;
choose a fresh directory for a retry. Only the script's unique temporary build
directory is cleaned up automatically.

Direct client builds now fail with specific errors when core/rules/updater or
the upstream notice/GPL body are missing, rather than silently omitting the updater.
The packaging script is preferred because it also checks hashes and explicitly
rebuilds the updater. Deterministic compiler settings and file hashes improve
auditability; they are **not a claim of byte-for-byte reproducible releases**.
The selected SDK is pinned, but its use here is not a verified Windows build.
NuGet restore graphs/locks, runtime dependencies, signing and release provenance
still need an independently validated Windows release environment.

## Verification boundary for this change

The editing environment has neither `dotnet` nor PowerShell/Windows WPF. Node
source assertions can run here; the C# harness, PowerShell script, publish output,
and actual WPF UI have **not been executed or visually verified here**.

Before release, run the harness and packaging script on Windows, inspect the
missing/invalid/valid configuration flows, and use an isolated staging service
for registration/update tests. Test interrupted and repeated startup/update
flows as well as the normal path. Never use real user credentials or production
services for those tests without explicit authorization. Proxy/TUN/device and
update behavior outside the configuration boundary was intentionally retained;
the existing gstatic/Cloudflare probes can run only in authorized live client
network tests, not in these source assertions or the fake-HTTP harness.

The root `NuGet.Config` clears inherited package feeds and uses only the official
nuget.org source. A resolved NuGet transitive lockfile is not supplied because
restore has not run here; record and review that graph during Windows acceptance.
SDK pinning and deterministic compilation settings are not a claim of a
byte-reproducible Windows package until that acceptance work is complete.

## First-party notices in any future binary distribution

This source-only v2 preparation does not change or execute the packaging script.
The existing script copies the upstream notices listed above, not the newly
added project-level `NOTICE` and `LICENSE`. Before distributing any future
Windows package, also include both root files, verify all actually bundled
third-party notices and corresponding-source obligations, and review the final
package. A script exit code alone is not proof that this license gate is met.
No Windows packaging or deployment is requested or performed for this candidate.
