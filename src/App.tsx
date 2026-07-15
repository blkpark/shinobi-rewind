import { Info, MagnifyingGlass, Pause, Play, ShieldCheck, SkipBack, SkipForward } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type React from "react";
import { CameraGrid } from "./components/CameraGrid";
import { Timeline } from "./components/Timeline";
import { rewindAPI } from "./lib/api";
import { cameraLabel, cameraTitle } from "./lib/camera.js";
import { applyFocus, driftCorrection, expireFocus, segmentAt, simultaneousFocus, videoOffset, type FocusState } from "./lib/playback.js";
import type { Camera, Capability, Event, Segment, View } from "./lib/types";

const speeds = [.25, .5, 1, 2, 5];
const kstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
const parseList = (raw: string | null) => raw?.split(",").filter(Boolean) || [];
const kstSecond = (date: string, clock: string) => Date.parse(`${date}T${clock}+09:00`) / 1000;
const formatTime = (seconds: number) => new Date(seconds * 1000).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
const isoAt = (seconds: number) => new Date(seconds * 1000).toISOString();

function initialState() {
  const query = new URLSearchParams(location.search);
  const date = query.get("date") || kstDate;
  const clock = query.get("time") || "14:31:03";
  return {
    view: (query.get("view") as View) || (localStorage.getItem("shinobi-rewind:view") as View) || "control",
    date, master: kstSecond(date, clock), selected: parseList(query.get("cameras")),
    rate: Number(query.get("rate")) || 1, autoFocus: query.get("motion") !== "off",
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
  const [events, setEvents] = useState<Event[]>([]);
  const [capability, setCapability] = useState<Capability>({ demo: true, motion: "unavailable", message: "카메라 상태 확인 중" });
  const [eventState, setEventState] = useState<"idle" | "ready" | "partial" | "error">("idle");
  const [rate, setRate] = useState(speeds.includes(initial.rate) ? initial.rate : 1);
  const [playing, setPlaying] = useState(false);
  const [autoFocus, setAutoFocus] = useState(initial.autoFocus);
  const [focus, setFocus] = useState<FocusState>({ until: {}, pulseUntil: {} });
  const [pinned, setPinned] = useState<string[] | null>(null);
  const videos = useRef<Record<string, HTMLVideoElement>>({});
	const masterRef = useRef(initial.master);
	const focusMasterRef = useRef(initial.master);

  const orderedIds = useMemo(() => cameras.map((camera) => camera.id), [cameras]);
  const shownCameras = useMemo(() => cameras.filter((camera) => selected.includes(camera.id)), [cameras, selected]);
  const focused = pinned || (autoFocus && capability.motion === "available" ? Object.keys(focus.until).filter((id) => focus.until[id] > Date.now()) : []);

	useEffect(() => {
		void rewindAPI.cameras().then((data) => {
			setCameras(data);
			setSelected((old) => old.length ? old.filter((id) => data.some((camera) => camera.id === id)).slice(0, 6) : data.slice(0, 6).map((camera) => camera.id));
		}).catch(() => setCapability({ demo: false, motion: "unavailable", message: "카메라 상태 확인 불가" }));
	}, []);

	useEffect(() => {
		if (!cameras.length || !selected.length) return;
		void rewindAPI.capabilities(selected).then(setCapability).catch(() => setCapability({ demo: false, motion: "unavailable", message: "모션 데이터 확인 불가" }));
	}, [cameras, selected]);

  useEffect(() => {
    setMaster((current) => kstSecond(date, formatTime(current)));
  }, [date]);

  useEffect(() => {
    const params = new URLSearchParams({ view, date, time: formatTime(master), cameras: selected.join(","), rate: String(rate), motion: autoFocus ? "on" : "off" });
    history.replaceState(null, "", `${location.pathname}?${params}`);
    localStorage.setItem("shinobi-rewind:view", view);
  }, [view, date, master, selected, rate, autoFocus]);

  useEffect(() => {
    if (!selected.length) { setSegments([]); return; }
    void Promise.all(selected.map((camera) => rewindAPI.timeline(date, camera))).then((data) => setSegments(data.flatMap((item) => item.segments))).catch(() => setSegments([]));
  }, [date, selected]);

  useEffect(() => {
    if (capability.motion !== "available" || !selected.length) { setEvents([]); setEventState("idle"); return; }
    const from = isoAt(kstSecond(date, "00:00:00"));
    const to = isoAt(kstSecond(date, "23:59:59"));
    void Promise.allSettled(selected.map((camera) => rewindAPI.events(from, to, camera))).then((results) => {
      const ok = results.filter((result): result is PromiseFulfilledResult<Event[]> => result.status === "fulfilled");
      setEvents(ok.flatMap((result) => result.value).sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.cameraId.localeCompare(b.cameraId) || a.id.localeCompare(b.id)));
      setEventState(ok.length === results.length ? "ready" : ok.length ? "partial" : "error");
    });
  }, [capability.motion, date, selected]);

	useEffect(() => {
		if (!playing) return;
    const timer = window.setInterval(() => setMaster((value) => value + .25 * rate), 250);
    return () => window.clearInterval(timer);
	}, [playing, rate]);

	useEffect(() => { masterRef.current = master; }, [master]);

  useEffect(() => {
    const liveFocus = simultaneousFocus(events, master, orderedIds, focusMasterRef.current);
		focusMasterRef.current = master;
    if (autoFocus && capability.motion === "available" && liveFocus.length) setFocus((old) => applyFocus(old, liveFocus, Date.now()));
    const timer = window.setInterval(() => setFocus((old) => expireFocus(old, Date.now())), 250);
    return () => window.clearInterval(timer);
  }, [autoFocus, capability.motion, events, master, orderedIds]);

	useEffect(() => {
		Object.values(videos.current).forEach((video) => { video.playbackRate = rate; if (playing) void video.play().catch(() => undefined); else video.pause(); });
	}, [playing, rate]);

	useEffect(() => {
		shownCameras.forEach((camera) => { const video = videos.current[camera.id]; if (video) syncVideo(camera, video); });
	}, [master, segments, shownCameras]);

	useEffect(() => {
		if (!playing) return;
		const timer = window.setInterval(() => shownCameras.forEach((camera) => { const video = videos.current[camera.id]; if (video) syncVideo(camera, video, masterRef.current); }), 750);
		return () => window.clearInterval(timer);
	}, [playing, rate, segments, shownCameras]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.matches("input,select,button")) return;
      if (event.code === "Space") { event.preventDefault(); setPlaying((value) => !value); }
      if (event.key.toLowerCase() === "j") setMaster((value) => value - 10);
      if (event.key.toLowerCase() === "l") setMaster((value) => value + 10);
      if (event.key === "ArrowLeft") navigateEvent(-1);
      if (event.key === "ArrowRight") navigateEvent(1);
    };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  });

	function syncVideo(camera: Camera, video: HTMLVideoElement, masterSeconds = master) {
		const segment = segmentAt(segments.filter((item) => item.cameraId === camera.id), masterSeconds);
		if (!segment || video.readyState < HTMLMediaElement.HAVE_METADATA) return;
		video.playbackRate = rate;
		if (playing) void video.play().catch(() => undefined); else video.pause();
		const expected = videoOffset(segment, masterSeconds);
		const correction = driftCorrection(video.currentTime, expected);
		if (correction !== null) video.currentTime = correction;
	}
  const navigateEvent = (direction: 1 | -1) => {
    const target = direction === 1 ? events.find((event) => Date.parse(event.at) / 1000 > master) : [...events].reverse().find((event) => Date.parse(event.at) / 1000 < master);
    if (target) { setMaster(Date.parse(target.at) / 1000); setSelected((old) => old.includes(target.cameraId) ? old : [...old, target.cameraId].slice(0, 6)); setView("control"); }
  };
  const changeDate = (next: string) => { setDate(next); setMaster(kstSecond(next, formatTime(master))); };
  const changeClock = (next: string) => setMaster(kstSecond(date, next));
  const setCamera = (next: string) => setSelected(next === "all" ? cameras.slice(0, 6).map((camera) => camera.id) : [next]);
  const pinFocus = () => setPinned((old) => old ? null : focused);

  return <main className="console">
    <header className="topbar">
      <div className="brand"><ShieldCheck size={23} weight="bold" aria-hidden="true" />내부 창고 관제 시스템</div>
      <nav aria-label="주요 보기"><button className={view === "search" ? "active" : ""} onClick={() => setView("search")}><MagnifyingGlass aria-hidden="true" />사건 검색</button><button className={view === "control" ? "active" : ""} onClick={() => setView("control")}><Play aria-hidden="true" />동기 관제</button></nav>
		<div className="clock">{date} · KST <strong>{formatTime(master)}</strong></div>
		<button className="ghost" onClick={() => setView("search")}>시간 점프</button>
    </header>
    {view === "search" ? <SearchView date={date} time={formatTime(master)} cameras={cameras} selected={selected} segments={segments} onDate={changeDate} onTime={changeClock} onCamera={setCamera} onOpen={() => setView("control")} /> : <ControlView {...{ date, cameras: shownCameras, segments, events, capability, eventState, master, setMaster, rate, setRate, playing, setPlaying, autoFocus, setAutoFocus, focused, focus, pinned, pinFocus, videos, syncVideo, navigateEvent }} />}
  </main>;
}

