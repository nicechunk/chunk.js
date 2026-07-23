# Security Policy

Chunk.js is pre-release software under active development. The npm package is currently private and no npm release is a supported distribution channel.

## Supported versions

| Version | Security support |
| --- | --- |
| Current `main` branch | Receives security fixes during active development |
| Older commits, forks, and copied snapshots | Not maintained by this project |
| npm packages | None are currently published or supported |

Security fixes may require consumers to update to a newer commit. This policy does not promise long-term support for a particular API, file format, browser, or deployment.

## Report a vulnerability privately

Do not publish the vulnerability, exploit steps, credentials, or affected private data in an issue, pull request, discussion, or other public channel. GitHub private vulnerability reporting is not currently enabled for this repository.

If you already have a trusted private channel to a repository maintainer, use it only to request a secure reporting route before sharing exploit details. Otherwise, open the repository's [security contact request](https://github.com/nicechunk/chunk.js/issues/new?template=security_contact.yml). That request is public: include no vulnerability details or sensitive information, and wait for a maintainer to provide a private route.

Include, when applicable:

- the affected commit and entry point;
- the security impact and the conditions required to trigger it;
- minimal reproduction steps or a proof of concept;
- browser, Node.js, operating-system, and host-integration details;
- whether untrusted NCM/NCF data, worker messages, chain/account data, or external assets are involved; and
- any mitigation you have already tested.

Remove credentials, private keys, access tokens, personal data, and unrelated production data. If a real credential was exposed, revoke or rotate it immediately; reporting it does not make it safe to keep using.

The maintainers will assess reports according to impact, reproducibility, and available project capacity. No acknowledgement, remediation, disclosure, or release-time service level is promised. Please coordinate public disclosure with the maintainers so users have a reasonable opportunity to apply an available fix.

## Scope

This policy covers code maintained in this repository, including its native ESM browser modules, WebGL2 renderer, module workers, codecs, parsers, and standalone examples.

NiceChunk host applications, servers, chain programs, accounts, deployment infrastructure, and externally supplied assets are separate systems. Report a problem to the owner of the affected system unless the root cause is in this repository. A reference to an external URL or host file does not bring that system into this policy's scope.

Security-sensitive boundaries include, but are not limited to:

- parsing untrusted NCM, NCF, snapshot, or account data;
- integer bounds, allocation limits, and malformed mesh inputs;
- worker message validation and fallback behavior;
- WebGL resource lifecycle and context restoration;
- cross-origin asset and module loading; and
- accidental inclusion of secrets or private host fixtures.

## Safe research expectations

Use local fixtures and accounts you control. Do not access other users' data, disrupt a service, degrade availability, perform social engineering, or retain data beyond what is necessary to demonstrate the issue. Stop testing and report privately if you encounter sensitive information. This repository does not promise a bug bounty or safe-harbor program.

## Supply-chain and licensing reports

Privately report suspected malicious dependencies, compromised release material, or leaked credentials as security issues. Questions limited to ownership, trademarks, or asset licensing should follow [docs/license-status.md](docs/license-status.md) and are not, by themselves, vulnerability reports.
