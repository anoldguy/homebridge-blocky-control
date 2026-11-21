# homebridge-blocky-control

A [Homebridge](https://homebridge.io) plugin that controls [blocky](https://0xerr0r.github.io/blocky/) DNS blocking. It works over HomeKit (HAP), Matter, or both.

It adds these controls:

| Control | Type | On / Open | Off / Closed |
| --- | --- | --- | --- |
| **Blocky** | Switch | Blocking is on | Blocking is off until you turn it back on |
| **Pause Blocky 5 Minutes** | Timer (valve) | Blocking is off for 5 minutes, with a countdown | Blocking turns back on now |
| **Pause Blocky 10 Minutes** | Timer (valve) | Blocking is off for 10 minutes, with a countdown | Blocking turns back on now |
| **Pause Blocky 1 Hour** | Timer (valve) | Blocking is off for 60 minutes, with a countdown | Blocking turns back on now |

HomeKit and Matter have no "timer" accessory. The closest is a valve, which carries a duration and shows a remaining-time countdown in the Home app.
So by default each pause is a generic Valve (HAP) or Water Valve (Matter) with a fixed duration. Set `pauseStyle` to `switch` to use plain switches instead.

- You choose the pause durations (`pauseMinutes`). Use an empty list to get only the main switch.
- Only one pause can run at a time. Turning on another pause switch restarts the timer with its duration.
- When blocky's timer ends, the pause turns off and **Blocky** turns back on.
- The plugin polls blocky's status, so changes made elsewhere also show up: blocky's CLI or API, other clients, or a restart.
  If something else started a timed disable, the plugin turns on the shortest pause that covers the time left.
- In HomeKit, all switches belong to one accessory. In Matter, each control is a separate accessory. Switches use the **On/Off Switch** type by default. Set `matterDeviceType` to `outlet` or `light` if your controller shows them as unsupported.

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
  "pauseStyle": "valve",
  "groups": [],
  "pollInterval": 15,
  "timeout": 5
}
```

| Key | Default | Description |
| --- | --- | --- |
| `url` | *(required)* | Base URL of blocky's HTTP listener. Leave off `/api`. |
| `name` | `Blocky` | Name of the main switch. Pause switches are named `Pause <name> …`. |
| `pauseMinutes` | `[5, 10, 60]` | One pause control is created for each entry. |
| `pauseStyle` | `valve` | `valve` (timer with countdown) or `switch`. |
| `groups` | all | Only disable these blocky groups (passed to blocky as `groups=`). |
| `pollInterval` | `15` | Seconds between status checks. `0` turns polling off. |
| `timeout` | `5` | HTTP request timeout, in seconds. |
| `matterDeviceType` | `switch` | Matter only: `switch`, `outlet`, or `light`. Changing it re-creates the Matter accessories. |

### HAP vs Matter

The plugin publishes over whichever transports the bridge has turned on.
If you pair the same bridge to Apple Home over both HAP and Matter, every switch appears twice.
Use a child bridge with only the transport you want.

## Security

**Anyone who can control your Home can turn DNS blocking off.** That includes every person you've
added to the Home in Apple Home (or every user and admin on a Matter fabric), Siri, and automations.
With a home hub it also works away from home. The main **Blocky** switch disables blocking with no
time limit, so if you rely on blocky for content filtering (kids, guests), keep that in mind:

- Apple Home can't limit control of a single accessory: everyone you share the Home with can operate it
  ("Allow Editing" only covers changing the setup). Don't share the Home with people who shouldn't turn it off.
- Use `pauseMinutes` and avoid the main switch in shared rooms, so blocking always comes back on by itself.
- Run the plugin on its own child bridge, and pair that bridge only to the controllers that need it.

blocky's API has no login, so anyone on your network who can reach `ports.http` could do the same
thing with `curl`. This plugin widens that to everyone with access to your Home. Consider limiting
blocky's HTTP port to the Homebridge host with a firewall rule.

The plugin only talks to the configured blocky URL. It doesn't follow redirects, and it rejects
URLs containing a user name or password.

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
- `src/matterDeviceTypes.ts`: maps `matterDeviceType` to a Homebridge Matter device type
- `src/platform.ts`: picks the transports, restores the cache, removes stale accessories
