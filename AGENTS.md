# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable prototype decisions

- Master time is authoritative across every active camera; correct video drift over 500ms and change segments at their real boundaries.
- Motion events without a source end are point markers. A finite focus hold is UI-only and must never appear as event duration.
- Show honest loading, unavailable, and unplayable video states. The timeline is a keyboard and pointer seek control, including on narrow screens.
- On desktop, the primary camera, the other five synchronized cameras, timeline, and transport must fit in one viewport. Clicking a supporting camera swaps it with the primary camera.
- Every camera card has a native fullscreen action. Timeline seeking must provide immediate drag/click time feedback and remain keyboard operable.
- A transient media failure must recover on retry or a later seek; it must not poison a segment for the lifetime of the view.
- Keep one next recording prepared per camera and promote that prepared player at a real segment boundary to avoid a blank flash.
- The default desktop layout keeps the primary camera about twice the width and height of a supporting camera. Operators can resize the primary/support split, and that split plus the chosen primary camera persist locally; transient motion focus never overwrites the saved layout.
- During an explicit seek, hold the master clock until the primary camera is ready, then resume the existing playback intent and rate. Late media events from an older segment must not change the current target state.
