import * as utils from '@iobroker/adapter-core';

import {
    FairlandApiClient,
    FairlandApiClientAuthenticationError,
    FairlandApiClientCommunicationError,
    FairlandApiClientError,
} from './fairlandApi';
import {
    applyDpProperty,
    coerceStateValue,
    getDpScale,
    inferStateType,
    invertEnum,
    parseEnumOptions,
    sanitizeObjectId,
    scaleRead,
    scaleWrite,
    toStateValue,
    toStatesObject,
    valuesMatch,
} from './dpUtils';
import {
    HEAT_HVAC_MODE_STATES,
    HEAT_HVAC_MODES,
    HEAT_PUMP_ACTION_DP_ID,
    HEAT_PUMP_CATEGORY_CODE,
    HEAT_PUMP_HVAC_MODE_DP_ID,
    HEAT_PUMP_NUMBER_DEFINITIONS,
    HEAT_PUMP_POWER_DP_ID,
    HEAT_PUMP_PRESET_DP_ID,
    HEAT_PUMP_SENSOR_DEFINITIONS,
    HEAT_PUMP_TARGET_TEMP_DP_ID,
    WATER_PUMP_CATEGORY_CODE,
    WATER_PUMP_MODE_DP_ID,
    WATER_PUMP_MODE_FALLBACK,
    WATER_PUMP_MODE_LABEL_TO_OPTION,
    WATER_PUMP_NUMBER_DEFINITIONS,
    WATER_PUMP_POWER_DP_ID,
    WATER_PUMP_SENSOR_DEFINITIONS,
} from './mappings';
import type {
    DpStateDefinition,
    FairlandCourtyard,
    FairlandDataPoint,
    FairlandDevice,
    NativeConfig,
    PendingWrite,
    StateValue,
    WritableStateMapping,
} from './types';

const WRITE_REFRESH_DELAY_MS = 5_000;
const PENDING_WRITE_TIMEOUT_MS = 30_000;
const DEFAULT_SCAN_INTERVAL_SECONDS = 30;
const MIN_SCAN_INTERVAL_SECONDS = 10;

class FairlandAdapter extends utils.Adapter {
    private apiClient: FairlandApiClient | undefined;
    private courtyardId: string | undefined;
    private pollTimer: ioBroker.Interval | undefined;
    private writeRefreshTimer: ioBroker.Timeout | undefined;
    private readonly pendingWrites = new Map<string, PendingWrite>();
    private readonly writableStates = new Map<string, WritableStateMapping>();
    private readonly ensuredObjects = new Set<string>();
    private readonly deviceObjectIds = new Map<string, string>();
    private isUnloading = false;
    private isPolling = false;

    public constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'fairland',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    private async onReady(): Promise<void> {
        const config = this.config as NativeConfig;
        const username = String(config.accountName ?? '').trim();
        const password = String(config.password ?? '');

        await this.setConnectionState(false);

        if (!username || !password) {
            this.log.warn('Please configure your iGarden account e-mail and password.');
            return;
        }

        const scanIntervalSeconds = this.getScanIntervalSeconds(config);

        this.apiClient = new FairlandApiClient({
            username,
            password,
        });

        try {
            const region = await this.apiClient.detectRegion();
            this.log.info(`Connected to Fairland iGarden API region '${region}'.`);
            await this.setStateAsync('info.region', { val: region, ack: true });

            const courtyards = await this.apiClient.getCourtyards();
            this.courtyardId = this.selectCourtyard(courtyards, String(config.courtyardId ?? '').trim());
            await this.setStateAsync('info.courtyard', { val: this.courtyardId, ack: true });

            await this.extendObjectAsync('devices', {
                type: 'channel',
                common: { name: 'Devices' },
                native: {},
            });
            this.ensuredObjects.add('devices');

            this.subscribeStates('devices.*');
            await this.pollDevices();
            this.pollTimer = this.setInterval(() => void this.pollDevices(), scanIntervalSeconds * 1000);
            this.log.info(`Polling Fairland devices every ${scanIntervalSeconds} seconds.`);
        } catch (error) {
            await this.setConnectionState(false);
            this.log.error(`Adapter startup failed: ${this.errorMessage(error)}`);
        }
    }

