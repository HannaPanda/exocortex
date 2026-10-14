import { describe, expect, it } from 'vitest';

import {
  createExternalMcpServerRequestSchema,
  externalMcpFunctionName,
  parseExternalMcpFunctionName,
  suggestExternalMcpToolAccess,
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

describe('suggestExternalMcpToolAccess (issue #196)', () => {
  const suggest = (name: string, hints = {}) => suggestExternalMcpToolAccess({ name, hints });

  it('reads what only looks, by its name', () => {
    for (const name of [
      'health_list_meals',
      'health_get_profile',
      'health_search_foods',
      'health_dashboard',
      'health_meal_summary',
      'getUserStats',
    ]) {
      expect(suggest(name), name).toBe('read');
    }
  });

  it('writes what changes, even when a reading word is in the name too', () => {
    for (const name of [
      'health_log_meal',
      'health_upsert_food',
      'health_delete_marker',
      'health_check_routine_step',
      'get_or_create_user',
      'createInvoice',
    ]) {
      expect(suggest(name), name).toBe('write');
    }
  });

  it('writes when unsure', () => {
    expect(suggest('health_kcal_week')).toBe('write');
    expect(suggest('health_markers')).toBe('write');
  });

  it('weighs the server hints, but never above a writing word', () => {
    expect(suggest('health_markers', { readOnlyHint: true })).toBe('read');
    expect(suggest('health_list_meals', { readOnlyHint: false })).toBe('write');
    expect(suggest('health_list_meals', { destructiveHint: true })).toBe('write');
    expect(suggest('delete_all', { readOnlyHint: true })).toBe('write');
  });
});