function SearchView({ date, time, cameras, selected, segments, onDate, onTime, onCamera, onOpen }: { date: string; time: string; cameras: Camera[]; selected: string[]; segments: Segment[]; onDate: (value: string) => void; onTime: (value: string) => void; onCamera: (value: string) => void; onOpen: () => void }) {
  const matching = segments.filter((segment) => selected.includes(segment.cameraId)).filter((segment) => Date.parse(segment.start) / 1000 <= kstSecond(date, time) && Date.parse(segment.end) / 1000 >= kstSecond(date, time));
  return <section className="search-view"><div><p className="eyebrow">RECORDING FINDER</p><h1>사건 시각으로 녹화를 찾습니다.</h1><p>날짜, 정확한 시각, 카메라를 선택하면 실제 녹화 구간만 표시합니다.</p></div>
    <div className="search-card"><label>날짜<input aria-label="날짜" type="date" value={date} onChange={(event) => onDate(event.target.value)} /></label><label>시각<input aria-label="시각" type="time" step="1" value={time} onChange={(event) => onTime(event.target.value)} /></label><label>카메라<select aria-label="카메라" value={selected.length === cameras.length ? "all" : selected[0] || ""} onChange={(event) => onCamera(event.target.value)}><option value="all">전체 카메라 ({cameras.length})</option>{cameras.map((camera) => { const label = cameraLabel(camera); return <option value={camera.id} key={camera.id}>{label.title}{label.subtitle ? ` · ${label.subtitle}` : ""}</option>; })}</select></label><button className="primary" onClick={onOpen}>동기 관제로 열기</button></div>
    <div className="result-list" aria-live="polite">{matching.length ? matching.map((segment) => <article key={segment.id}><span className={`state ${segment.state}`} /><b>{cameraTitle(cameras, segment.cameraId)}</b><span>{formatTime(Date.parse(segment.start) / 1000)} — {formatTime(Date.parse(segment.end) / 1000)}</span><em>{segment.state === "recorded" ? "녹화됨" : segment.state === "gap" ? "녹화 공백" : "파일 손상"}</em></article>) : <p>선택한 시각의 실제 녹화 구간이 없습니다.</p>}</div>
  </section>;
}

