# Contributing to Shinobi Rewind

Thanks for improving Shinobi Rewind. Keep each pull request focused and avoid unrelated refactors.

## Before opening a pull request

1. Never add camera footage, RTSP URLs, credentials, private IP addresses, or customer site details to code, fixtures, screenshots, issues, or commits.
2. Preserve the service boundary: Shinobi remains the recording source of truth; Rewind does not edit cameras, recordings, or Shinobi configuration.
3. Run `make test lint typecheck build`.
4. Describe the user-visible behavior and the verification performed. Do not claim live-camera proof unless it was actually run.

## Reporting bugs

Use a public issue only for reproducible, non-sensitive defects. Remove monitor names, URLs, video IDs, and request headers. Report suspected vulnerabilities or leaks privately as described in [SECURITY.md](SECURITY.md).

## Scope

This project supports self-hosted Shinobi installations. Authentication, WAN exposure, camera configuration, PTZ, and recording retention remain deployment-owner responsibilities.
