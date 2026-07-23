# License and Asset Status

This document explains what the repository's MIT License does and does not cover. It is a practical inventory, not legal advice. If this document conflicts with an applicable license or written authorization, the license or authorization controls.

## MIT-covered material

The root [`LICENSE`](../LICENSE) applies to the repository code owned by the project unless a file carries a different notice. It also expressly applies to the embedded default avatar model stored as `DEFAULT_PEASANT_GUY_NCM` in `renderer/avatar-mesh.js`, including that encoded model data as shipped in this repository.

The default avatar exception is narrow. It covers the inline `DEFAULT_PEASANT_GUY_NCM` payload and the repository code that decodes or renders it. It does not automatically cover a model loaded from `/media/vox/chr_peasant_guy_blackhair.ncm`, `/public/media/vox/chr_peasant_guy_blackhair.ncm`, a host application, a chain account, a user, or any other external source, even if that model has the same name or appearance.

Contributors must have the right to provide their work under the MIT License. A commit, path reference, generated output, or successful load at runtime is not evidence of ownership or permission.

## Governance-document exception

[`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) is an adapted Contributor Covenant version 2.1 document. Its footer identifies the source, describes the project-specific adaptation, and applies the source document's [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/). That file is not relicensed by the root MIT License. Other repository-owned governance documents remain within the MIT grant unless they carry their own notice.

## NiceChunk names and branding

The MIT License is a copyright license, not a trademark license. The NiceChunk name, logos, product names, service marks, domain names, branding, and trade dress are excluded from the MIT grant. No permission to imply endorsement, affiliation, or official status is granted. Any use of those marks requires separate permission under the applicable trademark policy or written authorization.

Descriptive references needed to explain compatibility with NiceChunk do not transfer ownership of a mark and should not imply sponsorship.

## External and host-provided material

The MIT License in this repository does not cover material that is merely referenced, fetched, mounted, generated from, or supplied by another source. Examples include:

- models, textures, images, audio, fonts, locale files, rule tables, and other assets loaded from host paths or URLs;
- NiceChunk application files, chain programs, account data, snapshots, and deployment configuration outside this repository;
- user-created NCM/NCF payloads, blueprints, characters, or forged items;
- fixtures or shared files from sibling repositories; and
- third-party libraries, specifications, or data carrying their own terms.

Each item remains governed by its own license, terms, and authorization. Preserve its notices and do not redistribute it through this repository unless the project has confirmed the necessary rights. Source code that contains a URL, import path, fallback lookup, or compatible decoder does not grant a license to the referenced content.

## Shared files and Apache-licensed repositories

Do not blindly copy, mirror, or synchronize a file between this repository and an Apache-licensed repository. A shared maintainer, similar filename, generated output, or technical compatibility does not create permission or dual-license the file.

Before any transfer in either direction:

1. Obtain explicit authorization for the specific source, destination, and intended distribution.
2. Identify the copyright holder, source repository and revision, original license, and whether the file was generated or modified.
3. Review license compatibility and the obligations of both repositories, including attribution, modification notices, patent terms, and any `NOTICE` requirements.
4. Preserve required copyright, license, provenance, and NOTICE text.
5. Record the review and the modifications in the destination pull request.
6. Keep the repositories separate if authorization or provenance is uncertain.

This process applies even when a destination uses Apache-2.0 and a source uses MIT. License compatibility does not replace an actual license grant, provenance evidence, or repository authorization.

## Contribution checklist

Before adding code or content, confirm that:

- it was authored for the contribution or is accompanied by a compatible license and complete provenance;
- it contains no NiceChunk mark or external/host asset being treated as MIT-covered without separate permission;
- generated files can be traced to inputs that the project is allowed to use and redistribute;
- files derived from third-party policy or documentation preserve their source, license, attribution, and modification notice;
- required third-party notices will remain with the material; and
- any cross-repository sync has completed the explicit authorization and review described above.

When the status is unclear, leave the material out of the repository and request a maintainer review. Do not use a placeholder license assertion to make an integration test pass.
