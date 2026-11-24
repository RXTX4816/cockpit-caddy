import { installFakeHost, type FakeHost } from "@rxtx4816/cockpit-plugin-base-react/testing/host";
import { DNS_DROPIN_PATH, DNS_ENV_PATH } from "../api/dnsChallenge";

/**
 * A fake host for the DNS credential files: the two `sh -c` commands that write the env file and
 * the systemd drop-in put their stdin where the shell would, and `systemctl` succeeds.
 * Everything else (cat, test, rm, mkdir) is the fake host's own.
 */
export function installDnsHost(files: Record<string, string> = {}): FakeHost {
  const host = installFakeHost(files);
  host.onRun(["sh", "-c"], ({ argv, options, host: h }) => {
    const cmd = argv[2] ?? "";
    if (cmd.includes(`> ${DNS_ENV_PATH}.tmp`)) h.files.set(DNS_ENV_PATH, options.stdin ?? "");
    if (cmd.includes(`> ${DNS_DROPIN_PATH}`)) h.files.set(DNS_DROPIN_PATH, options.stdin ?? "");
  });
  host.onRun(["systemctl"], "");
  return host;
}
