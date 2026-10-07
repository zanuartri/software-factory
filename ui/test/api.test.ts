import { expect, test } from "bun:test";

test("api sends If-None-Match and reuses the cached body on 304", async () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const originalLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  const requests: RequestInit[] = [];
  let chatCalls = 0;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { protocol: "http:", host: "localhost" } });
  globalThis.WebSocket = class { onopen: (() => void) | null = null; onmessage: ((event: MessageEvent) => void) | null = null; onclose: (() => void) | null = null; } as unknown as typeof WebSocket;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push(init ?? {});
    if (path.endsWith("/chat")) return ++chatCalls === 1
      ? Response.json({ rev: "r1", messages: ["message"] }, { headers: { etag: '"e1"' } })
      : new Response(null, { status: 304 });
    return Response.json({ path }, { headers: { etag: '"other"' } });
  };
  // Load only after the WebSocket and location stubs exist; api.ts connects as a module side effect.
  const { api } = await import("../src/api");
  try {
    const first = await api<{ rev: string; messages: string[] }>("/api/ws/demo/chat");
    const second = await api<{ rev: string; messages: string[] }>("/api/ws/demo/chat");
    expect(new Headers(requests[1].headers).get("if-none-match")).toBe('"e1"');
    expect(second).toBe(first);
    expect(second.messages).toEqual(["message"]);
    await api("/api/other");
    await api("/api/other");
    expect(new Headers(requests[3].headers).get("if-none-match")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    if (originalLocation) Object.defineProperty(globalThis, "location", originalLocation);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
