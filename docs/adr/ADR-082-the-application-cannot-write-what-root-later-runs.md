# ADR-082: the application cannot write what root later runs

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-081 (the Docker socket), issue #183, issue #184

## Context

ADR-081 took the Docker socket away from the four application units, which
closed the direct path from code execution in one of them to root. A delayed
path stayed open: all four ran as `johanna` with
`ReadWritePaths=/var/www/exocortex`, and the repository holds what a person
later runs as root. `scripts/deploy.sh` calls sudo, installs
`deploy/systemd/*` and `deploy/nginx/*` into `/etc`, and copies
`packages/sandbox/dist` root-owned into `/usr/local/lib/exocortex-sandbox`,
which would have handed the socket straight back. `build.sh` runs code out of
`node_modules` in the same terminal, with the same sudo timestamp.

Three ways out were on the table. A separate system user for the units means
re-owning the repository, the `.env` and the web releases, and every developer
command on this host would need a group dance. Hashing what `deploy.sh`
installs against the build covers `packages/sandbox/dist` but not the script
doing the hashing. Making the repository read-only to the units covers all of
it at once, and it costs nothing, because none of them writes there.

## Decision

- **The four units run with `ProtectSystem=strict` and no `ReadWritePaths`.**
  The whole file system is read-only to them; their scratch space is the
  private `/tmp` of `PrivateTmp=`. `ProtectHome=true` stays, which also hides
  `/run/user` and with it `johanna`'s own systemd manager, the one place an
  unconfined process could be started from without a password.
- **A feature that needs to write gets a directory outside the repository.**
  Never a `ReadWritePaths` back into `/var/www/exocortex`: a writable corner
  of the repository is a corner the next deploy might execute.
- **`deploy.sh` checks the running units, not the files.** After the restart
  it reads `ProtectSystem` and `ReadWritePaths` back through `systemctl show`
  for all four and fails when either has loosened.

## Consequences

- Before the change, the units' run-time writes under the repository were
  looked for in the source (no write outside `/tmp`) and in the web releases
  (`next start` wrote nothing into `.next-live` while live). A transient unit
  with the same properties could not write `scripts/`, `.env`,
  `packages/sandbox/dist`, `deploy/`, `node_modules` or the web release, and
  could still read the `.env`, use `/tmp` and connect to the broker socket.
- A Next.js feature that writes its cache at run time (image optimisation,
  incremental regeneration) would fail here. It is not in use; adopting one
  means a cache directory outside the repository.
- Other processes running as `johanna` (backups, development sessions) can
  still write the repository. They are not the processes reachable from the
  internet, and confining them is a different question.
