/**
 * The one container shape the broker starts (issues #180 and #183).
 *
 * Both callers execute a program somebody in a workspace wrote: a render
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
 * They live here, in the broker, and not in the worker that asks for a build.
 * The worker names a profile, an image and a script; every flag is chosen on
 * this side of the socket, so a compromised worker can ask for a container
 * but never for a privileged one, a mount or a network (issue #183).
 *
 * `/tmp` keeps `exec` on purpose. biber ships as a PAR archive that unpacks
 * itself into `$TMPDIR` and runs from there; with `noexec` every biblatex
 * project fails with errno 13. It buys little anyway: the container already
 * runs `sh` and `perl`, so a script needs no executable file to do anything.
 * `HOME` points into the tmpfs because TeX Live, luaotfload and fontconfig
 * write their user caches below it, and `nobody`'s home does not exist.
 *
 * `--pull=never`: an image name is a setting an admin types, and a pull is a
 * download from a registry of somebody's choosing onto this host's disk. Which
 * images exist on the machine stays the operator's decision (`docker pull`,
 * `docker build`); a name that is not there comes back as "no such image",
 * which the runners already report as an unavailable renderer.
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
  /**
   * The broker's own ceiling in seconds. The worker kills a build at the
   * configured timeout long before; this is what holds when it does not.
   */
  maxSeconds: number;
}

/**
 * What a caller may ask for. The limits are fixed per profile rather than
 * passed in, because a limit the caller chooses is no limit against the caller.
 * `maxSeconds` sits above the largest timeout the settings allow
 * (`render.timeoutSeconds` 900, `projects.timeoutSeconds` 1800).
 */
export const SANDBOX_PROFILES = {
  render: { memory: '2g', scratch: '1g', maxSeconds: 960 },
  project: { memory: '3g', scratch: '1536m', maxSeconds: 1_860 },
} as const satisfies Record<string, SandboxLimits>;

export type SandboxProfile = keyof typeof SANDBOX_PROFILES;

export function isSandboxProfile(value: unknown): value is SandboxProfile {
  return typeof value === 'string' && Object.hasOwn(SANDBOX_PROFILES, value);
}

/**
 * An image reference as `docker run` takes it, and nothing that could be read
 * as an option. The first character is what matters most: the image is a
 * positional argument after the flags, so a value starting with `-` would be
 * parsed as one more flag (`--privileged`).
 */
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,299}$/;

export function isImageReference(value: unknown): value is string {
  return typeof value === 'string' && IMAGE_REFERENCE.test(value);
}

export function sandboxArguments(limits: Pick<SandboxLimits, 'memory' | 'scratch'>): string[] {
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

/** Every container the broker starts carries this label, so they can be found. */
export const SANDBOX_LABEL = 'org.exocortex.sandbox=1';

/** The complete `docker` argument list for one run. */
export function dockerRunArguments(options: {
  name: string;
  profile: SandboxProfile;
  image: string;
  script: string;
}): string[] {
  return [
    'run',
    '--rm',
    '--interactive',
    '--pull=never',
    `--name=${options.name}`,
    `--label=${SANDBOX_LABEL}`,
    ...sandboxArguments(SANDBOX_PROFILES[options.profile]),
    '--entrypoint=sh',
    options.image,
    '-c',
    options.script,
  ];
}
