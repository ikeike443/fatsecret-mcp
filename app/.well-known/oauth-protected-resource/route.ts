import {
  protectedResourceHandler,
  metadataCorsOptionsRequestHandler,
  getPublicOrigin,
} from "mcp-handler";

/**
 * RFC 9728 Protected Resource Metadata. Points clients at our own domain as
 * the authorization server, since this server plays both roles.
 */
export async function GET(req: Request) {
  const origin = getPublicOrigin(req);
  return protectedResourceHandler({ authServerUrls: [origin] })(req);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
