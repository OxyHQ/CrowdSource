# @crowdsource/console

The CrowdSource developer and Trust & Safety console.

**Not scaffolded yet.** This directory is the reserved workspace for it; there is
no application here, and the manifest declares no build so nothing pretends
otherwise.

Scope when it is built:

- Developer console — organizations, applications, members and roles; service
  credentials, scopes, rotation and revocation; custom resource schemas; policy
  sets and versions; webhook endpoints, secrets, attempts, replay and DLQ; a
  case and decision explorer scoped to the tenant; usage and quotas; a sandbox
  with simulated cases.
- Trust & Safety console — specialist queues and escalations, critical appeals
  and corrected decisions, suspect applications and reviewers, taxonomy and Oxy
  conduct policy, cross-application incidents, retention and legal holds,
  quality and wellbeing metrics.

Both surfaces are one app: the Trust & Safety views are the same console gated by
an internal role, not a second deployment.
