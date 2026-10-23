# License scope and text provenance

## First-party selection

The owner selected GPL-3.0-or-later for this organized source candidate on
2026-10-23. The root `NOTICE` explicitly grants GPL version 3 **or any later
version** for project-authored code, scripts, tests and documentation. The
unchanged root `LICENSE` contains the standard GPLv3 terms. `package.json` and
the root package-lock entry carry the same SPDX identifier.

The SPDX identifier and the distinction from GPL-3.0-only were checked against
[SPDX's GPL-3.0-or-later entry](https://spdx.org/licenses/GPL-3.0-or-later.html).
The “or later” selection is expressed in the project notice; the standard legal
text itself has not been rewritten.

## Standard legal text

The root `LICENSE` is byte-identical to
`third_party/COPYING-GPL-3.0.txt` and the standard GPLv3 copy installed as
`/usr/share/common-licenses/GPL-3` in the verification environment.

The included copy was obtained from the GNU Coreutils upstream
[COPYING at commit 9192fd32e03abf6be27eb42c3adb592e49d2cb0e](https://github.com/coreutils/coreutils/blob/9192fd32e03abf6be27eb42c3adb592e49d2cb0e/COPYING),
blob `f288702d2fa16d3cdf0035b15a9fcbc552cd88e7`. SHA-256:

`3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986`

The GNU license website could not be retrieved during these checks; the
first-party GNU source mirror and SPDX reference were used rather than editing
or paraphrasing the legal text. The standard text retains the Free Software
Foundation's copyright on the license document itself. That is not a claim that
the FSF owns Yise CloudBridge.

## Third-party material and source-only boundary

- Original `client/LICENSE-sing-box.txt` and `client/THIRD_PARTY_NOTICES.txt` are
  preserved byte-for-byte. Their historical bundling statements describe the
  original private distribution, not this source-only candidate.
- `third_party/LICENSE-sing-box-upstream.txt` preserves the exact LICENSE notice
  from the declared sing-box source revision. Its extra naming/association
  notice is not removed or transferred onto first-party code.
- sing-box and S-UI remain separately maintained upstream projects. This
  repository does not claim their implementation as its own work.
- npm dependencies, .NET/System.Management and any future included runtime or
  rules retain applicable upstream rights and obligations. No blanket project
  license overrides those terms. Dependencies and generated binaries are not
  bundled in this source archive.
- The original generated rule files are excluded because their source/version
  provenance is unresolved. The current license choice does not resolve that
  gap, and it does not authorize silently substituting arbitrary rule data.
- Branding assets retain their original bytes. The code license does not grant
  third-party trademark rights or resolve an unverified third-party asset claim.

Any later binary distribution must include the first-party notice/LICENSE,
applicable upstream notices and the corresponding source required for the actual
components distributed. Existing packaging instructions are not a claim that
this future distribution/rights review has occurred. No binary packaging or
production rollout is being performed as part of this candidate preparation.

This is a scope/provenance record, not an independent legal opinion or a claim
that publication has been authorized. The owner's final repository/file-scope
approval is still required before any public upload.
