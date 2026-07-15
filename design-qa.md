# Design QA — control view recovery pass

- Source visual truth: user-provided current-state screenshots `Screenshot 2026-07-15 at 20.39.57.png` and `Screenshot 2026-07-15 at 20.46.00.png`, plus the eight explicit interaction requirements in the same review.
- Implementation screenshot: `docs/design-qa/2026-07-15-1280x720.png`
- Viewport: 1280 x 720
- State: control view, six cameras, detector off, CAM-204 promoted to primary after interaction, timeline focused after keyboard seek

## Full-view comparison evidence

The source state clipped the supporting cameras and required scrolling before the timeline and transport were visible. The implementation keeps the primary camera, all five supporting cameras, the complete four-lane timeline, and transport inside a 1280 x 720 viewport. Browser measurements were `scrollWidth=1280` and `scrollHeight=720`; every camera card reported equal `clientHeight` and `scrollHeight`.

The duplicated detector-off event rail was removed from the unavailable state. The existing dark palette, compact camera headers, semantic green/orange/red states, and navigation hierarchy remain consistent with the source.

## Focused region evidence

- Camera region: CAM-204 moved from the supporting row to the primary region after activating `CAM-204을 주 화면으로 전환`; CAM-201 moved into the supporting row without resetting master time.
- Supporting cards: the compact unavailable state no longer collides with its footer at 1280 x 720.
- Timeline: the playhead exposes exact KST time, provides a larger pointer target, and visually follows drag before committing the seek. ArrowRight advanced the authoritative time by 10 seconds.
- Card actions: each of the six cards exposes a native fullscreen action with a camera-specific accessible name.

## Required fidelity surfaces

- Typography: existing system/Noto Sans KR stack, weights, and hierarchy retained; compact supporting-card copy was reduced rather than clipped.
- Spacing and layout: passed at 1280 x 720 with no document or card overflow; primary/supporting/timeline/transport hierarchy is visible in one view.
- Colors and tokens: existing console palette and semantic state colors retained; no new decorative palette introduced.
- Image quality and assets: video uses `object-fit: contain` so CCTV frames are not cropped; existing Phosphor icons are used for fullscreen and media states.
- Copy and content: unavailable, retry, synchronization, and detector-off states are explicit and do not claim video availability.

## Comparison history

1. P0/P1 source findings: supporting cameras and timeline were below the viewport; detector-off rail consumed space; no swap/fullscreen affordance; timeline click had no preview; error state was sticky; segment transition cold-loaded the next source.
2. Fixes: viewport-bound shell, primary plus five supporting layout, compact detector-off state, click/keyboard swap, native fullscreen, drag preview, seek revision recovery, monotonic clock, and active/standby next-segment player.
3. P2 follow-up found in first 1280 x 720 capture: supporting-card unavailable copy collided with the footer.
4. P2 fix: compact supporting-card empty copy and footer spacing. Post-fix screenshot has no card overflow or text collision.

## Residual validation gap

The local demo intentionally contains no CCTV media. Visual QA and interaction wiring pass, but transient Range/decode recovery, per-camera <=500 ms drift, and no-flash promotion must still be exercised against the live Shinobi recordings before production acceptance. The implementation now distinguishes per-camera timeline request failure from genuine no-recording state; the error path still needs a live injected-failure check.

final result: passed
