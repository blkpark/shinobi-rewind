import { Info, MagnifyingGlass, Pause, Play, ShieldCheck, SkipBack, SkipForward, Star } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { CameraGrid } from "./components/CameraGrid";
import { Timeline } from "./components/Timeline";
import { SearchView } from "./components/SearchView";
import { rewindAPI } from "./lib/api";
import { cameraTitle, resolveCameraSelection } from "./lib/camera.js";
import { clampRate, includeCameraScope, parseFavorites, parseKSTSecond, parseRateDraft, serializeFavorites, toggleAudible, transportJump, type Favorite } from "./lib/interaction.js";
import { applyFocus, canCorrectMedia, driftCorrection, expireFocus, monotonicMaster, segmentAt, simultaneousFocus, videoOffset, type FocusState } from "./lib/playback.js";
import type { Camera, Capability, Event, Segment, View } from "./lib/types";

const speeds = [.25, .5, 1, 2, 5];
const layoutKey = "shinobi-rewind:layout:v1";
const favoritesKey = "shinobi-rewind:favorites:v1";
const defaultPrimaryRatio = 40;
const kstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const parseList = (raw: string | null) => raw?.split(",").filter(Boolean) || [];
const kstSecond = (date: string, clock: string) => parseKSTSecond(date, clock) ?? parseKSTSecond(kstDate, "14:31:03")!;
const formatTime = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
const isoAt = (seconds: number) => new Date(seconds * 1000).toISOString();

function savedLayout() {
  try {
    const value = JSON.parse(localStorage.getItem(layoutKey) || "null");
    return value?.version === 1 && typeof value.primaryCamera === "string" && Number.isFinite(value.primaryRatio) && value.primaryRatio >= 25 && value.primaryRatio <= 60
      ? value as { version: 1; primaryCamera: string; primaryRatio: number }
      : null;
  } catch { return null; }
}

function initialState() {
  const query = new URLSearchParams(location.search);
  const requestedDate = query.get("date") || kstDate;
  const date = parseKSTSecond(requestedDate, "00:00:00") === null ? kstDate : requestedDate;
  const clock = query.get("time") || "14:31:03";
  const layout = savedLayout();
  return {
    view: (query.get("view") as View) || (localStorage.getItem("shinobi-rewind:view") as View) || "control",
    date, master: parseKSTSecond(date, clock) ?? kstSecond(date, "14:31:03"), selected: parseList(query.get("cameras")),
    rate: clampRate(query.get("rate") || 1), autoFocus: query.get("motion") !== "off", layout,
  };
}

