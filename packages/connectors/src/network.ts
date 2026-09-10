import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
export class NetworkError extends Error {
  constructor(
    message: string,
    public ambiguous = false,
    public retryable = false,
  ) {
    super(message);
  }
}
export function isPublicAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && [0, 168].includes(b)) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 198 && [18, 19].includes(b)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only globally routable IPv6 unicast, excluding documentation ranges.
  return (
    isIP(ip) === 6 &&
    /^[23]/i.test(ip) &&
    !/^2001:db8:|^2002:|^3fff:/i.test(ip) &&
    !(
      ip.toLowerCase().startsWith("2001:") &&
      parseInt(ip.split(":")[1] || "0", 16) <= 0x1ff
    )
  );
}
export function assertToolDestination(endpoint: string) {
  const url = new URL(endpoint);
  const allowed = (process.env.TOOL_ALLOWED_ORIGINS ?? "")
    .split(",")
    .filter(Boolean);
  if (!allowed.includes(url.origin) || url.username || url.password || url.hash)
    throw new Error("API origin is not allowed by the administrator");
  const privateAllowed = (process.env.TOOL_ALLOW_PRIVATE_ORIGINS ?? "")
    .split(",")
    .includes(url.origin);
  if (
    url.protocol !== "https:" &&
    !(privateAllowed && url.protocol === "http:")
  )
    throw new Error("HTTPS is required");
  return { url, privateAllowed };
}
export async function boundedRequest(
  url: URL,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
    timeoutMs?: number;
    allowPrivate?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{ status: number; body: Buffer }> {
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new NetworkError("Invalid destination");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 30000),
    ...(options.signal ? [options.signal] : []),
  ]);
  signal.throwIfAborted();
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await new Promise<Awaited<ReturnType<typeof lookup>>[]>(
        (resolve, reject) => {
          const abort = () =>
            reject(new NetworkError("DNS lookup timed out", false, true));
          signal.addEventListener("abort", abort, { once: true });
          lookup(host, { all: true })
            .then(resolve, () =>
              reject(new NetworkError("DNS lookup failed", false, true)),
            )
            .finally(() => signal.removeEventListener("abort", abort));
        },
      );
  if (
    !addresses.length ||
    (!options.allowPrivate &&
      addresses.some((a) => !isPublicAddress(a.address)))
  )
    throw new NetworkError("Private or reserved destination blocked");
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    let dispatched = false;
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(
      url,
      {
        method: options.method ?? "GET",
        headers: options.headers,
        signal,
        lookup: ((_hostname: any, _options: any, callback: any) => {
          if (_options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        }) as any,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 1024 * 1024)) {
            response.destroy();
            request.destroy(
              new NetworkError("Response exceeds size limit", dispatched),
            );
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 500,
            body: Buffer.concat(chunks),
          }),
        );
        response.on("error", () =>
          reject(new NetworkError("Response interrupted", dispatched, true)),
        );
      },
    );
    // Once a socket connects, even a partial request can have an uncertain outcome.
    request.on("socket", (socket) => {
      if (!socket.connecting) dispatched = true;
      socket.once("connect", () => {
        dispatched = true;
      });
    });
    const timer = setTimeout(
      () =>
        request.destroy(
          new NetworkError("Request timed out", dispatched, true),
        ),
      options.timeoutMs ?? 30000,
    );
    request.on("close", () => clearTimeout(timer));
    request.on("error", (e) =>
      reject(
        e instanceof NetworkError
          ? e
          : new NetworkError("API connection failed", dispatched, true),
      ),
    );
    request.end(options.body);
  });
}
