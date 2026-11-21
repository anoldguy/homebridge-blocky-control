import type { API, Logging, MatterAccessory } from 'homebridge';

import type { BlockyController, BlockySnapshot } from './blockyController.js';
import { type BlockyControl, isTimer, type PauseStyle } from './controls.js';
import { type MatterDeviceKind, resolveMatterDeviceType } from './matterDeviceTypes.js';
import { MANUFACTURER, MODEL, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

type MatterApi = NonNullable<API['matter']>;

/** ValveConfigurationAndControl.ValveState */
const VALVE_CLOSED = 0;
const VALVE_OPEN = 1;

/**
 * Publishes each control as its own Matter accessory:
 *  - the main control, and pauses when pauseStyle is 'switch': an on/off accessory (`matterDeviceType`)
 *  - pauses when pauseStyle is 'valve': a Water Valve with a fixed open duration and a remaining-time countdown
 *
 * Homebridge's valve handler sets open/closed state only. It replaces
 * matter.js's built-in timer, so this class sends remainingDuration itself,
 * using blocky's autoEnableInSec.
 */
export class BlockyMatterAccessories {
  /** last state sent for each UUID (JSON), so unchanged state isn't sent again */
  private readonly lastPushed = new Map<string, string>();
  private readonly uuids = new Map<string, string>();
  /** command currently being handled; pushes wait for it so they don't overlap with Homebridge's own state update */
  private inFlight: Promise<unknown> = Promise.resolve();
  /** reachability last sent to Matter; Homebridge registers accessories as reachable */
  private reachablePushed = true;

  constructor(
    private readonly api: API,
    private readonly log: Logging,
    private readonly controller: BlockyController,
    private readonly controls: BlockyControl[],
    private readonly uuidSeed: string,
    private readonly kind: MatterDeviceKind,
    private readonly pauseStyle: PauseStyle,
  ) {
    for (const control of controls) {
      this.uuids.set(control.id, api.hap.uuid.generate(`${uuidSeed}:matter${this.typeSeed(control)}:${control.id}`));
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
    const accessories = this.controls.map((control): MatterAccessory => {
      const uuid = this.uuids.get(control.id)!;
      const base = {
        UUID: uuid,
        displayName: control.displayName,
        // Derived from the UUID: unique per accessory, at most 32 characters, and doesn't reveal the blocky URL.
        serialNumber: uuid.replace(/-/g, ''),
        manufacturer: MANUFACTURER,
        model: MODEL,
        context: { controlId: control.id },
      };
      if (isTimer(control, this.pauseStyle)) {
        const state = this.valveState(control, snapshot);
        this.lastPushed.set(uuid, JSON.stringify(state));
        return {
          ...base,
          deviceType: matter.deviceTypes.WaterValve,
          clusters: {
            valveConfigurationAndControl: {
              ...state,
              defaultOpenDuration: control.minutes * 60,
              openDuration: control.minutes * 60,
            },
          },
          handlers: {
            valveConfigurationAndControl: {
              // The requested openDuration is ignored, because each valve has a fixed pause length.
              open: () => this.handle(() => control.set(true)),
              close: () => this.handle(() => control.set(false)),
            },
          },
        };
      }
      const on = control.isOn(snapshot);
      this.lastPushed.set(uuid, JSON.stringify({ onOff: on }));
      return {
        ...base,
        deviceType: resolveMatterDeviceType(matter, this.kind),
        clusters: { onOff: { onOff: on } },
        handlers: {
          onOff: {
            on: () => this.handle(() => control.set(true)),
            off: () => this.handle(() => control.set(false)),
            toggle: () => this.handle(() => control.toggle()),
          },
        },
      };
    });

    await matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
    this.controller.on('change', (snap) => void this.push(snap));
    // Homebridge publishes accessories as reachable; correct that now if blocky is down.
    void this.push(snapshot);
    const valves = this.controls.filter((c) => isTimer(c, this.pauseStyle)).length;
    this.log.info(`Registered ${accessories.length - valves} Matter ${this.kind} and ${valves} valve accessories`);
  }

  /**
   * The Matter device type ID is part of the UUID (except for outlets, which keep the original UUIDs).
   * Apple Home drops a device if the same UUID comes back with a different type, so changing the type
   * has to create new accessories (see homebridge/homebridge#4034).
   */
  private typeSeed(control: BlockyControl): string {
    const matter = this.api.matter;
    if (!matter) {
      return '';
    }
    if (isTimer(control, this.pauseStyle)) {
      return `:0x${matter.deviceTypes.WaterValve.deviceType.toString(16)}`;
    }
    return this.kind === 'outlet' ? '' : `:0x${resolveMatterDeviceType(matter, this.kind).deviceType.toString(16)}`;
  }

  private valveState(control: BlockyControl, snapshot: BlockySnapshot) {
    const open = control.isOn(snapshot);
    return {
      currentState: open ? VALVE_OPEN : VALVE_CLOSED,
      targetState: open ? VALVE_OPEN : VALVE_CLOSED,
      remainingDuration: open ? snapshot.autoEnableInSec : null,
    };
  }

  private handle(action: () => Promise<void>): Promise<void> {
    const run = (async () => {
      try {
        await action();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new this.api.matter!.status.Failure(`Blocky request failed: ${message}`);
      }
    })();
    this.inFlight = run.catch(() => undefined);
    return run;
  }

  private async push(snapshot: BlockySnapshot): Promise<void> {
    const matter = this.api.matter;
    if (!matter) {
      return;
    }
    // Let Homebridge finish its own state update for a command before sending ours.
    await this.inFlight;
    await this.pushReachable(matter, snapshot.reachable);
    if (!snapshot.known) {
      return;
    }
    for (const control of this.controls) {
      const uuid = this.uuids.get(control.id)!;
      const timer = isTimer(control, this.pauseStyle);
      const state = timer ? this.valveState(control, snapshot) : { onOff: control.isOn(snapshot) };
      const key = JSON.stringify(state);
      if (this.lastPushed.get(uuid) === key) {
        continue;
      }
      this.lastPushed.set(uuid, key);
      try {
        await this.update(matter, uuid, timer, state);
      } catch (error) {
        this.lastPushed.delete(uuid);
        this.log.debug(`Failed to update Matter state for ${control.displayName}:`, error);
      }
    }
  }

  /** Mark every accessory reachable or not, so controllers show blocky being down (like "No Response" in HAP). */
  private async pushReachable(matter: MatterApi, reachable: boolean): Promise<void> {
    if (reachable === this.reachablePushed) {
      return;
    }
    this.reachablePushed = reachable;
    for (const uuid of this.uuids.values()) {
      try {
        await matter.updateAccessoryState(uuid, matter.clusterNames.BridgedDeviceBasicInformation, { reachable });
      } catch (error) {
        this.log.debug('Failed to update Matter reachability:', error);
      }
    }
  }

  private update(matter: MatterApi, uuid: string, timer: boolean, state: object): Promise<void> {
    return timer
      ? matter.updateAccessoryState(uuid, matter.clusterNames.ValveConfigurationAndControl, state as Record<string, unknown>)
      : matter.updateAccessoryState(uuid, matter.clusterNames.OnOff, state as Record<string, unknown>);
  }
}
