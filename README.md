# ioBroker Fairland Adapter

Unofficial ioBroker adapter for Fairland pool heat pumps and pool pumps that
use the Fairland **iGarden** cloud API.

This adapter talks directly to the iGarden cloud. It does not use Tuya and it
does not support Fairland devices paired through the SmartPool app.

## Supported devices

- Fairland pool heat pumps on the iGarden platform
- Fairland Inverflow Plus pool pumps on the iGarden platform
- OEM-rebadged iGarden devices, for example Madimack pool pumps

The adapter currently knows the device categories `heatPump` and `waterPump`.
Unknown categories are logged and skipped.

This project is not affiliated with, endorsed by, or supported by Fairland,
Home Assistant, ioBroker, or the upstream ha-fairland project maintainers.

## Installation

This adapter is not published to npm or the official ioBroker repository yet.
Install it from GitHub as a custom adapter.

### ioBroker Admin UI

In ioBroker Admin, open adapter installation, choose installation from a custom
URL/GitHub repository, and use:

```text
https://github.com/dude2k/ioBroker.fairland
```

After installation, create an instance of the `fairland` adapter manually if
ioBroker does not create one automatically.

### CLI

The most reliable installation URL for ioBroker containers is the GitHub archive
URL because it does not require an SSH client inside the container:

```bash
iobroker url https://github.com/dude2k/ioBroker.fairland/archive/refs/heads/main.tar.gz
```

If you install with a GitHub shorthand, some npm
versions convert the GitHub shorthand to an SSH URL. In minimal ioBroker
containers this can fail with `ssh: not found`.

For local development:

```bash
npm install
npm run build
```

## Configuration

The instance configuration contains:

- `iGarden account e-mail`: account name used in the iGarden app
- `iGarden password`: account password
- `Scan interval`: polling interval in seconds, minimum 10 seconds
- `Courtyard ID`: optional. Leave empty to use the first courtyard returned by
  the cloud. If the account has several courtyards, the adapter logs all IDs.
- `Create raw dpId states`: optional diagnostic states under
  `devices.<device>.raw.dp_<id>`

The adapter automatically detects the correct regional API server:

- EU: `api-eu.fairlandiot.com`
- US: `api-us.fairlandiot.com`
- CN: `api-cn.fairlandiot.com`
- HK: `api-hk.fairlandiot.com`

## Important iGarden limitation

The iGarden cloud usually allows only one active session per account. If the
adapter is logged in, the iGarden mobile app may show the device as offline, and
the reverse can also happen.

Recommended workaround: create a second iGarden account, share the device to
that account in the iGarden app, and configure ioBroker with the second account.

## State structure

Devices are created below:

```text
fairland.0.devices.<deviceId>
```

Common states:

```text
info.name
info.category
info.version
power
mode
```

Heat pump states include:

```text
temperature.current
temperature.target
temperature.outlet
temperature.ambient
power.current
presetMode
hvac.action
config.*
diagnostic.*
```

Water pump states include:

```text
pump.speedSetpoint
pump.runningRate
pump.backwashDuration
pump.backwashCountdown
power.current
energy.consumption
mode
```

Writable states are mapped back to the correct Fairland `dpId`. The adapter keeps
optimistic values for a short period after writes because the iGarden cloud can
take a few seconds to report newly written values back.

## Development notes

The implementation is a TypeScript port of the Home Assistant Fairland/iGarden
integration logic:

- cloud login and automatic regional server detection
- courtyard and device discovery
- category-specific `dpId` mappings
- scale and unit parsing from `dpProperty`
- optimistic write handling

Build:

```bash
npm run build
```

The compiled adapter entry point is `build/main.js`.

## Attribution

This adapter is derived from the MIT-licensed Home Assistant Fairland
integration by @siedi:

```text
https://github.com/siedi/ha-fairland
```

The original project license notice is preserved in `LICENSE`, and additional
third-party notices are listed in `THIRD_PARTY_NOTICES.md`.

## Changelog

### **WORK IN PROGRESS**
- (copilot) Adapter requires node.js >= 22 now

### 0.1.2

- Fixed `diagnostic.powerDisplayStatus` state type for boolean Fairland API values.

### 0.1.1

- Fixed ioBroker package schema for GitHub installation.
- Added upstream license attribution and third-party notices.

### 0.1.0

- Initial ioBroker port of the Fairland iGarden integration.

## License

MIT.

Copyright (c) 2026 dude2k.
Portions derived from ha-fairland: Copyright (c) 2025 @siedi.

See `LICENSE` for details.
