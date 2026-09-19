import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, DEFAULT_MODE, lobbyModeFor, rulesFor } from '../src/game/modes.js';

test('two modes, classic is the only stakeable one', () => {
  assert.deepEqual(Object.keys(MODES).sort(), ['classic', 'lbs']);
  assert.equal(MODES.classic.stakeable, true);
  assert.equal(MODES.lbs.stakeable, false);
  assert.equal(MODES.classic.fragments && MODES.classic.mints, true);
  assert.equal(MODES.lbs.fragments || MODES.lbs.mints, false);
});

test('lobbyModeFor: known modes pass, anything else is classic', () => {
  assert.equal(lobbyModeFor('classic'), 'classic');
  assert.equal(lobbyModeFor('lbs'), 'lbs');
  for (const bad of [undefined, null, 'multiplayer', 'LBS', 'toString', '__proto__', 7, {}]) {
    assert.equal(lobbyModeFor(bad), DEFAULT_MODE, String(bad));
  }
});

test('rulesFor: returns the frozen ruleset, throws on unknown', () => {
  assert.equal(rulesFor('lbs').roundMode, 'lbs-online');
  assert.ok(Object.isFrozen(rulesFor('classic')));
  assert.throws(() => rulesFor('nope'), /unknown mode/);
});
