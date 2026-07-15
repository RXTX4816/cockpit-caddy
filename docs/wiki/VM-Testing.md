# VM Testing

Automated QEMU VMs for testing cockpit-caddy across three distros.
The VM harness is provided by [`@rxtx4816/cockpit-plugin-base-react`](https://github.com/RXTX4816/cockpit-plugin-base-react) and invoked via `npm run vm <command>`. Plugin-specific config (VM names, ports, distro packages) lives in `scripts/test-vm.config.sh` in this repo.

The harness downloads official cloud images, provisions them with cloud-init, and mounts your local `src/` folder live into the VM — so `npm run watch` changes are visible in the browser without restarting anything.

## Prerequisites

Install QEMU and the cloud image tools (Arch Linux):

```bash
sudo pacman -S qemu-full cloud-image-utils wget
```

KVM must be accessible (`/dev/kvm`) for reasonable boot speed.
The script falls back to software emulation automatically if it isn't, but it will be slow.

## First-time setup

```bash
# 1. Download cloud base images (~500-700 MB each, one per distro)
npm run vm download debian        # just debian
npm run vm download               # all three distros

# 2. Build the plugin so src/main.js exists
npm run build
```

Images are saved to `.vms/<distro>/base.qcow2` (gitignored).

## Starting a VM

```bash
npm run vm start arch             # specific VM
npm run vm start                  # all three VMs
```

The VM boots in the background. Block until cloud-init finishes:

```bash
npm run vm wait arch
```

`wait` polls SSH then runs `cloud-init status --wait` inside the VM. It warns if Cockpit doesn't come up.

## Access

| VM | Cockpit | SSH |
|---|---|---|
| arch | https://localhost:9093 | `ssh -p 2230 test@localhost` |
| debian | https://localhost:9094 | `ssh -p 2231 test@localhost` |
| fedora | https://localhost:9095 | `ssh -p 2232 test@localhost` |

**Login:** `test` / `test` (your `~/.ssh/id_*.pub` is also injected automatically if found)

## Useful commands

| Command | What it does |
|---|---|
| `npm run vm status` | Show all VMs with state and ports |
| `npm run vm download [distro\|all]` | Download base cloud images |
| `npm run vm build` | `npm run build` shortcut |
| `npm run vm start <vm>` | Start VM(s) in background |
| `npm run vm wait <vm>` | Block until cloud-init fully finishes |
| `npm run vm stop <vm>` | Stop VM(s) |
| `npm run vm ssh <vm>` | Open SSH session |
| `npm run vm logs <vm>` | Tail serial console output |
| `npm run vm clean <vm>` | Wipe disk + re-provision on next start |
| `npm run vm reset <distro>` | Remove all files including base image |

## Live editing

The `src/` directory on your host is mounted read-only into the VM at
`/usr/share/cockpit/cockpit-caddy` via 9p virtfs. Start watch mode on the host
and just refresh the browser in the VM:

```bash
npm run watch
```

No file copying or VM restarts needed.

## Automated browser tests (Playwright)

Once a VM is up, run the Playwright E2E suite against it. Each VM is a Playwright project named after the distro — use `--project` to select which VM(s) to test:

```bash
# Start and wait for a VM
npm run vm start arch
npm run vm wait arch

# Run against that specific VM
npm run test:e2e -- --project=arch

# Run against a subset (all must be running)
npm run test:e2e -- --project=arch --project=debian

# Run against all three VMs (requires all to be running)
npm run test:e2e

# Visual runner — shows every step, ideal for debugging failures
npm run test:e2e:ui

# Record a new test interactively
BASE_URL=https://localhost:9093 npm run test:e2e:codegen
```

Check which VMs are currently running before selecting projects:

```bash
npm run vm status
```

Tests live in `e2e/` and cover login, tab navigation, service control, proxy management, Caddyfile editor, and logs viewer. See [E2E Test Coverage](E2E-Test-Coverage) for the full catalog of what's implemented.

## Reprovisioning

VMs use an overlay disk over the base image. The base is never modified.

```bash
# Wipe a VM's disk and cloud-init state; next start re-provisions from scratch
npm run vm clean arch

# Remove everything for a distro including the shared base image
npm run vm reset arch
```

`clean` is the go-to fix when cloud-init fails or you want to test a fresh install
without re-downloading the base image.

## Environment overrides

```bash
VM_MEM=4096 VM_CPUS=4 npm run vm start fedora
```

| Variable | Default | Description |
|---|---|---|
| `VM_MEM` | `2048` | RAM in MB |
| `VM_CPUS` | `2` | vCPU count |
| `VM_DISK_SIZE` | `12G` | Overlay disk size |

## Troubleshooting

**`wait` exits but Cockpit page is not accessible**
SSH is available before cloud-init finishes installing packages. Use `wait` (not just `start`) — it runs `cloud-init status --wait` inside the VM. If `wait` reports a warning, SSH in and check:
```bash
npm run vm ssh arch
sudo cloud-init status --long
sudo journalctl -u cloud-init --no-pager -n 50
```

**VM won't start / QEMU error about virtfs**
`qemu-base` doesn't include virtfs support. Install `qemu-full`:
```bash
sudo pacman -S qemu-full
```

**Cockpit loads but cockpit-caddy is missing**
The 9p mount failed. SSH in and check:
```bash
mount | grep cockpit
ls /usr/share/cockpit/cockpit-caddy/
# If missing:
sudo modprobe 9p 9pnet 9pnet_virtio
sudo mount /usr/share/cockpit/cockpit-caddy
```

**First boot is very slow**
Expected without KVM. Make sure your user is in the `kvm` group:
```bash
sudo usermod -aG kvm $USER   # then log out and back in
```

**Port already in use**
Change the port constants in `scripts/test-vm.config.sh`:
```bash
COCKPIT_BASE=9093   # arch=9093, debian=9094, fedora=9095
SSH_BASE=2230       # arch=2230, debian=2231, fedora=2232
```
