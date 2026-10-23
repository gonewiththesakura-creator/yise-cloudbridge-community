# External runtime components

This review snapshot contains source, not a complete Windows distribution.
No proxy executable or routing-rule data is bundled. The existing
`client/THIRD_PARTY_NOTICES.txt` and `client/LICENSE-sing-box.txt` are preserved
unchanged as provenance of the original distribution; statements there about
bundling describe that original distribution, not this review archive.

## sing-box

The original declared version is 1.13.19, source revision
`b5ebaa1fc0f2b94256180b95468e73ef53caa27d`.
The [official release](https://github.com/SagerNet/sing-box/releases/tag/v1.13.19)
metadata was checked on 2026-10-23. Its Windows amd64 ZIP is 21,046,252 bytes,
with official asset SHA-256:

`e011a4def2f5e2b143ed54adb2b1a20a6be407806ab4442f3667f1dd817a2c8d`

The exact archive URL, source revision and original executable's declared hash
are recorded in `external-components.json`. The original executable hash is a
historical declaration, not a newly measured hash. No executable was downloaded
or run during this maintenance phase. Before extracting/running a separately
obtained archive, verify its hash and provenance; never use a floating `latest`
link. Review all distribution requirements before bundling it.

The original upstream LICENSE notice from that exact source revision is retained in
`third_party/LICENSE-sing-box-upstream.txt` in addition to the original notices. The complete standard GPLv3 body is
in `third_party/COPYING-GPL-3.0.txt`, copied from the GNU Coreutils upstream
COPYING file (blob f288702d2fa16d3cdf0035b15a9fcbc552cd88e7); the GNU license-text site was
unavailable during retrieval. Source: https://github.com/coreutils/coreutils/blob/9192fd32e03abf6be27eb42c3adb592e49d2cb0e/COPYING.
The project is not affiliated with or endorsed by SagerNet.

## Routing rules

The original `geoip-cn.srs` and `geosite-cn.srs` were unpinned generated files.
They are intentionally excluded rather than silently replaced with today's
rules. Their original generation revision, data provenance and an appropriate
compatible pinned pair remain a packaging gate. The runtime still supports the
real local rules; it is not replaced by an always-pass proxy mock.

Do not label a package complete before these sources/hashes and redistribution
obligations are reviewed. The Windows packaging script fails clearly if required
runtime components are absent. Upstreams:
[sing-geoip](https://github.com/SagerNet/sing-geoip) and
[sing-geosite](https://github.com/SagerNet/sing-geosite).

## S-UI and platform

S-UI is a separately installed upstream HTTP service, not an independently
rewritten first-party proxy engine. The exact supported S-UI version is not yet
verified; test a specifically selected version in isolation before deployment.
No persistent S-UI credentials are created by this review's helper scripts.

Windows WPF and System.Management 10.0.0 are still required for the client.
Actual Windows builds/TPM/TUN acceptance are distinct from Node API/mTLS tests.
At runtime the retained proxy code uses public connectivity/speed probes and
DNS providers. These providers were not contacted in tests and are not the
removed private control-service default.
