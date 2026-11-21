import type { API } from 'homebridge';

export type MatterDeviceKind = 'switch' | 'outlet' | 'light';

export const MATTER_DEVICE_KINDS: MatterDeviceKind[] = ['switch', 'outlet', 'light'];

type MatterApi = NonNullable<API['matter']>;
type EndpointType = MatterApi['deviceTypes']['OnOffOutlet'];

/**
 * Matter 1.4 "Mounted On/Off Control" (0x010F). This is an in-wall switch that
 * turns a load on and off. It's the only Matter device type that is an
 * actual on/off switch, as opposed to:
 *   - OnOffLightSwitch (0x0103): a remote that controls other devices. It's a client and has no on/off state of its own.
 *   - OnOffPlugInUnit (0x010A): an outlet.
 * Homebridge 2.x doesn't include it in `api.matter.deviceTypes`, but its
 * required server clusters (Identify, Groups, OnOff with Lighting,
 * ScenesManagement) match OnOffPlugInUnit. So we reuse the outlet's
 * definition from Homebridge's own matter.js and change only the identity.
 */
const MOUNTED_ON_OFF_CONTROL = { name: 'MountedOnOffControl', deviceType: 0x010f, deviceRevision: 1 } as const;

/**
 * Copy a matter.js endpoint type with a different device type ID.
 *
 * matter.js's `with()`, `set()` and `withBehaviors()` rebuild the type from
 * the original options they closed over, which would quietly bring back the
 * outlet ID. Homebridge calls `with()` to add its handler behaviors, so we
 * wrap those methods to keep applying the override.
 */
function retype<T extends object>(base: T, identity: typeof MOUNTED_ON_OFF_CONTROL): T {
  const copy: Record<string, unknown> = { ...base, ...identity };
  for (const method of ['with', 'withBehaviors', 'set'] as const) {
    const original = (base as Record<string, unknown>)[method];
    if (typeof original === 'function') {
      copy[method] = (...args: unknown[]) => retype(original.apply(base, args), identity);
    }
  }
  return copy as T;
}

export function resolveMatterDeviceType(matter: MatterApi, kind: MatterDeviceKind): EndpointType {
  switch (kind) {
  case 'outlet':
    return matter.deviceTypes.OnOffOutlet;
  case 'light':
    return matter.deviceTypes.OnOffLight as unknown as EndpointType;
  case 'switch':
  default:
    return retype(matter.deviceTypes.OnOffOutlet, MOUNTED_ON_OFF_CONTROL);
  }
}

export function normalizeMatterDeviceKind(value: unknown): MatterDeviceKind {
  return MATTER_DEVICE_KINDS.includes(value as MatterDeviceKind) ? (value as MatterDeviceKind) : 'switch';
}
