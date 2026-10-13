/**
 * A container image reference as the build sandbox accepts it (issue #175).
 *
 * The same pattern `isImageReference` in `packages/sandbox/src/policy.ts`
 * checks before it hands the name to `docker run`, restated here because the
 * broker has no dependencies and this package is a leaf. A setting that the
 * broker would refuse on every build is now refused when it is saved instead,
 * and every value the broker has ever accepted still passes, so a custom image
 * that works today keeps working. The pattern is syntax only: whether the image
 * exists on this machine is a question nobody here can answer without asking
 * the broker, and the broker never pulls (ADR-081).
 */
export const CONTAINER_IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,299}$/;

export function isContainerImageReference(value: string): boolean {
  return CONTAINER_IMAGE_REFERENCE.test(value);
}

/** The settings that name the image a build runs in. */
export const CONTAINER_IMAGE_SETTING_KEYS = ['render.image', 'projects.image'] as const;

export type ContainerImageSettingKey = (typeof CONTAINER_IMAGE_SETTING_KEYS)[number];

export function isContainerImageSettingKey(key: string): key is ContainerImageSettingKey {
  return (CONTAINER_IMAGE_SETTING_KEYS as readonly string[]).includes(key);
}
