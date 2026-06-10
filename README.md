# ioBroker Fairland Adapter

ioBroker adapter for Fairland pool heat pumps and pool pumps that use the
Fairland **iGarden** cloud API.

This adapter talks directly to the iGarden cloud. It does not use Tuya and it
does not support Fairland devices paired through the SmartPool app.

## Supported devices

- Fairland pool heat pumps on the iGarden platform
- Fairland Inverflow Plus pool pumps on the iGarden platform
- OEM-rebadged iGarden devices, for example Madimack pool pumps

The adapter currently knows the device categories `heatPump` and `waterPump`.
Unknown categories are logged and skipped.

## Installation

The adapter can be installed from GitHub once this repository has been pushed:

```text
https://github.com/dude2k/Fairland_Adapter.git
```

In ioBroker Admin, open the adapter installation view, choose installation from
a custom URL/GitHub repository, and use the URL above. Then create an instance
of the `fairland` adapter.

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
