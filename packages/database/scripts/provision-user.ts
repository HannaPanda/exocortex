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
}

function parseArguments(argv: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    // pnpm passes its own `--` separator straight through to argv.
    if (key === undefined || key === '--' || !key.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`Missing value for ${key}`);
    }
    values.set(key.slice(2), next);
    index += 1;
  }

  const email = values.get('email');
  const name = values.get('name');
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

  return { email, name, workspaceName, workspaceOf, role };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const prisma = createPrismaClient();

  try {
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
          'This script only creates; change roles or passwords deliberately.',
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
        accounts: {
          create: {
            providerId: 'credential',
            accountId: options.email,
            password: hashPassword(password),
          },
        },
      },
      select: { id: true },
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
