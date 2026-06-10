"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDpProperty = parseDpProperty;
exports.getDpScale = getDpScale;
exports.scaleRead = scaleRead;
exports.scaleWrite = scaleWrite;
exports.applyDpProperty = applyDpProperty;
exports.parseEnumOptions = parseEnumOptions;
exports.toStatesObject = toStatesObject;
exports.invertEnum = invertEnum;
exports.sanitizeObjectId = sanitizeObjectId;
exports.toStateValue = toStateValue;
exports.inferStateType = inferStateType;
exports.coerceStateValue = coerceStateValue;
exports.valuesMatch = valuesMatch;
const TIME_UNIT_MAP = {
    s: "s",
    min: "min",
};
function parseDpProperty(dp) {
    if (typeof dp.dpProperty !== "string" || dp.dpProperty.trim() === "") {
        return {};
    }
    try {
        const parsed = JSON.parse(dp.dpProperty);
        return isRecord(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
function getDpScale(dp, fallback = 0) {
    const prop = parseDpProperty(dp);
    const scale = prop.scale;
    if (typeof scale === "number" && Number.isFinite(scale)) {
        return scale;
    }
    if (typeof scale === "string" && scale.trim() !== "") {
        const parsed = Number(scale);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}
function scaleRead(value, scale) {
    if (value === null || value === undefined) {
        return null;
    }
    if (scale > 0 && typeof value === "number") {
        return value / 10 ** scale;
    }
    return toStateValue(value);
}
function scaleWrite(value, scale) {
    if (value === null || value === undefined) {
        return value;
    }
    if (scale > 0 && typeof value === "number") {
        return Math.round(value * 10 ** scale);
    }
    return value;
}
function applyDpProperty(definition, dp) {
    const prop = parseDpProperty(dp);
    const next = { ...definition };
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
    if (definition.useDpTimeUnit && typeof prop.unit === "string" && TIME_UNIT_MAP[prop.unit]) {
        next.unit = TIME_UNIT_MAP[prop.unit];
    }
    return next;
}
function parseEnumOptions(dp, fallback, labelToOption) {
    const prop = parseDpProperty(dp);
    const options = {};
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
function toStatesObject(options) {
    return Object.fromEntries(Object.values(options).map((option) => [option, humanize(option)]));
}
function invertEnum(options) {
    return Object.fromEntries(Object.entries(options).map(([raw, option]) => [option, Number(raw)]));
}
function sanitizeObjectId(value) {
    const sanitized = String(value)
        .trim()
        .replace(/[.\s]+/g, "_")
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "");
    return sanitized || "unknown";
}
function toStateValue(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    return JSON.stringify(value);
}
function inferStateType(value) {
    if (typeof value === "boolean") {
        return "boolean";
    }
    if (typeof value === "number") {
        return "number";
    }
    if (typeof value === "string") {
        return "string";
    }
    return "mixed";
}
function coerceStateValue(value, type) {
    if (value === undefined || value === null || type === "mixed" || type === undefined) {
        return value ?? null;
    }
    if (type === "boolean") {
        if (typeof value === "boolean") {
            return value;
        }
        if (typeof value === "number") {
            return value !== 0;
        }
        return ["true", "1", "on", "yes"].includes(value.toLowerCase());
    }
    if (type === "number") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return String(value);
}
function valuesMatch(a, b) {
    const aNumber = Number(a);
    const bNumber = Number(b);
    if (Number.isFinite(aNumber) && Number.isFinite(bNumber)) {
        return aNumber === bNumber;
    }
    return String(a) === String(b);
}
function slugify(value) {
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return slug || "unknown";
}
function humanize(value) {
    return value
        .split("_")
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