    private async onStateChange(id: string, state: ioBroker.State | null | undefined): Promise<void> {
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
        } catch (error) {
            this.log.error(`Failed to write ${localId}: ${this.errorMessage(error)}`);
        }
    }

    private onUnload(callback: () => void): void {
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
            .catch(error => this.log.debug(`Failed to update connection state on unload: ${error}`))
            .finally(callback);
    }

    private async pollDevices(): Promise<void> {
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
        } catch (error) {
            await this.setConnectionState(false);
            this.log.warn(`Polling Fairland devices failed: ${this.errorMessage(error)}`);
        } finally {
            this.isPolling = false;
        }
    }

    private async loadDevices(courtyardId: string): Promise<FairlandDevice[]> {
        if (!this.apiClient) {
            return [];
        }

        const devices = await this.apiClient.getAllDevicesInCourtyard(courtyardId);
        const updatedDevices: FairlandDevice[] = [];

        for (const device of devices) {
            try {
                const dps = await this.apiClient.getDeviceStatus(device.id);
                updatedDevices.push({ ...device, dps });
            } catch (error) {
                this.log.warn(
                    `Could not fetch status for ${device.deviceName ?? device.id}: ${this.errorMessage(error)}`,
                );
                updatedDevices.push(device);
            }
        }

        return updatedDevices;
    }

    private async ensureDeviceObjects(device: FairlandDevice): Promise<void> {
        const deviceBase = this.deviceBase(device);
        await this.ensureDevice(deviceBase, device);

        await this.ensureState(`${deviceBase}.info.name`, {
            name: 'Device name',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await this.ensureState(`${deviceBase}.info.category`, {
            name: 'Device category',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });
        await this.ensureState(`${deviceBase}.info.version`, {
            name: 'Firmware version',
            type: 'string',
            role: 'text',
            read: true,
            write: false,
        });

        const dpMap = this.dpMap(device);
        if (device.categoryCode === HEAT_PUMP_CATEGORY_CODE) {
            await this.ensureHeatPumpStates(device, dpMap);
        } else if (device.categoryCode === WATER_PUMP_CATEGORY_CODE) {
            await this.ensureWaterPumpStates(device, dpMap);
        } else {
            this.log.debug(`Skipping unsupported Fairland category '${device.categoryCode}' for ${device.deviceName}.`);
        }

        if ((this.config as NativeConfig).createRawStates) {
            await this.ensureRawStates(device, dpMap);
        }
    }

    private async ensureHeatPumpStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        const deviceBase = this.deviceBase(device);
        const powerDp = dpMap.get(HEAT_PUMP_POWER_DP_ID);
        if (powerDp) {
            const stateId = `${deviceBase}.power`;
            await this.ensureState(stateId, {
                name: 'Power',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: powerDp.dpMode === 'rw',
            });
            if (powerDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: HEAT_PUMP_POWER_DP_ID,
                    kind: 'heatPower',
                    valueType: 'boolean',
                });
            }
        }

        const modeDp = dpMap.get(HEAT_PUMP_HVAC_MODE_DP_ID);
        if (modeDp) {
            const stateId = `${deviceBase}.mode`;
            await this.ensureState(stateId, {
                name: 'Mode',
                type: 'string',
                role: 'level.mode',
                read: true,
                write: modeDp.dpMode === 'rw',
                states: HEAT_HVAC_MODE_STATES,
            });
            if (modeDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: HEAT_PUMP_HVAC_MODE_DP_ID,
                    kind: 'heatHvacMode',
                    optionToRaw: invertEnum(HEAT_HVAC_MODES),
                    valueType: 'string',
                });
            }
        }

        const targetDp = dpMap.get(HEAT_PUMP_TARGET_TEMP_DP_ID);
        if (targetDp) {
            const scale = getDpScale(targetDp, 0);
            const stateId = `${deviceBase}.temperature.target`;
            await this.ensureState(stateId, {
                name: 'Target temperature',
                type: 'number',
                role: 'level.temperature',
                unit: '°C',
                read: true,
                write: targetDp.dpMode === 'rw',
                min: 8,
                max: 40,
                step: 1,
            });
            if (targetDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: HEAT_PUMP_TARGET_TEMP_DP_ID,
                    kind: 'heatTargetTemperature',
                    scale,
                    valueType: 'number',
                });
            }
        }

        const presetDp = dpMap.get(HEAT_PUMP_PRESET_DP_ID);
        if (presetDp) {
            const options = this.parseHeatPresetOptions(presetDp);
            const stateId = `${deviceBase}.presetMode`;
            await this.ensureState(stateId, {
                name: 'Preset mode',
                type: 'string',
                role: 'level.mode',
                read: true,
                write: presetDp.dpMode === 'rw',
                states: toStatesObject(options),
            });
            if (presetDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: HEAT_PUMP_PRESET_DP_ID,
                    kind: 'heatPresetMode',
                    optionToRaw: invertEnum(options),
                    valueType: 'string',
                });
            }
        }

        await this.ensureState(`${deviceBase}.hvac.action`, {
            name: 'HVAC action',
            type: 'string',
            role: 'state',
            read: true,
            write: false,
            states: {
                off: 'Off',
                idle: 'Idle',
                heating: 'Heating',
                cooling: 'Cooling',
            },
        });

        for (const definition of HEAT_PUMP_SENSOR_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of HEAT_PUMP_NUMBER_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, true);
        }
    }

    private async ensureWaterPumpStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        const deviceBase = this.deviceBase(device);
        const powerDp = dpMap.get(WATER_PUMP_POWER_DP_ID);
        if (powerDp) {
            const stateId = `${deviceBase}.power`;
            await this.ensureState(stateId, {
                name: 'Power',
                type: 'boolean',
                role: 'switch',
                read: true,
                write: powerDp.dpMode === 'rw',
            });
            if (powerDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: WATER_PUMP_POWER_DP_ID,
                    kind: 'waterPower',
                    valueType: 'boolean',
                });
            }
        }

        const modeDp = dpMap.get(WATER_PUMP_MODE_DP_ID);
        if (modeDp) {
            const options = parseEnumOptions(modeDp, WATER_PUMP_MODE_FALLBACK, WATER_PUMP_MODE_LABEL_TO_OPTION);
            const stateId = `${deviceBase}.mode`;
            await this.ensureState(stateId, {
                name: 'Mode',
                type: 'string',
                role: 'level.mode',
                read: true,
                write: modeDp.dpMode === 'rw',
                states: toStatesObject(options),
            });
            if (modeDp.dpMode === 'rw') {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: WATER_PUMP_MODE_DP_ID,
                    kind: 'waterPumpMode',
                    optionToRaw: invertEnum(options),
                    valueType: 'string',
                });
            }
        }

        for (const definition of WATER_PUMP_SENSOR_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of WATER_PUMP_NUMBER_DEFINITIONS) {
            await this.ensureDefinitionState(device, definition, dpMap, true);
        }
    }

    private async ensureDefinitionState(
        device: FairlandDevice,
        definition: DpStateDefinition,
        dpMap: Map<string, FairlandDataPoint>,
        writableDefinition: boolean,
    ): Promise<void> {
        const dp = dpMap.get(definition.dpId);
        if (!dp || (definition.requireValue && dp.dpValue === null)) {
            return;
        }
        if (writableDefinition && dp.dpMode !== 'rw') {
            return;
        }

        const applied = applyDpProperty(definition, dp);
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
                kind: 'direct',
                scale: applied.scale,
                valueType: applied.type,
            });
        }
    }

    private async ensureRawStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        for (const dp of dpMap.values()) {
            const stateId = `${this.deviceBase(device)}.raw.dp_${sanitizeObjectId(dp.dpId)}`;
            const type = inferStateType(dp.dpValue);
            const writable = dp.dpMode === 'rw';
            await this.ensureState(stateId, {
                name: `Raw dp ${dp.dpId}${dp.dpName ? ` (${dp.dpName})` : ''}`,
                type,
                role: 'state',
                read: true,
                write: writable,
            });

            if (writable) {
                this.writableStates.set(stateId, {
                    deviceId: device.id,
                    dpId: dp.dpId,
                    kind: 'raw',
                    valueType: type,
                });
            }
        }
    }

    private async updateDeviceStates(device: FairlandDevice): Promise<void> {
        const deviceBase = this.deviceBase(device);
        const dpMap = this.dpMap(device);

        await this.setStateAsync(`${deviceBase}.info.name`, { val: device.deviceName ?? device.id, ack: true });
        await this.setStateAsync(`${deviceBase}.info.category`, { val: device.categoryCode ?? '', ack: true });
        await this.setStateAsync(`${deviceBase}.info.version`, { val: device.version ?? '', ack: true });

        if (device.categoryCode === HEAT_PUMP_CATEGORY_CODE) {
            await this.updateHeatPumpStates(device, dpMap);
        } else if (device.categoryCode === WATER_PUMP_CATEGORY_CODE) {
            await this.updateWaterPumpStates(device, dpMap);
        }

        if ((this.config as NativeConfig).createRawStates) {
            await this.updateRawStates(device, dpMap);
        }
    }

    private async updateHeatPumpStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        const deviceBase = this.deviceBase(device);
        const powerRaw = this.dpValue(device.id, dpMap, HEAT_PUMP_POWER_DP_ID);
        const isOn = Boolean(powerRaw);

        if (dpMap.has(HEAT_PUMP_POWER_DP_ID)) {
            await this.setStateAsync(`${deviceBase}.power`, { val: isOn, ack: true });
        }

        if (dpMap.has(HEAT_PUMP_HVAC_MODE_DP_ID)) {
            const modeRaw = this.dpValue(device.id, dpMap, HEAT_PUMP_HVAC_MODE_DP_ID);
            const mode = isOn ? (HEAT_HVAC_MODES[Number(modeRaw)] ?? 'off') : 'off';
            await this.setStateAsync(`${deviceBase}.mode`, { val: mode, ack: true });
        }

        const targetDp = dpMap.get(HEAT_PUMP_TARGET_TEMP_DP_ID);
        if (targetDp) {
            const rawValue = this.effectiveDpValue(device.id, targetDp.dpId, targetDp.dpValue);
            await this.setStateAsync(`${deviceBase}.temperature.target`, {
                val: scaleRead(rawValue, getDpScale(targetDp, 0)),
                ack: true,
            });
        }

        const presetDp = dpMap.get(HEAT_PUMP_PRESET_DP_ID);
        if (presetDp) {
            const rawValue = this.dpValue(device.id, dpMap, HEAT_PUMP_PRESET_DP_ID);
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

        for (const definition of HEAT_PUMP_SENSOR_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of HEAT_PUMP_NUMBER_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, true);
        }
    }

    private async updateWaterPumpStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        const deviceBase = this.deviceBase(device);

        if (dpMap.has(WATER_PUMP_POWER_DP_ID)) {
            await this.setStateAsync(`${deviceBase}.power`, {
                val: Boolean(this.dpValue(device.id, dpMap, WATER_PUMP_POWER_DP_ID)),
                ack: true,
            });
        }

        const modeDp = dpMap.get(WATER_PUMP_MODE_DP_ID);
        if (modeDp) {
            const rawValue = this.dpValue(device.id, dpMap, WATER_PUMP_MODE_DP_ID);
            const options = parseEnumOptions(modeDp, WATER_PUMP_MODE_FALLBACK, WATER_PUMP_MODE_LABEL_TO_OPTION);
            await this.setStateAsync(`${deviceBase}.mode`, {
                val: options[Number(rawValue)] ?? null,
                ack: true,
            });
        }

        for (const definition of WATER_PUMP_SENSOR_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, false);
        }
        for (const definition of WATER_PUMP_NUMBER_DEFINITIONS) {
            await this.updateDefinitionState(device, definition, dpMap, true);
        }
    }

    private async updateDefinitionState(
        device: FairlandDevice,
        definition: DpStateDefinition,
        dpMap: Map<string, FairlandDataPoint>,
        writableDefinition: boolean,
    ): Promise<void> {
        const dp = dpMap.get(definition.dpId);
        if (!dp || (definition.requireValue && dp.dpValue === null)) {
            return;
        }
        if (writableDefinition && dp.dpMode !== 'rw') {
            return;
        }

        const applied = applyDpProperty(definition, dp);
        const rawValue = this.effectiveDpValue(device.id, applied.dpId, dp.dpValue);
        const value = scaleRead(rawValue, applied.scale ?? 0);
        await this.setStateAsync(`${this.deviceBase(device)}.${definition.id}`, {
            val: value,
            ack: true,
        });
    }

    private async updateRawStates(device: FairlandDevice, dpMap: Map<string, FairlandDataPoint>): Promise<void> {
        for (const dp of dpMap.values()) {
            const rawValue = this.effectiveDpValue(device.id, dp.dpId, dp.dpValue);
            await this.setStateAsync(`${this.deviceBase(device)}.raw.dp_${sanitizeObjectId(dp.dpId)}`, {
                val: toStateValue(rawValue),
                ack: true,
            });
        }
    }

    private async handleWritableState(
        localId: string,
        mapping: WritableStateMapping,
        value: StateValue,
    ): Promise<void> {
        if (!this.apiClient) {
            return;
        }

        if (mapping.kind === 'heatHvacMode') {
            await this.writeHeatHvacMode(localId, mapping, value);
            return;
        }

        if (mapping.kind === 'heatPresetMode' || mapping.kind === 'waterPumpMode') {
            await this.writeMappedMode(localId, mapping, value);
            return;
        }

        const coerced = coerceStateValue(value, mapping.valueType);
        const rawValue = mapping.kind === 'heatTargetTemperature' ? scaleWrite(coerced, mapping.scale ?? 0) : coerced;

        await this.apiClient.setDeviceStatus(mapping.deviceId, mapping.dpId, rawValue);
        this.notePendingWrite(mapping.deviceId, mapping.dpId, rawValue);
        await this.setStateAsync(localId, { val: coerced, ack: true });
        this.scheduleWriteRefresh();
    }

    private async writeHeatHvacMode(localId: string, mapping: WritableStateMapping, value: StateValue): Promise<void> {
        if (!this.apiClient) {
            return;
        }

        const mode = String(value);
        const deviceBase = this.deviceObjectIds.get(mapping.deviceId);

        if (mode === 'off') {
            await this.apiClient.setDeviceStatus(mapping.deviceId, HEAT_PUMP_POWER_DP_ID, false);
            this.notePendingWrite(mapping.deviceId, HEAT_PUMP_POWER_DP_ID, false);
            await this.setStateAsync(localId, { val: 'off', ack: true });
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

        await this.apiClient.setDeviceStatus(mapping.deviceId, HEAT_PUMP_POWER_DP_ID, true);
        this.notePendingWrite(mapping.deviceId, HEAT_PUMP_POWER_DP_ID, true);
        await this.apiClient.setDeviceStatus(mapping.deviceId, mapping.dpId, rawMode);
        this.notePendingWrite(mapping.deviceId, mapping.dpId, rawMode);

        if (deviceBase) {
            await this.setStateAsync(`${deviceBase}.power`, { val: true, ack: true });
        }
        await this.setStateAsync(localId, { val: mode, ack: true });
        this.scheduleWriteRefresh();
    }

    private async writeMappedMode(localId: string, mapping: WritableStateMapping, value: StateValue): Promise<void> {
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

    private heatPumpAction(deviceId: string, dpMap: Map<string, FairlandDataPoint>, isOn: boolean): string {
        if (!isOn) {
            return 'off';
        }

        const action = this.dpValue(deviceId, dpMap, HEAT_PUMP_ACTION_DP_ID);
        const mode = this.dpValue(deviceId, dpMap, HEAT_PUMP_HVAC_MODE_DP_ID);
        if (Number(action) !== 1) {
            return 'idle';
        }

        if (Number(mode) === 1) {
            return 'heating';
        }
        if (Number(mode) === 2) {
            return 'cooling';
        }
        return 'idle';
    }

    private dpValue(deviceId: string, dpMap: Map<string, FairlandDataPoint>, dpId: string): unknown {
        const dp = dpMap.get(dpId);
        return dp ? this.effectiveDpValue(deviceId, dpId, dp.dpValue) : undefined;
    }

    private effectiveDpValue(deviceId: string, dpId: string, polledValue: unknown): unknown {
        const key = this.pendingKey(deviceId, dpId);
        const pending = this.pendingWrites.get(key);
        if (!pending) {
            return polledValue;
        }

        if (valuesMatch(polledValue, pending.value) || Date.now() >= pending.expiresAt) {
            this.pendingWrites.delete(key);
            return polledValue;
        }

        return pending.value;
    }

    private notePendingWrite(deviceId: string, dpId: string, value: unknown): void {
        this.pendingWrites.set(this.pendingKey(deviceId, dpId), {
            value,
            expiresAt: Date.now() + PENDING_WRITE_TIMEOUT_MS,
        });
    }

    private scheduleWriteRefresh(): void {
        if (this.writeRefreshTimer) {
            this.clearTimeout(this.writeRefreshTimer);
        }
        this.writeRefreshTimer = this.setTimeout(() => {
            this.writeRefreshTimer = undefined;
            void this.pollDevices();
        }, WRITE_REFRESH_DELAY_MS);
    }

    private selectCourtyard(courtyards: FairlandCourtyard[], configuredCourtyardId: string): string {
        if (configuredCourtyardId) {
            this.log.info(`Using configured courtyard ID '${configuredCourtyardId}'.`);
            return configuredCourtyardId;
        }

        if (courtyards.length === 0) {
            throw new FairlandApiClientError('No courtyards found for this account.');
        }

        if (courtyards.length > 1) {
            this.log.warn(
                `Multiple courtyards found. Using '${courtyards[0].name}' (${courtyards[0].id}). Available: ${courtyards
                    .map(courtyard => `${courtyard.name}=${courtyard.id}`)
                    .join(', ')}`,
            );
        }

        return courtyards[0].id;
    }

    private parseHeatPresetOptions(dp: FairlandDataPoint): Record<number, string> {
        return parseEnumOptions(dp, {}, {});
    }

    private getScanIntervalSeconds(config: NativeConfig): number {
        const parsed = Number(config.scanInterval ?? DEFAULT_SCAN_INTERVAL_SECONDS);
        if (!Number.isFinite(parsed)) {
            return DEFAULT_SCAN_INTERVAL_SECONDS;
        }
        return Math.max(MIN_SCAN_INTERVAL_SECONDS, Math.round(parsed));
    }

    private dpMap(device: FairlandDevice): Map<string, FairlandDataPoint> {
        return new Map((device.dps ?? []).map(dp => [String(dp.dpId), { ...dp, dpId: String(dp.dpId) }]));
    }

    private deviceBase(device: FairlandDevice): string {
        let objectId = this.deviceObjectIds.get(device.id);
        if (!objectId) {
            objectId = `devices.${sanitizeObjectId(device.id)}`;
            this.deviceObjectIds.set(device.id, objectId);
        }
        return objectId;
    }

    private async ensureDevice(deviceBase: string, device: FairlandDevice): Promise<void> {
        if (this.ensuredObjects.has(deviceBase)) {
            return;
        }

        await this.extendObjectAsync(deviceBase, {
            type: 'device',
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

    private async ensureState(
        stateId: string,
        common: ioBroker.StateCommon,
        native: Record<string, unknown> = {},
    ): Promise<void> {
        await this.ensureParentChannels(stateId);

        await this.extendObjectAsync(stateId, {
            type: 'state',
            common,
            native,
        });
        this.ensuredObjects.add(stateId);
    }

    private async ensureParentChannels(stateId: string): Promise<void> {
        const parts = stateId.split('.');
        let current = '';

        for (let index = 0; index < parts.length - 1; index += 1) {
            current = current ? `${current}.${parts[index]}` : parts[index];

            if (this.ensuredObjects.has(current)) {
                continue;
            }

            if (index === 1 && parts[0] === 'devices') {
                continue;
            }

            await this.extendObjectAsync(current, {
                type: 'channel',
                common: {
                    name: this.channelName(parts[index]),
                },
                native: {},
            });
            this.ensuredObjects.add(current);
        }
    }

    private channelName(part: string): string {
        return part
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[_-]+/g, ' ')
            .replace(/\b\w/g, match => match.toUpperCase());
    }

    private pendingKey(deviceId: string, dpId: string): string {
        return `${deviceId}:${dpId}`;
    }

    private toLocalId(id: string): string {
        const prefix = `${this.namespace}.`;
        return id.startsWith(prefix) ? id.slice(prefix.length) : id;
    }

    private async setConnectionState(connected: boolean): Promise<void> {
        await this.setStateAsync('info.connection', { val: connected, ack: true });
    }

    private errorMessage(error: unknown): string {
        if (
            error instanceof FairlandApiClientAuthenticationError ||
            error instanceof FairlandApiClientCommunicationError ||
            error instanceof FairlandApiClientError ||
            error instanceof Error
        ) {
            return error.message;
        }
        return String(error);
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new FairlandAdapter(options);
} else {
    new FairlandAdapter();
}
