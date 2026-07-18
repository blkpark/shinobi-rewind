# 실시간 관제 V1 제품 명세

상태: 운영 HQ/LQ HLS 연결, 30분 안정성 proof 진행 중
작성일: 2026-07-16
대상: Shinobi Rewind 내부 운영자

## 문제와 목표

운영자는 사건을 확인하기 전에 현재 현장을 한 화면에서 보고, 이상이 있으면 같은 카메라의 최근 녹화로 곧바로 넘어가야 한다. 현재 Rewind는 사건 검색과 녹화 동기 관제만 제공하므로, Shinobi 화면을 별도로 열어야 하고 실시간 장애와 녹화 공백을 같은 상태로 오인하기 쉽다.

V1은 `실시간 관제`를 세 번째 독립 뷰로 제공한다. 6대 카메라를 한 viewport에서 안정적으로 보고, 한 카메라 장애가 나머지 카메라를 멈추지 않으며, 실제 존재하는 최근 녹화 구간으로 전환할 수 있어야 한다.

## 제품 원칙

1. 실시간과 녹화를 시각·상태·URL에서 명확히 분리한다.
2. 녹색 점은 실제 프레임이 진행할 때만 `LIVE`를 뜻한다.
3. supporting 카메라는 저대역폭 스트림, primary·PiP·전체화면은 고화질을 우선한다.
4. 한 카메라의 reconnect는 그 카드 안에서 끝나며 전체 grid를 재마운트하지 않는다.
5. API key, group key, RTSP credential, 원본 stream URL은 브라우저와 로그에 노출하지 않는다.
6. PTZ, 양방향 음성, 카메라 설정, 서버 재인코딩은 V1 범위가 아니다.

## 정보 구조와 사용자 흐름

상단 navigation은 `실시간 관제 | 사건 검색 | 녹화 관제` 세 탭으로 구성한다. 기존 `동기 관제`는 `녹화 관제`로 이름을 바꿔 실시간과 혼동하지 않게 한다.

### 기본 흐름

1. 실시간 관제 진입 시 저장된 layout과 camera order를 복원한다.
2. 각 카드는 독립적으로 `연결 중 → LIVE → 저대역폭/지연 → 재연결 중 → 오프라인` 상태를 가진다.
3. supporting 카드를 클릭하거나 Enter/Space를 누르면 primary와 자리를 교환한다. 저화질 프레임을 유지한 채 고화질로 승격해 검은 깜박임을 줄인다.
4. 오디오를 켜면 기존 audible camera는 즉시 음소거된다. 기본값은 모두 음소거다.
5. `최근 녹화 보기`는 추정 현재시각이 아니라 서버가 확인한 `latestRecordedAt`으로 녹화 관제를 연다.
6. 녹화 관제의 `실시간으로`는 현재 live edge와 같은 camera scope로 돌아온다.

### 장애 흐름

- 마지막 정상 프레임을 남길 수 있지만 반드시 dim 처리하고 `재연결 중 · 마지막 화면 HH:MM:SS`를 표시한다.
- 8초 이상 복구되지 않으면 명시적인 `다시 연결` 버튼을 제공한다.
- codec 미지원, upstream 연결 실패, 브라우저 decode 실패, stale frame을 같은 `연결 실패` 문구로 합치지 않는다.
- 탭이 오래 hidden 상태거나 사용자가 view를 이탈하면 viewer session을 정리한다.

## 화면 구성

### 상단

- 세 개의 first-class view tab
- KST wall clock
- 전체 상태 요약: `6대 중 5대 LIVE · 1대 재연결 중`

### 도구 막대

- layout preset: `3×2`, `주+5`, `2×2`, `1대`
- 품질: `자동`, `저대역폭`, `고화질` — 실제 capability가 있을 때만 표시
- 카메라 선택과 저장된 layout 상태
- detector가 꺼진 경우 `활동 포커스 사용 불가 · detector off`

### 카메라 카드

- 카메라명, grid position, primary 여부
- `LIVE`, `연결 중`, `저대역폭`, `재연결 중`, `오프라인`, `화면 정지` 텍스트 상태
- 최근 프레임 시각은 서버가 근거를 제공할 때만 표시
- 음성 있음/없음/확인 중, 단일 오디오 전환
- PiP, fullscreen, primary 전환
- `최근 녹화` handoff

실시간 화면에는 녹화 timeline과 배속을 넣지 않는다. 일시정지가 필요하면 정지된 wall-clock과 큰 `일시정지됨` overlay를 강제해 LIVE로 오인하지 않게 한다.

## 기술 계약

### 전송 방식 결정

V1 transport는 **same-origin HLS proxy + 브라우저 HLS adapter**를 기준으로 spike한다. Shinobi는 monitor별 HLS와 stream channel을 제공하지만, upstream 인증값이 들어간 URL을 브라우저에 직접 전달하지 않는다. backend가 allowlist된 opaque camera id만 받아 playlist와 segment를 proxy한다.

