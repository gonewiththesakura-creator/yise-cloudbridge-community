# Self-hosting templates and operational boundaries

This source-only maintenance snapshot is **not an installer or a tested production
release**. No server has been modified, no firewall/SSH rules changed, and no API
credentials created as part of this work. Production rollout, real S-UI compatibility,
Windows client acceptance, certificate issuance and restore drills remain operator
acceptance gates. See [BUILD_WEB.md](BUILD_WEB.md),
[BUILD_WINDOWS.md](BUILD_WINDOWS.md), and
[EXTERNAL_COMPONENTS.md](EXTERNAL_COMPONENTS.md).

## Topology and configuration

The retained topology uses separate listeners:

- nginx serves the console over HTTPS on a configurable port (example: 8443) and
  proxies only to the Node console on loopback (example: 8787).
- Node's public TCP mTLS data plane (example: 443) forwards to an S-UI VLESS listener
  bound **only to loopback** (example: 2443). Do not expose that internal listener.
- Optional TUIC uses a separate UDP listener (example: 443) in S-UI, requiring a
  server TLS certificate and the device CA certificate for mutual authentication.
- S-UI's management API should remain loopback-only. Helpers reject non-loopback
  plain HTTP and all redirects when sending the API token.

Copy `.env.example` to a private `.env` and `deploy/deployment.env.example` to a
private deployment configuration. They are templates, not working credentials.
The reserved `example.invalid` hostnames and `/srv/example` paths must be replaced.
`DATA_DIR` may be relative for local tests; use an absolute production path matching
`CB_DATA_DIR`, and set `CB_DATABASE_PATH` to its `friendlink.db` file. Keep application
paths and deployment paths synchronized, including `HOST`, `PORT`, data-plane ports,
certificates and service account access. The Node service reads `CB_CONFIG_FILE`;
the backup service reads `DEPLOY_ENV_FILE`.

The example configuration deliberately binds to loopback, disables TUIC and leaves
TLS/CA paths and update enforcement unset. Set the intended public bind addresses,
valid DNS names, certificate paths and S-UI inbound IDs yourself before enrolling
devices. The template requires a different console TLS port from the TCP data-plane
port. TCP and UDP may share a port number because they are different transports.
Use a certificate covering both `PUBLIC_HOST` and `PROXY_SERVER_NAME` if they differ.
The renewal hook verifies the proxy name; validating other certificate names remains
an operator responsibility.

Only enable `TRUST_PROXY=true` behind a trusted proxy with the Node listener not
publicly reachable. The nginx template overwrites forwarded host, IP and protocol
headers rather than accepting the caller's forwarded-IP chain. `COOKIE_SECURE=true`
is appropriate for HTTPS. For isolated HTTP development only, explicitly set it to
false. Do not use that development override for public service.

## Secrets and external prerequisites

Use a supported Node runtime (see `package.json`), Bash on Linux, nginx, OpenSSL,
SQLite support in Node, and a separately obtained and verified S-UI build. The repo
intentionally does not distribute the proxy core, runtime databases, private CA,
server keys or operational credentials.

`node deploy/generate-secrets.mjs` is a no-write preview. To create a new local
0600 file explicitly:

```sh
node deploy/generate-secrets.mjs --apply .secrets/bootstrap-secrets.json
```

The helper refuses existing files or symlinks, never prints generated values, and
creates only the application admin password, setup token and encryption key. Copy
them privately into your application configuration. Restrict access to that file;
never paste values into reports, source control or issue trackers. The encryption
key must be 32 random bytes encoded as base64. Do not regenerate it over an existing
database: existing encrypted credentials depend on it. Obtain any required S-UI
account/token through your separately approved administration workflow. These
helpers never create accounts, persistent API tokens or permissions.

Provision a device CA, server certificates, service accounts, directories, file
ownership and a backup passphrase through your normal reviewed operations process.
Do not reuse public test certificates or commit the CA private key. S-UI only needs
the CA certificate, not its private key. Restrict the CA private key to the control
plane account. `SupplementaryGroups` in the S-UI template allows access to shared
server TLS material, so use group access only for those intended files.

## Review, render, then install manually

The `.service`, `.timer` and nginx `.conf` files contain `{{VARIABLE}}` placeholders.
Do not copy unresolved files into host configuration. The renderer validates ports,
hostnames, loopback upstream, system account names and absolute paths. It accepts a
conservative path alphabet, without spaces, traversal or configuration directives.

```sh
node --env-file=deploy/deployment.env deploy/render-templates.mjs
node --env-file=deploy/deployment.env deploy/render-templates.mjs --apply --output-dir deploy/rendered
```

The first command prints the complete rendered configuration without writing. The
second **only writes new local files** into a fresh directory and refuses an existing
directory. It does not install configuration, reload nginx, run systemd, create
users, obtain certificates or change firewall/SSH settings. Review and validate the
rendered output with the versions installed on your target before installing it via
your normal operations process. Apply relevant directory ownership and service
hardening changes deliberately. The supplied services retain binding capability
and filesystem hardening, with write access restricted to their configured data
paths. The backup unit is an explicitly mutating scheduled job; inspect its paths
and retention before enabling its timer. Its schedule is 04:17 in the host's local
time zone with up to 20 minutes of jitter.

