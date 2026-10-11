# ADR-081: the application never holds the Docker socket

- Status: accepted
- Date: 2026-10-11
- Relates to: ADR-026 (rendering is a derived view), ADR-027 (projects),
  issue #180 (the hardened container), issue #183

## Context

Render and project builds run LaTeX in a container, and the worker used to
start it with `docker run`. That worked because the account all four units
run as is in the `docker` group, and that is the problem: reaching the Docker
socket is root on the host. `docker run -v /:/host` needs no exploit.

Issue #180 hardened the container against a document that escapes TeX. It
did nothing about code execution in the worker itself, through a dependency
or a parser bug, because that code held the socket. Neither did it stop an
admin setting `render.image` to a value starting with `--`, which `docker run`
would have read as one more flag.

Three ways out were on the table. Rootless Docker or Podman for a separate
user would make the socket worth less, at the price of a second daemon, a
second image store and a 1.7 GB image pulled twice on a host whose memory is
already shared. A generic socket proxy filters by API endpoint, and
`POST /containers/create` is the endpoint that takes a bind mount, so it
filters nothing that matters here. A broker that knows exactly one container
shape is small, and it is the only one of the three where the flags stop
being the caller's to choose.

## Decision

- **None of the four application units can reach Docker.** Each hides
  `/run/docker.sock` and `/run/containerd` with `InaccessiblePaths=`. The
  account keeps its group; the unit does not get to use it.
- **A build is a request to `exocortex-sandbox`.** The request is a profile
  (`render` or `project`), an image reference and a shell script, and
  nothing else: an unknown field is refused, and an image reference has to
  start with a letter or digit. Memory, scratch size, the time ceiling and
  every isolation flag come from `packages/sandbox/src/policy.ts` on the
  broker's side: `--network=none`, `--user=65534:65534`, `--cap-drop=ALL`,
  `no-new-privileges`, `--read-only`, one tmpfs, `--pull=never`, no mount.
- **The broker runs as its own system user from a root-owned copy.**
  `exocortex-sandbox` is in the `docker` group and nothing else, has no
  login and no home, and runs `/usr/local/lib/exocortex-sandbox/main.js`,
  which `deploy.sh` installs from `packages/sandbox/dist`. Not from the
  repository: `/var/www/exocortex` is writable by the units this protects
  against, and a file they could edit would run with the socket at the next
  restart. The package therefore has no dependencies, internal or external.
- **systemd owns the socket.** `exocortex-sandbox.socket` creates it as
  `exocortex-sandbox:johanna`, mode 0660, and hands it to the broker as file
  descriptor 3, which is how a socket can belong to the broker's user and
  the worker's group at once.
- **A dropped connection is a cancel.** End of input is a frame of its own,
  so a connection that ends before the exit frame is a client that gave up;
  the broker then tells the daemon to kill the named container, because
  killing the CLI alone leaves it running. The same happens at the profile's
  time ceiling and when the broker stops.
- **Nothing is pulled.** An image is on the machine because the operator put
  it there; a missing one is "no such image", which the runners already
  report as an unavailable renderer.

## Consequences

- A compromised worker can still start a LaTeX container, with an image
  that is already on the machine, as often as four at a time. It cannot
  start a privileged one, mount anything, publish a port, reach a network or
  pull an image.
- `render.image` and `projects.image` stay admin settings. What an admin can
  do with them is now choose among local images, not choose flags.
- A development machine runs the broker by hand
  (`pnpm --filter @exocortex/sandbox start`), listening on
  `EXOCORTEX_SANDBOX_SOCKET`. Without it, builds report the renderer as
  unavailable, the way a missing `docker` binary did.
- The repository was still writable by the four units, and `deploy.sh`, which
  a person runs with sudo, lives in it. That separate path from a compromised
  process to root is closed by ADR-082.
