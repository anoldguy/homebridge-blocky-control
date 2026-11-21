import type { API, Characteristic, CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';

import type { BlockyController, BlockySnapshot } from './blockyController.js';
import { type BlockyControl, isTimer, type PauseStyle } from './controls.js';
import { MANUFACTURER, MODEL } from './settings.js';

/**
 * Sets up one HAP accessory. The main control is a Switch service. With
 * pauseStyle 'valve', each pause control is a Valve service with a fixed
 * SetDuration and a RemainingDuration countdown. With 'switch', it's a Switch.
 */
export class BlockyHapAccessory {
  private readonly services = new Map<string, Service>();

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly controller: BlockyController,
    private readonly controls: BlockyControl[],
    private readonly pauseStyle: PauseStyle,
    serialNumber: string,
  ) {
    const { Service, Characteristic } = api.hap;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, MODEL)
      .setCharacteristic(Characteristic.SerialNumber, serialNumber);

    const wanted = new Set(controls.map((c) => `${this.serviceTypeFor(c).UUID}:${c.id}`));

    // Remove Switch or Valve services left in the cache for controls that are gone, or that changed type.
    for (const service of [...accessory.services]) {
      const ours = service.UUID === Service.Switch.UUID || service.UUID === Service.Valve.UUID;
      if (ours && !wanted.has(`${service.UUID}:${service.subtype}`)) {
        accessory.removeService(service);
      }
    }

    for (const control of controls) {
      const type = this.serviceTypeFor(control);
      const service = accessory.getServiceById(type, control.id)
        ?? accessory.addService(type, control.displayName, control.id);

      service.setCharacteristic(Characteristic.Name, control.displayName);
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        service.setCharacteristic(Characteristic.ConfiguredName, control.displayName);
      }

      if (isTimer(control, pauseStyle)) {
        this.configureValve(service, control);
      } else {
        service.getCharacteristic(Characteristic.On)
          .onGet(() => this.get(control))
          .onSet((value) => this.set(control, value));
      }

      this.services.set(control.id, service);
    }

    controller.on('change', (snapshot) => this.push(snapshot));
  }

  private serviceTypeFor(control: BlockyControl): WithUUID<typeof Service> {
    return isTimer(control, this.pauseStyle) ? this.api.hap.Service.Valve : this.api.hap.Service.Switch;
  }

  private configureValve(service: Service, control: BlockyControl & { minutes: number }): void {
    const { Characteristic } = this.api.hap;
    const seconds = control.minutes * 60;
    const maxValue = Math.max(3600, seconds);

    service.setCharacteristic(Characteristic.ValveType, Characteristic.ValveType.GENERIC_VALVE);

    // The duration is fixed per valve, so remove write permission. Then Home shows the length without letting you edit it.
    service.getCharacteristic(Characteristic.SetDuration)
      .setProps({ maxValue, perms: [this.api.hap.Perms.NOTIFY, this.api.hap.Perms.PAIRED_READ] })
      .updateValue(seconds);
    service.getCharacteristic(Characteristic.RemainingDuration)
      .setProps({ maxValue })
      .onGet(() => this.remaining(control));

    service.getCharacteristic(Characteristic.Active)
      .onGet(() => (this.get(control) ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE))
      .onSet((value) => this.set(control, value === Characteristic.Active.ACTIVE));
    service.getCharacteristic(Characteristic.InUse)
      .onGet(() => (this.get(control) ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE));
  }

  private get(control: BlockyControl): boolean {
    const snapshot = this.controller.snapshot;
    if (!snapshot.known || !snapshot.reachable) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return control.isOn(snapshot);
  }

  private remaining(control: BlockyControl, snapshot = this.controller.snapshot): number {
    return control.isOn(snapshot) ? snapshot.autoEnableInSec : 0;
  }

  private async set(control: BlockyControl, value: CharacteristicValue): Promise<void> {
    try {
      await control.set(Boolean(value));
    } catch {
      // the controller has already logged the error
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  private push(snapshot: BlockySnapshot): void {
    const { Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    for (const control of this.controls) {
      const service = this.services.get(control.id);
      if (!service) {
        continue;
      }
      const timer = isTimer(control, this.pauseStyle);
      const stateful: WithUUID<new () => Characteristic>[] = timer ? [Characteristic.Active, Characteristic.InUse] : [Characteristic.On];

      if (!snapshot.reachable) {
        // shows "No Response" in the Home app until blocky is reachable again
        for (const c of stateful) {
          service.getCharacteristic(c).updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        }
        continue;
      }
      if (!snapshot.known) {
        continue;
      }
      const on = control.isOn(snapshot);
      if (timer) {
        // Send RemainingDuration before Active, so Home starts the countdown from the right value.
        service.getCharacteristic(Characteristic.RemainingDuration).updateValue(this.remaining(control, snapshot));
        service.getCharacteristic(Characteristic.Active).updateValue(on ? Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
        service.getCharacteristic(Characteristic.InUse).updateValue(on ? Characteristic.InUse.IN_USE : Characteristic.InUse.NOT_IN_USE);
      } else {
        service.getCharacteristic(Characteristic.On).updateValue(on);
      }
    }
  }
}
