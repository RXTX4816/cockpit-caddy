# Security Policy

`cockpit-caddy` is a Cockpit plugin that manages server-side Caddy configuration.
Because it runs with privileges to reconfigure a reverse proxy and TLS settings,
we take security reports seriously and appreciate responsible disclosure.

## Supported Versions

Security fixes are applied to the latest released version. We follow a
rolling-release model driven by semantic versioning, so please upgrade to the
most recent release before reporting an issue.

| Version        | Supported          |
|----------------|--------------------|
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
pull requests, or discussions.**

Instead, use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/RXTX4816/cockpit-caddy/security)
   of the repository.
2. Click **Report a vulnerability** to open a private security advisory.

This keeps the report confidential between you and the maintainers while a fix
is prepared.

Please include as much of the following as you can:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof of concept
- Affected version(s) and environment (OS, Caddy version, Cockpit version)
- Any suggested mitigation or fix, if you have one

## Response Process

- We aim to **acknowledge your report within 5 business days**.
- We will keep you informed of progress as we investigate and prepare a fix.
- Once a fix is released, we will publish a security advisory and credit the
  reporter, unless anonymity is requested.

Thank you for helping keep `cockpit-caddy` and its users safe.
