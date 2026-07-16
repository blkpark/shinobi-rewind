# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable prototype decisions

- `docs/wireframes/interaction-v2.html` is the owner-approved interaction baseline as of 2026-07-16. Implementation may adapt responsive details but must preserve its information hierarchy, direct-manipulation timeline, favorites, PiP/audio ownership, and month-to-day search flow.
- Master time is authoritative across every active camera; correct video drift over 500ms and change segments at their real boundaries.
- Motion events without a source end are point markers. A finite focus hold is UI-only and must never appear as event duration.
- Show honest loading, unavailable, and unplayable video states. The timeline is a keyboard and pointer seek control, including on narrow screens.
- On desktop, the primary camera, the other five synchronized cameras, timeline, and transport must fit in one viewport. Clicking a supporting camera swaps it with the primary camera.
- Every camera card has a native fullscreen action. Timeline seeking must provide immediate drag/click time feedback and remain keyboard operable.
- A transient media failure must recover on retry or a later seek; it must not poison a segment for the lifetime of the view.
- On the plain HTTP/1 internal deployment, keep one active player per camera and release its previous `src` on seek or segment change. Reintroduce prepared next-recording playback only with HTTP/2 or MediaSource so preloading cannot starve seek requests.
- The default desktop layout keeps the primary camera about twice the width and height of a supporting camera. Operators can resize the primary/support split, and that split plus the chosen primary camera persist locally; transient motion focus never overwrites the saved layout.
- During an explicit seek, hold the master clock until the primary camera is ready, then resume the existing playback intent and rate. Late media events from an older segment must not change the current target state.
- Preserve the full CCTV frame with `object-fit: contain`. When the camera grid is not wide enough for the split layout, pack the primary as 2x2 in a 3x3 grid and fill the remaining five cells instead of leaving an empty tile or cropping video.
- Each camera can enter native OS Picture-in-Picture when the browser supports it; only one camera may own PiP at a time and unsupported browsers keep fullscreen as the fallback.
- Audio availability comes from server-side media metadata, not browser-only `audioTracks`. At most one camera may be audible; enabling another camera transfers audio ownership and mutes the previous one.
- Custom playback speed is bounded to 0.25x-5x. Preserve the existing presets, allow 0.05x input steps, and make the browser audio-mute limitation above 4x explicit.
- In synchronized control, unmodified Left/Right arrows jump the master clock by 5 seconds outside form fields. Previous/next motion remains a separate command.
- The control timeline keeps the playhead fixed while time content moves beneath it. Wheel/trackpad zoom has visible +/- controls and zoom presets as keyboard/accessibility fallbacks.
- Event search drills from month to week to day with persistent breadcrumbs, camera/state filters, and honest detector-off/no-data/no-event states.
- A favorite stores camera scope plus an absolute KST timestamp, not a segment-relative offset. Operators can save from a camera card or the master transport, see favorite markers on the timeline, and jump back from control or event search without hiding gap/corrupt status at that time.
- High-frequency controls respond on pointer-down and remain interruptible. Timeline drag tracks the pointer 1:1 with capture; predetermined feedback uses CSS transforms/opacity only. `prefers-reduced-motion` removes travel while preserving state and orientation feedback.
- Recorded playback automatically follows the master clock across a KST date boundary. Hold the clock while the next day's timeline loads; do not require an operator to press `다음날` at midnight.
- A favorite remains an absolute-KST browser marker and separately requests preservation of the completed original segment on the secondary archive drive. Removing the marker never deletes the verified archive. Archive browsing stays inside event search with month-to-day navigation, honest per-camera partial states, and preview only after byte-count and SHA-256 verification; permanent deletion remains unavailable until the LAN service has an authenticated destructive-action boundary.
