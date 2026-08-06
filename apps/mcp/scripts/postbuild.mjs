#!/usr/bin/env node
// Makes the compiled entry point executable so `bin.exocortex-mcp` (and a
// direct `./dist/main.js` invocation) works without an explicit `node` prefix.
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = fileURLToPath(new URL('../dist/main.js', import.meta.url));
chmodSync(target, 0o755);
