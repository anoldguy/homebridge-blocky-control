import type { API, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, PlatformConfig } from 'homebridge';

import { BlockyClient } from './blockyClient.js';
import { BlockyController } from './blockyController.js';
import { parseBlockyUrl, readNumber } from './config.js';
import { buildControls, normalizePauseMinutes, normalizePauseStyle, type PauseStyle } from './controls.js';
import { BlockyHapAccessory } from './hapAccessory.js';
import { BlockyMatterAccessories } from './matterAccessories.js';
import { type MatterDeviceKind, normalizeMatterDeviceKind } from './matterDeviceTypes.js';
import {
  DEFAULT_PAUSE_MINUTES,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MAX_POLL_INTERVAL_SECONDS,
  MAX_REQUEST_TIMEOUT_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  PLATFORM_NAME,
  PLUGIN_NAME,
} from './settings.js';

const STABLE_UUID_SEED = `blocky:${PLATFORM_NAME}`;

export interface BlockyPlatformConfig extends PlatformConfig {
  /** blocky HTTP base URL, e.g. http://192.168.1.2:4000 */
  url?: string;
  /** pause durations in minutes (one switch per entry) */
  pauseMinutes?: number[];
  /** only disable these blocking groups (default: all) */
  groups?: string[];
  pollInterval?: number;
  timeout?: number;
  /** Matter device type for each control */
  matterDeviceType?: MatterDeviceKind;
  /** 'valve' (timer with countdown, default) or 'switch' */
  pauseStyle?: PauseStyle;
}

/**
 * Optional calls keep this working on Homebridge 1.x, which has none of these methods.
 * isHapEnabled and isHapExternalsOnly were added in Homebridge 2.5.
 */
type TransportApi = API & {
  isHapEnabled?: () => boolean;
  isHapExternalsOnly?: () => boolean;
  isMatterExternalsOnly?: () => boolean;
};

export class BlockyPlatform implements DynamicPlatformPlugin {
  private readonly hapCache = new Map<string, PlatformAccessory>();
  private readonly matterCache = new Map<string, MatterAccessory>();
  private controller?: BlockyController;
  private shuttingDown = false;