function ControlView(props: { date: string; cameras: Camera[]; segments: Segment[]; events: Event[]; capability: Capability; eventState: string; master: number; setMaster: (value: number | ((value: number) => number)) => void; rate: number; setRate: (value: number) => void; playing: boolean; setPlaying: (value: boolean | ((value: boolean) => boolean)) => void; autoFocus: boolean; setAutoFocus: (value: boolean) => void; focused: string[]; focus: FocusState; pinned: string[] | null; pinFocus: () => void; videos: React.MutableRefObject<Record<string, HTMLVideoElement>>; syncVideo: (camera: Camera, video: HTMLVideoElement) => void; navigateEvent: (direction: 1 | -1) => void }) {
  const { date, cameras, segments, events, capability, eventState, master, setMaster, rate, setRate, playing, setPlaying, autoFocus, setAutoFocus, focused, focus, pinned, pinFocus, videos, syncVideo, navigateEvent } = props;
  const motionEnabled = capability.motion === "available";
  return <><section className="controls"><span className="control-summary">선택 카메라 {cameras.length}대 · {focused.length ? `${focused.length}개 자동 포커스` : "전체 보기"}</span>
    <div className="toggle-wrap"><span>모션 자동 포커스 <Info aria-hidden="true" /></span><button type="button" className={`toggle ${autoFocus && motionEnabled ? "on" : ""}`} role="switch" aria-checked={autoFocus && motionEnabled} aria-label="모션 자동 포커스" disabled={!motionEnabled} onClick={() => setAutoFocus(!autoFocus)}><span /></button></div>
    <span className={`motion-status ${capability.motion}`}>{capability.message}{eventState === "partial" ? " · 일부 카메라 이벤트를 불러오지 못했습니다" : eventState === "error" ? " · 이벤트 요청 오류" : ""}</span><button className="ghost" onClick={pinFocus} disabled={!focused.length}>{pinned ? "포커스 고정 해제" : "포커스 고정"}</button></section>
	  <section className="workspace"><div><CameraGrid cameras={cameras} segments={segments} master={master} capability={capability} focused={focused} pulses={focus.pulseUntil} videos={videos} onReady={syncVideo} /><Timeline day={date} segments={segments} events={events} master={master} onSeek={setMaster} /></div><EventRail cameras={cameras} capability={capability} events={events} eventState={eventState} onOpen={(event) => setMaster(Date.parse(event.at) / 1000)} /></section>
    <footer className="transport"><button onClick={() => navigateEvent(-1)} aria-label="이전 이벤트"><SkipBack aria-hidden="true" />이전 모션</button><button onClick={() => setMaster((value) => value - 10)}>-10초</button><button className="play" onClick={() => setPlaying((value) => !value)} aria-label={playing ? "일시 정지" : "재생"}>{playing ? <Pause weight="fill" /> : <Play weight="fill" />}</button><button onClick={() => setMaster((value) => value + 10)}>+10초</button><div className="rates" aria-label="재생 속도">{speeds.map((speed) => <button className={rate === speed ? "active" : ""} onClick={() => setRate(speed)} key={speed}>x{speed}</button>)}</div><button onClick={() => navigateEvent(1)} aria-label="다음 이벤트">다음 모션<SkipForward aria-hidden="true" /></button></footer>
  </>;
}

