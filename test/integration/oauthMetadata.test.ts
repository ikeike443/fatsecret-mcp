import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GET as authServerMetadataGET } from "../../app/.well-known/oauth-authorization-server/route";
import { GET as protectedResourceMetadataGET } from "../../app/.well-known/oauth-protected-resource/route";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.OAUTH_CLIENT_ID = "test-client-id";
  process.env.OAUTH_CLIENT_SECRET = "test-client-secret";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("GET /.well-known/oauth-authorization-server", () => {
  it("serves RFC 8414 metadata pointing at our own authorize/token endpoints", async () => {
    const req = new Request("https://fatsecret-mcp.example/.well-known/oauth-authorization-server");
    const res = await authServerMetadataGET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({
      issuer: "https://fatsecret-mcp.example",
      authorization_endpoint: "https://fatsecret-mcp.example/api/oauth/authorize",
      token_endpoint: "https://fatsecret-mcp.example/api/oauth/token",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
    });
  });
});

describe("GET /.well-known/oauth-protected-resource", () => {
  it("serves RFC 9728 metadata pointing at this server as its own authorization server", async () => {
    const req = new Request("https://fatsecret-mcp.example/.well-known/oauth-protected-resource");
    const res = await protectedResourceMetadataGET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.authorization_servers).toEqual(["https://fatsecret-mcp.example"]);
  });
});
