import test from 'node:test';
import assert from 'node:assert/strict';
import { MODES, ARENA, SANDBOX_LBS, DEFAULT_MODE, SOLO_MODES, lobbyModeFor, rulesFor, isStakeableRoundMode } from '../src/game/modes.js';

test('two lobby modes: arena is the only stakeable one, sandbox admits guests', () => {
  assert.deepEqual(Object.keys(MODES).sort(), [ARENA, SANDBOX_LBS].sort());
  assert.equal(MODES[ARENA].stakeable, true);
  assert.equal(MODES[ARENA].guests, false);
  assert.equal(MODES[SANDBOX_LBS].stakeable, false);
  assert.equal(MODES[SANDBOX_LBS].guests, true);
  assert.equal(MODES[ARENA].fragments && MODES[ARENA].mints && MODES[ARENA].bots && MODES[ARENA].powerups, true, 'the classic ruleset, unchanged');
  assert.equal(MODES[SANDBOX_LBS].fragments || MODES[SANDBOX_LBS].mints || MODES[SANDBOX_LBS].bots || MODES[SANDBOX_LBS].powerups, false);
});

test('lobbyModeFor: new names, old aliases, and anything unknown falls into the sandbox never the arena', () => {
  assert.equal(lobbyModeFor('arena'), ARENA);
  assert.equal(lobbyModeFor('sandbox-lbs'), SANDBOX_LBS);
  assert.equal(lobbyModeFor('classic'), ARENA, 'alias');
  assert.equal(lobbyModeFor('lbs'), SANDBOX_LBS, 'alias');
  for (const bad of [undefined, null, 'multiplayer', 'ARENA', 'toString', '__proto__', 7, {}]) {
    assert.equal(lobbyModeFor(bad), DEFAULT_MODE, String(bad));
  }
  assert.equal(DEFAULT_MODE, SANDBOX_LBS);
});

test('round modes: only arena is stakeable; every solo mode is sandbox', () => {
  assert.equal(isStakeableRoundMode(MODES[ARENA].roundMode), true);
  assert.equal(isStakeableRoundMode(MODES[SANDBOX_LBS].roundMode), false);
  for (const m of SOLO_MODES) { assert.ok(m.startsWith('sandbox-')); assert.equal(isStakeableRoundMode(m), false); }
  assert.equal(MODES[ARENA].roundMode, 'arena');
});

test('rulesFor: returns the frozen ruleset, throws on unknown', () => {
  assert.ok(Object.isFrozen(rulesFor(ARENA)));
  assert.throws(() => rulesFor('classic'), /unknown mode/, 'rulesFor takes lobby modes, not aliases');
  assert.throws(() => rulesFor('nope'), /unknown mode/);
});

test('lobby wait: the arena waits 10s because bots fill it, the sandbox waits 30s for people', () => {
  assert.equal(MODES[ARENA].waitSeconds, 10);
  assert.equal(MODES[SANDBOX_LBS].waitSeconds, 30);
});
