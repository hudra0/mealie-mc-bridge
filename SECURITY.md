# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (a private security advisory). Do not open a public issue, and do not put cookies, tokens, passwords or logs with personal data into the report; describe the steps and use synthetic values.

If the button is missing, open an issue that asks for a private contact, without any details of the problem.

You get an answer within a week. Once a fix is released, the advisory is published with credit, unless you prefer otherwise.

## Supported versions

The project is in 0.x. Security fixes go into the latest release and `main`; older releases get no backports. Upgrade to the newest `X.Y` tag of `ghcr.io/hudra0/mealie-mc-bridge`.

| Version        | Supported |
| -------------- | --------- |
| latest 0.x     | yes       |
| older releases | no        |

## Threat model in brief

The bridge is a self-hosted service for one household. It holds the keys to the operator's Monsieur Cuisine session, the Lidl account (when the automatic login is used) and a language model API key.

What it is built to withstand:

- **Other people on the LAN** without the admin password: the admin pages need a login (required unless `ADMIN_AUTH=off`), forms carry tokens bound to the session, cross-origin POSTs and foreign `Origin` headers are refused, failed logins are throttled per client (`TRUST_PROXY` behind a reverse proxy), and pages without a login answer only to IP addresses, `localhost` and `ADMIN_HOSTS` (DNS rebinding).
- **Mealie household members** who can see and use the webhook URL: daily job and cost limits, a quantized scale and a size cap for the recipe text bound what they can spend.
- **Hostile recipe content** from websites: the recipe is marked as untrusted data in the prompt, and every model answer passes a strict schema, the device limits and the cooking rules before anything is uploaded. Output is escaped on the admin pages and in the Mealie timeline.
- **Leaks into logs, pages, mails and backups**: secrets are encrypted in `bridge.db` with `SETTINGS_KEY`, logs and mails are scrubbed of cookies, tokens and passwords, browser error texts never leave the browser adapter, and no browser profile with a session stays on disk.
- **A compromised page in the login browser**: Chromium gets a minimal environment without the bridge's secrets and types the Lidl account only into https pages of `LIDL_LOGIN_HOSTS`.

What it does not protect against:

- Anyone who can read the traffic of a plain-HTTP setup. Put a reverse proxy with TLS in front when the admin pages leave the host (README, "Security").
- Anyone with access to the host, the container or the data directory together with `SETTINGS_KEY`.
- A compromised Mealie, monsieur-cuisine.com or model provider.

The README section "Security" lists what crosses the network, who can use the webhook and what a backup holds.
