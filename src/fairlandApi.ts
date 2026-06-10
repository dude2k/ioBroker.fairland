import type {
  ApiRegion,
  FairlandCourtyard,
  FairlandDataPoint,
  FairlandDevice,
} from "./types";

export const API_REGIONS: Record<ApiRegion, string> = {
  eu: "https://api-eu.fairlandiot.com",
  us: "https://api-us.fairlandiot.com",
  cn: "https://api-cn.fairlandiot.com",
  hk: "https://api-hk.fairlandiot.com",
};

const DEFAULT_REGION: ApiRegion = "eu";
const SUCCESS_CODE = 200000;

interface ApiResponse<T> {
  code: number;
  msg?: string;
  data: T;
}

interface LoginData {
  authorization: string;
  userId: string;
  [key: string]: unknown;
}

interface ClientOptions {
  username: string;
  password: string;
  countryCode?: string;
  phoneCode?: string;
  region?: ApiRegion;
  timeoutMs?: number;
}

export class FairlandApiClientError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FairlandApiClientError";
  }
}

export class FairlandApiClientCommunicationError extends FairlandApiClientError {
  public constructor(message: string) {
    super(message);
    this.name = "FairlandApiClientCommunicationError";
  }
}

export class FairlandApiClientAuthenticationError extends FairlandApiClientError {
  public constructor(message: string) {
    super(message);
    this.name = "FairlandApiClientAuthenticationError";
  }
}

export class FairlandApiClient {
  private readonly username: string;
  private readonly password: string;
  private readonly countryCode: string;
  private readonly phoneCode: string;
  private readonly timeoutMs: number;
  private token: string | undefined;
  private userId: string | undefined;

  public region: ApiRegion;

  public constructor(options: ClientOptions) {
    this.username = options.username;
    this.password = options.password;
    this.countryCode = options.countryCode ?? "DE";
    this.phoneCode = options.phoneCode ?? "49";
    this.region = options.region ?? DEFAULT_REGION;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  public get baseUrl(): string {
    return API_REGIONS[this.region] ?? API_REGIONS[DEFAULT_REGION];
  }

  public get currentUserId(): string | undefined {
    return this.userId;
  }

  public async detectRegion(): Promise<ApiRegion> {
    let lastAuthError: FairlandApiClientAuthenticationError | undefined;
    let lastError: FairlandApiClientError | undefined;

    for (const region of Object.keys(API_REGIONS) as ApiRegion[]) {
      this.region = region;
      this.token = undefined;

      try {
        await this.login();
        return region;
      } catch (error) {
        if (error instanceof FairlandApiClientAuthenticationError) {
          lastAuthError = error;
        } else if (error instanceof FairlandApiClientError) {
          lastError = error;
        } else {
          lastError = new FairlandApiClientError(String(error));
        }
      }
    }

    throw lastError ?? lastAuthError ?? new FairlandApiClientAuthenticationError("Login failed");
  }

  public async login(): Promise<LoginData> {
    const response = await this.fetchJson<LoginData>(
      `${this.baseUrl}/fyld-user-api/user/loginByPassword`,
      {
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
      },
    );

    if (response.code !== SUCCESS_CODE) {
      throw new FairlandApiClientAuthenticationError(
        `Login failed: ${response.code} ${response.msg ?? ""}`.trim(),
      );
    }

    this.token = response.data.authorization;
    this.userId = response.data.userId;
    return response.data;
  }

  public async getCourtyards(): Promise<FairlandCourtyard[]> {
    return this.apiRequest<FairlandCourtyard[]>(
      "/fyld-device-api/deviceGroupApi/allGroupInfo",
      {
        needDeviceCount: true,
      },
    );
  }

  public async getAllDevicesInCourtyard(courtyardId: string): Promise<FairlandDevice[]> {
    const data = await this.apiRequest<{ bindDeviceInfos?: FairlandDevice[] }>(
      "/fyld-device-api/deviceApi/deviceAllGroupInfo",
      {
        deviceGroupId: courtyardId,
        shareId: null,
      },
    );

    return data.bindDeviceInfos ?? [];
  }

  public async getDeviceStatus(deviceId: string): Promise<FairlandDataPoint[]> {
    return this.apiRequest<FairlandDataPoint[]>(
      "/fyld-device-api/deviceDataPointApi/deviceDataPointInfo",
      {
        deviceId,
      },
    );
  }

  public async setDeviceStatus(deviceId: string, dpId: string, value: unknown): Promise<unknown> {
    return this.apiRequest<unknown>("/fyld-device-api/devicePropertySetApi/set", {
      deviceId,
      dpIdValues: [{ type: "", dpId, value }],
    });
  }

  private async apiRequest<T>(
    path: string,
    payload: Record<string, unknown>,
    retryOnAuth = true,
  ): Promise<T> {
    if (!this.token) {
      throw new FairlandApiClientAuthenticationError("Not logged in");
    }

    try {
      const response = await this.fetchJson<T>(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
      });

      if (response.code !== SUCCESS_CODE) {
        throw new FairlandApiClientError(
          `API failed: ${response.code} ${response.msg ?? ""}`.trim(),
        );
      }

      return response.data;
    } catch (error) {
      if (retryOnAuth && error instanceof FairlandApiClientAuthenticationError) {
        await this.login();
        return this.apiRequest<T>(path, payload, false);
      }
      throw error;
    }
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
  ): Promise<ApiResponse<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new FairlandApiClientAuthenticationError("Invalid credentials");
      }

      if (!response.ok) {
        const body = await response.text();
        throw new FairlandApiClientCommunicationError(
          `HTTP ${response.status}: ${body}`,
        );
      }

      return (await response.json()) as ApiResponse<T>;
    } catch (error) {
      if (error instanceof FairlandApiClientError) {
        throw error;
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new FairlandApiClientCommunicationError(`Timeout fetching ${url}`);
      }

      throw new FairlandApiClientCommunicationError(
        `Error fetching ${url}: ${String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private publicHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      terminal: "2",
      "User-Agent": "Dart/3.5 (dart:io)",
      Accept: "application/json;charset=UTF-8",
    };
  }

  private authHeaders(): Record<string, string> {
    if (!this.token) {
      throw new FairlandApiClientAuthenticationError("Not logged in");
    }

    return {
      ...this.publicHeaders(),
      Authorization: this.token,
    };
  }
}