## S-UI inbound helpers

```sh
node --env-file=.env deploy/configure-mtls-inbound.mjs --dry-run
node --env-file=.env deploy/configure-mtls-inbound.mjs --status
node --env-file=.env deploy/enable-tuic.mjs --dry-run
node --env-file=.env deploy/enable-tuic.mjs --status
```

No arguments means `--dry-run`: a deterministic offline plan, **no API calls and no
token required**. TUIC plans still require explicit hostname and absolute TLS/CA
paths. `--status` reads redacted matching IDs/listeners using an already-authorized
token. Only `--apply` creates or edits the named inbound/TLS objects. The former
implicit `prepare` mode is intentionally rejected. Optional `SUI_VLESS_TAG`,
`SUI_TUIC_TAG` and `SUI_TUIC_TLS_NAME` select different managed names. Duplicate
matches and wrong protocol types stop the operation instead of replacing unrelated
objects. Unrelated inbound fields/users are preserved, and unchanged objects are
not saved again. No helper creates users or firewall rules.

Apply is a separate operator decision. Review the plan, compare live status, check
file access and back up S-UI before using it. TLS and inbound saves are separate API
operations, not a transaction: on any failed or uncertain response inspect status
before retrying. Record the returned inbound IDs in the application configuration.
This local test suite uses in-memory API fixtures; it does not establish compatibility
with your deployed S-UI API version or prove public connectivity.

## Backup and recovery

`backup-cloudbridge.sh` defaults to a no-write plan. Shell helpers consume exported
variables; they **never source an application/configuration file**. If exporting a
configuration via a shell, use only a file you authored and reviewed because shell
sourcing can execute commands. All values are also supplied by the backup unit's
reviewed `EnvironmentFile`.

`--apply` requires explicit application/data/config/CA/backup/passphrase paths. It
makes consistent individual SQLite snapshots using `server/sqlite-backup.mjs`,
includes the application configuration and device CA, optionally snapshots S-UI
when `SUI_DATABASE_PATH` is set, then writes a private encrypted archive. A configured
but missing S-UI database is an error rather than silently omitted. Publication is
atomic without overwriting prior archives. Temporary plaintext is removed on exit;
this is not guaranteed secure erasure on the underlying storage. Separate SQLite
snapshots are not an atomic cross-service checkpoint. Coordinate/quiesce services
in your own maintenance procedure if cross-service consistency is required.

Encryption remains OpenSSL AES-256-CBC, PBKDF2 with 200,000 iterations for compatibility.
CBC is **not authenticated encryption**. It provides confidentiality, not reliable
tamper detection; protect archive integrity using your trusted backup repository
or an independently authenticated storage/encryption layer. Store the passphrase
separately from archives. The secrets/config/CA make these backups highly sensitive.
By default archives are never pruned. A positive `BACKUP_RETENTION_DAYS` explicitly
opts in to deleting matching generated archives older than that period during an
applied backup. Confirm off-host copies and restore drills before opting in.

Restore into a private temporary directory first, never directly over live data:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
  -pass file:/YOUR/PRIVATE/PASSPHRASE_FILE \
  -in /YOUR/TRUSTED/BACKUP.tar.enc -out /YOUR/PRIVATE/RESTORE/backup.tar
tar -tf /YOUR/PRIVATE/RESTORE/backup.tar
```

After verifying the trusted archive's contents, extract into the isolated restore
location, check SQLite integrity, validate the application encryption key and CA,
and rehearse startup with non-production listeners. The archive does not contain
external binaries, installed services, ACME account state or a full machine image.
There is intentionally no automated destructive restore command.

## Certificate renewal and health

`certbot-reload-cloudbridge.sh` defaults to a no-copy/no-restart plan. Its explicit
`--apply` takes Certbot's `RENEWED_LINEAGE`, verifies the proxy hostname, expiration
and certificate/private-key match, stages private files, replaces configured target
files and only then restarts/reloads the explicitly named service units. Review the
hook and export its deployment variables before wiring it into Certbot. Both target
files must be in the same non-root directory; the two replacements are not a
transaction and interrupted renewal must be inspected before services are restarted.
This is an opt-in hook, not certificate issuance automation.

`health-check.sh` defaults to a no-network/no-host-inspection plan. `--check` validates
`HEALTH_CONSOLE_URL` (normally `/api/bootstrap`) and, when configured, reads S-UI's
inbounds endpoint. Set `NODE_BIN` explicitly. Optional `HEALTH_SERVICE_UNITS` adds
read-only systemd checks; optional `HEALTH_TUIC_PORT` checks the local UDP listener.
A local listener is **not proof of firewall, routing, public reachability or an
end-to-end client connection**. These checks make no firewall or SSH changes.
Secrets are neither included in URLs nor printed. API failure bodies are not logged.

## What is tested here

`node --test tests/deploy-config.test.mjs` covers pure configuration, rendered
fixtures, dry-run/status safety, mocked S-UI changes, isolated temporary-certificate hostname checks and shell
syntax/default plans.
It never invokes an applied deploy helper, systemd, firewall configuration, real
credentials or a production endpoint. Full host deployment and recovery are not
claimed as tested by these checks.
