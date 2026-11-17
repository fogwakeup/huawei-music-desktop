import test from 'node:test';
import assert from 'node:assert/strict';
import { planRemoveFromQueue } from '../src/renderer/player.mjs';

const track = id => ({ id, title: id, artists: [], available: true });
const queue = ['A', 'B', 'C', 'D'].map(track);

test('removing the active row advances to the next track in play order', () => {
  const plan = planRemoveFromQueue(queue, [0, 1, 2, 3], 1, 'B');
  assert.deepEqual(plan.queue.map(item => item.id), ['A', 'C', 'D']);
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.cursor, 1);
  assert.equal(plan.activeRemoved, true);
  assert.deepEqual([0, 1, 2, 3].map(value => plan.remapCursor(value)).filter(value => value >= 0), [0, 1, 2]);
});

test('removing a row before the cursor keeps the same song playing', () => {
  const plan = planRemoveFromQueue(queue, [0, 1, 2, 3], 2, 'A');
  assert.deepEqual(plan.queue.map(item => item.id), ['B', 'C', 'D']);
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.cursor, 1, 'the active order position shifted left by one');
  assert.equal(plan.activeRemoved, false);
});

test('removing a row after the cursor keeps the cursor untouched', () => {
  const plan = planRemoveFromQueue(queue, [0, 1, 2, 3], 1, 'D');
  assert.deepEqual(plan.order, [0, 1, 2]);
  assert.equal(plan.cursor, 1);
  assert.deepEqual([0, 1, 2, 3].map(value => plan.remapCursor(value)).filter(value => value >= 0), [0, 1, 2]);
});

test('shuffle order and previous-track history are remapped consistently', () => {
  const plan = planRemoveFromQueue(queue, [2, 0, 3, 1], 0, 'C');
  assert.deepEqual(plan.queue.map(item => item.id), ['A', 'B', 'D']);
  assert.deepEqual(plan.order, [0, 2, 1]);
  assert.equal(plan.cursor, 0);
  assert.equal(plan.activeRemoved, true);
  assert.deepEqual([0, 1, 2, 3].map(value => plan.remapCursor(value)).filter(value => value >= 0), [0, 1, 2]);
});

test('the last removable row yields an empty queue and invalid cursor', () => {
  const plan = planRemoveFromQueue([track('A')], [0], 0, 'A');
  assert.deepEqual(plan.queue, []);
  assert.deepEqual(plan.order, []);
  assert.equal(plan.cursor, -1);
});

test('unknown ids and malformed inputs are rejected', () => {
  assert.equal(planRemoveFromQueue(queue, [0, 1, 2, 3], 0, 'Z'), null);
  assert.equal(planRemoveFromQueue(queue, [0, 1, 2, 3], 0, 42), null);
  assert.equal(planRemoveFromQueue(null, [0], 0, 'A'), null);
});