export function App() {
  const initial = useMemo(initialState, []);
  const [view, setView] = useState<View>(initial.view);
  const [date, setDate] = useState(initial.date);
  const [master, setMaster] = useState(initial.master);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [selected, setSelected] = useState<string[]>(initial.selected);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineFailed, setTimelineFailed] = useState<string[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [capability, setCapability] = useState<Capability>({ demo: true, motion: "unavailable", message: "카메라 상태 확인 중" });
  const [eventState, setEventState] = useState<"idle" | "ready" | "partial" | "error">("idle");
  const [rate, setRate] = useState(initial.rate);
  const [playing, setPlaying] = useState(false);
  const [autoFocus, setAutoFocus] = useState(initial.autoFocus);
  const [focus, setFocus] = useState<FocusState>({ until: {}, pulseUntil: {} });
  const [pinned, setPinned] = useState<string[] | null>(null);
  const [primaryCamera, setPrimaryCamera] = useState(initial.layout?.primaryCamera || "");
  const [primaryRatio, setPrimaryRatio] = useState(initial.layout?.primaryRatio || defaultPrimaryRatio);
  const [primarySyncing, setPrimarySyncing] = useState(false);
  const [seekRevision, setSeekRevision] = useState(0);
  const [timelineRevision, setTimelineRevision] = useState(0);
  const [favorites, setFavorites] = useState<Favorite[]>(() => parseFavorites(localStorage.getItem(favoritesKey)));
  const [audibleCamera, setAudibleCamera] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const videos = useRef<Record<string, HTMLVideoElement>>({});
	const mediaRecovery = useRef(false);
	const masterRef = useRef(initial.master);
	const focusMasterRef = useRef(initial.master);
	const clockRef = useRef({ master: initial.master, wall: performance.now() });
  const effectivePlaying = playing && !primarySyncing;

  const orderedIds = useMemo(() => cameras.map((camera) => camera.id), [cameras]);
  const shownCameras = useMemo(() => cameras.filter((camera) => selected.includes(camera.id)), [cameras, selected]);
  const focused = pinned && capability.motion === "available" ? pinned : (autoFocus && capability.motion === "available" ? Object.keys(focus.until).filter((id) => focus.until[id] > Date.now()) : []);
  const effectivePrimaryCamera = focused.length === 1 ? focused[0] : primaryCamera;

  useEffect(() => {
    if (!audibleCamera) return;
    const target = segmentAt(segments.filter((item) => item.cameraId === audibleCamera), master);
    if (target?.hasAudio !== true) setAudibleCamera(null);
  }, [audibleCamera, master, segments]);

	useEffect(() => {
		void rewindAPI.cameras().then((data) => {
			setCameras(data);
			setSelected((old) => resolveCameraSelection(data, old));
		}).catch(() => setCapability({ demo: false, motion: "unavailable", message: "카메라 상태 확인 불가" }));
	}, []);

  useEffect(() => {
    if (!shownCameras.length) { setPrimaryCamera(""); return; }
    if (!shownCameras.some((camera) => camera.id === primaryCamera)) setPrimaryCamera(shownCameras[0].id);
  }, [shownCameras, primaryCamera]);

  useEffect(() => {
    if (!primaryCamera) return;
    localStorage.setItem(layoutKey, JSON.stringify({ version: 1, primaryCamera, primaryRatio }));
  }, [primaryCamera, primaryRatio]);

  useEffect(() => { localStorage.setItem(favoritesKey, serializeFavorites(favorites)); }, [favorites]);

  useEffect(() => {
    setPinned((old) => {
      if (!old || capability.motion !== "available") return null;
      const next = old.filter((id) => selected.includes(id));
      return next.length ? next : null;
    });
  }, [capability.motion, selected]);

	useEffect(() => {
		if (!cameras.length || !selected.length) return;
		let current = true;
		void rewindAPI.capabilities(selected).then((value) => { if (current) setCapability(value); }).catch(() => { if (current) setCapability({ demo: false, motion: "unavailable", message: "모션 데이터 확인 불가" }); });
		return () => { current = false; };
	}, [cameras, selected]);

  useEffect(() => {
    setMaster((current) => kstSecond(date, formatTime(current)));
  }, [date]);

  const urlSecond = Math.floor(master);
  useEffect(() => {
    const params = new URLSearchParams({ view, date, time: formatTime(urlSecond), cameras: selected.join(","), rate: String(rate), motion: autoFocus ? "on" : "off" });
    history.replaceState(null, "", `${location.pathname}?${params}`);
    localStorage.setItem("shinobi-rewind:view", view);
  }, [view, date, urlSecond, selected, rate, autoFocus]);

  useEffect(() => {
    if (!selected.length) { setSegments([]); setTimelineFailed([]); setTimelineLoading(false); return; }
    let current = true;
    setSegments([]);
    setTimelineFailed([]);
    setTimelineLoading(true);
    void Promise.allSettled(selected.map((camera) => rewindAPI.timeline(date, camera))).then((results) => {
      if (!current) return;
      setSegments(results.flatMap((result) => result.status === "fulfilled" ? result.value.segments : []));
      setTimelineFailed(results.flatMap((result, index) => result.status === "rejected" ? [selected[index]] : []));
      setTimelineLoading(false);
      if (mediaRecovery.current) {
        mediaRecovery.current = false;
        setSeekRevision((value) => value + 1);
      }
    });
    return () => { current = false; };
  }, [date, selected, timelineRevision]);

  useEffect(() => {
    if (capability.motion !== "available" || !selected.length) { setEvents([]); setEventState("idle"); return; }
    let current = true;
    const from = isoAt(kstSecond(date, "00:00:00"));
    const to = isoAt(kstSecond(date, "23:59:59"));
    void Promise.allSettled(selected.map((camera) => rewindAPI.events(from, to, camera))).then((results) => {
      if (!current) return;
      const ok = results.filter((result): result is PromiseFulfilledResult<Event[]> => result.status === "fulfilled");
      setEvents(ok.flatMap((result) => result.value).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.cameraId.localeCompare(b.cameraId) || a.id.localeCompare(b.id)));
      setEventState(ok.length === results.length ? "ready" : ok.length ? "partial" : "error");
    });
		return () => { current = false; };
  }, [capability.motion, date, selected]);

	useEffect(() => {
		if (!effectivePlaying) return;
    clockRef.current = { master: masterRef.current, wall: performance.now() };
    const timer = window.setInterval(() => {
      const value = monotonicMaster(clockRef.current.master, clockRef.current.wall, rate, performance.now());
      masterRef.current = value;
      setMaster(value);
    }, 100);
    return () => window.clearInterval(timer);
	}, [effectivePlaying, rate]);

	useEffect(() => { masterRef.current = master; }, [master]);

  useEffect(() => {
    const liveFocus = simultaneousFocus(events, master, orderedIds, focusMasterRef.current);
		focusMasterRef.current = master;
    if (autoFocus && capability.motion === "available" && liveFocus.length) setFocus((old) => applyFocus(old, liveFocus, Date.now()));
    const timer = window.setInterval(() => setFocus((old) => expireFocus(old, Date.now())), 250);
    return () => window.clearInterval(timer);
  }, [autoFocus, capability.motion, events, master, orderedIds]);

	useEffect(() => {
		Object.entries(videos.current).forEach(([camera, video]) => { video.playbackRate = rate; video.muted = rate > 4 || audibleCamera !== camera; if (effectivePlaying) void video.play().catch(() => undefined); else video.pause(); });
	}, [audibleCamera, effectivePlaying, rate]);

	useEffect(() => {
		shownCameras.forEach((camera) => { const video = videos.current[camera.id]; if (video) syncVideo(camera, video, masterRef.current); });
	}, [seekRevision, segments, shownCameras]);

	useEffect(() => {
		if (!effectivePlaying) return;
		const timer = window.setInterval(() => shownCameras.forEach((camera) => { const video = videos.current[camera.id]; if (video) syncVideo(camera, video, masterRef.current); }), 750);
		return () => window.clearInterval(timer);
	}, [effectivePlaying, rate, segments, shownCameras]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const jump = transportJump(event);
      if (jump !== null) { event.preventDefault(); seekTo((value) => value + jump); return; }
      if ((event.target as HTMLElement)?.closest("input,select,textarea,button,[contenteditable='true']")) return;
      if (event.code === "Space") { event.preventDefault(); setPlaying((value) => !value); }
      if (event.key.toLowerCase() === "j") seekTo((value) => value - 10);
      if (event.key.toLowerCase() === "l") seekTo((value) => value + 10);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

	function syncVideo(camera: Camera, video: HTMLVideoElement, masterSeconds = master) {
		const segment = segmentAt(segments.filter((item) => item.cameraId === camera.id), masterSeconds);
		if (!segment || video.dataset.segmentId !== segment.id) return;
		video.playbackRate = rate;
		if (effectivePlaying) void video.play().catch(() => undefined); else video.pause();
		if (!canCorrectMedia(segment.id, video.dataset.segmentId, video.seeking, video.readyState)) return;
		const expected = videoOffset(segment, masterSeconds);
		const correction = driftCorrection(video.currentTime, expected);
		if (correction !== null) video.currentTime = correction;
	}
  const seekTo = (next: number | ((value: number) => number)) => {
    setFocus({ until: {}, pulseUntil: {} });
    setPrimarySyncing(true);
    setMaster((current) => {
      const value = typeof next === "function" ? next(current) : next;
      masterRef.current = value;
      focusMasterRef.current = value - .001;
      clockRef.current = { master: value, wall: performance.now() };
      return value;
    });
    setSeekRevision((value) => value + 1);
  };
  const navigateEvent = (direction: 1 | -1) => {
    const target = direction === 1 ? events.find((event) => Date.parse(event.at) / 1000 > master) : [...events].reverse().find((event) => Date.parse(event.at) / 1000 < master);
    if (target) { seekTo(Date.parse(target.at) / 1000); setSelected((old) => old.includes(target.cameraId) ? old : [...old, target.cameraId].slice(0, 6)); setView("control"); }
  };
  const recoverMediaIndex = () => {
    if (mediaRecovery.current) return;
    mediaRecovery.current = true;
    setTimelineRevision((value) => value + 1);
  };
  const changeDate = (next: string) => { if (parseKSTSecond(next, "00:00:00") === null) return; setDate(next); seekTo(kstSecond(next, formatTime(master))); };
  const changeClock = (next: string) => { const value = parseKSTSecond(date, next); if (value !== null) seekTo(value); };
  const setCamera = (next: string) => setSelected(next === "all" ? cameras.slice(0, 6).map((camera) => camera.id) : [next]);
  const pinFocus = () => setPinned((old) => old ? null : focused);
  const toggleFavorite = (cameraId: string | null) => {
    const at = isoAt(Math.floor(masterRef.current));
    const existing = favorites.find((item) => item.cameraId === cameraId && item.at === at);
    setFavorites((items) => existing ? items.filter((item) => item.id !== existing.id) : [...items, { id: `${cameraId || "all"}:${at}`, cameraId, at }]);
    setNotice(existing ? "즐겨찾기에서 제거했습니다." : "현재 KST 시각을 즐겨찾기에 저장했습니다.");
  };
  const jumpFavorite = (favorite: Favorite) => {
    const target = Date.parse(favorite.at) / 1000;
    if (!Number.isFinite(target)) return;
    if (favorite.cameraId) {
      setSelected((old) => includeCameraScope(old, favorite.cameraId, cameras.map((camera) => camera.id)));
      if (cameras.some((camera) => camera.id === favorite.cameraId)) setPrimaryCamera(favorite.cameraId);
    }
    setDate(kstDateAt(target)); seekTo(target); setView("control");
  };
  const setAudio = (cameraId: string, hasAudio: boolean | null) => setAudibleCamera((current) => toggleAudible(current, cameraId, hasAudio));
  const kstDateAt = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });

  return <main className="console">
    <header className="topbar">
      <div className="brand"><ShieldCheck size={23} weight="bold" aria-hidden="true" />영상 관제 콘솔</div>
      <nav aria-label="주요 보기"><button className={view === "search" ? "active" : ""} onClick={() => setView("search")}><MagnifyingGlass aria-hidden="true" />사건 검색</button><button className={view === "control" ? "active" : ""} onClick={() => setView("control")}><Play aria-hidden="true" />동기 관제</button></nav>
		<div className="clock">{date} · KST <strong>{formatTime(master)}</strong></div>
		<button className="ghost" onClick={() => setView("search")}>시간 점프</button>
    </header>
    {view === "search" ? <SearchView date={date} cameras={cameras} selected={selected} segments={segments} events={events} favorites={favorites} capability={capability} eventState={eventState} timelineLoading={timelineLoading} timelineFailed={timelineFailed} onDate={changeDate} onTime={changeClock} onCamera={setCamera} onOpen={() => setView("control")} /> : <ControlView {...{ date, cameras: shownCameras, allCameras: cameras, segments, timelineLoading, timelineFailed, events, capability, eventState, master, seekTo, seekRevision, primaryCamera: effectivePrimaryCamera, setPrimaryCamera, primaryRatio, setPrimaryRatio, setPrimarySyncing, rate, setRate, playing, setPlaying, autoFocus, setAutoFocus, focused, focus, pinned, pinFocus, videos, syncVideo, navigateEvent, recoverMediaIndex, favorites, toggleFavorite, jumpFavorite, audibleCamera: rate > 4 ? null : audibleCamera, setAudio, notice, setNotice, changeDate }} />}
  </main>;
}

