# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable prototype decisions

- `docs/wireframes/interaction-v2.html` is the owner-approved interaction baseline as of 2026-07-16. Implementation may adapt responsive details but must preserve its information hierarchy, direct-manipulation timeline, favorites, PiP/audio ownership, and month-to-day search flow.
- Master time is authoritative across every active camera; correct video drift over 500ms and change segments at their real boundaries.
- Motion events without a source end are point markers. A finite focus hold is UI-only and must never appear as event duration.
- Show honest loading, unavailable, and unplayable video states. The timeline is a keyboard and pointer seek control, including on narrow screens.
- Live metadata, recorded timelines, events, and media settle per camera. One slow or failed camera must not block ready cameras; aggregate status remains loading or partial until every requested camera settles, and obsolete date/view requests are aborted.
- On desktop, the primary camera, the other five synchronized cameras, timeline, and transport must fit in one viewport. Clicking a supporting camera swaps it with the primary camera.
- Recorded camera fullscreen keeps the selected camera, timeline, and transport controls inside one fullscreen container. The same card action becomes an accessible exit-fullscreen control and restores the prior multi-camera layout on exit.
- Expanding recorded playback from one/fewer visible cameras to more cameras preserves the playback intent and rate but freezes master time until every visible playable camera reaches the same absolute time. Missing or failed timelines do not block the group; media timeout resumes cameras that are ready.
- A transient media failure must recover on retry or a later seek; it must not poison a segment for the lifetime of the view.
- On the plain HTTP/1 internal deployment, keep one active player per camera and release its previous `src` on seek or segment change. Reintroduce prepared next-recording playback only with HTTP/2 or MediaSource so preloading cannot starve seek requests.
- The default desktop layout keeps the primary camera about twice the width and height of a supporting camera. Operators can resize the primary/support split, and that split plus the chosen primary camera persist locally; transient motion focus never overwrites the saved layout.
- During an explicit seek, hold the master clock until the primary camera is ready, then resume the existing playback intent and rate. Late media events from an older segment must not change the current target state.
- Preserve the full CCTV frame with `object-fit: contain`. When the camera grid is not wide enough for the split layout, pack the primary as 2x2 in a 3x3 grid and fill the remaining five cells instead of leaving an empty tile or cropping video.
- Each camera can enter native OS Picture-in-Picture when the browser supports it; only one camera may own PiP at a time and unsupported browsers keep fullscreen as the fallback.
- Audio availability comes from server-side media metadata, not browser-only `audioTracks`. At most one camera may be audible; enabling another camera transfers audio ownership and mutes the previous one.
- Custom playback speed is bounded to 0.25x-20x. Preserve the existing presets, add 10x/20x presets, allow 0.05x input steps, and make the browser audio-mute limitation above 4x explicit.
- In synchronized control, unmodified Left/Right arrows jump the master clock by 5 seconds outside form fields. Previous/next motion remains a separate command.
- The control timeline keeps the playhead fixed while time content moves beneath it. Wheel/trackpad zoom has visible +/- controls and zoom presets as keyboard/accessibility fallbacks.
- Event search drills from month to week to day with persistent breadcrumbs, camera/state filters, and honest detector-off/no-data/no-event states.
- Entering event search from another app view starts on today in KST. An explicit search deep link keeps its requested date, and clicking the already-active search tab does not discard the operator's current date.
- Month and week search load the visible recording range before a date is clicked. Every date renders 24 hour cells: blue recorded, gray gap, red corrupt, dark no recording, and hatched unknown/partial response. Explicit month/week/day controls remain beside the breadcrumbs; clicking a date only drills into detail.
- Day recording rows show a high-contrast favorite badge when a global or same-camera favorite falls inside that row's half-open time range.
- A favorite stores camera scope plus an absolute KST timestamp, not a segment-relative offset. Before saving, show the containing source segment's start, end, and exact seconds; keep that clicked range stable while the asynchronous archive request completes. Operators can save from a camera card or the master transport, see favorite markers on the timeline, and jump back from control or event search without hiding gap/corrupt status at that time.
- The timeline renders each favorite as the containing recorded segment bar plus a high-contrast point at the exact saved KST timestamp. If no containing recorded segment exists, keep the point without inventing a backup range.
- Clicking a favorite point seeks to its stored absolute second, not the surrounding bar coordinate. The favorites menu exposes explicit removal and states that pending or verified archive copies remain after the browser marker is removed.
- High-frequency controls respond on pointer-down and remain interruptible. Timeline drag tracks the pointer 1:1 with capture; predetermined feedback uses CSS transforms/opacity only. `prefers-reduced-motion` removes travel while preserving state and orientation feedback.
- Recorded playback automatically follows the master clock across a KST date boundary. Hold the clock while the next day's timeline loads; do not require an operator to press `다음날` at midnight.
- A favorite remains an absolute-KST browser marker and separately requests preservation of the completed original segment on the secondary archive drive. Removing the marker never deletes the verified archive. Archive browsing stays inside event search with month-to-day navigation, honest per-camera partial states, and preview only after byte-count and SHA-256 verification; permanent deletion remains unavailable until the LAN service has an authenticated destructive-action boundary.
- The operator UI supports Korean and English across live, search, playback, timeline, archive, status, and accessibility labels. Persist the explicit browser choice; otherwise use the browser language with English fallback. Server truth-state codes remain unchanged and are translated only at the presentation boundary.
