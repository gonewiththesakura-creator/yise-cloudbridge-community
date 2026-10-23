# Security model and review limits

The control plane uses authenticated administration sessions, CSRF tokens,
password hashing, device challenge signatures, expiring credentials and member
status/quota checks. This maintenance phase adds explicit CSRF coverage for PUT
update-policy requests and isolates application-instance login throttling.

The Windows device identity uses a non-exportable CNG key, preferring TPM when
available. That is not the same as saying every transport secret is
non-exportable: TUIC uses a separate transport identity, and the proxy core can
require temporary on-disk credentials. Keep runtime directories private.
Authorized users may intentionally relay traffic from an enrolled machine.

A missing client control-service address blocks update/activation requests.
Configuration is explicit, HTTPS-only, and contains no original deployment
address. Changing the service authority is a trust decision; do not accept
untrusted client settings or update URLs. TLS certificate validation remains on.

API, mTLS gateway and upstream proxy are different trust boundaries. Keep
administration and S-UI APIs bound to loopback behind a correctly configured TLS
reverse proxy. Use fresh local secret material, narrowly permissioned service
accounts and backups. Do not copy example values into production. A persistent
S-UI API token must be provisioned by the operator, not silently created by the
scripts.

The included integration tests use temporary accounts, keys and databases.
No production penetration test, external security certification, Windows TPM
hardware validation, updater power-loss atomicity, or public-release license
review has been completed. The test report must not be read as those assurances.
