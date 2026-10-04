# CrowdSource: published SDK adoption

Source `8e998da334d6b4a063237641b90f37733fcbd852` pins the published SDK and its measured compatible Bloom version, including the regenerated lockfile. Existing application behavior and previously reviewed fixes remain in the branch.

Validation: {"receiverPassed": 1, "sdkImporterMembers": 6579, "bloomImporterMembers": 41880, "typesBuildTwoExports": "passed", "externalExportMaps": 177, "localRuntimeAudit": "passed UID1001,140 package names,zero tooling targets", "securityAudit": "passed approved exact expiring graph"}. Exact commands, logs, archive member hashes and importer resolutions are in [proof.json](proof.json).

- Published registry archives and all installed SDK importer members were compared byte for byte. Stale same-version candidate materializations were retained and repaired with a frozen install; their setup failures remain in the records.
- Local web export proves compilation, not browser/native acceptance or deployed public-client configuration. Required PR/main CI and root image/promotion remain separate.
- No production database, provider writes, grants, credentials or auth fixtures were changed. Owned PostgreSQL was stopped and its PID absence verified.
- Root accepted final tooling policy review a4a21043094f172d40f1694043e0d21e77b9d73123ae9f694f84952188837696. Only the three exact advisory/package pairs qualify, with graph/peer/archive/Docker pins and absolute expiry2026-10-09T22:00:00Z. All other advisory refusal remains.
- The measured runtime image is local amd64. Final ARM image and independent runtime audit remain deployment requirements. Source maps were produced solely for inspection and are not deployment artifacts.
- The initial Bun1.3.14 frozen setup failed; canonical Bun1.4.2 install passed. Initial receiver run omitted its required owned PostgreSQL URL; rerun with ownedPG passed, then the process was stopped. Filtered test is not full-suite acceptance.