function RateControl({ rate, setRate }: { rate: number; setRate: (value: number) => void }) {
  const [draft, setDraft] = useState(rate.toFixed(2));
  useEffect(() => setDraft(rate.toFixed(2)), [rate]);
  const commit = () => {
    const value = parseRateDraft(draft);
    if (value === null) { setDraft(rate.toFixed(2)); return; }
    setRate(value); setDraft(value.toFixed(2));
  };
  return <label className="custom-rate">배속<input type="range" min="0.25" max="5" step="0.05" value={rate} onChange={(event) => setRate(clampRate(event.target.value))} /><input type="number" min="0.25" max="5" step="0.05" value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(rate.toFixed(2)); event.currentTarget.blur(); } }} aria-label="사용자 지정 재생 속도" /><output>{rate.toFixed(2)}x</output></label>;
}

function ControlView(props: { date: string; cameras: Camera[]; allCameras: Camera[]; segments: Segment[]; timelineLoading: boolean; timelineFailed: string[]; events: Event[]; capability: Capability; eventState: string; master: number; seekTo: (value: number | ((value: number) => number)) => void; seekRevision: number; primaryCamera: string; setPrimaryCamera: (value: string) => void; primaryRatio: number; setPrimaryRatio: (value: number) => void; setPrimarySyncing: (value: boolean) => void; rate: number; setRate: (value: number) => void; playing: boolean; setPlaying: (value: boolean | ((value: boolean) => boolean)) => void; autoFocus: boolean; setAutoFocus: (value: boolean) => void; focused: string[]; focus: FocusState; pinned: string[] | null; pinFocus: () => void; videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; syncVideo: (camera: Camera, video: HTMLVideoElement) => void; navigateEvent: (direction: 1 | -1) => void; recoverMediaIndex: () => void; favorites: Favorite[]; toggleFavorite: (camera: string | null) => void; jumpFavorite: (favorite: Favorite) => void; audibleCamera: string | null; setAudio: (camera: string, hasAudio: boolean | null) => void; notice: string; setNotice: (message: string) => void; changeDate: (day: string) => void }) {
  const { date, cameras, allCameras, segments, timelineLoading, timelineFailed, events, capability, eventState, master, seekTo, seekRevision, primaryCamera, setPrimaryCamera, primaryRatio, setPrimaryRatio, setPrimarySyncing, rate, setRate, playing, setPlaying, autoFocus, setAutoFocus, focused, focus, pinned, pinFocus, videos, syncVideo, navigateEvent, recoverMediaIndex, favorites, toggleFavorite, jumpFavorite, audibleCamera, setAudio, notice, setNotice, changeDate } = props;
  const motionEnabled = capability.motion === "available";
  const favoriteAt = (camera: string | null) => favorites.some((item) => item.cameraId === camera && Math.floor(Date.parse(item.at) / 1000) === Math.floor(master));
  return <div className="control-view"><section className="controls"><span className="control-summary">선택 카메라 {cameras.length}대 · {focused.length ? `${focused.length}개 자동 포커스` : "전체 보기"}</span>
    <div className="toggle-wrap"><span>모션 자동 포커스 <Info aria-hidden="true" /></span><button type="button" className={`toggle ${autoFocus && motionEnabled ? "on" : ""}`} role="switch" aria-checked={autoFocus && motionEnabled} aria-label="모션 자동 포커스" disabled={!motionEnabled} onClick={() => setAutoFocus(!autoFocus)}><span /></button></div>
    <span className={`motion-status ${capability.motion}`}>{capability.message}{eventState === "partial" ? " · 일부 카메라 이벤트를 불러오지 못했습니다" : eventState === "error" ? " · 이벤트 요청 오류" : ""}</span><button className="ghost" onClick={pinFocus} disabled={!focused.length}>{pinned ? "포커스 고정 해제" : "포커스 고정"}</button><button className="ghost" onClick={() => setPrimaryRatio(defaultPrimaryRatio)}>크기 초기화</button><details className="favorites-menu"><summary>★ 즐겨찾기 {favorites.length}</summary><div>{favorites.length ? favorites.map((favorite) => <button onClick={() => jumpFavorite(favorite)} key={favorite.id}><Star weight="fill" /><span>{favorite.cameraId ? cameraTitle(allCameras, favorite.cameraId) : "전체 카메라"}<small>{new Date(favorite.at).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })} KST</small></span></button>) : <p>저장된 시간이 없습니다.</p>}</div></details></section>
	  <section className={`workspace ${capability.motion === "available" ? "" : "events-off"}`}><div><CameraGrid cameras={cameras} segments={segments} timelineLoading={timelineLoading} timelineFailed={timelineFailed} master={master} capability={capability} focused={focused} pulses={focus.pulseUntil} primaryCamera={primaryCamera} onPrimary={setPrimaryCamera} primaryRatio={primaryRatio} onPrimaryRatio={setPrimaryRatio} onPrimarySyncing={setPrimarySyncing} seekRevision={seekRevision} videos={videos} onReady={syncVideo} onMediaMissing={recoverMediaIndex} audibleCamera={audibleCamera} onAudible={setAudio} onFavorite={toggleFavorite} isFavorite={favoriteAt} onPiPStatus={setNotice} /><Timeline day={date} segments={segments} events={events} favorites={favorites} master={master} onSeek={seekTo} onDay={changeDate} /></div><EventRail cameras={cameras} capability={capability} events={events} eventState={eventState} onOpen={(event) => seekTo(Date.parse(event.at) / 1000)} /></section>
    <footer className="transport"><button onClick={() => navigateEvent(-1)} aria-label="이전 이벤트"><SkipBack aria-hidden="true" />이전 모션</button><button onClick={() => seekTo((value) => value - 5)}>-5초</button><button className="play" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "일시 정지" : "재생"}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button><button onClick={() => seekTo((value) => value + 5)}>+5초</button><button className={favoriteAt(primaryCamera) ? "favorite-on" : ""} onClick={() => toggleFavorite(primaryCamera || null)}><Star weight={favoriteAt(primaryCamera) ? "fill" : "regular"} />현재 시각</button><div className="rates" aria-label="재생 속도">{speeds.map((speed) => <button className={rate === speed ? "active" : ""} onClick={() => setRate(speed)} key={speed}>x{speed}</button>)}</div><RateControl rate={rate} setRate={setRate} /><button onClick={() => navigateEvent(1)} aria-label="다음 이벤트">다음 모션<SkipForward aria-hidden="true" /></button>{rate > 4 && <span className="audio-limit">4x 초과 · 브라우저 음성 자동 제한</span>}</footer>
    {notice && <div className="notice" role="status" onAnimationEnd={() => setNotice("")}>{notice}</div>}
  </div>;
}

