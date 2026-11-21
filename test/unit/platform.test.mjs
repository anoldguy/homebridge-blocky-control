import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import { BlockyPlatform } from '../../dist/platform.js';
import { startFakeBlocky } from '../fake-blocky.mjs';
import { makeApi, quietLog } from '../mock-homebridge.mjs';

describe('BlockyPlatform', () => {
  let fake;
  const platforms = [];

  before(async () => {
    fake = await startFakeBlocky({ port: 0 });
  });
  after(async () => {
    await fake.close();
  });
  afterEach(() => {
    for (const p of platforms.splice(0)) {
      p.api.emit('shutdown');
    }
  });

  /** Build a platform and run setup() directly (normally triggered by didFinishLaunching). */
  async function setUp(config, apiOptions, cache = {}) {
    const { api, calls } = makeApi(apiOptions);
    const platform = new BlockyPlatform(quietLog, { platform: 'BlockyControl', pollInterval: 0, ...config }, api);
    platforms.push(platform);
    for (const accessory of cache.hap ?? []) {
      platform.configureAccessory(accessory);
    }
    for (const accessory of cache.matter ?? []) {
      platform.configureMatterAccessory(accessory);
    }
    await platform.setup();
    return { platform, api, calls };
  }

  it('gives every Matter accessory a distinct serial number that does not contain the URL', async () => {
    const { calls } = await setUp({ url: fake.url, pauseMinutes: [5, 10, 60] }, { hap: false, matter: true });
    const serials = calls.matterRegistered.map((a) => a.serialNumber);
    assert.equal(serials.length, 4);
    assert.equal(new Set(serials).size, 4);
    for (const serial of serials) {
      assert.ok(serial.length <= 32, serial);
      assert.ok(!serial.includes('127.0.0.1'), serial);
    }
  });

  it('keeps the same accessory UUIDs when the URL text changes', async () => {
    const a = await setUp({ url: fake.url }, { hap: true, matter: true });
    const b = await setUp({ url: `${fake.url}/` }, { hap: true, matter: true });
    assert.equal(a.calls.hapRegistered[0].UUID, b.calls.hapRegistered[0].UUID);
    assert.deepEqual(a.calls.matterRegistered.map((x) => x.UUID), b.calls.matterRegistered.map((x) => x.UUID));
  });

  it('keeps URL-seeded accessories from earlier versions instead of re-creating them', async () => {
    const { api } = makeApi();
    const legacyUuid = api.hap.uuid.generate(`blocky:${fake.url}:hap`);
    const cached = new api.platformAccessory('Blocky', legacyUuid);
    const { calls } = await setUp({ url: fake.url }, { hap: true }, { hap: [cached] });
    assert.deepEqual(calls.hapRegistered, []);
    assert.deepEqual(calls.hapUnregistered, []);
    assert.deepEqual(calls.hapUpdated.map((x) => x.UUID), [legacyUuid]);
  });

  it('still publishes HAP and starts polling when Matter registration fails', async () => {
    const { platform, calls } = await setUp({ url: fake.url, pollInterval: 60 }, { hap: true, matter: true, failMatterRegister: true });
    assert.equal(calls.hapRegistered.length, 1);
    assert.ok(platform.controller.pollTimer, 'polling should be running');
  });

  it('marks Matter accessories unreachable while blocky is down', async () => {
    const { calls } = await setUp({ url: 'http://127.0.0.1:1', timeout: 1, pauseMinutes: [5] }, { hap: false, matter: true });
    await new Promise((r) => setImmediate(r));
    const reachability = calls.matterUpdates.filter((u) => u.cluster === 'bridgedDeviceBasicInformation');
    assert.equal(reachability.length, 2);
    assert.ok(reachability.every((u) => u.attributes.reachable === false));
  });

  it('keeps cached accessories and publishes nothing when the URL is invalid', async () => {
    const { api } = makeApi();
    const cached = new api.platformAccessory('Blocky', api.hap.uuid.generate('anything'));
    const { calls } = await setUp({ url: '192.168.1.2:4000' }, { hap: true }, { hap: [cached] });
    assert.deepEqual(calls.hapRegistered, []);
    assert.deepEqual(calls.hapUnregistered, []);
  });

  it('keeps cached accessories when the URL is missing', async () => {
    const { api } = makeApi();
    const cached = new api.platformAccessory('Blocky', api.hap.uuid.generate('anything'));
    const { calls } = await setUp({ url: '' }, { hap: true, matter: true }, { hap: [cached], matter: [{ UUID: 'm1', displayName: 'Blocky' }] });
    assert.deepEqual(calls.hapUnregistered, []);
    assert.deepEqual(calls.matterUnregistered, []);
  });
});
