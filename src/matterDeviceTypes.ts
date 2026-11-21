import type { API, MatterAccessory } from 'homebridge';

export type MatterDeviceKind = 'switch' | 'outlet' | 'light';

export const MATTER_DEVICE_KINDS: MatterDeviceKind[] = ['switch', 'outlet', 'light'];

type MatterApi = NonNullable<API['matter']>;

/**
 * Maps the config value to one of Homebridge's built-in Matter device types.
 * 'switch' uses `OnOffSwitch` (Matter On/Off Light Switch, 0x0103). Other
 * Homebridge plugins use the same type for virtual switches, e.g.
 * homebridge-dummy and homebridge-rainbird.
 */
export function resolveMatterDeviceType(matter: MatterApi, kind: MatterDeviceKind): MatterAccessory['deviceType'] {
  switch (kind) {
  case 'outlet':
    return matter.deviceTypes.OnOffOutlet;
  case 'light':
    return matter.deviceTypes.OnOffLight;
  case 'switch':
  default:
    return matter.deviceTypes.OnOffSwitch;
  }
}

export function normalizeMatterDeviceKind(value: unknown): MatterDeviceKind {
  return MATTER_DEVICE_KINDS.includes(value as MatterDeviceKind) ? (value as MatterDeviceKind) : 'switch';
}
