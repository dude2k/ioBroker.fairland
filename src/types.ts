export type ApiRegion = "eu" | "us" | "cn" | "hk";

export type DeviceCategory = "heatPump" | "waterPump" | string;

export type StateValue = string | number | boolean | null;

export interface NativeConfig {
  accountName?: string;
  password?: string;
  scanInterval?: number | string;
  courtyardId?: string;
  createRawStates?: boolean;
}

export interface FairlandCourtyard {
  id: string;
  name: string;
  [key: string]: unknown;
}

export interface FairlandDataPoint {
  dpId: string;
  dpName?: string;
  dpMode?: string;
  dpValue: unknown;
  dpProperty?: string;
  [key: string]: unknown;
}

export interface FairlandDevice {
  id: string;
  deviceName: string;
  categoryCode?: DeviceCategory;
  version?: string;
  dps?: FairlandDataPoint[];
  [key: string]: unknown;
}

export interface DpStateDefinition {
  id: string;
  dpId: string;
  name: string;
  role: string;
  type: "boolean" | "number" | "string" | "mixed";
  unit?: string;
  read?: boolean;
  write?: boolean;
  min?: number;
  max?: number;
  step?: number;
  scale?: number;
  requireValue?: boolean;
  useDpScale?: boolean;
  useDpRange?: boolean;
  useDpTimeUnit?: boolean;
  states?: Record<string, string>;
}

export interface WritableStateMapping {
  deviceId: string;
  dpId: string;
  kind:
    | "direct"
    | "heatPower"
    | "waterPower"
    | "heatTargetTemperature"
    | "heatHvacMode"
    | "heatPresetMode"
    | "waterPumpMode"
    | "raw";
  scale?: number;
  optionToRaw?: Record<string, number>;
  valueType?: "boolean" | "number" | "string" | "mixed";
}

export interface PendingWrite {
  value: unknown;
  expiresAt: number;
}
