import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { BlockyClient } from '../../dist/blockyClient.js';
import { BlockyController } from '../../dist/blockyController.js';
import { buildControls, formatMinutes, isTimer, normalizePauseMinutes, normalizePauseStyle } from '../../dist/controls.js';
import { normalizeMatterDeviceKind } from '../../dist/matterDeviceTypes.js';
import { startFakeBlocky } from '../fake-blocky.mjs';

const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

describe('BlockyController against fake blocky', () => {
  let fake;
  let controller;
  let controls;
  const byId = (id) => controls.find((c) => c.id === id);
  const states = () => Object.fromEntries(controls.map((c) => [c.id, c.isOn(controller.snapshot)]));

  before(async () => {
    fake = await startFakeBlocky({ port: 0 });
  });
  after(async () => {
    await fake.close();
  });
  beforeEach(async () => {
    controller?.stop();
    await fetch(`${fake.url}/api/blocking/enable`);
    fake.state.requests.length = 0;
    const client = new BlockyClient({ url: `${fake.url}/`, timeoutMs: 2000 });
    controller = new BlockyController(client, quietLog, { pauseMinutes: [5, 10, 60], pollIntervalSeconds: 0 });
    controls = buildControls(controller, 'Blocky', [5, 10, 60]);
    await controller.refresh();
  });

  it('starts with the main switch on and pauses off', () => {
    assert.deepEqual(states(), { 'blocking': true, 'pause-5': false, 'pause-10': false, 'pause-60': false });
  });

  it('main switch off disables with no time limit', async () => {
    await byId('blocking').set(false);
    assert.equal(fake.state.enabled, false);
    assert.equal(fake.state.until, 0);
    assert.ok(fake.state.requests.includes('GET /api/blocking/disable'));
    assert.deepEqual(states(), { 'blocking': false, 'pause-5': false, 'pause-10': false, 'pause-60': false });
    await byId('blocking').set(true);
    assert.equal(fake.state.enabled, true);
  });

  it('pause switch disables for N minutes and switching pauses moves the switch', async () => {
    await byId('pause-10').set(true);
    assert.ok(fake.state.requests.includes('GET /api/blocking/disable?duration=10m'));
    assert.deepEqual(states(), { 'blocking': false, 'pause-5': false, 'pause-10': true, 'pause-60': false });
    assert.ok(controller.snapshot.autoEnableInSec > 590);

    await byId('pause-60').set(true);
    assert.deepEqual(states(), { 'blocking': false, 'pause-5': false, 'pause-10': false, 'pause-60': true });
  });

  it('turning off the active pause turns blocking back on', async () => {
    await byId('pause-5').set(true);
    await byId('pause-5').set(false);
    assert.equal(fake.state.enabled, true);
    assert.deepEqual(states(), { 'blocking': true, 'pause-5': false, 'pause-10': false, 'pause-60': false });
  });

  it('turning off a pause switch that is not active does nothing', async () => {
    await byId('pause-5').set(true);
    fake.state.requests.length = 0;
    await byId('pause-60').set(false);
    assert.equal(fake.state.enabled, false);
    assert.equal(fake.state.requests.length, 0);
  });

  it('a quick on-then-off of a pause switch ends with blocking on', async () => {
    // Don't wait for the pause to finish before cancelling it.
    await Promise.all([byId('pause-60').set(true), byId('pause-60').set(false)]);
    assert.equal(fake.state.enabled, true);
    assert.deepEqual(states(), { 'blocking': true, 'pause-5': false, 'pause-10': false, 'pause-60': false });
  });

  it('toggles based on the state when the request runs', async () => {
    await Promise.all([byId('blocking').toggle(), byId('blocking').toggle()]);
    assert.equal(fake.state.enabled, true);
    await Promise.all([byId('pause-5').toggle(), byId('pause-5').toggle(), byId('pause-5').toggle()]);
    assert.equal(fake.state.enabled, false);
    assert.deepEqual(states(), { 'blocking': false, 'pause-5': true, 'pause-10': false, 'pause-60': false });
  });

  it('turning on the main switch ends a pause', async () => {
    await byId('pause-60').set(true);
    await byId('blocking').set(true);
    assert.deepEqual(states(), { 'blocking': true, 'pause-5': false, 'pause-10': false, 'pause-60': false });
  });

  it('matches a timed disable made by another client to the closest pause switch', async () => {
    await fetch(`${fake.url}/api/blocking/disable?duration=8m`);
    await controller.refresh();
    assert.deepEqual(states(), { 'blocking': false, 'pause-5': false, 'pause-10': true, 'pause-60': false });
  });

  it('picks up a re-enable made by another client', async () => {
    await byId('pause-5').set(true);
    await fetch(`${fake.url}/api/blocking/enable`);
    await controller.refresh();
    assert.deepEqual(states(), { 'blocking': true, 'pause-5': false, 'pause-10': false, 'pause-60': false });
  });

  it('emits change events', async () => {
    const seen = [];
    controller.on('change', (s) => seen.push(s.blockingEnabled));
    await byId('blocking').set(false);
    await byId('blocking').set(true);
    assert.deepEqual(seen, [false, true]);
  });

  it('sends configured groups', async () => {
    const client = new BlockyClient({ url: fake.url, timeoutMs: 2000, groups: ['ads'] });
    await client.disable(5);
    assert.ok(fake.state.requests.includes('GET /api/blocking/disable?duration=5m&groups=ads'));
    assert.deepEqual(fake.state.disabledGroups, ['ads']);
  });

  it('turns blocking back on when blocky\'s timer runs out', async () => {
    await fetch(`${fake.url}/api/blocking/disable?duration=1s`);
    await controller.refresh();
    assert.equal(controller.snapshot.blockingEnabled, false);
    await new Promise((r) => setTimeout(r, 1300));
    await controller.refresh();
    assert.equal(controller.snapshot.blockingEnabled, true);
  });
});

