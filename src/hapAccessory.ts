import type { API, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { BlockyController, BlockySnapshot } from './blockyController.js';
import type { BlockyControl } from './controls.js';
import { MANUFACTURER, MODEL } from './settings.js';

/**
 * Sets up one HAP accessory with a Switch service for each control.
 */
export class BlockyHapAccessory {
  private readonly services = new Map<string, Service>();

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly controller: BlockyController,
    private readonly controls: BlockyControl[],
    serialNumber: string,
  ) {
    const { Service, Characteristic } = api.hap;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, MANUFACTURER)
      .setCharacteristic(Characteristic.Model, MODEL)
      .setCharacteristic(Characteristic.SerialNumber, serialNumber);

    const wanted = new Set(controls.map((c) => c.id));

    // Remove Switch services left in the cache for pause durations that are no longer configured.
    for (const service of [...accessory.services]) {
      if (service.UUID === Service.Switch.UUID && (!service.subtype || !wanted.has(service.subtype))) {
        accessory.removeService(service);
      }
    }

    for (const control of controls) {
      const service = accessory.getServiceById(Service.Switch, control.id)
        ?? accessory.addService(Service.Switch, control.displayName, control.id);

      service.setCharacteristic(Characteristic.Name, control.displayName);
      if (!service.testCharacteristic(Characteristic.ConfiguredName)) {
        service.addOptionalCharacteristic(Characteristic.ConfiguredName);
        service.setCharacteristic(Characteristic.ConfiguredName, control.displayName);
      }

      service.getCharacteristic(Characteristic.On)
        .onGet(() => this.get(control))
        .onSet((value) => this.set(control, value));

      this.services.set(control.id, service);
    }

    controller.on('change', (snapshot) => this.push(snapshot));
  }

  private get(control: BlockyControl): CharacteristicValue {
    const snapshot = this.controller.snapshot;
    if (!snapshot.known || !snapshot.reachable) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return control.isOn(snapshot);
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
      const characteristic = this.services.get(control.id)?.getCharacteristic(Characteristic.On);
      if (!characteristic) {
        continue;
      }
      if (snapshot.known && snapshot.reachable) {
        characteristic.updateValue(control.isOn(snapshot));
      } else if (!snapshot.reachable) {
        // shows "No Response" in the Home app until blocky is reachable again
        characteristic.updateValue(new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE));
      }
    }
  }
}
