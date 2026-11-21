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

  describe('HAP accessory', () => {
    const service = (accessory, type, subtype) => accessory.getServiceById(type, subtype);

    it('has a Switch for the main control and a Valve per pause', async () => {
      const { api, calls } = await setUp({ url: fake.url, pauseMinutes: [5, 60] }, { hap: true });
      const accessory = calls.hapRegistered[0];
      const { Service, Characteristic } = api.hap;
      assert.ok(service(accessory, Service.Switch, 'blocking'));
      const valve = service(accessory, Service.Valve, 'pause-60');
      assert.ok(valve);
      assert.equal(valve.getCharacteristic(Characteristic.SetDuration).value, 3600);
      assert.ok(!valve.getCharacteristic(Characteristic.SetDuration).props.perms.includes(api.hap.Perms.PAIRED_WRITE));
    });

    it('switches to plain Switch services with pauseStyle switch, removing the old valves', async () => {
      const first = await setUp({ url: fake.url, pauseMinutes: [5] }, { hap: true });
      const accessory = first.calls.hapRegistered[0];
      first.api.emit('shutdown');
      const { api } = await setUp({ url: fake.url, pauseMinutes: [5], pauseStyle: 'switch' }, { hap: true }, { hap: [accessory] });
      assert.ok(service(accessory, api.hap.Service.Switch, 'pause-5'));
      assert.equal(service(accessory, api.hap.Service.Valve, 'pause-5'), undefined);
    });

    it('turns blocky off and on from the characteristics', async () => {
      const { api, calls } = await setUp({ url: fake.url, pauseMinutes: [5] }, { hap: true });
      const accessory = calls.hapRegistered[0];
      const { Service, Characteristic } = api.hap;
      const active = service(accessory, Service.Valve, 'pause-5').getCharacteristic(Characteristic.Active);
      await active.handleSetRequest(Characteristic.Active.ACTIVE);
      assert.equal(fake.state.enabled, false);
      assert.ok(fake.state.until > Date.now() + 290_000);
      await active.handleSetRequest(Characteristic.Active.INACTIVE);
      assert.equal(fake.state.enabled, true);
    });

    it('reports No Response while blocky is unreachable', async () => {
      const { api, calls } = await setUp({ url: 'http://127.0.0.1:1', timeout: 1, pauseMinutes: [] }, { hap: true });
      const on = service(calls.hapRegistered[0], api.hap.Service.Switch, 'blocking').getCharacteristic(api.hap.Characteristic.On);
      const noResponse = api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
      await assert.rejects(on.handleGetRequest(), (e) => e === noResponse || e.hapStatus === noResponse);
    });
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
