# Security Policy

## Supported versions

Shinobi Rewind is currently a `0.1.x` beta. Security fixes are applied to the latest release on `main`.

## Deployment boundary

Run the service only on a trusted LAN or behind an authenticated VPN or reverse proxy. The application does not implement user authentication, and `POST /api/v1/archives` creates persistent archive work. Do not expose the application directly to the public internet.

- Keep the Compose bind on `127.0.0.1` unless an access-control layer protects every route.
- Store Shinobi API and group keys outside the repository and inject them at runtime.
- Do not place RTSP credentials in browser URLs, camera names, logs, or screenshots.
- Mount archive storage with the minimum required permissions and keep it outside the web root.
- Rotate any credential that appears in a log, issue, screenshot, or commit history.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or leaked credential. Contact the maintainer privately through the contact method on their GitHub profile. Include the affected version, impact, reproduction steps, and any suggested mitigation. Do not include live camera credentials or footage. Private vulnerability reporting should be enabled before this repository is made public.
