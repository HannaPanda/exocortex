/**
 * The isolation every LaTeX container runs under (issue #180).
 *
 * Both runners execute a program somebody in a workspace wrote: a render
 * template (ADR-026) or a whole project (ADR-027). TeX's restricted mode is
 * the first boundary; these flags are the second, so that a document which
 * escapes TeX still lands in a process that owns nothing:
 *
 *   - no network, so a build reads what it was handed and fetches nothing;
 *   - an unprivileged user with every capability dropped and no way to gain
 *     one back, whatever `USER` the configured image declares;
 *   - a read-only root filesystem, so the image's own TeX tree, fonts and
 *     binaries cannot be changed for the rest of the build;
 *   - one size-limited tmpfs at `/tmp` as the only writable place. It counts
 *     against `--memory`, so its size is part of that budget, not added to it.
 *
 * `/tmp` keeps `exec` on purpose. biber ships as a PAR archive that unpacks
 * itself into `$TMPDIR` and runs from there; with `noexec` every biblatex
 * project fails with errno 13. It buys little anyway: the container already
 * runs `sh` and `perl`, so a script needs no executable file to do anything.
 * `HOME` points into the tmpfs because TeX Live, luaotfload and fontconfig
 * write their user caches below it, and `nobody`'s home does not exist.
 *
 * Docker's default seccomp profile and AppArmor policy stay in force: nothing
 * here passes `--privileged` or an `unconfined` option.
 */

/** `nobody:nogroup`, present in every Alpine and Debian image. */
const SANDBOX_USER = '65534:65534';

export interface SandboxLimits {
  /** `--memory`, e.g. `2g`. */
  memory: string;
  /** Size of the writable `/tmp`, e.g. `1g`. Taken out of `memory`. */
  scratch: string;
}

export function sandboxArguments(limits: SandboxLimits): string[] {
  return [
    '--network=none',
    '--security-opt=no-new-privileges',
    '--cap-drop=ALL',
    `--user=${SANDBOX_USER}`,
    '--read-only',
    `--tmpfs=/tmp:rw,exec,nosuid,nodev,size=${limits.scratch},mode=1777`,
    '--env=HOME=/tmp',
    `--memory=${limits.memory}`,
    '--pids-limit=512',
  ];
}