describe('error handling', () => {
  it('rejects actions and marks unreachable when blocky is down', async () => {
    const client = new BlockyClient({ url: 'http://127.0.0.1:1', timeoutMs: 500 });
    const controller = new BlockyController(client, quietLog, { pauseMinutes: [5], pollIntervalSeconds: 0 });
    await controller.refresh();
    assert.equal(controller.snapshot.reachable, false);
    assert.equal(controller.snapshot.known, false);
    await assert.rejects(controller.pause(5), /Could not reach blocky/);
  });

  it('keeps blocky reachable when it refuses a request with an HTTP error', async () => {
    const fake = await startFakeBlocky({ port: 0 });
    try {
      const client = new BlockyClient({ url: fake.url, timeoutMs: 2000, groups: ['nope'] });
      const controller = new BlockyController(client, quietLog, { pauseMinutes: [5], pollIntervalSeconds: 0 });
      await controller.refresh();
      fake.state.requests.length = 0;
      await assert.rejects(controller.pause(5), /HTTP 400/);
      assert.equal(controller.snapshot.reachable, true);
      assert.equal(controller.snapshot.blockingEnabled, true);
      assert.ok(fake.state.requests.includes('GET /api/blocking/status'), 're-reads the real state');
    } finally {
      await fake.close();
    }
  });

  it('reports HTTP errors from blocky', async () => {
    const fake = await startFakeBlocky({ port: 0 });
    try {
      const client = new BlockyClient({ url: fake.url, timeoutMs: 2000, groups: ['nope'] });
      await assert.rejects(client.disable(5), /HTTP 400/);
    } finally {
      await fake.close();
    }
  });
});

describe('polling', () => {
  it('does not build up a backlog of status requests while blocky is slow', async () => {
    let calls = 0;
    const slowClient = {
      status: () => {
        calls += 1;
        return new Promise((r) => setTimeout(() => r({ enabled: true }), 30));
      },
    };
    const controller = new BlockyController(slowClient, quietLog, { pauseMinutes: [], pollIntervalSeconds: 0 });
    const first = Array.from({ length: 10 }, () => controller.refresh());
    await new Promise((r) => setTimeout(r, 5)); // the first refresh is now running
    const second = Array.from({ length: 10 }, () => controller.refresh());
    await Promise.all([...first, ...second]);
    assert.equal(calls, 2);
  });
});

describe('helpers', () => {
  it('formats minutes', () => {
    assert.equal(formatMinutes(5), '5 Minutes');
    assert.equal(formatMinutes(1), '1 Minute');
    assert.equal(formatMinutes(60), '1 Hour');
    assert.equal(formatMinutes(120), '2 Hours');
    assert.equal(formatMinutes(90), '90 Minutes');
  });

  it('normalizes pause minutes', () => {
    assert.deepEqual(normalizePauseMinutes(undefined, [5, 10]), [5, 10]);
    assert.deepEqual(normalizePauseMinutes([60, '5', 5, -1, 2.5, 'x'], []), [5, 60]);
    assert.deepEqual(normalizePauseMinutes([], [5]), []);
  });

  it('picks which controls are timers', () => {
    const controls = buildControls({}, 'Blocky', [5]);
    assert.deepEqual(controls.map((c) => isTimer(c, 'valve')), [false, true]);
    assert.deepEqual(controls.map((c) => isTimer(c, 'switch')), [false, false]);
    assert.equal(controls[1].minutes, 5);
  });

  it('normalizes pause style and Matter device kind', () => {
    assert.equal(normalizePauseStyle(undefined), 'valve');
    assert.equal(normalizePauseStyle('switch'), 'switch');
    assert.equal(normalizePauseStyle('bogus'), 'valve');
    assert.equal(normalizeMatterDeviceKind(undefined), 'switch');
    assert.equal(normalizeMatterDeviceKind('outlet'), 'outlet');
    assert.equal(normalizeMatterDeviceKind('nope'), 'switch');
  });
});