  constructor(
    public readonly log: Logging,
    public readonly config: BlockyPlatformConfig,
    public readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => {
      this.setup().catch((error) => this.log.error('Failed to set up Blocky Control:', error));
    });
    this.api.on('shutdown', () => {
      this.shuttingDown = true;
      this.controller?.stop();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.hapCache.set(accessory.UUID, accessory);
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matterCache.set(accessory.UUID, accessory);
  }

  private async setup(): Promise<void> {
    const rawUrl = this.config.url?.trim();
    if (!rawUrl) {
      // Leave cached accessories alone: removing them would delete the user's rooms and automations over a config typo.
      this.log.error('No blocky URL configured. Set "url" (e.g. http://192.168.1.2:4000) in the plugin settings.');
      return;
    }
    const parsedUrl = parseBlockyUrl(rawUrl);
    if (!parsedUrl.ok) {
      this.log.error(`Invalid blocky URL: ${parsedUrl.error}`);
      return;
    }
    const url = parsedUrl.url;
    const warn = (message: string) => this.log.warn(message);

    const baseName = this.config.name?.trim() || 'Blocky';
    const pauseMinutes = normalizePauseMinutes(this.config.pauseMinutes, DEFAULT_PAUSE_MINUTES);
    const pollIntervalSeconds = readNumber(this.config.pollInterval, {
      name: 'pollInterval', fallback: DEFAULT_POLL_INTERVAL_SECONDS, min: MIN_POLL_INTERVAL_SECONDS, max: MAX_POLL_INTERVAL_SECONDS, allowZero: true,
    }, warn);
    const timeoutMs = 1000 * readNumber(this.config.timeout, {
      name: 'timeout', fallback: DEFAULT_REQUEST_TIMEOUT_MS / 1000, min: 1, max: MAX_REQUEST_TIMEOUT_SECONDS,
    }, warn);
    const groups = Array.isArray(this.config.groups)
      ? this.config.groups.map((g) => String(g).trim()).filter(Boolean)
      : undefined;

    const client = new BlockyClient({ url, groups, timeoutMs });
    const controller = new BlockyController(client, this.log, { pauseMinutes, pollIntervalSeconds });
    this.controller = controller;
    const controls = buildControls(controller, baseName, pauseMinutes);
    const pauseStyle = normalizePauseStyle(this.config.pauseStyle);

    const api = this.api as TransportApi;
    const hapActive = api.isHapEnabled?.() !== false && !api.isHapExternalsOnly?.();
    const matterActive = Boolean(api.isMatterEnabled?.()) && !api.isMatterExternalsOnly?.() && Boolean(api.matter);
    const kind = normalizeMatterDeviceKind(this.config.matterDeviceType);
    const seed = this.chooseUuidSeed(rawUrl, (s) => new BlockyMatterAccessories(this.api, this.log, controller, controls, s, kind, pauseStyle));

    // Get the real state before exposing anything, so switches don't start out wrong.
    await controller.refresh();

    try {
      if (hapActive) {
        this.setupHap(controller, controls, seed, pauseStyle);
      } else {
        this.removeCachedHap(new Set());
      }

      if (matterActive) {
        // A Matter failure shouldn't take HAP down with it.
        try {
          const matter = new BlockyMatterAccessories(this.api, this.log, controller, controls, seed, kind, pauseStyle);
          await this.removeCachedMatter(matter.wantedUuids);
          await matter.register();
        } catch (error) {
          this.log.error('Failed to publish Matter accessories:', error);
        }
      }

      if (!hapActive && !matterActive) {
        this.log.warn('Neither HAP nor Matter is enabled for this bridge; no accessories were published.');
      }
    } finally {
      // Always start polling, so whatever did get published keeps up with blocky.
      if (!this.shuttingDown) {
        controller.start();
      }
    }
  }

  /**
   * The seed every accessory UUID is built from. The platform is singular, so a
   * constant works and editing the URL (trailing slash, new IP, hostname) keeps
   * the same accessories, along with their rooms and automations.
   *
   * Versions up to 1.1.1 seeded from the raw URL. If the cache still has
   * accessories from that seed, keep using it so existing setups don't lose
   * their accessories. A later URL change moves them to the stable seed.
   */
  private chooseUuidSeed(url: string, matterFor: (seed: string) => BlockyMatterAccessories): string {
    const legacy = `blocky:${url}`;
    const hapHit = this.hapCache.has(this.api.hap.uuid.generate(`${legacy}:hap`));
    const matterHit = this.api.matter !== undefined
      && [...matterFor(legacy).wantedUuids].some((uuid) => this.matterCache.has(uuid));
    return hapHit || matterHit ? legacy : STABLE_UUID_SEED;
  }

  private setupHap(controller: BlockyController, controls: ReturnType<typeof buildControls>, seed: string, pauseStyle: PauseStyle): void {
    const uuid = this.api.hap.uuid.generate(`${seed}:hap`);
    const displayName = controls[0].displayName;
    let accessory = this.hapCache.get(uuid);
    const isNew = !accessory;
    if (!accessory) {
      accessory = new this.api.platformAccessory(displayName, uuid);
    }
    new BlockyHapAccessory(this.api, accessory, controller, controls, pauseStyle, uuid.slice(0, 8));
    if (isNew) {
      this.log.info('Adding HAP accessory:', displayName);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.api.updatePlatformAccessories([accessory]);
    }
    this.removeCachedHap(new Set([uuid]));
  }

  private removeCachedHap(keep: Set<string>): void {
    const stale = [...this.hapCache.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length > 0) {
      this.log.info('Removing stale HAP accessories:', stale.map((a) => a.displayName).join(', '));
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }

  private async removeCachedMatter(keep: Set<string>): Promise<void> {
    const stale = [...this.matterCache.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length > 0 && this.api.matter) {
      this.log.info('Removing stale Matter accessories:', stale.map((a) => a.displayName).join(', '));
      await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
    }
  }
}
