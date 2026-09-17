/**
 * Development seed.
 *
 * Creates two users (Johanna, Stefan), one shared workspace and a set of nested
 * example pages whose content is real Yjs state, so the seeded pages behave
 * exactly like pages created through the UI.
 *
 * Passwords are never hardcoded: they come from `SEED_JOHANNA_PASSWORD` /
 * `SEED_STEFAN_PASSWORD`, or a one-time password is generated and printed.
 */
import { randomBytes, scryptSync } from 'node:crypto';

import { loadDotEnv } from '@exocortex/config';
import { markdownToYjsState, SEED_PAGES } from '@exocortex/editor';

import { createPrismaClient, type PrismaClient } from '../src/client';
import { generateOrderKey } from '../src/order-key';

loadDotEnv();

interface SeedUser {
  email: string;
  name: string;
  passwordEnvVariable: string;
}

const SEED_USERS: SeedUser[] = [
  { email: 'johanna@exocortex.app', name: 'Johanna', passwordEnvVariable: 'SEED_JOHANNA_PASSWORD' },
  { email: 'stefan@exocortex.app', name: 'Stefan', passwordEnvVariable: 'SEED_STEFAN_PASSWORD' },
];

/**
 * Better Auth's default password hasher is scrypt with the format
 * `salt:hexDerivedKey`. Reproducing it here keeps seeding independent of the
 * running API, and a seeded user can sign in through the normal login form.
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

function generatePassword(): string {
  // 18 bytes of base64url: comfortably above the 12 character minimum.
  return randomBytes(18).toString('base64url');
}

interface SeedPage {
  readonly title: string;
  readonly icon: string;
  readonly markdown: string;
  readonly children: readonly SeedPage[];
}

async function createPageTree(
  prisma: PrismaClient,
  input: {
    workspaceId: string;
    userId: string;
    parentId: string | null;
    pages: readonly SeedPage[];
  },
): Promise<number> {
  let created = 0;
  let orderKey: string | null = null;

  for (const page of input.pages) {
    orderKey = generateOrderKey(orderKey, null);
    const imported = markdownToYjsState(page.markdown);

    const document = await prisma.document.create({
      data: {
        workspaceId: input.workspaceId,
        parentId: input.parentId,
        type: 'PAGE',
        title: page.title,
        icon: page.icon,
        orderKey,
        createdById: input.userId,
        updatedById: input.userId,
        content: {
          create: {
            yjsState: Buffer.from(imported.yjsState),
            schemaVersion: imported.schemaVersion,
            proseMirrorJson: imported.proseMirrorJson,
            plainText: imported.plainText,
            markdown: page.markdown,
            materializedAt: new Date(),
          },
        },
        searchIndex: {
          create: {
            workspaceId: input.workspaceId,
            title: page.title,
            plainText: imported.plainText,
          },
        },
      },
      select: { id: true },
    });
    created += 1;

    if (page.children.length > 0) {
      created += await createPageTree(prisma, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        parentId: document.id,
        pages: page.children,
      });
    }
  }

  return created;
}

/**
 * The production administrator. Promoting her to the global ADMIN role must be
 * reproducible from the seed script, but the seed script must never create her:
 * she already exists in production and seeding must stay safe to run there.
 */
const PRODUCTION_ADMIN_EMAIL = 'johanna@hannapanda.de';

async function promoteProductionAdmin(prisma: PrismaClient): Promise<void> {
  const result = await prisma.user.updateMany({
    where: { email: PRODUCTION_ADMIN_EMAIL, role: { not: 'ADMIN' } },
    data: { role: 'ADMIN' },
  });
  if (result.count > 0) {
    console.log(`  promoted ${PRODUCTION_ADMIN_EMAIL} to ADMIN`);
  }
}

async function main(): Promise<void> {
  const prisma = createPrismaClient();
  const printedCredentials: { email: string; password: string }[] = [];

  try {
    await promoteProductionAdmin(prisma);

    const users = [];
    for (const seedUser of SEED_USERS) {
      const fromEnvironment = process.env[seedUser.passwordEnvVariable];
      const password =
        fromEnvironment !== undefined && fromEnvironment.length >= 12
          ? fromEnvironment
          : generatePassword();
      if (fromEnvironment === undefined || fromEnvironment.length < 12) {
        printedCredentials.push({ email: seedUser.email, password });
      }

      const user = await prisma.user.upsert({
        where: { email: seedUser.email },
        create: {
          email: seedUser.email,
          name: seedUser.name,
          emailVerified: true,
        },
        update: {
          name: seedUser.name,
          emailVerified: true,
        },
        select: { id: true, email: true },
      });

      // Re-seeding must also reset the credential, otherwise the printed
      // password would not work on a second run. The account is written here
      // rather than nested in the upsert because it needs the user's id, which
      // is not known until the row exists.
      await prisma.account.deleteMany({ where: { userId: user.id, providerId: 'credential' } });
      await prisma.account.create({
        data: {
          userId: user.id,
          providerId: 'credential',
          // Better Auth's own convention for a credential account is that the
          // account id *is* the user id (`sign-up.mjs`), not the address. It
          // used to be the address here, and better-auth 1.7 turned that from
          // an inconsistency into a locked door: `signInEmail` now looks for an
          // account whose `accountId` equals the user id and reports "user not
          // found" when there is none.
          accountId: user.id,
          password: hashPassword(password),
        },
      });

      users.push(user);
    }

    const [johanna, stefan] = users;
    if (johanna === undefined || stefan === undefined) {
      throw new Error('Seeding failed: expected two users');
    }

    const workspace = await prisma.workspace.upsert({
      where: { slug: 'exocortex-team' },
      create: { name: 'eXocortex Team', slug: 'exocortex-team' },
      update: { name: 'eXocortex Team' },
      select: { id: true },
    });

    for (const [user, role] of [
      [johanna, 'OWNER'],
      [stefan, 'MEMBER'],
    ] as const) {
      await prisma.workspaceMember.upsert({
        where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
        create: { workspaceId: workspace.id, userId: user.id, role },
        update: { role },
      });
    }

    // Idempotent: a re-run rebuilds the example pages from scratch.
    const existing = await prisma.document.count({ where: { workspaceId: workspace.id } });
    if (existing > 0) {
      await prisma.document.deleteMany({ where: { workspaceId: workspace.id } });
    }

    const pageCount = await createPageTree(prisma, {
      workspaceId: workspace.id,
      userId: johanna.id,
      parentId: null,
      pages: SEED_PAGES as readonly SeedPage[],
    });

    console.log('');
    console.log('eXocortex seed completed.');
    console.log(`  workspace : eXocortex Team (${workspace.id})`);
    console.log(`  users     : ${users.map((user) => user.email).join(', ')}`);
    console.log(`  pages     : ${pageCount}`);

    if (printedCredentials.length > 0) {
      console.log('');
      console.log('  One-time development credentials (not stored anywhere else):');
      for (const credential of printedCredentials) {
        console.log(`    ${credential.email}  ${credential.password}`);
      }
      console.log('');
      console.log('  Set SEED_JOHANNA_PASSWORD / SEED_STEFAN_PASSWORD in .env to');
      console.log('  choose them yourself.');
    }
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Seeding failed:', error);
  process.exit(1);
});
