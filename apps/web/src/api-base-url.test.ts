import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { browserApiBaseUrl, SERVER_API_BASE_URL } from "./api-base-url.ts";

describe("browserApiBaseUrl", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds request URLs on the page origin, never on the server-only host", () => {
    vi.stubGlobal("location", { origin: "https://app.example.test" });

    const url = new URL("/api/session", browserApiBaseUrl());

    expect(url.href).toBe("https://app.example.test/api/session");
    expect(url.hostname).not.toContain("api.internal");
    expect(new URL("/api/session", SERVER_API_BASE_URL).hostname).toBe("api.internal");
  });
});
