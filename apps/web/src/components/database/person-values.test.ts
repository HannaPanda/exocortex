import { describe, expect, it } from 'vitest';

import { personIdsOfValue, pickerChoices, resolvePerson, samePeople } from './person-values';

const members = [
  { userId: 'u_anna', name: 'Anna' },
  { userId: 'u_ben', name: 'Ben' },
];

describe('personIdsOfValue', () => {
  it('reads a list, a single id and nothing', () => {
    expect(personIdsOfValue(['u_anna', 3, 'u_ben'])).toEqual(['u_anna', 'u_ben']);
    expect(personIdsOfValue('u_anna')).toEqual(['u_anna']);
    expect(personIdsOfValue(null)).toEqual([]);
    expect(personIdsOfValue('')).toEqual([]);
  });
});

describe('resolvePerson', () => {
  it('prefers the row, which knows who left', () => {
    const rowPeople = [{ id: 'u_carla', name: 'Carla', member: false }];
    expect(resolvePerson('u_carla', rowPeople, members)).toEqual({
      id: 'u_carla',
      name: 'Carla',
      state: 'former',
    });
  });

  it('names a member just picked from the member list', () => {
    expect(resolvePerson('u_ben', [], members)).toEqual({
      id: 'u_ben',
      name: 'Ben',
      state: 'member',
    });
  });

  it('calls an id the answered row does not know a deleted account', () => {
    expect(resolvePerson('u_gone', [], members).state).toBe('deleted');
  });

  it('calls it unknown when there is no row to ask', () => {
    expect(resolvePerson('u_gone', undefined, null)).toEqual({
      id: 'u_gone',
      name: null,
      state: 'unknown',
    });
  });
});

describe('pickerChoices', () => {
  it('offers the members, then whoever the cell held that left', () => {
    expect(pickerChoices(members, ['u_ben', 'u_carla'])).toEqual(['u_anna', 'u_ben', 'u_carla']);
  });

  it('offers only the cell to a reader without a member list', () => {
    expect(pickerChoices(null, ['u_carla'])).toEqual(['u_carla']);
  });
});

describe('samePeople', () => {
  it('compares in order', () => {
    expect(samePeople(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(samePeople(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(samePeople([], ['a'])).toBe(false);
  });
});
