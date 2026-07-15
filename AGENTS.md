# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

## Durable prototype decisions

- Master time is authoritative across every active camera; correct video drift over 500ms and change segments at their real boundaries.
- Motion events without a source end are point markers. A finite focus hold is UI-only and must never appear as event duration.
- Show honest loading, unavailable, and unplayable video states. The timeline is a keyboard and pointer seek control, including on narrow screens.
