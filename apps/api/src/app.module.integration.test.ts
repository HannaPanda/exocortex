import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import { AppModule } from './app.module';

/**
 * That the application can actually be constructed.
 *
 * Written after `ProjectsModule` (issue #43) shipped through `build.sh` green
 * and then refused to start: it injected `OutboxService`, which `PlatformModule`
 * provides but deliberately does not export, so every module that needs it
 * lists it among its own providers. Nothing about that is visible to
 * TypeScript -- the constructor parameter has a type and the type resolves --
 * and nothing about it is visible to a unit test of the service either, because
 * a unit test passes the dependency in by hand.
 *
 * Compiling the real module graph is what sees it. Nest resolves every provider
 * of every module here, which is the same work it does at boot, so a missing or
 * unexported provider fails here instead of in `deploy.sh` after the units have
 * already been restarted.
 *
 * It is an integration test and named like one. Prisma itself connects lazily,
 * but Better Auth's OAuth provider plugin seeds its resource rows while the
 * module initialises (Better Auth 1.7), so compiling the graph opens a database
 * connection whether the test asks for one or not. Without a database that
 * arrives as an unhandled rejection rather than a failed expectation, which is
 * the worst of both: red, and about nothing the test was asking. `deploy.sh`
 * runs it by name in step 5b, where infrastructure exists and the units have
 * not been restarted yet.
 */
describe('AppModule', () => {
  it('resolves every provider of every module', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();

    // Reaching one provider per layer proves the graph was built rather than
    // merely parsed. `get` throws when the token is not resolvable.
    expect(moduleRef.get(AppModule, { strict: false })).toBeDefined();

    await moduleRef.close();
  }, 60_000);
});
