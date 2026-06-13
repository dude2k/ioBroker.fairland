"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const fairlandApi_1 = require("./fairlandApi");
const dpUtils_1 = require("./dpUtils");
const mappings_1 = require("./mappings");
const WRITE_REFRESH_DELAY_MS = 5_000;
const PENDING_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_SCAN_INTERVAL_SECONDS = 30;
const MIN_SCAN_INTERVAL_SECONDS = 10;
class FairlandAdapter extends utils.Adapter {
    apiClient;
    courtyardId;
    pollTimer;
    writeRefreshTimer;
    pendingWrites = new Map();
    writableStates = new Map();
    ensuredObjects = new Set();
    deviceObjectIds = new Map();
    isUnloading = false;
    isPolling = false;
    constructor(options = {}) {
        super({
            ...options,
            name: "fairland",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("stateChange", this.onStateChange.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }
    async onReady() {
        const config = this.config;
        const username = String(config.accountName ?? "").trim();
        const password = String(config.password ?? "");
        await this.setConnectionState(false);
        if (!username || !password) {
            this.log.warn("Please configure your iGarden account e-mail and password.");
            return;
        }
        const scanIntervalSeconds = this.getScanIntervalSeconds(config);
        this.apiClient = new fairlandApi_1.FairlandApiClient({
            username,
            password,
        });
        try {
            const region = await this.apiClient.detectRegion();
            this.log.info(`Connected to Fairland iGarden API region '${region}'.`);
            await this.setStateAsync("info.region", { val: region, ack: true });
            const courtyards = await this.apiClient.getCourtyards();
            this.courtyardId = this.selectCourtyard(courtyards, String(config.courtyardId ?? "").trim());
            await this.setStateAsync("info.courtyard", { val: this.courtyardId, ack: true });
            await this.extendObjectAsync("devices", {
                type: "channel",
                common: { name: "Devices" },
                native: {},
            });
            this.ensuredObjects.add("devices");
            this.subscribeStates("devices.*");
            await this.pollDevices();
            this.pollTimer = this.setInterval(() => void this.pollDevices(), scanIntervalSeconds * 1000);
            this.log.info(`Polling Fairland devices every ${scanIntervalSeconds} seconds.`);
        }
        catch (error) {
            await this.setConnectionState(false);
            this.log.error(`Adapter startup failed: ${this.errorMessage(error)}`);
        }
    }
    async onStateChange(id, state) {
        if (this.isUnloading || !state || state.ack) {
            return;
        }
        const localId = this.toLocalId(id);
        const mapping = this.writableStates.get(localId);
        if (!mapping) {
            return;
        }
        if (!this.apiClient) {
            this.log.warn(`Ignoring write to ${localId}: API client is not ready.`);
            return;
        }
        try {
            await this.handleWritableState(localId, mapping, state.val);
        }
        catch (error) {
            this.log.error(`Failed to write ${localId}: ${this.errorMessage(error)}`);
        }
    }
    onUnload(callback) {
        this.isUnloading = true;
        if (this.pollTimer) {
            this.clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.writeRefreshTimer) {
            this.clearTimeout(this.writeRefreshTimer);
            this.writeRefreshTimer = undefined;
        }
        void this.setConnectionState(false)
            .catch((error) => this.log.debug(`Failed to update connection state on unload: ${error}`))
            .finally(callback);
    }
    async pollDevices() {
        if (!this.apiClient || !this.courtyardId || this.isPolling) {
            return;
        }
        this.isPolling = true;
        try {
            const devices = await this.loadDevices(this.courtyardId);
            for (const device of devices) {
                await this.ensureDeviceObjects(device);
                await this.updateDeviceStates(device);
            }
            await this.setConnectionState(true);
        }
        catch (error) {
            await this.setConnectionState(false);
            this.log.warn(`Polling Fairland devices failed: ${this.errorMessage(error)}`);
        }
        finally {
            this.isPolling = false;
        }
    }
    async loadDevices(courtyardId) {
        if (!this.apiClient) {
            return [];
        }
        const devices = await this.apiClient.getAllDevicesInCourtyard(courtyardId);
        const updatedDevices = [];
        for (const device of devices) {
            try {
                const dps = await this.apiClient.getDeviceStatus(device.id);
                updatedDevices.push({ ...device, dps });
            }
            catch (error) {
                this.log.warn(`Could not fetch status for ${device.deviceName ?? device.id}: ${this.errorMessage(error)}`);
                updatedDevices.push(device);
            }
        }
        return updatedDevices;
    }
    async ensureDeviceObjects(device) {
        const deviceBase = this.deviceBase(device);
        await this.ensureDevice(deviceBase, device);
        await this.ensureState(`${deviceBase}.info.name`, {
            name: "Device name",
            type: "string",
            role: "text",
            read: true,
            write: false,
        });
        await this.ensureState(`${deviceBase}.info.category`, {
            name: "Device category",
            type: "string",
            role: "text",
            read: true,
            write: false,
        });
        await this.ensureState(`${deviceBase}.info.version`, {
            name: "Firmware version",
            type: "string",
            role: "text",
            read: true,
            write: false,
        });
        const dpMap = this.dpMap(device);
        if (device.categoryCode === mappings_1.HEAT_PUMP_CATEGORY_CODE) {
            await this.ensureHeatPumpStates(device, dpMap);
        }
        else if (device.categoryCode === mappings_1.WATER_PUMP_CATEGORY_CODE) {
            await this.ensureWaterPumpStates(device, dpMap);
        }
        else {
            this.log.debug(`Skipping unsupported Fairland category '${device.categoryCode}' for ${device.deviceName}.`);
        }
        if (this.config.createRawStates) {
            await this.ensureRawStates(device, dpMap);
        }
    }
    async ensureHeatPumpStates(device, dpMap) {
        const deviceBase = this.deviceBase(device);
        const powerDp = dpMap.get(mappings_1.HEAT_PUMP_POWER_DP_ID);
        if (powerDp) {
            const stateId = `${deviceBase}.power`;
            await this.ensureState(stateId, {
                name: "Power",
                type: "boolean",
                role: "switch",
                read: true,
                write: powerDp.dpMode === "rw",
            });
            if (powerDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.HEAT_PUMP_POWER_DP_ID,
                    kind: "heatPower",
                    valueType: "boolean",
                });
            }
        }
        const modeDp = dpMap.get(mappings_1.HEAT_PUMP_HVAC_MODE_DP_ID);
        if (modeDp) {
            const stateId = `${deviceBase}.mode`;
            await this.ensureState(stateId, {
                name: "Mode",
                type: "string",
                role: "level.mode",
                read: true,
                write: modeDp.dpMode === "rw",
                states: mappings_1.HEAT_HVAC_MODE_STATES,
            });
            if (modeDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.HEAT_PUMP_HVAC_MODE_DP_ID,
                    kind: "heatHvacMode",
                    optionToRaw: (0, dpUtils_1.invertEnum)(mappings_1.HEAT_HVAC_MODES),
                    valueType: "string",
                });
            }
        }
        const targetDp = dpMap.get(mappings_1.HEAT_PUMP_TARGET_TEMP_DP_ID);
        if (targetDp) {
            const scale = (0, dpUtils_1.getDpScale)(targetDp, 0);
            const stateId = `${deviceBase}.temperature.target`;
            await this.ensureState(stateId, {
                name: "Target temperature",
                type: "number",
                role: "level.temperature",
                unit: "°C",
                read: true,
                write: targetDp.dpMode === "rw",
                min: 8,
                max: 40,
                step: 1,
            });
            if (targetDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.HEAT_PUMP_TARGET_TEMP_DP_ID,
                    kind: "heatTargetTemperature",
                    scale,
                    valueType: "number",
                });
            }
        }
        const presetDp = dpMap.get(mappings_1.HEAT_PUMP_PRESET_DP_ID);
        if (presetDp) {
            const options = this.parseHeatPresetOptions(presetDp);
            const stateId = `${deviceBase}.presetMode`;
            await this.ensureState(stateId, {
                name: "Preset mode",
                type: "string",
                role: "level.mode",
                read: true,
                write: presetDp.dpMode === "rw",
                states: (0, dpUtils_1.toStatesObject)(options),
            });
            if (presetDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.HEAT_PUMP_PRESET_DP_ID,
                    kind: "heatPresetMode",
                    optionToRaw: (0, dpUtils_1.invertEnum)(options),
                    valueType: "string",
                });
            }
        }
        await this.ensureState(`${deviceBase}.hvac.action`, {
            name: "HVAC action",
            type: "string",
            role: "state",
            read: true,
            write: false,
            states: {
                off: "Off",
                idle: "Idle",
                heating: "Heating",
                cooling: "Cooling",
            },
        });
        for (const definition of mappings_1.HEAT_PUMP_SENSOR_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of mappings_1.HEAT_PUMP_NUMBER_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, true);
        }
    }
    async ensureWaterPumpStates(device, dpMap) {
        const deviceBase = this.deviceBase(device);
        const powerDp = dpMap.get(mappings_1.WATER_PUMP_POWER_DP_ID);
        if (powerDp) {
            const stateId = `${deviceBase}.power`;
            await this.ensureState(stateId, {
                name: "Power",
                type: "boolean",
                role: "switch",
                read: true,
                write: powerDp.dpMode === "rw",
            });
            if (powerDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.WATER_PUMP_POWER_DP_ID,
                    kind: "waterPower",
                    valueType: "boolean",
                });
            }
        }
        const modeDp = dpMap.get(mappings_1.WATER_PUMP_MODE_DP_ID);
        if (modeDp) {
            const options = (0, dpUtils_1.parseEnumOptions)(modeDp, mappings_1.WATER_PUMP_MODE_FALLBACK, mappings_1.WATER_PUMP_MODE_LABEL_TO_OPTION);
            const stateId = `${deviceBase}.mode`;
            await this.ensureState(stateId, {
                name: "Mode",
                type: "string",
                role: "level.mode",
                read: true,
                write: modeDp.dpMode === "rw",
                states: (0, dpUtils_1.toStatesObject)(options),
            });
            if (modeDp.dpMode === "rw") {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: mappings_1.WATER_PUMP_MODE_DP_ID,
                    kind: "waterPumpMode",
                    optionToRaw: (0, dpUtils_1.invertEnum)(options),
                    valueType: "string",
                });
            }
        }
        for (const definition of mappings_1.WATER_PUMP_SENSOR_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of mappings_1.WATER_PUMP_NUMBER_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, true);
        }
    }
    async ensureDefinitionState(device, definition, dpMap, writableDefinition) {
        const dp = dpMap.get(definition.dpId);
        if (!dp || (definition.requireValue && dp.dpValue === null)) {
            return;
        }
        if (writableDefinition && dp.dpMode !== "rw") {
            return;
        }
        const applied = (0, dpUtils_1.applyDpProperty)(definition, dp);
        const stateId = `${this.deviceBase(device)}.${definition.id}`;
        await this.ensureState(stateId, {
            name: applied.name,
            type: applied.type,
            role: applied.role,
            unit: applied.unit,
            read: applied.read ?? true,
            write: Boolean(writableDefinition && applied.write),
            min: applied.min,
            max: applied.max,
            step: applied.step,
            states: applied.states,
        });
        if (writableDefinition && applied.write) {
            this.writableStates.set(stateId, {
                deviceId: device.id,
                dpId: applied.dpId,
                kind: "direct",
                scale: applied.scale,
                valueType: applied.type,
            });
        }
    }
    async ensureRawStates(device, dpMap) {
        for (const dp of dpMap.values()) {
            const stateId = `${this.deviceBase(device)}.raw.dp_${(0, dpUtils_1.sanitizeObjectId)(dp.dpId)}`;
            const type = (0, dpUtils_1.inferStateType)(dp.dpValue);
            const writable = dp.dpMode === "rw";
            await this.ensureState(stateId, {
                name: `Raw dp ${dp.dpId}${dp.dpName ? ` (${dp.dpName})` : ""}`,
                type,
                role: "state",
                read: true,
                write: writable,
            });
            if (writable) {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: dp.dpId,
                    kind: "raw",
                    valueType: type,
                });
            }
        }
    }
    async updateDeviceStates(device) {
        const deviceBase = this.deviceBase(device);
        const dpMap = this.dpMap(device);
        await this.setStateAsync(`${deviceBase}.info.name`, { val: device.deviceName ?? device.id, ack: true });
        await this.setStateAsync(`${deviceBase}.info.category`, { val: device.categoryCode ?? "", ack: true });
        await this.setStateAsync(`${deviceBase}.info.version`, { val: device.version ?? "", ack: true });
        if (device.categoryCode === mappings_1.HEAT_PUMP_CATEGORY_CODE) {
            await this.updateHeatPumpStates(device, dpMap);
        }
        else if (device.categoryCode === mappings_1.WATER_PUMP_CATEGORY_CODE) {
            await this.updateWaterPumpStates(device, dpMap);
        }
        if (this.config.createRawStates) {
            await this.updateRawStates(device, dpMap);
        }
    }
    async updateHeatPumpStates(device, dpMap) {
        const deviceBase = this.deviceBase(device);
        const powerRaw = this.dpValue(device.id, dpMap, mappings_1.HEAT_PUMP_POWER_DP_ID);
        const isOn = Boolean(powerRaw);
        if (dpMap.has(mappings_1.HEAT_PUMP_POWER_DP_ID)) {
            await this.setStateAsync(`${deviceBase}.power`, { val: isOn, ack: true });
        }
        if (dpMap.has(mappings_1.HEAT_PUMP_HVAC_MODE_DP_ID)) {
            const modeRaw = this.dpValue(device.id, dpMap, mappings_1.HEAT_PUMP_HVAC_MODE_DP_ID);
            const mode = isOn ? mappings_1.HEAT_HVAC_MODES[Number(modeRaw)] ?? "off" : "off";
            await this.setStateAsync(`${deviceBase}.mode`, { val: mode, ack: true });
        }
        const targetDp = dpMap.get(mappings_1.HEAT_PUMP_TARGET_TEMP_DP_ID);
        if (targetDp) {
            const rawValue = this.effectiveDpValue(device.id, targetDp.dpId, targetDp.dpValue);
            await this.setStateAsync(`${deviceBase}.temperature.target`, {
                val: (0, dpUtils_1.scaleRead)(rawValue, (0, dpUtils_1.getDpScale)(targetDp, 0)),
                ack: true,
            });
        }
        const presetDp = dpMap.get(mappings_1.HEAT_PUMP_PRESET_DP_ID);
        if (presetDp) {
            const rawValue = this.dpValue(device.id, dpMap, mappings_1.HEAT_PUMP_PRESET_DP_ID);
            const options = this.parseHeatPresetOptions(presetDp);
            await this.setStateAsync(`${deviceBase}.presetMode`, {
                val: options[Number(rawValue)] ?? null,
                ack: true,
            });
        }
        await this.setStateAsync(`${deviceBase}.hvac.action`, {
            val: this.heatPumpAction(device.id, dpMap, isOn),
            ack: true,
        });
        for (const definition of mappings_1.HEAT_PUMP_SENSOR_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of mappings_1.HEAT_PUMP_NUMBER_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, true);
        }
    }
    async updateWaterPumpStates(device, dpMap) {
        const deviceBase = this.deviceBase(device);
        if (dpMap.has(mappings_1.WATER_PUMP_POWER_DP_ID)) {
            await this.setStateAsync(`${deviceBase}.power`, {
                val: Boolean(this.dpValue(device.id, dpMap, mappings_1.WATER_PUMP_POWER_DP_ID)),
                ack: true,
            });
        }
        const modeDp = dpMap.get(mappings_1.WATER_PUMP_MODE_DP_ID);
        if (modeDp) {
            const rawValue = this.dpValue(device.id, dpMap, mappings_1.WATER_PUMP_MODE_DP_ID);
            const options = (0, dpUtils_1.parseEnumOptions)(modeDp, mappings_1.WATER_PUMP_MODE_FALLBACK, mappings_1.WATER_PUMP_MODE_LABEL_TO_OPTION);
            await this.setStateAsync(`${deviceBase}.mode`, {
                val: options[Number(rawValue)] ?? null,
                ack: true,
            });
        }
        for (const definition of mappings_1.WATER_PUMP_SENSOR_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of mappings_1.WATER_PUMP_NUMBER_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, true);
        }
    }
    async updateDefinitionState(device, definition, dpMap, writableDefinition) {
        const dp = dpMap.get(definition.dpId);
        if (!dp || (definition.requireValue && dp.dpValue === null)) {
            return;
        }
        if (writableDefinition && dp.dpMode !== "rw") {
            return;
        }
        const applied = (0, dpUtils_1.applyDpProperty)(definition, dp);
        const rawValue = this.effectiveDpValue(device.id, applied.dpId, dp.dpValue);
        const value = (0, dpUtils_1.scaleRead)(rawValue, applied.scale ?? 0);
        await this.setStateAsync(`${this.deviceBase(device)}.${definition.id}`, {
            val: value,
            ack: true,
        });
    }
    async updateRawStates(device, dpMap) {
        for (const dp of dpMap.values()) {
            const rawValue = this.effectiveDpValue(device.id, dp.dpId, dp.dpValue);
            await this.setStateAsync(`${this.deviceBase(device)}.raw.dp_${(0, dpUtils_1.sanitizeObjectId)(dp.dpId)}`, {
                val: (0, dpUtils_1.toStateValue)(rawValue),
                ack: true,
            });
        }
    }
    async handleWritableState(localId, mapping, value) {
        if (!this.apiClient) {
            return;
        }
        if (mapping.kind === "heatHvacMode") {
            await this.writeHeatHvacMode(localId, mapping, value);
            return;
        }
        if (mapping.kind === "heatPresetMode" || mapping.kind === "waterPumpMode") {
            await this.writeMappedMode(localId, mapping, value);
            return;
        }
        const coerced = (0, dpUtils_1.coerceStateValue)(value, mapping.valueType);
        const rawValue = mapping.kind === "heatTargetTemperature"
            ? (0, dpUtils_1.scaleWrite)(coerced, mapping.scale ?? 0)
            : coerced;
        await this.apiClient.setDeviceStatus(mapping.deviceId, mapping.dpId, rawValue);
        this.notePendingWrite(mapping.deviceId, mapping.dpId, rawValue);
        await this.setStateAsync(localId, { val: coerced, ack: true });
        this.scheduleWriteRefresh();
    }
    async writeHeatHvacMode(localId, mapping, value) {
        if (!this.apiClient) {
            return;
        }
        const mode = String(value);
        const deviceBase = this.deviceObjectIds.get(mapping.deviceId);
        if (mode === "off") {
            await this.apiClient.setDeviceStatus(mapping.deviceId, mappings_1.HEAT_PUMP_POWER_DP_ID, false);
            this.notePendingWrite(mapping.deviceId, mappings_1.HEAT_PUMP_POWER_DP_ID, false);
            await this.setStateAsync(localId, { val: "off", ack: true });
            if (deviceBase) {
                await this.setStateAsync(`${deviceBase}.power`, { val: false, ack: true });
            }
            this.scheduleWriteRefresh();
            return;
        }
        const rawMode = mapping.optionToRaw?.[mode];
        if (rawMode === undefined) {
            this.log.warn(`Ignoring unknown heat pump mode '${mode}'.`);
            return;
        }
        await this.apiClient.setDeviceStatus(mapping.deviceId, mappings_1.HEAT_PUMP_POWER_DP_ID, true);
        this.notePendingWrite(mapping.deviceId, mappings_1.HEAT_PUMP_POWER_DP_ID, true);
        await this.apiClient.setDeviceStatus(mapping.deviceId, mapping.dpId, rawMode);
        this.notePendingWrite(mapping.deviceId, mapping.dpId, rawMode);
        if (deviceBase) {
            await this.setStateAsync(`${deviceBase}.power`, { val: true, ack: true });
        }
        await this.setStateAsync(localId, { val: mode, ack: true });
        this.scheduleWriteRefresh();
    }
    async writeMappedMode(localId, mapping, value) {
        if (!this.apiClient) {
            return;
        }
        const option = String(value);
        const rawValue = mapping.optionToRaw?.[option];
        if (rawValue === undefined) {
            this.log.warn(`Ignoring unknown mode option '${option}' for ${localId}.`);
            return;
        }
        await this.apiClient.setDeviceStatus(mapping.deviceId, mapping.dpId, rawValue);
        this.notePendingWrite(mapping.deviceId, mapping.dpId, rawValue);
        await this.setStateAsync(localId, { val: option, ack: true });
        this.scheduleWriteRefresh();
    }
    heatPumpAction(deviceId, dpMap, isOn) {
        if (!isOn) {
            return "off";
        }
        const action = this.dpValue(deviceId, dpMap, mappings_1.HEAT_PUMP_ACTION_DP_ID);
        const mode = this.dpValue(deviceId, dpMap, mappings_1.HEAT_PUMP_HVAC_MODE_DP_ID);
        if (Number(action) !== 1) {
            return "idle";
        }
        if (Number(mode) === 1) {
            return "heating";
        }
        if (Number(mode) === 2) {
            return "cooling";
        }
        return "idle";
    }
    dpValue(deviceId, dpMap, dpId) {
        const dp = dpMap.get(dpId);
        return dp ? this.effectiveDpValue(deviceId, dpId, dp.dpValue) : undefined;
    }
    effectiveDpValue(deviceId, dpId, polledValue) {
        const key = this.pendingKey(deviceId, dpId);
        const pending = this.pendingWrites.get(key);
        if (!pending) {
            return polledValue;
        }
        if ((0, dpUtils_1.valuesMatch)(polledValue, pending.value) || Date.now() >= pending.expiresAt) {
            this.pendingWrites.delete(key);
            return polledValue;
        }
        return pending.value;
    }
    notePendingWrite(deviceId, dpId, value) {
        this.pendingWrites.set(this.pendingKey(deviceId, dpId), {
            value,
            expiresAt: Date.now() + PENDING_WRITE_TIMEOUT_MS,
        });
    }
    scheduleWriteRefresh() {
        if (this.writeRefreshTimer) {
            this.clearTimeout(this.writeRefreshTimer);
        }
        this.writeRefreshTimer = this.setTimeout(() => {
            this.writeRefreshTimer = undefined;
            void this.pollDevices();
        }, WRITE_REFRESH_DELAY_MS);
    }
    selectCourtyard(courtyards, configuredCourtyardId) {
        if (configuredCourtyardId) {
            this.log.info(`Using configured courtyard ID '${configuredCourtyardId}'.`);
            return configuredCourtyardId;
        }
        if (courtyards.length === 0) {
            throw new fairlandApi_1.FairlandApiClientError("No courtyards found for this account.");
        }
        if (courtyards.length > 1) {
            this.log.warn(`Multiple courtyards found. Using '${courtyards[0].name}' (${courtyards[0].id}). Available: ${courtyards
                .map((courtyard) => `${courtyard.name}=${courtyard.id}`)
                .join(", ")}`);
        }
        return courtyards[0].id;
    }
    parseHeatPresetOptions(dp) {
        return (0, dpUtils_1.parseEnumOptions)(dp, {}, {});
    }
    getScanIntervalSeconds(config) {
        const parsed = Number(config.scanInterval ?? DEFAULT_SCAN_INTERVAL_SECONDS);
        if (!Number.isFinite(parsed)) {
            return DEFAULT_SCAN_INTERVAL_SECONDS;
        }
        return Math.max(MIN_SCAN_INTERVAL_SECONDS, Math.round(parsed));
    }
    dpMap(device) {
        return new Map((device.dps ?? []).map((dp) => [String(dp.dpId), { ...dp, dpId: String(dp.dpId) }]));
    }
    deviceBase(device) {
        let objectId = this.deviceObjectIds.get(device.id);
        if (!objectId) {
            objectId = `devices.${(0, dpUtils_1.sanitizeObjectId)(device.id)}`;
            this.deviceObjectIds.set(device.id, objectId);
        }
        return objectId;
    }
    async ensureDevice(deviceBase, device) {
        if (this.ensuredObjects.has(deviceBase)) {
            return;
        }
        await this.extendObjectAsync(deviceBase, {
            type: "device",
            common: {
                name: device.deviceName ?? device.id,
            },
            native: {
                id: device.id,
                categoryCode: device.categoryCode,
                version: device.version,
            },
        });
        this.ensuredObjects.add(deviceBase);
    }
    async ensureState(stateId, common, native = {}) {
        await this.ensureParentChannels(stateId);
        await this.extendObjectAsync(stateId, {
            type: "state",
            common,
            native,
        });
        this.ensuredObjects.add(stateId);
    }
    async ensureParentChannels(stateId) {
        const parts = stateId.split(".");
        let current = "";
        for (let index = 0; index < parts.length - 1; index += 1) {
            current = current ? `${current}.${parts[index]}` : parts[index];
            if (this.ensuredObjects.has(current)) {
                continue;
            }
            if (index === 1 && parts[0] === "devices") {
                continue;
            }
            await this.extendObjectAsync(current, {
                type: "channel",
                common: {
                    name: this.channelName(parts[index]),
                },
                native: {},
            });
            this.ensuredObjects.add(current);
        }
    }
    channelName(part) {
        return part
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .replace(/[_-]+/g, " ")
            .replace(/\b\w/g, (match) => match.toUpperCase());
    }
    pendingKey(deviceId, dpId) {
        return `${deviceId}:${dpId}`;
    }
    toLocalId(id) {
        const prefix = `${this.namespace}.`;
        return id.startsWith(prefix) ? id.slice(prefix.length) : id;
    }
    async setConnectionState(connected) {
        await this.setStateAsync("info.connection", { val: connected, ack: true });
    }
    errorMessage(error) {
        if (error instanceof fairlandApi_1.FairlandApiClientAuthenticationError ||
            error instanceof fairlandApi_1.FairlandApiClientCommunicationError ||
            error instanceof fairlandApi_1.FairlandApiClientError ||
            error instanceof Error) {
            return error.message;
        }
        return String(error);
    }
}
if (require.main !== module) {
    module.exports = (options) => new FairlandAdapter(options);
}
else {
    new FairlandAdapter();
}
