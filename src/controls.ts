import type { BlockyController, BlockySnapshot } from './blockyController.js';

/**
 * One switch exposed to HomeKit or Matter. The HAP and Matter code both use
 * these, so the two behave the same way.
 */
export interface BlockyControl {
  /** stable id, used for HAP subtypes and Matter UUID seeds */
  id: string;
  displayName: string;
  /** what the switch should show for a given snapshot */
  isOn(snapshot: BlockySnapshot): boolean;
  /** run when the user flips the switch */
  set(on: boolean): Promise<void>;
}

export function formatMinutes(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'Hour' : 'Hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`;
}

export function buildControls(controller: BlockyController, baseName: string, pauseMinutes: number[]): BlockyControl[] {
  const controls: BlockyControl[] = [
    {
      id: 'blocking',
      displayName: baseName,
      isOn: (s) => s.blockingEnabled,
      set: (on) => controller.setBlocking(on),
    },
  ];
  for (const minutes of pauseMinutes) {
    controls.push({
      id: `pause-${minutes}`,
      displayName: `Pause ${baseName} ${formatMinutes(minutes)}`,
      isOn: (s) => !s.blockingEnabled && s.activePauseMinutes === minutes,
      set: (on) => (on ? controller.pause(minutes) : controller.cancelPause(minutes)),
    });
  }
  return controls;
}

/** Remove duplicates, drop values that aren't positive whole numbers, and sort. */
export function normalizePauseMinutes(input: unknown, fallback: number[]): number[] {
  if (!Array.isArray(input)) {
    return [...fallback];
  }
  const values = input
    .map((v) => Number(v))
    .filter((v) => Number.isInteger(v) && v > 0);
  return [...new Set(values)].sort((a, b) => a - b);
}
