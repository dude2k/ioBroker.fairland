"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FairlandApiClient = exports.FairlandApiClientAuthenticationError = exports.FairlandApiClientCommunicationError = exports.FairlandApiClientError = exports.API_REGIONS = void 0;
exports.API_REGIONS = {
    eu: "https://api-eu.fairlandiot.com",
    us: "https://api-us.fairlandiot.com",
    cn: "https://api-cn.fairlandiot.com",
    hk: "https://api-hk.fairlandiot.com",
};
const DEFAULT_REGION = "eu";
const SUCCESS_CODE = 200000;
class FairlandApiClientError extends Error {
    constructor(message) {
        super(message);
        this.name = "FairlandApiClientError";
    }
}
exports.FairlandApiClientError = FairlandApiClientError;
class FairlandApiClientCommunicationError extends FairlandApiClientError {
    constructor(message) {
        super(message);
        this.name = "FairlandApiClientCommunicationError";
    }
}
exports.FairlandApiClientCommunicationError = FairlandApiClientCommunicationError;
class FairlandApiClientAuthenticationError extends FairlandApiClientError {
    constructor(message) {
        super(message);
        this.name = "FairlandApiClientAuthenticationError";
    }
}
exports.FairlandApiClientAuthenticationError = FairlandApiClientAuthenticationError;
class FairlandApiClient {
    username;
    password;
    countryCode;
    phoneCode;
    timeoutMs;
    token;
    userId;
    region;
    constructor(options) {
        this.username = options.username;
        this.password = options.password;
        this.countryCode = options.countryCode ?? "DE";
        this.phoneCode = options.phoneCode ?? "49";
        this.region = options.region ?? DEFAULT_REGION;
        this.timeoutMs = options.timeoutMs ?? 10_000;
    }
    get baseUrl() {
        return exports.API_REGIONS[this.region] ?? exports.API_REGIONS[DEFAULT_REGION];
    }
    get currentUserId() {
        return this.userId;
    }
    async detectRegion() {
        let lastAuthError;
        let lastError;
        for (const region of Object.keys(exports.API_REGIONS)) {
            this.region = region;
            this.token = undefined;
            try {
                await this.login();
                return region;
            }
            catch (error) {
                if (error instanceof FairlandApiClientAuthenticationError) {
                    lastAuthError = error;
                }
                else if (error instanceof FairlandApiClientError) {
                    lastError = error;
                }
                else {
                    lastError = new FairlandApiClientError(String(error));
                }
            }
        }
        throw lastError ?? lastAuthError ?? new FairlandApiClientAuthenticationError("Login failed");
    }
    async login() {
        const response = await this.fetchJson(`${this.baseUrl}/fyld-user-api/user/loginByPassword`, {
            method: "POST",
            headers: this.publicHeaders(),
            body: JSON.stringify({
                phoneCode: this.phoneCode,
                accountName: this.username,
                password: this.password,
                countryCode: this.countryCode,
                randStr: "",
                ticket: "",
            }),
        });
        if (response.code !== SUCCESS_CODE) {
            throw new FairlandApiClientAuthenticationError(`Login failed: ${response.code} ${response.msg ?? ""}`.trim());
        }
        this.token = response.data.authorization;
        this.userId = response.data.userId;
        return response.data;
    }
    async getCourtyards() {
        return this.apiRequest("/fyld-device-api/deviceGroupApi/allGroupInfo", {
            needDeviceCount: true,
        });
    }
    async getAllDevicesInCourtyard(courtyardId) {
        const data = await this.apiRequest("/fyld-device-api/deviceApi/deviceAllGroupInfo", {
            deviceGroupId: courtyardId,
            shareId: null,
        });
        return data.bindDeviceInfos ?? [];
    }
    async getDeviceStatus(deviceId) {
        return this.apiRequest("/fyld-device-api/deviceDataPointApi/deviceDataPointInfo", {
            deviceId,
        });
    }
    async setDeviceStatus(deviceId, dpId, value) {
        return this.apiRequest("/fyld-device-api/devicePropertySetApi/set", {
            deviceId,
            dpIdValues: [{ type: "", dpId, value }],
        });
    }
    async apiRequest(path, payload, retryOnAuth = true) {
        if (!this.token) {
            throw new FairlandApiClientAuthenticationError("Not logged in");
        }
        try {
            const response = await this.fetchJson(`${this.baseUrl}${path}`, {
                method: "POST",
                headers: this.authHeaders(),
                body: JSON.stringify(payload),
            });
            if (response.code !== SUCCESS_CODE) {
                throw new FairlandApiClientError(`API failed: ${response.code} ${response.msg ?? ""}`.trim());
            }
            return response.data;
        }
        catch (error) {
            if (retryOnAuth && error instanceof FairlandApiClientAuthenticationError) {
                await this.login();
                return this.apiRequest(path, payload, false);
            }
            throw error;
        }
    }
    async fetchJson(url, init) {
        const signal = AbortSignal.timeout(this.timeoutMs);
        try {
            const response = await fetch(url, {
                ...init,
                signal,
            });
            if (response.status === 401 || response.status === 403) {
                throw new FairlandApiClientAuthenticationError("Invalid credentials");
            }
            if (!response.ok) {
                const body = await response.text();
                throw new FairlandApiClientCommunicationError(`HTTP ${response.status}: ${body}`);
            }
            return (await response.json());
        }
        catch (error) {
            if (error instanceof FairlandApiClientError) {
                throw error;
            }
            if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
                throw new FairlandApiClientCommunicationError(`Timeout fetching ${url}`);
            }
            throw new FairlandApiClientCommunicationError(`Error fetching ${url}: ${String(error)}`);
        }
    }
    publicHeaders() {
        return {
            "Content-Type": "application/json",
            terminal: "2",
            "User-Agent": "Dart/3.5 (dart:io)",
            Accept: "application/json;charset=UTF-8",
        };
    }
    authHeaders() {
        if (!this.token) {
            throw new FairlandApiClientAuthenticationError("Not logged in");
        }
        return {
            ...this.publicHeaders(),
            Authorization: this.token,
        };
    }
}
exports.FairlandApiClient = FairlandApiClient;
