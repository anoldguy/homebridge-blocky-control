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
});
