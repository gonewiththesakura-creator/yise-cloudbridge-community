# Source provenance

Yise CloudBridge originated as a private application. The owner describes the
application layer as their original work built around the separately maintained
sing-box core and S-UI HTTP API. That description is an owner statement, not an
independent copyright/ownership audit or a claim that the proxy engines were
written for this project.

The reviewed source snapshot is
`e87de9f2f163e60940559ed3680fb5608709fa51`, the existing private project's initial
import of version 2.6.0. The branch was checked before maintenance and still
pointed to that commit. This copy was materialized through read-only access,
without importing private Git history or manufacturing older commits.

The source-only maintenance work dated 2026-10-23 extracted configuration and
policy boundaries, added regression tests and replaced private operations with
general templates. It retained the real WPF, React, control-plane, identity,
updater and transport integration implementations. Changes are listed in
[CHANGES.md](CHANGES.md).

Candidate v2 adds the owner's GPL-3.0-or-later selection for project-authored
code, scripts, tests and documentation. It retains the original third-party
notices and includes the full unmodified standard GPLv3 text. This selection is
not a relicense of independently identified upstream material or a claim of
ownership over it. See [LICENSE_PROVENANCE.md](LICENSE_PROVENANCE.md).

Private deployment/use before this candidate does not establish public
open-source adoption, a long public maintenance history, independent community
review, or enterprise/security certification. No such evidence is asserted here.

This candidate has not been published, pushed to a remote or installed over a
production system. Final publication requires the owner's separate approval of
the repository and exact file scope. The source archive contains no private
operator handoff, production configuration, Git history, credentials, database,
installed packages, build output, proxy executable or unpinned rule file.
Original branding assets remain unchanged; no third-party trademark rights or
independent redistribution-rights audit is implied.

`SOURCE_MANIFEST.json` gives the exact candidate file inventory and hashes.
`PUBLICATION_SCOPE.json` identifies the proposed public file set, not permission
to publish. There is no raw patch carrying removed private deployment values.
