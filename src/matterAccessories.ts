import type { API, Logging, MatterAccessory } from 'homebridge';

import type { BlockyController, BlockySnapshot } from './blockyController.js';
import type { BlockyControl } from './controls.js';
import { type MatterDeviceKind, resolveMatterDeviceType } from './matterDeviceTypes.js';
import { MANUFACTURER, MODEL, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

/**
 * Publishes each control as its own Matter on/off endpoint. By default that's
 * a Mounted On/Off Control (switch); see matterDeviceTypes.ts.
 */
export class BlockyMatterAccessories {
  /** last OnOff value sent to Matter for each UUID, so unchanged values aren't sent again */
  private readonly lastPushed = new Map<string, boolean>();
  private readonly uuids = new Map<string, string>();

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly controller: BlockyController,
    private readonly controls: BlockyControl[],
    private readonly uuidSeed: string,
    private readonly kind: MatterDeviceKind,
  ) {
    // The device type is part of the UUID (except 'outlet', which keeps the original UUIDs). Changing the
    // type creates new accessories instead of changing existing ones in place, which controllers like Apple
    // Home often don't pick up.
    const typeSeed = kind === 'outlet' ? '' : `:${kind}`;
    for (const control of controls) {
      this.uuids.set(control.id, api.hap.uuid.generate(`${uuidSeed}:matter${typeSeed}:${control.id}`));
    }
  }

  get wantedUuids(): Set<string> {
    return new Set(this.uuids.values());
  }

  /**
   * Register every control. Cached accessories with the same UUID are
   * restored by Homebridge, and their handlers are attached again.
   */
  async register(): Promise<void> {
    const matter = this.api.matter;
    if (!matter) {
      return;
    }
    const snapshot = this.controller.snapshot;
    const deviceType = resolveMatterDeviceType(matter, this.kind);
    const accessories: MatterAccessory[] = this.controls.map((control) => {
      const uuid = this.uuids.get(control.id)!;
      const on = control.isOn(snapshot);
      this.lastPushed.set(uuid, on);
      return {
        UUID: uuid,
        displayName: control.displayName,
        deviceType,
        serialNumber: `${this.uuidSeed}-${control.id}`.slice(0, 32),
        manufacturer: MANUFACTURER,
        model: MODEL,
        context: { controlId: control.id },
        clusters: {
          onOff: { onOff: on },
        },
        handlers: {
          onOff: {
            on: () => this.handle(control, uuid, true),
            off: () => this.handle(control, uuid, false),
            toggle: () => this.handle(control, uuid, !control.isOn(this.controller.snapshot)),
          },
        },
      };
    });

    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    this.controller.on('change', (snap) => void this.push(snap));
    this.log.info(`Registered ${accessories.length} Matter ${this.kind} accessor${accessories.length === 1 ? 'y' : 'ies'}`);
  }

  private async handle(control: BlockyControl, uuid: string, on: boolean): Promise<void> {
    const previous = this.lastPushed.get(uuid);
    // Homebridge sets this value itself once the handler returns. Record it now so push() doesn't send it again.
    this.lastPushed.set(uuid, on);
    try {
      await control.set(on);
    } catch (error) {
      if (previous !== undefined) {
        this.lastPushed.set(uuid, previous);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new this.api.matter!.status.Failure(`Blocky request failed: ${message}`);
    }
  }

  private async push(snapshot: BlockySnapshot): Promise<void> {
    const matter = this.api.matter;
    if (!matter || !snapshot.known) {
      return;
    }
    for (const control of this.controls) {
      const uuid = this.uuids.get(control.id)!;
      const on = control.isOn(snapshot);
      if (this.lastPushed.get(uuid) === on) {
        continue;
      }
      this.lastPushed.set(uuid, on);
      try {
        await matter.updateAccessoryState(uuid, matter.clusterNames.OnOff, { onOff: on });
      } catch (error) {
        this.lastPushed.delete(uuid);
        this.log.debug(`Failed to update Matter state for ${control.displayName}:`, error);
      }
    }
  }
}
