import { describe, expect, it } from 'vitest';

import {
  createExternalMcpServerRequestSchema,
  externalMcpFunctionName,
  parseExternalMcpFunctionName,
} from './external-mcp';

describe('external MCP function names (issue #196)', () => {
  it('splits back at the first double underscore, so a tool may contain one', () => {
    const name = externalMcpFunctionName('health', 'log__weight_x');
    expect(name).toBe('mcp_health__log__weight_x');
    expect(parseExternalMcpFunctionName(name)).toEqual({
      serverKey: 'health',
      toolName: 'log__weight_x',
    });
  });

  it('answers null for everything that is not one', () => {
    for (const name of ['exo_page_read', 'mcp_health', 'mcp___x', 'mcp_Health__x', 'mcp_h__x']) {
      expect(parseExternalMcpFunctionName(name)).toBeNull();
    }
  });
});

describe('createExternalMcpServerRequestSchema', () => {
  const base = { key: 'health', name: 'Health', url: 'https://health.example.org/mcp' };

  it('accepts a bearer server', () => {
    expect(
      createExternalMcpServerRequestSchema.safeParse({
        ...base,
        authKind: 'bearer',
        secret: 'hmcp_0123456789',
      }).success,
    ).toBe(true);
  });

  it('refuses plain http, credentials in the address and a key with an underscore', () => {
    for (const input of [
      { ...base, url: 'http://health.example.org/mcp' },
      { ...base, url: 'https://user:pw@health.example.org/mcp' },
      { ...base, key: 'my_server' },
    ]) {
      expect(createExternalMcpServerRequestSchema.safeParse(input).success).toBe(false);
    }
  });

  it('refuses a header the transport owns, and a secret over two lines', () => {
    expect(
      createExternalMcpServerRequestSchema.safeParse({
        ...base,
        authKind: 'header',
        authHeaderName: 'Mcp-Session-Id',
        secret: '0123456789ab',
      }).success,
    ).toBe(false);
    expect(
      createExternalMcpServerRequestSchema.safeParse({
        ...base,
        authKind: 'bearer',
        secret: '01234567\r\nX-Evil: 1',
      }).success,
    ).toBe(false);
  });
});
