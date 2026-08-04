# Security Policy

trovark grades other projects' security posture, so reports about trovark itself are held to the same bar we hold everyone else to: evidence-linked and reproducible.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Use GitHub's private vulnerability reporting: **Security tab → Report a vulnerability** on this repository. Include the trovark version (`npx trovark --version`), a reproduction, and the impact you see.

You'll get an initial response within a few days. Fixes ship as ordinary releases with the advisory published after users have a patched version.

## Scope notes

- trovark performs **static analysis only** — it never executes a scanned server's code. Reports that trovark *executed* untrusted code are top priority.
- False grades are quality bugs, not security bugs — open a regular [bug report](https://github.com/lets-order-some-fries/trovark/issues/new/choose) with the evidence link.