Chrome에서 native HLS 지원을 가정하지 않는다. 구현 착수 전 아래 두 후보를 동일 카메라 6대로 측정하고 한 가지를 확정한다.

| 후보 | 장점 | 위험 | V1 판단 |
|---|---|---|---|
| HLS proxy + hls.js | 검증된 브라우저 호환, segment 단위 복구 | 의존성 1개, 수 초 지연 | 기본 후보 |
| Shinobi Poseidon fragmented MP4 proxy | 낮은 지연 가능 | websocket/stream lifecycle과 브라우저 호환 검증 필요 | spike 비교 |
| WebRTC/go2rtc | 낮은 지연 | 신규 infra와 codec/NAT 운영 범위 확대 | P2 |

### 제안 API

- `GET /api/v1/live/capabilities`
- `GET /api/v1/live/cameras`
- `GET /api/v1/live/{allowlistedCameraId}/playlist.m3u8?quality=low|high`
- `GET /api/v1/live/{allowlistedCameraId}/segments/{opaqueSegmentId}`

playlist rewrite와 segment lookup은 server-side registry를 사용한다. camera route id는 기존 검색·녹화·layout 계약의 allowlisted public id(`CAM-###`)를 재사용하며 credential이 아니다. 별도 camera id mapping은 P0에서 만들지 않고, upstream asset path와 segment id만 opaque 처리한다. upstream host, API key, group key와 raw RTSP/HLS URL을 response, HTML, query, error, structured log에 넣지 않는다.

### 운영 전제

- 운영 6대는 Hikvision `101` main stream을 고화질 HLS/녹화에 사용하고, `102` substream을 Shinobi static stream channel `0`의 저대역폭 HLS로 노출한다. Rewind가 `toggleSubstream`처럼 upstream 상태를 변경하지 않는다.
- 한 브라우저가 카메라 RTSP에 직접 연결하지 않고 Shinobi가 restream owner가 된다.
- 운영 read-only key는 `get_monitors`, `watch_videos`, `watch_stream`만 허용하고 mutation, socket auth, control, delete 권한은 모두 거부한다.
- 현재 monitor 설정에서 credential이 포함된 substream 입력이 관찰되었으므로 실시간 기능 출시 전에 CAM-201~206 RTSP credential을 회전하고 log redaction을 검증한다.

## P0 / P1 / P2

### P0 — 출시 필수

- `live` URL/view와 세 탭 navigation
- secret-safe same-origin transport, camera allowlist, session cleanup
- `3×2`와 `주+5`, primary swap, 저장되는 camera order/layout
- supporting LQ / primary HQ 전환과 capability fallback
- 카드별 연결 상태, stale-frame overlay, 제한된 자동 reconnect와 수동 retry
- 단일 audio owner, PiP, fullscreen
- `latestRecordedAt` 기반 live ↔ playback 왕복
- detector-off 상태의 활동 포커스 비활성화
- 1280×720 one-viewport와 키보드/스크린리더 기준

### P1 — 운영 편의

- `2×2`, `1대`, 이름 있는 사용자 layout과 drag reorder
- 품질 수동 전환과 진단 drawer
- 현재 시각 즐겨찾기 및 해당 시각의 녹화 존재 여부 표시
- Motion Data Trust Gate 통과 후 활동 포커스
- 카메라 group별 layout 저장

### P2 — 별도 설계

- WebRTC/go2rtc 저지연 transport
- kiosk/cycle mode, multi-monitor pop-out/PWA
- 운영자별 server-side layout
- bandwidth/GPU 기반 adaptive concurrency

## 접근성 수용 기준

- Tab으로 모든 카드 action에 도달하고, 카드 focus에서 Arrow 4방향·Home/End로 물리적 grid를 탐색한다.
- Enter/Space는 primary 전환이며 form control과 카드 방향키를 전역 단축키가 가로채지 않는다.
- auto-focus/layout 변경 뒤에도 DOM focus는 같은 camera/action에 남는다.
- 상태는 색상 외에 텍스트와 아이콘을 함께 사용하고, 상태 변화만 dedupe된 `aria-live=polite`로 알린다.
- audio/PiP/fullscreen 상태는 `aria-pressed`와 browser state event를 기준으로 동기화한다.
- motion border pulse는 최대 2회, 초당 3회 미만이며 `prefers-reduced-motion`에서는 점멸을 제거한다.
- 일반 텍스트 4.5:1, UI boundary/focus 3:1 이상을 충족한다.
- 1280×720에서 6대와 핵심 controls가 document scroll 없이 보이고, 320 CSS px와 200% zoom에서도 기능 손실이 없다.

## 성공 지표와 검증 게이트

