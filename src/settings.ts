/**
 * Platform name users put in config.json (`"platform": "BlockyControl"`).
 */
export const PLATFORM_NAME = 'BlockyControl';

/**
 * Must match the `name` field in package.json.
 */
export const PLUGIN_NAME = 'homebridge-blocky-control';

export const MANUFACTURER = 'Blocky';
export const MODEL = 'Blocky DNS Control';

export const DEFAULT_PAUSE_MINUTES = [5, 10, 60];
export const DEFAULT_POLL_INTERVAL_SECONDS = 15;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5000;
export const MIN_POLL_INTERVAL_SECONDS = 5;
export const MAX_POLL_INTERVAL_SECONDS = 3600;
/** HomeKit gives a write about 10 seconds, so a longer request timeout only turns slow failures into HAP errors. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 10;
/** Longest pause, matching the limit in config.schema.json. */
export const MAX_PAUSE_MINUTES = 1440;
