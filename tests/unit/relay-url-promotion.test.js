// Relay URLs must never go through undici ProxyAgent: a relay endpoint
// (https://*.vercel.app, *.workers.dev, *.deno.dev) saved as a standard
// proxy fails 100% of requests with a bare "fetch failed" and silently
// falls back to direct. These tests pin the promotion to the relay path
// at both layers: config resolution and proxyAwareFetch.
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/models", () => ({
  getProxyPoolById: vi.fn(),
}));

const { getProxyPoolById } = await import("@/models");
const { resolveConnectionProxyConfig } = await import("../../src/lib/network/connectionProxy.js");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("resolveConnectionProxyConfig promotes relay URLs", () => {
  it("routes a standard-type pool holding a vercel.app URL via relay headers", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "p-relay", isActive: true, proxyUrl: "https://vercel-relay-abc123.vercel.app",
      type: "http", strictProxy: false,
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p-relay" });
    expect(cfg.vercelRelayUrl).toBe("https://vercel-relay-abc123.vercel.app");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });

  it("routes legacy connection fields holding a workers.dev URL via relay headers", async () => {
    getProxyPoolById.mockResolvedValue(null);
    const cfg = await resolveConnectionProxyConfig({
      connectionProxyEnabled: true,
      connectionProxyUrl: "https://my-relay.user.workers.dev",
    });
    expect(cfg.vercelRelayUrl).toBe("https://my-relay.user.workers.dev");
    expect(cfg.connectionProxyEnabled).toBe(false);
  });

  it("leaves a real HTTP proxy untouched", async () => {
    getProxyPoolById.mockResolvedValue({
      id: "p-http", isActive: true, proxyUrl: "http://127.0.0.1:7890",
      type: "http", strictProxy: false,
    });
    const cfg = await resolveConnectionProxyConfig({ proxyPoolId: "p-http" });
    expect(cfg.connectionProxyEnabled).toBe(true);
    expect(cfg.connectionProxyUrl).toBe("http://127.0.0.1:7890");
    expect(cfg.vercelRelayUrl ?? "").toBe("");
  });
});

describe("proxyAwareFetch relay promotion + fallback", () => {
  async function loadProxyFetch(fetchMock) {
    vi.resetModules();
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(key, "");
    }
    vi.stubGlobal("fetch", fetchMock);
    return import("../../open-sse/utils/proxyFetch.js");
  }

  it("sends relay headers instead of ProxyAgent for a relay URL in standard proxy fields", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(url).toBe("https://vercel-relay-abc123.vercel.app");
      expect(options.headers["x-relay-target"]).toBe("https://api.example.com");
      expect(options.headers["x-relay-path"]).toBe("/v1/chat");
      expect(options.dispatcher).toBeUndefined();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const { proxyAwareFetch } = await loadProxyFetch(fetchMock);
    const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "GET" }, {
      connectionProxyEnabled: true,
      connectionProxyUrl: "https://vercel-relay-abc123.vercel.app",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to direct when the relay is down (non-strict)", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response("direct", { status: 200 }));
    const { proxyAwareFetch } = await loadProxyFetch(fetchMock);
    const res = await proxyAwareFetch("https://api.example.com/v1/chat", { method: "GET" }, {
      vercelRelayUrl: "https://dead-relay.vercel.app",
    });
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://dead-relay.vercel.app");
    expect(fetchMock.mock.calls[1][0]).toBe("https://api.example.com/v1/chat");
  });

  it("refuses direct fallback when the relay is down (strict)", async () => {
    const fetchMock = vi.fn(async () => { throw new TypeError("fetch failed"); });
    const { proxyAwareFetch } = await loadProxyFetch(fetchMock);
    await expect(
      proxyAwareFetch("https://api.example.com/v1/chat", { method: "GET" }, {
        vercelRelayUrl: "https://dead-relay.vercel.app",
        strictProxy: true,
      }),
    ).rejects.toThrow(/strictProxy/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("BaseExecutor relay→direct failover on 429", () => {
  async function loadBase(fetchMock) {
    vi.resetModules();
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
      vi.stubEnv(key, "");
    }
    vi.stubGlobal("fetch", fetchMock);
    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    return new BaseExecutor("test", { baseUrl: "https://api.example.com/v1" });
  }
  const req = (proxyOptions) => ({
    model: "m", body: { a: 1 }, stream: false,
    credentials: { apiKey: "k" }, log: null, proxyOptions,
  });

  it("retries direct once when the relay answers 429", async () => {
    const calls = [];
    const fetchMock = vi.fn(async (url) => {
      calls.push(String(url));
      return calls.length === 1
        ? new Response("limited", { status: 429 })
        : new Response("ok-direct", { status: 200 });
    });
    const ex = await loadBase(fetchMock);
    const r = await ex.execute(req({ vercelRelayUrl: "https://r.vercel.app" }));
    expect(r.response.status).toBe(200);
    expect(await r.response.text()).toBe("ok-direct");
    expect(calls).toEqual(["https://r.vercel.app", "https://api.example.com/v1"]);
  });

  it("does not fail over when strictProxy is set", async () => {
    const fetchMock = vi.fn(async () => new Response("limited", { status: 429 }));
    const ex = await loadBase(fetchMock);
    const r = await ex.execute(req({ vercelRelayUrl: "https://r.vercel.app", strictProxy: true }));
    expect(r.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not fail over for a standard (non-relay) proxy 429", async () => {
    const fetchMock = vi.fn(async () => new Response("limited", { status: 429 }));
    const ex = await loadBase(fetchMock);
    const r = await ex.execute(req({ connectionProxyEnabled: true, connectionProxyUrl: "http://127.0.0.1:9" }));
    expect(r.response.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