| 영역 | 출시 기준 |
|---|---|
| 첫 화면 | 같은 LAN warm p95 첫 frame 2초 목표, 실제 측정값 보고 |
| 장애 격리 | 한 카메라를 끊어도 나머지 5대는 재생 유지 |
| 상태 정직성 | stale frame이 `LIVE`로 표시되는 순간 0건 |
| 전환 | supporting→primary에서 기존 LQ frame을 유지한 채 HQ 승격 |
| 오디오 | audible camera 항상 최대 1대 |
| handoff | 실제 `latestRecordedAt` 구간으로 녹화 관제 진입 |
| 정리 | view/tab 이탈 후 Shinobi viewer session이 기준치로 복귀 |
| 보안 | browser network/HTML/log에 credential 또는 raw upstream URL 0건 |
| 접근성 | axe serious/critical 0건, keyboard-only와 VoiceOver/NVDA 수동 시나리오 통과 |
| 반응형 | 1280×720, 1024×768, 390×844, 320×568, 200% zoom 검증 |

## 개발 순서

1. credential 회전과 최소권한 live key, static low-bandwidth channel을 별도 infra release로 준비한다.
2. transport spike: HLS와 Poseidon을 6대 동시 재생, latency, reconnect, cleanup 기준으로 비교한다.
3. backend live proxy와 secret/no-log contract test를 작성한다.
4. 독립 live state machine과 카드 장애 격리를 구현한다.
5. layout/audio/PiP/fullscreen과 live↔playback handoff를 연결한다.
6. 브라우저, 접근성, session cleanup, credential redaction gate를 통과한다.

## 제외 범위

- PTZ, camera settings, 영상 삭제
- 양방향 음성/마이크
- 자체 motion/object detection
- server-side transcoding
- 외부 WAN 공개
- detector trust gate 이전의 motion 자동 포커스

## 2026-07-16 구현 증빙과 남은 gate

- Go same-origin HLS proxy는 nested playlist, `EXT-X-KEY`, `EXT-X-MAP`을 포함한 URI rewrite, exact host/root pinning, traversal·redirect 차단, 1MiB playlist 제한, Range/HEAD/416/cancel streaming, sanitized 403, 5분 TTL/4,096개 registry bound를 구현했다.
- live frontend는 독립 clock/state, 4개 layout, primary swap, camera별 retry/stale 상태, hidden-tab cleanup, lazy `hls.js`, single audio, PiP/fullscreen state sync, completed recording handoff를 구현했다.
- `go test ./...`, race, vet, frontend typecheck, 25 tests, build가 통과했다. demo 6대로 1280×720 3×2/주+5 no-scroll, primary swap, visible-only summary, console error 0건을 브라우저에서 확인했다.
- 운영 `watch_stream` 권한, CAM-201~206 RTSP credential 회전, static LQ channel이 준비되지 않아 실제 HLS first-frame/30분 안정성/camera disconnect/LQ→HQ hold/session cleanup/accessibility proof는 아직 차단 상태다. 이 gate 전에는 배포 완료로 판정하지 않는다.

## 2026-07-17 운영 HLS 연결

- Hikvision 공식 채널 규칙과 운영 설정을 대조해 CAM-201~206의 `101` main, `102` substream을 확인했다. CAM-201 `102`는 H.264 640×360 20fps로 직접 probe했다.
- 최소권한 API key에 `watch_stream`만 추가하고 mutation/control/delete 권한은 계속 거부했다. Shinobi 권한 cache 갱신 후 CAM-201 main HLS가 200과 재작성 segment를 반환했다.
- 6대 모두 `102`를 additional input feed로 연결하고 static HLS channel `0`을 만들었다. 운영에서 main 6개와 low 6개 playlist 생성을 확인했다.
- Rewind는 `SHINOBI_LOW_STREAM_CHANNEL=0`이 명시된 배포에서만 low capability를 노출한다. 설정이 없거나 잘못된 quality 요청은 422로 실패한다.
- 남은 release gate는 실제 브라우저 6대 first-frame, primary HQ/supporting LQ 전환, 30분 안정성, 한 카메라 disconnect 격리, session cleanup, CAM-201~206 RTSP credential 회전이다.

## 조사 근거

- [Shinobi Get Streams](https://docs.shinobi.video/api/get-streams): HLS, JPEG, MJPEG, FLV, Poseidon MP4와 stream channel endpoint
- [Shinobi Embedding Streams](https://docs.shinobi.video/api/embedding-streams): iframe/websocket embed 방식과 upstream 결합도
- [Frigate Live View](https://docs.frigate.video/configuration/live/): multi-camera stream 선택, codec/browser 호환, 저대역폭 fallback
- [Frigate Restream](https://docs.frigate.video/configuration/restream): 중앙 restream으로 camera connection을 줄이는 구조
- [Frigate Birdseye](https://docs.frigate.video/configuration/birdseye/): stable camera order, layout, cooldown 기준
