/**
 * Provisions one person: an account, a workspace of their own, and ownership of
 * it.
 *
 * Self-registration is disabled (`emailAndPassword.disableSignUp`) and there is
 * no admin endpoint that creates users, on purpose -- accounts here are handed
 * out, not requested. This script is the supported way to hand one out.
 *
 *   pnpm db:provision-user --email a@b.de --name Stefan --workspace "Stefans Bereich"
 *
 * The password is generated and printed once. It is never stored anywhere else
 * and never mailed: pass it on over a channel you trust, and let the person
 * change it through "Passwort vergessen" afterwards, which reaches a real
 * mailbox now.
 *
 * `--role` sets the workspace role and defaults to OWNER, because the point of a
 * workspace of one's own is that nobody has to ask permission to arrange it. Use
 * `--workspace-of <slug>` instead to add someone to a workspace that exists.
 *
 * For an account that already exists, `--reset-password` issues a new one and
 * changes nothing else (no `--name`: the account has one, and this must not
 * touch it):
 *
 *   pnpm db:provision-user --email a@b.de --reset-password
 *
 * That is a separate flag rather than the default because running the create
 * command twice must never lock somebody out of their own account. It exists for
 * the two cases where "Passwort vergessen" cannot help: a mailbox nobody reads
 * any more, and the end-to-end suite's own accounts, whose password has to be
 * known to a script rather than to a person.
 */
import { randomBytes, scryptSync } from 'node:crypto';

import { loadDotEnv } from '@exocortex/config';

import { createPrismaClient, type PrismaClient } from '../src/client';

loadDotEnv();

const WORKSPACE_ROLES = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'] as const;
type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/**
 * Better Auth's default password hasher: scrypt, formatted `salt:hexDerivedKey`.
 * Same parameters as `seed.ts`, so an account created here signs in through the
 * normal login form with no special casing anywhere.
 */
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key = scryptSync(password.normalize('NFKC'), salt, 64, {
    N: 16_384,
    r: 16,
    p: 1,
    maxmem: 128 * 16_384 * 16 * 2,
  });
  return `${salt}:${key.toString('hex')}`;
}

/** 24 base64url characters, comfortably above the 12 character minimum. */
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/ä/gi, 'ae')
    .replace(/ö/gi, 'oe')
    .replace(/ü/gi, 'ue')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'arbeitsbereich';
}

