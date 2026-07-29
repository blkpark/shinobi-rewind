# Shinobi Rewind

An unofficial, self-hosted companion for finding Shinobi recordings by exact time, reviewing up to six cameras on one shared timeline, and preserving explicitly favorited segments on a separate archive drive.

The operator UI supports Korean and English. The language switch in the top bar is saved in browser storage; first-time visitors use their browser language, with English as the fallback.

## Run

`make run` builds the embedded React UI and launches demo mode at `http://localhost:8080`. Demo mode includes recording, gap, and corrupt timeline states and deliberately reports `모션 데이터 사용 불가 · detector off`.

For a live, read-only installation copy `.env.example` to `.env`, set `DEMO_MODE=false`, and provide `SHINOBI_URL`, `SHINOBI_GROUP_KEY`, and `SHINOBI_API_KEY` through your secret manager. Prefer a dedicated RTSP-to-HLS bridge through `LIVE_HLS_URL`; it keeps live-view reconnects independent from Shinobi recording. Bridge path names are derived server-side from the camera ID and quality. `SHINOBI_LOW_STREAM_CHANNEL` remains an optional compatibility path and must not share a multi-input FFmpeg process with recording cameras. Credentials and upstream recording paths are never sent to the browser or included in request logs.

The included Compose example joins an existing `cctv` Docker network and binds to `127.0.0.1:8092` by default. Override `SHINOBI_REWIND_BIND_IP` and `SHINOBI_REWIND_PORT` in the deployment environment; keep site-specific addresses out of the public repository.

## Container image

Release tags publish a multi-stage Docker image to `ghcr.io/blkpark/shinobi-rewind`. Pin a released version in production instead of a floating tag:

```sh
docker pull ghcr.io/blkpark/shinobi-rewind:v0.2.0
```

The image contains this project's license and [third-party notices](THIRD_PARTY_NOTICES.md). It still requires a local `.env`, a trusted network, and an existing Shinobi deployment.

`npm` is only required to build the embedded web UI; the running Go service and release image do not use an npm cache. A build host that needs a custom cache location can set `NPM_CONFIG_CACHE` in its shell or CI environment. Do not put that build-only path in the application's runtime `.env` file.

## Security boundary

Shinobi Rewind is designed for a trusted LAN or an authenticated VPN/reverse proxy. It does not provide user authentication. In particular, archive creation is a write operation, so never expose the service directly to the public internet. Keep the default loopback bind unless an external access-control layer protects every route. See [SECURITY.md](SECURITY.md) before operating with real cameras.

Set `ARCHIVE_ROOT` to a dedicated writable directory to enable favorite preservation. The service streams the completed original segment from Shinobi into a `.part` file, verifies its byte count and SHA-256 digest, and atomically publishes only the verified copy. The archive is intentionally independent of browser favorite removal and exposes no permanent-delete API while the LAN service has no authentication boundary.

## API

`GET /api/v1/capabilities`, `/cameras`, `/timeline?date=YYYY-MM-DD&camera=...`, `/events?from=RFC3339&to=RFC3339&camera=...`, and `GET|HEAD /api/v1/videos/{opaqueId}`. Video proxying forwards HTTP ranges without buffering; gap, corrupt, malformed, and unplayable segments return a safe error. The archive API accepts idempotent favorite preservation requests, lists them by KST date or month, and serves HTTP Range previews only for verified artifacts.

Timeline segments expose `hasAudio` as `true`, `false`, or `null`. Only explicit Shinobi video metadata becomes true/false; missing or ambiguous metadata stays null rather than being guessed. The browser keeps at most one audible camera and mutes audio above 4x.

The control view keeps one active video per camera, supports native PiP with fullscreen fallback, 0.25x–20x custom speed, fixed-playhead drag/zoom, direct time jumps, ±5 second arrow-key jumps, and absolute-KST local favorites. Incident search drills from month to week to day and keeps detector-off, zero-event, no-data, and partial failures distinct.

## Checks

Run `make fmt test lint typecheck build`. The frontend uses only React/Vite/TypeScript; backend uses Go standard library.

## Open-source status

The source is MIT licensed and contains a credential-free demo mode. It is suitable for self-hosted evaluation and trusted-network use, but version `0.2.x` should be treated as beta: deployments must supply their own authentication boundary, Shinobi instance, archive storage, and optional RTSP-to-HLS bridge.

Shinobi Rewind is not affiliated with, endorsed by, or supported by Shinobi Systems. It does not include Shinobi source code. Operators remain responsible for complying with the [Shinobi license](https://gitlab.com/Shinobi-Systems/Shinobi/-/blob/master/LICENSE.md) and any camera-vendor terms that apply to their own installation.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution rules, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for bundled dependency notices.

## Live integration note

Live mode uses Shinobi's documented `/{apiKey}/videos/{groupKey}/{monitorId}` and `/{apiKey}/events/{groupKey}/{monitorId}` routes with KST `start` and `end` bounds, decoding their `{videos:[...]}` and `{events:[...]}` envelopes. The UI intentionally does not claim motion is absent when the detector/event source is unavailable.
