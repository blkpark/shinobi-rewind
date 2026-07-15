# Shinobi Rewind

Read-only companion for finding Shinobi recordings by exact time and reviewing up to six cameras on one shared timeline.

## Run

`make run` builds the embedded React UI and launches demo mode at `http://localhost:8080`. Demo mode includes recording, gap, and corrupt timeline states and deliberately reports `모션 데이터 사용 불가 · detector off`.

For a live, read-only installation copy `.env.example` to `.env`, set `DEMO_MODE=false`, and provide `SHINOBI_URL`, `SHINOBI_GROUP_KEY`, and `SHINOBI_API_KEY` through your secret manager. The credentials and upstream recording paths are never sent to the browser or included in request logs.

The included Compose example joins an existing `cctv` Docker network and binds to `127.0.0.1:8092` by default. Override `SHINOBI_REWIND_BIND_IP` and `SHINOBI_REWIND_PORT` in the deployment environment; keep site-specific addresses out of the public repository.

## API

`GET /api/v1/capabilities`, `/cameras`, `/timeline?date=YYYY-MM-DD&camera=...`, `/events?from=RFC3339&to=RFC3339&camera=...`, and `GET|HEAD /api/v1/videos/{opaqueId}`. Video proxying forwards HTTP ranges without buffering; gap, corrupt, malformed, and unplayable segments return a safe error.

## Checks

Run `make fmt test lint typecheck build`. The frontend uses only React/Vite/TypeScript; backend uses Go standard library.

## Live integration note

Live mode uses Shinobi's documented `/{apiKey}/videos/{groupKey}/{monitorId}` and `/{apiKey}/events/{groupKey}/{monitorId}` routes with KST `start` and `end` bounds, decoding their `{videos:[...]}` and `{events:[...]}` envelopes. The UI intentionally does not claim motion is absent when the detector/event source is unavailable.
