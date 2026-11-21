# homebridge-blocky-control

A [Homebridge](https://homebridge.io) plugin that controls [blocky](https://0xerr0r.github.io/blocky/) DNS blocking. It works over HomeKit (HAP), Matter, or both.

It adds these switches:

| Switch | On | Off |
| --- | --- | --- |
| **Blocky** | Blocking is on | Blocking is off until you turn it back on |
| **Pause Blocky 5 Minutes** | Blocking is off for 5 minutes | Blocking turns back on now |
| **Pause Blocky 10 Minutes** | Blocking is off for 10 minutes | Blocking turns back on now |
| **Pause Blocky 1 Hour** | Blocking is off for 60 minutes | Blocking turns back on now |

- You choose the pause durations (`pauseMinutes`). Use an empty list to get only the main switch.
- Only one pause can run at a time. Turning on another pause switch restarts the timer with its duration.
- When blocky's timer ends, the pause switch turns off and **Blocky** turns back on.
- The plugin polls blocky's status, so changes made elsewhere also show up: blocky's CLI or API, other clients, or a restart.
  If something else started a timed disable, the plugin turns on the shortest pause switch that covers the time left.
- In HomeKit, all switches belong to one accessory. In Matter, each switch is a separate accessory. By default it uses the Matter 1.4 **Mounted On/Off Control** (switch) type. Set `matterDeviceType` to `outlet` or `light` if your Matter controller doesn't support switches.

## Requirements

- Homebridge 1.8+ for HAP. Matter needs Homebridge 2.x with Matter turned on for the bridge or child bridge.
- blocky's HTTP API must be reachable from Homebridge (`ports.http` in blocky's config).

## Configuration

```json
{
  "platform": "BlockyControl",
  "name": "Blocky",
  "url": "http://192.168.1.2:4000",
  "pauseMinutes": [5, 10, 60],
  "groups": [],
  "pollInterval": 15,
  "timeout": 5
}
```

| Key | Default | Description |
| --- | --- | --- |
| `url` | *(required)* | Base URL of blocky's HTTP listener. Leave off `/api`. |
| `name` | `Blocky` | Name of the main switch. Pause switches are named `Pause <name> …`. |
| `pauseMinutes` | `[5, 10, 60]` | One pause switch is created for each entry. |
| `groups` | all | Only disable these blocky groups (passed to blocky as `groups=`). |
| `pollInterval` | `15` | Seconds between status checks. `0` turns polling off. |
| `timeout` | `5` | HTTP request timeout, in seconds. |
| `matterDeviceType` | `switch` | Matter only: `switch` (Mounted On/Off Control), `outlet`, or `light`. Changing it re-creates the Matter accessories. |

### HAP vs Matter

The plugin publishes over whichever transports the bridge has turned on.
If you pair the same bridge to Apple Home over both HAP and Matter, every switch appears twice.
Use a child bridge with only the transport you want.

## blocky API used

- `GET /api/blocking/status`
- `GET /api/blocking/enable`
- `GET /api/blocking/disable?duration=<n>m[&groups=a,b]` (with no `duration`, blocking stays off until re-enabled)

## Development

```shell
npm install
npm test                 # build + unit tests against an in-process fake blocky
npm run fake-blocky      # fake blocky API on http://127.0.0.1:4000
npm run watch            # build, link, run Homebridge with test/hbConfig (HAP + Matter)
```

Code layout:

- `src/blockyClient.ts`: HTTP client for blocky's REST API
- `src/blockyController.ts`: state, polling, actions, and the "change" event. Shared by both transports.
- `src/controls.ts`: definitions of the main switch and the pause switches
- `src/hapAccessory.ts`: HAP accessory with one `Switch` service per control
- `src/matterAccessories.ts`: one Matter on/off accessory per control
- `src/matterDeviceTypes.ts`: builds the Mounted On/Off Control type, which Homebridge doesn't expose
- `src/platform.ts`: picks the transports, restores the cache, removes stale accessories
