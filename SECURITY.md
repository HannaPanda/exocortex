# Security policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability.

- **Preferred:** GitHub's private vulnerability reporting on this repository
  (Security tab, "Report a vulnerability"). The report, the discussion and a
  fix can stay private until the fix is live.
- **Mail:** johanna@hannapanda.de, subject starting with `[security]`.

Useful in a report: what an attacker needs beforehand (an account, a role, a
token scope, a setting switched on), what they get, and the shortest way to see
it. Test against your own installation, never against `exocortex.app` or
anybody else's.

## What happens next

eXocortex is maintained by one person, so these are intentions rather than a
service level:

- an acknowledgement within a week
- a first assessment (confirmed, needs more, not a vulnerability) within two
  weeks
- a fix for a confirmed high-severity finding as soon as it can be made and
  deployed, normally within 30 days, with a coordinated date for publishing
  the details

Credit in the advisory is yours if you want it.

## Scope

The code in this repository, and the deployment configuration under `deploy/`.
Dependencies are in scope where eXocortex uses them in a way that makes a known
weakness reachable.

## How findings are written about

The rules this project follows for describing a vulnerability in public, in
issues, commits and documentation, are in `docs/security.md` under "Writing
about a vulnerability in public". In short: while a finding is open, the public
side says what class of problem it is and what it affects, and the technical
detail stays private.
