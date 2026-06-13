import type { DpStateDefinition, FairlandDataPoint, StateValue } from './types';

const TIME_UNIT_MAP: Record<string, string> = {
    s: 's',
    min: 'min',
};
export function parseDpProperty(dp: FairlandDataPoint): Record<string, unknown> {
    if (typeof dp.dpProperty !== 'string' || dp.dpProperty.trim() === '') {
        return {};
    }

    try {
        const parsed = JSON.parse(dp.dpProperty) as unknown;
        return isRecord(parsed) ? parsed : {};
    } catch {
        return {};
    }
}
export function getDpScale(dp: FairlandDataPoint, fallback = 0): number {
    const prop = parseDpProperty(dp);
    const scale = prop.scale;
    if (typeof scale === 'number' && Number.isFinite(scale)) {
        return scale;
    }
    if (typeof scale === 'string' && scale.trim() !== '') {
        const parsed = Number(scale);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}
export function scaleRead(value: unknown, scale: number): StateValue {
    if (value === null || value === undefined) {
        return null;
    }

    if (scale > 0 && typeof value === 'number') {
        return value / 10 ** scale;
    }

    return toStateValue(value);
}
export function scaleWrite(value: StateValue, scale: number): unknown {
    if (value === null || value === undefined) {
        return value;
    }

    if (scale > 0 && typeof value === 'number') {
        return Math.round(value * 10 ** scale);
    }

    return value;
}
export function applyDpProperty(definition: DpStateDefinition, dp: FairlandDataPoint): DpStateDefinition {
    const prop = parseDpProperty(dp);
    const next: DpStateDefinition = { ...definition };

    if (definition.useDpScale) {
        next.scale = getDpScale(dp, definition.scale ?? 0);
    }

    if (definition.useDpRange) {
        if (prop.min !== undefined) {
            const min = Number(prop.min);
            if (Number.isFinite(min)) {
                next.min = min;
            }
        }
        if (prop.max !== undefined) {
            const max = Number(prop.max);
            if (Number.isFinite(max)) {
                next.max = max;
            }
        }
        if (prop.step !== undefined) {
            const step = Number(prop.step);
            if (Number.isFinite(step) && step > 0) {
                next.step = step;
            }
        }
    }

    if (definition.useDpTimeUnit && typeof prop.unit === 'string' && TIME_UNIT_MAP[prop.unit]) {
        next.unit = TIME_UNIT_MAP[prop.unit];
    }

    return next;
}
export function parseEnumOptions(
    dp: FairlandDataPoint,
    fallback: Record<number, string>,
    labelToOption: Record<string, string>,
): Record<number, string> {
    const prop = parseDpProperty(dp);
    const options: Record<number, string> = {};

    for (const [raw, label] of Object.entries(prop)) {
        const value = Number(raw);
        if (!Number.isInteger(value)) {
            continue;
        }

        const text = String(label);
        options[value] = labelToOption[text] ?? slugify(text);
    }

    return Object.keys(options).length > 0 ? options : { ...fallback };
}
export function toStatesObject(options: Record<number, string>): Record<string, string> {
    return Object.fromEntries(Object.values(options).map(option => [option, humanize(option)]));
}
export function invertEnum(options: Record<number, string>): Record<string, number> {
    return Object.fromEntries(Object.entries(options).map(([raw, option]) => [option, Number(raw)]));
}
export function sanitizeObjectId(value: unknown): string {
    const sanitized = String(value)
        .trim()
        .replace(/[.\s]+/g, '_')
        .replace(/[^A-Za-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');

    return sanitized || 'unknown';
}
export function toStateValue(value: unknown): StateValue {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return value;
    }

    return JSON.stringify(value);
}
export function inferStateType(value: unknown): 'boolean' | 'number' | 'string' | 'mixed' {
    if (typeof value === 'boolean') {
        return 'boolean';
    }
    if (typeof value === 'number') {
        return 'number';
    }
    if (typeof value === 'string') {
        return 'string';
    }
    return 'mixed';
}
export function coerceStateValue(
    value: StateValue | undefined,
    type: 'boolean' | 'number' | 'string' | 'mixed' | undefined,
): StateValue {
    if (value === undefined || value === null || type === 'mixed' || type === undefined) {
        return value ?? null;
    }

    if (type === 'boolean') {
        if (typeof value === 'boolean') {
            return value;
        }
        if (typeof value === 'number') {
            return value !== 0;
        }
        return ['true', '1', 'on', 'yes'].includes(value.toLowerCase());
    }

    if (type === 'number') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    return String(value);
}
export function valuesMatch(a: unknown, b: unknown): boolean {
    const aNumber = Number(a);
    const bNumber = Number(b);

    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
        return aNumber === bNumber;
    }

    return String(a) === String(b);
}

function slugify(value: string): string {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');

    return slug || 'unknown';
}

function humanize(value: string): string {
    return value
        .split('_')
        .filter(Boolean)
        .map(part => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