function EventRail({ cameras, capability, events, eventState, onOpen }: { cameras: Camera[]; capability: Capability; events: Event[]; eventState: string; onOpen: (event: Event) => void }) {
  if (capability.motion !== "available") return <aside className="events"><header>이벤트</header><div className="unavailable"><b>{capability.motion === "detector_off" ? "모션 데이터 사용 불가 · detector off" : "모션 데이터 확인 불가"}</b><span>{capability.message}</span><small>자동 포커스와 모션 필터가 비활성화되었습니다.</small></div></aside>;
  if (eventState === "error") return <aside className="events"><header>이벤트</header><div className="unavailable"><b>이벤트 요청 실패</b><span>실제 이벤트를 만들거나 추정하지 않습니다.</span></div></aside>;
  return <aside className="events"><header>이벤트 ({events.length})</header>{events.length ? events.map((event) => <button className="event-item" onClick={() => onOpen(event)} key={`${event.cameraId}-${event.id}`}><span className="event-dot" /><b>{cameraTitle(cameras, event.cameraId)}</b><small>{formatTime(Date.parse(event.at) / 1000)} · 모션</small></button>) : <div className="unavailable"><b>{eventState === "partial" ? "일부 이벤트만 표시" : "이벤트 없음"}</b><span>{eventState === "partial" ? "응답한 카메라의 실제 이벤트만 표시합니다." : "선택 기간에 저장된 이벤트가 없습니다."}</span></div>}</aside>;
}
