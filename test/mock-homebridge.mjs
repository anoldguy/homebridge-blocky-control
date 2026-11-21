// A small stand-in for Homebridge's API, for platform tests.
// HAP uses the real hap-nodejs; Matter is a recording fake.
import { EventEmitter } from 'node:events';

import * as hap from '@homebridge/hap-nodejs';

export const quietLog = Object.assign(() => {}, { debug() {}, info() {}, warn() {}, error() {}, success() {} });

class FakePlatformAccessory extends hap.Accessory {
  constructor(displayName, uuid) {
    super(displayName, uuid);
    this.context = {};
  }
}

class MatterFailure extends Error {}

function fakeMatter(calls, { failRegister = false } = {}) {
  const deviceType = (id) => ({ deviceType: id });
  return {
    deviceTypes: {
      OnOffSwitch: deviceType(0x103),
      OnOffOutlet: deviceType(0x10a),
      OnOffLight: deviceType(0x100),
      WaterValve: deviceType(0x42),
    },
    clusterNames: {
      OnOff: 'onOff',
      ValveConfigurationAndControl: 'valveConfigurationAndControl',
      BridgedDeviceBasicInformation: 'bridgedDeviceBasicInformation',
    },
    status: { Failure: MatterFailure },
    async registerPlatformAccessories(_plugin, _platform, accessories) {
      if (failRegister) {
        throw new Error('matter register failed');
      }
      calls.matterRegistered.push(...accessories);
    },
    async unregisterPlatformAccessories(_plugin, _platform, accessories) {
      calls.matterUnregistered.push(...accessories);
    },
    async updateAccessoryState(uuid, cluster, attributes) {
      calls.matterUpdates.push({ uuid, cluster, attributes });
    },
  };
}

/**
 * @param {{ hap?: boolean, matter?: boolean, failMatterRegister?: boolean }} options
 */
export function makeApi({ hap: hapOn = true, matter: matterOn = false, failMatterRegister = false } = {}) {
  const calls = {
    hapRegistered: [],
    hapUpdated: [],
    hapUnregistered: [],
    matterRegistered: [],
    matterUnregistered: [],
    matterUpdates: [],
  };
  const api = Object.assign(new EventEmitter(), {
    hap,
    platformAccessory: FakePlatformAccessory,
    isHapEnabled: () => hapOn,
    isHapExternalsOnly: () => false,
    isMatterEnabled: () => matterOn,
    isMatterExternalsOnly: () => false,
    matter: matterOn ? fakeMatter(calls, { failRegister: failMatterRegister }) : undefined,
    registerPlatformAccessories: (_plugin, _platform, accessories) => calls.hapRegistered.push(...accessories),
    updatePlatformAccessories: (accessories) => calls.hapUpdated.push(...accessories),
    unregisterPlatformAccessories: (_plugin, _platform, accessories) => calls.hapUnregistered.push(...accessories),
  });
  return { api, calls };
}
