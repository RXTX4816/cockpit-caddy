const MIN_PORT = 1024;
const MAX_PORT = 65535;
const DEFAULT_START = 8443;

export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT;
}

export function suggestNextPort(usedPorts: number[]): number {
  const used = new Set(usedPorts);
  let candidate = DEFAULT_START;
  while (used.has(candidate) && candidate <= MAX_PORT) {
    candidate++;
  }
  return candidate;
}

export function formatProxyUrl(host: string, port: number, tls: boolean): string {
  return `${tls ? "https" : "http"}://${host}:${port}`;
}