/** Mirrors `WorkspacesService.findFreeSlug`: append -2, -3, … until one is free. */
async function findFreeSlug(prisma: PrismaClient, desired: string): Promise<string> {
  let candidate = desired;
  let suffix = 2;
  while ((await prisma.workspace.findUnique({ where: { slug: candidate } })) !== null) {
    candidate = `${desired}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

interface Options {
  email: string;
  name: string;
  workspaceName: string | undefined;
  workspaceOf: string | undefined;
  role: WorkspaceRole;
  resetPassword: boolean;
}

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    // pnpm passes its own `--` separator straight through to argv.
    if (key === undefined || key === '--' || !key.startsWith('--')) continue;
    const next = argv[index + 1];
    // A switch takes no value, so the next `--something` is the next argument
    // and not a missing one.
    if (next === undefined || next.startsWith('--')) {
      if (key === '--reset-password') {
        flags.add(key.slice(2));
        continue;
      }
      throw new Error(`Missing value for ${key}`);
    }
    values.set(key.slice(2), next);
    index += 1;
  }

  const resetPassword = flags.has('reset-password');

  const email = values.get('email');
  // A reset needs no name: the account it belongs to already has one, and this
  // command is not allowed to change it.
  const name = values.get('name') ?? (resetPassword ? '' : undefined);
  if (email === undefined || name === undefined) {
    throw new Error('Both --email and --name are required');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error(`Not an email address: ${email}`);
  }

  const role = (values.get('role') ?? 'OWNER') as WorkspaceRole;
  if (!WORKSPACE_ROLES.includes(role)) {
    throw new Error(`--role must be one of ${WORKSPACE_ROLES.join(', ')}`);
  }

  const workspaceName = values.get('workspace');
  const workspaceOf = values.get('workspace-of');
  if (workspaceName !== undefined && workspaceOf !== undefined) {
    throw new Error('Use either --workspace (create one) or --workspace-of (join one)');
  }

  return { email, name, workspaceName, workspaceOf, role, resetPassword };
}

/**
 * Issues a new password for an account that already exists, and touches nothing
 * else: not the name, not the roles, not the memberships. Whoever runs this is
 * fixing a way in, not editing a person.
 */
async function resetPassword(prisma: PrismaClient, email: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, name: true },
  });
  if (user === null) {
    throw new Error(`No user with ${email}. Drop --reset-password to create one.`);
  }

  const account = await prisma.account.findFirst({
    where: { userId: user.id, providerId: 'credential' },
    select: { id: true },
  });
  if (account === null) {
    throw new Error(`${email} has no password login to reset (${user.id}).`);
  }

  const password = generatePassword();
  await prisma.account.update({
    where: { id: account.id },
    data: { password: hashPassword(password) },
  });
  // Every session signed in with the old password is left standing on purpose:
  // this reissues a key, it does not throw anyone out. Disabling an account is
  // what does that, and it is a different operation in the admin area.

  console.log('');
  console.log('Password reset.');
  console.log(`  user     : ${user.name} <${email}> (${user.id})`);
  console.log('');
  console.log('  New password, shown here and stored nowhere else:');
  console.log(`    ${password}`);
  console.log('');
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const prisma = createPrismaClient();

  try {
    if (options.resetPassword) {
      await resetPassword(prisma, options.email);
      return;
    }

    const existing = await prisma.user.findUnique({
      where: { email: options.email },
      select: { id: true },
    });
    if (existing !== null) {
      // Resetting someone's password is a different, more dangerous operation
      // than creating them; it does not get to happen by accident because a
      // command was run twice.
      throw new Error(
        `A user with ${options.email} already exists (${existing.id}). ` +
          'Pass --reset-password to issue a new password, or change roles deliberately.',
      );
    }

    const password = generatePassword();
    const user = await prisma.user.create({
      data: {
        email: options.email,
        name: options.name,
        // The address was chosen by an administrator rather than typed by a
        // stranger, which is the thing verification exists to establish.
        emailVerified: true,
      },
      select: { id: true },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        providerId: 'credential',
        // Better Auth's own convention for a credential account is that the
        // account id *is* the user id (`sign-up.mjs`), not the address, and
        // since 1.7 `signInEmail` refuses to find an account that says
        // otherwise. Written after the user rather than nested inside it,
        // because it needs an id that does not exist until then.
        accountId: user.id,
        password: hashPassword(password),
      },
    });

    let workspaceId: string;
    let workspaceName: string;
    let workspaceSlug: string;

    if (options.workspaceOf !== undefined) {
      const workspace = await prisma.workspace.findUnique({
        where: { slug: options.workspaceOf },
        select: { id: true, name: true, slug: true },
      });
      if (workspace === null) {
        throw new Error(`No workspace with slug ${options.workspaceOf}`);
      }
      ({ id: workspaceId, name: workspaceName, slug: workspaceSlug } = workspace);
    } else {
      const desiredName = options.workspaceName ?? `${options.name}s Arbeitsbereich`;
      const slug = await findFreeSlug(prisma, slugify(desiredName));
      const workspace = await prisma.workspace.create({
        data: { name: desiredName, slug },
        select: { id: true, name: true, slug: true },
      });
      ({ id: workspaceId, name: workspaceName, slug: workspaceSlug } = workspace);
    }

    await prisma.workspaceMember.create({
      data: { workspaceId, userId: user.id, role: options.role },
    });

    console.log('');
    console.log('User provisioned.');
    console.log(`  user      : ${options.name} <${options.email}> (${user.id})`);
    console.log(`  workspace : ${workspaceName} [${workspaceSlug}] (${workspaceId})`);
    console.log(`  role      : ${options.role}`);
    console.log('');
    console.log('  One-time password, shown here and stored nowhere else:');
    console.log(`    ${password}`);
    console.log('');
    console.log('  Hand it over on a channel you trust. They can change it through');
    console.log('  "Passwort vergessen" on the login page.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Provisioning failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
