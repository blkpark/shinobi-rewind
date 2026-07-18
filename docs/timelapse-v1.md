# Multi-camera Timelapse V1

Status: proposal / interactive wireframe

## Decision

Add `타임랩스 검토` as a submode of `녹화 관제`. It is not a fourth top-level
navigation item and it is not another playback-rate button.

P0 reads the JPEG frames that Shinobi already creates and shows one approximately
aligned frame per camera around a shared absolute KST timestamp. It is a `빠른
훑어보기`, not frame-accurate evidence playback. It must not seek six MP4 files or
ask Shinobi to build a video.

## Why this shape

- Shinobi can store `Timelapse Frames` for configured monitors. Availability and
  cadence are installation-specific and must be measured before enabling this mode.
- Current frames are representative images created after a completed recording
  segment. Their cadence can be useful for scanning a long period, but must not be
  presented as smooth or frame-accurate CCTV footage.
- Six high-speed MP4 players would repeat the existing Range-request and broken-file
  failure modes.
- Shinobi's `timelapseBuildVideo` endpoint writes a new FileBin artifact and requires
  mutation permission. That is outside the read-only P0 contract.

## Placement and flow

1. Enter `녹화 관제`.
2. Switch `일반 재생 | 타임랩스 검토` below the global navigation.
3. Select a time range, quick range, frame step, and preview cadence.
4. Rewind requests a frame manifest for all selected cameras.
5. The fixed playhead advances over the selected range. Every tile resolves against
   the same master time and displays its actual source-frame KST and staleness.
6. Selecting `정확한 녹화로 열기` returns to normal playback at that tile's actual
   source timestamp.

## P0 source contract

Suggested read-only BFF surface:

```text
GET /api/v1/timelapse?start=<RFC3339>&end=<RFC3339>&camera=CAM-DEMO-01,...
GET /api/v1/timelapse/{opaqueFrameID}
```

The manifest response contains opaque frame identifiers only. Shinobi credentials,
group keys, monitor IDs, and filesystem paths never reach the browser.

For target time `T`, each camera selects the nearest frame within an owner-approved
maximum skew, choosing the earlier frame on an exact tie. The tile is unavailable
when no qualifying frame exists. It must never silently freeze the previous frame,
and any future frame is clearly shown with a signed delta.

Required fields per sample:

```text
camera_id, target_at, frame_at, delta_seconds, frame_id, availability, reason
```

P0 permission requirement: the Shinobi API key must have `watch_videos`; no delete or
write permission is required.

## Interaction contract

- Default range: the current timeline window, clipped to one KST day.
- Quick ranges: 10 minutes, 1 hour, 6 hours, 24 hours.
- Frame step: `자동`, 1 minute, 5 minutes, 15 minutes, 30 minutes. `자동` derives a
  useful step from source density and requested range.
- Preview cadence: 0.5, 1, or 2 frame sets per second. This changes review speed,
  not source timestamps.
- Missing-frame policy: continue other cameras and show an explicit empty tile.
- Audio: unavailable in timelapse mode; open normal playback to review audio.
- Keyboard: Space play/pause, Left/Right one sample, Shift+Left/Right ten samples,
  Home/End range boundaries, Enter opens exact recording for the focused tile.
- Pointer-down gives immediate playhead and range-handle feedback. A newer seek
  cancels the visible state of older requests.
- No frame cross-fade. Respect `prefers-reduced-motion`.

## Screen composition

- Preserve the existing primary + five camera grid and click-to-promote behavior.
- Add a compact mode toolbar above the grid.
- Preserve recording, motion, favorite, gap, and damaged-file timeline rows.
- Add a `타임랩스 프레임` coverage row and selected-range handles.
- Keep the playhead fixed while the scale scrolls under it during playback.
- Every camera card shows actual KST and one of: exact, delayed, no frame, source
  unavailable, or request failed.

## P1: composite export (separate approval)

An optional 2x3 MP4 export can be built later from the same manifest. This introduces
a render job, temporary storage, cancellation, TTL cleanup, checksum validation, and
download authorization. It is intentionally separated from P0 and must not block
interactive review.

## Performance and safety budgets

- Maximum six cameras per synchronized review session.
- Only the current, previous, and next frame set may be prefetched.
- Limit concurrent upstream JPEG reads and cancel obsolete requests.
- Cache only immutable opaque JPEG responses with a bounded TTL; do not create
  persistent Rewind-owned copies.
- Return partial per-camera results instead of failing the whole grid.
- Log request IDs, camera IDs, target time, source-frame time, latency, and reason;
  never log Shinobi credentials or source paths.

## Acceptance gates

- Six cameras remain aligned to one absolute master timestamp across midnight.
- A missing camera frame does not stop or falsify the other five cameras.
- Actual frame time and staleness are visible on every tile.
- Repeated range clicks cannot expose a response from an obsolete request.
- 1280x720 shows grid, compact timeline, and primary controls without page scroll.
- Keyboard and screen-reader semantics cover mode, range, transport, and camera grid.
- P0 performs no database/file mutation and calls no video-build endpoint.

## Operational gate

Before implementation is marked deployable, measure real frame cadence, API latency,
and retention for every camera. Historical Shinobi reports associate JPEG generation
with CPU load, so enabling a denser capture cadence is a separate operational change
and is not part of this proposal.