function EventRail({ cameras, capability, events, eventState, onOpen }: { cameras: Camera[]; capability: Capability; events: Event[]; eventState: string; onOpen: (event: Event) => void }) {
  if (capability.motion !== "available") return <aside className="events"><header>이벤트</header><div className="unavailable"><b>{capability.motion === "detector_off" ? "모션 데이터 사용 불가 · detector off" : "모션 데이터 확인 불가"}</b><span>{capability.message}</span><small>자동 포커스와 모션 필터가 비활성화되었습니다.</small></div></aside>;
  if (eventState === "error") return <aside className="events"><header>이벤트</header><div className="unavailable"><b>이벤트 요청 실패</b><span>실제 이벤트를 만들거나 추정하지 않습니다.</span></div></aside>;
  return <aside className="events"><header>이벤트 ({events.length})</header>{events.length ? events.map((event) => <button className="event-item" onClick={() => onOpen(event)} key={`${event.cameraId}-${event.id}`}><span className="event-dot" /><b>{cameraTitle(cameras, event.cameraId)}</b><small>{formatTime(Date.parse(event.at) / 1000)} · 모션</small></button>) : <div className="unavailable"><b>{eventState === "partial" ? "일부 이벤트만 표시" : "이벤트 없음"}</b><span>{eventState === "partial" ? "응답한 카메라의 실제 이벤트만 표시합니다." : "선택 기간에 저장된 이벤트가 없습니다."}</span></div>}</aside>;
}
