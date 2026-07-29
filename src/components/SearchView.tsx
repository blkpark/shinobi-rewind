import { useEffect, useMemo, useState } from "react";
import { rewindAPI } from "../lib/api";
import { cameraLabel } from "../lib/camera.js";
import { dayState, formatKSTRange, shiftMonth, type Favorite } from "../lib/interaction.js";
import { useLanguage } from "../lib/i18n";
import type { Archive, ArchiveArtifact, Camera, Capability, Event, RecordingSummary, Segment } from "../lib/types";

type Props = { date: string; cameras: Camera[]; selected: string[]; segments: Segment[]; events: Event[]; favorites: Favorite[]; capability: Capability; eventState: string; timelineLoading: boolean; timelineFailed: string[]; onDate: (value: string) => void; onTime: (value: string) => void; onCamera: (value: string) => void; onOpen: () => void };
type SearchMode = "recordings" | "archives";
const kstDate = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const kstHour = (stamp: string) => new Date(stamp).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false });
const kstClock = (stamp: string) => new Date(stamp).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false });
const second = (stamp: string) => Date.parse(stamp) / 1000;
const dateAt = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const addDays = (day: string, amount: number) => new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
const bytes = (value: number | undefined, pending: string) => value === undefined ? pending : value < 1024 * 1024 ? `${(value / 1024).toFixed(0)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;
const statuses = {
  ko: { queued: "대기 중", waiting_recording: "녹화 종료 대기", copying: "복사 중", verifying: "검증 중", verified: "검증됨", partial: "일부 보존", failed: "실패" },
  en: { queued: "Queued", waiting_recording: "Waiting for recording", copying: "Copying", verifying: "Verifying", verified: "Verified", partial: "Partially archived", failed: "Failed" },
} as const;
const reasons = {
  ko: { segment_not_found: "해당 시각의 녹화 구간을 찾지 못했습니다.", segment_corrupt: "원본 녹화 파일이 손상되었습니다.", source_unavailable: "원본 녹화에 연결할 수 없습니다.", copy_failed: "보조 드라이브로 복사하지 못했습니다.", verification_failed: "복사본 검증에 실패했습니다.", invalid_media: "완료된 MP4 파일로 확인되지 않았습니다.", artifact_too_large: "보존 가능한 파일 크기를 초과했습니다.", insufficient_storage: "백업 드라이브의 안전 여유 공간이 부족합니다.", queue_full: "백업 대기열이 가득 찼습니다." },
  en: { segment_not_found: "No recording segment was found at this time.", segment_corrupt: "The source recording is corrupt.", source_unavailable: "The source recording is unavailable.", copy_failed: "Could not copy to the secondary drive.", verification_failed: "Archive verification failed.", invalid_media: "The file is not a completed MP4.", artifact_too_large: "The file exceeds the archive size limit.", insufficient_storage: "The archive drive does not have enough safe free space.", queue_full: "The archive queue is full." },
} as const;

export function SearchView(props: Props) {
  const { language, text } = useLanguage();
  const { date, cameras, selected, segments, events, favorites, capability, eventState, timelineLoading, timelineFailed, onDate, onTime, onCamera, onOpen } = props;
  const [level, setLevel] = useState<"month" | "week" | "day">("month"), [filter, setFilter] = useState("all");
  const [mode, setMode] = useState<SearchMode>("recordings"), [archiveStatus, setArchiveStatus] = useState("all"), [archives, setArchives] = useState<Archive[]>([]);
  const [archiveState, setArchiveState] = useState<"idle" | "loading" | "ready" | "error">("idle"), [selectedArchive, setSelectedArchive] = useState(""), [selectedArtifact, setSelectedArtifact] = useState(""), [archiveHour, setArchiveHour] = useState<number | null>(null);
  const [recordingSummary, setRecordingSummary] = useState<RecordingSummary | null>(null), [summaryState, setSummaryState] = useState<"idle" | "loading" | "ready" | "error">("idle"), [summaryScope, setSummaryScope] = useState("");
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
  const day = Number(date.slice(8)), first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekStart = addDays(date, -new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  const failed = timelineFailed.length === selected.length && selected.length ? "all" : timelineFailed.length ? "partial" : "none";
  const state = dayState({ loading: timelineLoading, failed, capability: capability.motion, events: events.length });
  const stateText = { loading: text("녹화 목록 확인 중", "Checking recordings"), no_data: text("데이터 확인 불가", "Data unavailable"), partial: text("일부 카메라 확인 불가", "Some cameras unavailable"), detector_off: text("모션 데이터 사용 불가 · detector off", "Motion data unavailable · detector off"), events: language === "ko" ? `${events.length}개 이벤트` : `${events.length} events`, zero_events: text("확인된 이벤트 0건", "0 confirmed events") }[state];
  const dayFavorites = favorites.filter((item) => kstDate(second(item.at)) === date && (!item.cameraId || selected.includes(item.cameraId)));
  const cameraScope = [...selected].sort().join(",");
  const monthStart = dateAt(year, month, 1), monthEnd = dateAt(year, month, days);
  const rangeStart = level === "month" ? monthStart : weekStart, rangeEnd = level === "month" ? monthEnd : addDays(weekStart, 6);

  useEffect(() => {
    if (mode !== "archives") return;
    let current = true;
    let timer = 0;
    setArchiveState("loading");
    const load = () => void rewindAPI.archives({ month: date.slice(0, 7) }).then((items) => { if (current) { setArchives(items); setArchiveState("ready"); if (items.some((item) => !["verified", "partial", "failed"].includes(item.status))) timer = window.setTimeout(load, 5000); } }).catch(() => { if (current) { setArchives([]); setArchiveState("error"); } });
    load();
    return () => { current = false; window.clearTimeout(timer); };
  }, [date.slice(0, 7), mode]);

  useEffect(() => {
    if (mode !== "recordings" || level === "day" || !selected.length) return;
    const scope = `${cameraScope}|${rangeStart}|${rangeEnd}`;
    if (summaryScope.startsWith(`${cameraScope}|`)) {
      const [, loadedFrom, loadedTo] = summaryScope.split("|");
      if (loadedFrom <= rangeStart && loadedTo >= rangeEnd) return;
    }
    let current = true;
    setRecordingSummary(null); setSummaryState("loading");
    rewindAPI.recordingSummary(rangeStart, rangeEnd, selected).then((value) => {
      if (!current) return;
      setRecordingSummary(value); setSummaryScope(scope); setSummaryState("ready");
    }).catch(() => {
      if (!current) return;
      setRecordingSummary(null); setSummaryScope(scope); setSummaryState("error");
    });
    return () => { current = false; };
  }, [cameraScope, level, mode, rangeEnd, rangeStart, selected, summaryScope]);

  const visibleItems = useMemo(() => {
    const segmentItems = segments.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.start, kind: item.state, label: item.state === "recorded" ? text("녹화", "Recording") : item.state === "gap" ? text("녹화 공백", "Recording gap") : text("파일 손상", "Corrupt file") }));
    const eventItems = events.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.at, kind: "motion", label: text("모션 이벤트", "Motion event") }));
    const favoriteItems = dayFavorites.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.at, kind: "favorite", label: item.label || text("즐겨찾기", "Favorite") }));
    return [...favoriteItems, ...eventItems, ...segmentItems].filter((item) => filter === "all" || item.kind === filter).sort((a, b) => second(a.at) - second(b.at));
  }, [dayFavorites, events, filter, language, segments, text]);
  const scopedArchives = useMemo(() => archives.filter((archive) => (selected.length === cameras.length || archive.cameraIds.some((camera) => selected.includes(camera))) && (archiveStatus === "all" || archive.status === archiveStatus)), [archiveStatus, archives, cameras.length, selected]);
  const summaryDays = useMemo(() => new Map((recordingSummary?.days || []).map((item) => [item.date, item])), [recordingSummary]);
  const dayArchives = scopedArchives.filter((archive) => kstDate(second(archive.at)) === date && (archiveHour === null || Number(kstHour(archive.at)) === archiveHour));
  const activeArchive = dayArchives.find((archive) => archive.id === selectedArchive) || dayArchives[0];
  const activeArtifact = activeArchive?.artifacts.find((artifact) => artifact.id === selectedArtifact) || activeArchive?.artifacts.find((artifact) => artifact.status === "verified") || activeArchive?.artifacts[0];
  const selectArchive = (archive: Archive) => { setSelectedArchive(archive.id); setSelectedArtifact(archive.artifacts.find((artifact) => artifact.status === "verified")?.id || archive.artifacts[0]?.id || ""); };
  const selectDay = (value: string, next: "week" | "day") => { onDate(value); setArchiveHour(null); setLevel(next); };
  const goMonth = (amount: number) => { onDate(shiftMonth(date, amount)); setArchiveHour(null); setLevel("month"); };
  const today = () => { onDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())); setArchiveHour(null); setLevel("month"); };
  const daySummary = (value: string) => summaryDays.get(value);
  const summaryLabel = (value: string) => {
    if (mode === "archives") {
      const count = scopedArchives.filter((item) => kstDate(second(item.at)) === value).length;
      return count ? (language === "ko" ? `보존 ${count}건` : `${count} archived`) : archiveState === "loading" ? text("확인 중", "Checking") : archiveState === "error" ? text("확인 불가", "Unavailable") : text("보존 없음", "No archives");
    }
    const summary = daySummary(value);
    if (!summary) return summaryState === "loading" ? text("녹화 범위 확인 중", "Checking recording range") : summaryState === "error" ? text("녹화 범위 확인 실패", "Recording range unavailable") : text("녹화 없음", "No recordings");
    if (recordingSummary?.failedCameras.length === recordingSummary?.cameraCount) return text("카메라 응답 실패", "Cameras did not respond");
    const recorded = summary.hours.filter((item) => item.recorded).length, gap = summary.hours.filter((item) => item.gap).length, corrupt = summary.hours.filter((item) => item.corrupt).length;
    const labels = language === "ko" ? [recorded ? `녹화 ${recorded}시간` : "", gap ? `공백 ${gap}` : "", corrupt ? `손상 ${corrupt}` : ""] : [recorded ? `${recorded}h recorded` : "", gap ? `${gap} gaps` : "", corrupt ? `${corrupt} corrupt` : ""];
    return labels.filter(Boolean).join(" · ") || text("녹화 없음", "No recordings");
  };
  const hourCells = (value: string, className: string) => {
    const summary = daySummary(value), partial = !!recordingSummary?.failedCameras.length;
    return <span className={`${className} ${partial ? "summary-partial" : ""}`} aria-hidden="true">{Array.from({ length: 24 }, (_, hour) => {
      if (mode === "archives") {
        const archived = scopedArchives.some((item) => kstDate(second(item.at)) === value && Number(kstHour(item.at)) === hour);
        return <i className={archived ? "archived" : ""} key={hour} />;
      }
      const item = summary?.hours[hour];
      const states = [item?.recorded ? "recorded" : "", item?.gap ? "gap" : "", item?.corrupt ? "corrupt" : ""].filter(Boolean).join(" ");
      return <i className={states || (summaryState === "loading" ? "loading" : recordingSummary?.failedCameras.length === recordingSummary?.cameraCount ? "unknown" : "")} key={hour} />;
    })}</span>;
  };

  const statusText = statuses[language] as Record<string, string>;
  return <section className="calendar-search">
    <aside className="search-filters">
      <h1>{text("사건 찾기", "Find incidents")}</h1>
      <label>{text("카메라", "Camera")}<select value={selected.length === cameras.length ? "all" : selected[0] || ""} onChange={(event) => onCamera(event.target.value)}><option value="all">{text("전체 카메라", "All cameras")} ({cameras.length})</option>{cameras.map((camera) => { const label = cameraLabel(camera); return <option value={camera.id} key={camera.id}>{label.title}{label.subtitle ? ` · ${label.subtitle}` : ""}</option>; })}</select></label>
      {mode === "recordings" ? <label>{text("상태", "Status")}<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">{text("전체 내역", "All records")}</option><option value="recorded">{text("녹화 있음", "Recorded")}</option><option value="favorite">★ {text("즐겨찾기", "Favorites")}</option><option value="motion">{text("모션", "Motion")}</option><option value="gap">{text("녹화 공백", "Recording gaps")}</option><option value="corrupt">{text("파일 손상", "Corrupt files")}</option></select></label> : <label>{text("백업 상태", "Archive status")}<select value={archiveStatus} onChange={(event) => setArchiveStatus(event.target.value)}><option value="all">{text("전체 상태", "All statuses")}</option>{["verified", "partial", "waiting_recording", "copying", "failed"].map((value) => <option value={value} key={value}>{statusText[value]}</option>)}</select></label>}
      <label>{text("빠른 시간 이동", "Quick time jump")}<input type="time" step="1" onChange={(event) => onTime(event.target.value)} /></label><button className="primary" onClick={onOpen}>{text("현재 시각 동기 관제", "Open synchronized playback")}</button>
      {mode === "recordings" ? <div className={`search-trust ${state}`}><b>{stateText}</b><span>{eventState === "partial" ? text("응답한 카메라의 실제 내역만 표시합니다.", "Only records from responding cameras are shown.") : state === "zero_events" ? text("이벤트 API가 정상 응답한 결과입니다.", "The event API returned successfully.") : text("상태를 추정하지 않습니다.", "Statuses are not inferred.")}</span></div> : <div className={`search-trust archive-drive ${archiveState}`}><b>{archiveState === "loading" ? text("백업 드라이브 확인 중", "Checking archive drive") : archiveState === "error" ? text("백업 드라이브 확인 불가", "Archive drive unavailable") : language === "ko" ? `${scopedArchives.length}개 보존 요청` : `${scopedArchives.length} archive requests`}</b><span>{archiveState === "error" ? text("빈 내역으로 판단하지 않습니다.", "This is not treated as an empty result.") : text("검증된 백업본만 프리뷰합니다.", "Only verified archives can be previewed.")}</span></div>}
    </aside>
    <div className="calendar-content">
      <div className="search-mode" role="tablist" aria-label={text("검색 자료", "Search sources")}><button className={mode === "recordings" ? "active" : ""} onClick={() => setMode("recordings")} role="tab" aria-selected={mode === "recordings"}>{text("녹화 내역", "Recordings")}</button><button className={mode === "archives" ? "active" : ""} onClick={() => setMode("archives")} role="tab" aria-selected={mode === "archives"}>{text("보존 영상", "Archives")}</button></div>
      <nav className="breadcrumbs" aria-label={text("검색 범위", "Search range")}><button onClick={() => goMonth(-1)} aria-label={text("이전 달", "Previous month")}>‹</button><button onClick={() => setLevel("month")}>{language === "ko" ? `${year}년 ${month}월` : new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}</button><button onClick={() => goMonth(1)} aria-label={text("다음 달", "Next month")}>›</button><button className="today" onClick={today}>{text("오늘", "Today")}</button>{level !== "month" && <><span>›</span><button onClick={() => setLevel("week")}>{language === "ko" ? `${month}월 ${Math.ceil(day / 7)}주` : `Week ${Math.ceil(day / 7)}`}</button></>}{level === "day" && <><span>›</span><b>{language === "ko" ? `${month}월 ${day}일` : `${month}/${day}`}</b></>}{mode === "recordings" && <span className="recording-legend" aria-label={text("시간 셀 범례", "Hourly cell legend")}><i className="recorded" />{text("녹화", "Recorded")}<i className="gap" />{text("공백", "Gap")}<i className="corrupt" />{text("손상", "Corrupt")}</span>}<span className="range-switch" role="group" aria-label={text("달력 보기", "Calendar view")}><button className={level === "month" ? "active" : ""} onClick={() => setLevel("month")}>{text("월 보기", "Month")}</button><button className={level === "week" ? "active" : ""} onClick={() => setLevel("week")}>{text("주 보기", "Week")}</button><button className={level === "day" ? "active" : ""} onClick={() => setLevel("day")}>{text("일 보기", "Day")}</button></span></nav>
      {level === "month" && <div className="month-grid"><div className="weekday-row">{(language === "ko" ? ["일", "월", "화", "수", "목", "금", "토"] : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]).map((item) => <b key={item}>{item}</b>)}</div><div className="month-days">{Array.from({ length: first }, (_, index) => <span key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => { const value = dateAt(year, month, index + 1), favoriteCount = favorites.filter((item) => kstDate(second(item.at)) === value).length, label = summaryLabel(value); return <button className={value === date ? "selected" : ""} onClick={() => selectDay(value, "week")} aria-label={`${value} ${label}`} key={value}><b>{index + 1}{favoriteCount ? <em>★ {favoriteCount}</em> : null}</b>{hourCells(value, "day-hours")}<small>{label}</small></button>; })}</div></div>}
      {level === "week" && <div className="week-grid">{Array.from({ length: 7 }, (_, index) => { const value = addDays(weekStart, index), label = summaryLabel(value); return <button className={value === date ? "selected" : ""} onClick={() => selectDay(value, "day")} aria-label={`${value} ${label}`} key={value}><b>{value.slice(5)}</b>{hourCells(value, "week-hours")}<small>{label}</small></button>; })}</div>}
      {level === "day" && mode === "recordings" && <div className="day-results"><section className="hour-list"><h2>{date} {text("시간대", "hours")}</h2>{Array.from({ length: 24 }, (_, hour) => { const items = visibleItems.filter((item) => Number(kstHour(item.at)) === hour); return <button onClick={() => { onTime(`${String(hour).padStart(2, "0")}:00:00`); onOpen(); }} key={hour}><time>{String(hour).padStart(2, "0")}:00</time><span>{items.length ? (language === "ko" ? `${items.length}개 내역` : `${items.length} records`) : timelineLoading ? text("확인 중", "Checking") : text("표시할 내역 없음", "No records")}</span></button>; })}</section><section className="search-results"><h2>{language === "ko" ? `내역 ${visibleItems.length}건` : `${visibleItems.length} records`}</h2>{visibleItems.length ? visibleItems.map((item) => <button onClick={() => { onTime(kstClock(item.at)); onOpen(); }} key={`${item.kind}-${item.id}`}><time>{kstClock(item.at).slice(0, 5)}</time><b>{item.label}</b><small>{item.cameraId ? cameraLabel(cameras.find((camera) => camera.id === item.cameraId) || { id: item.cameraId, name: "", detector: false }).title : text("전체 카메라", "All cameras")}</small></button>) : <p>{state === "detector_off" && filter === "motion" ? text("detector가 꺼져 있어 모션 0건으로 판단할 수 없습니다.", "Motion cannot be reported as zero while the detector is off.") : text("선택한 필터에 해당하는 내역이 없습니다.", "No records match the selected filter.")}</p>}</section></div>}
      {level === "day" && mode === "archives" && <div className="archive-day"><section className="hour-list"><h2>{date} {text("시간대", "hours")}</h2>{Array.from({ length: 24 }, (_, hour) => { const count = scopedArchives.filter((item) => kstDate(second(item.at)) === date && Number(kstHour(item.at)) === hour).length; return <button className={archiveHour === hour ? "selected" : ""} onClick={() => setArchiveHour(archiveHour === hour ? null : hour)} key={hour}><time>{String(hour).padStart(2, "0")}:00</time><span>{count ? (language === "ko" ? `${count}건 보존` : `${count} archived`) : text("보존 없음", "No archives")}</span></button>; })}</section><section className="archive-list"><h2>{language === "ko" ? `보존 영상 ${dayArchives.length}건` : `${dayArchives.length} archived videos`}</h2>{archiveState === "loading" ? <p>{text("보존 내역 확인 중", "Checking archives")}</p> : archiveState === "error" ? <p>{text("백업 드라이브를 확인할 수 없습니다.", "The archive drive is unavailable.")}</p> : dayArchives.length ? dayArchives.map((archive) => <button className={activeArchive?.id === archive.id ? "selected" : ""} onClick={() => selectArchive(archive)} key={archive.id}><time>{kstClock(archive.at).slice(0, 5)}</time><span><b>{archive.label || text("즐겨찾기 보존", "Favorite archive")}</b><small>{archive.cameraIds.map((id) => cameraLabel(cameras.find((camera) => camera.id === id) || { id, name: "", detector: false }).title).join(" · ")}</small></span><em className={`archive-status ${archive.status}`}>{statusText[archive.status] || archive.status}</em></button>) : <p>{text("이 날짜에 보존된 즐겨찾기가 없습니다.", "No favorites were archived on this date.")}</p>}</section><ArchivePreview archive={activeArchive} artifact={activeArtifact} cameras={cameras} onArtifact={setSelectedArtifact} onOpen={() => { if (!activeArchive) return; onTime(kstClock(activeArchive.at)); onOpen(); }} /></div>}
    </div>
  </section>;
}

function ArchivePreview({ archive, artifact, cameras, onArtifact, onOpen }: { archive?: Archive; artifact?: ArchiveArtifact; cameras: Camera[]; onArtifact: (id: string) => void; onOpen: () => void }) {
  const { language, text } = useLanguage();
  const statusText = statuses[language] as Record<string, string>, reasonText = reasons[language] as Record<string, string>;
  if (!archive) return <section className="archive-preview"><h2>{text("프리뷰", "Preview")}</h2><p>{text("보존 영상을 선택해 주세요.", "Select an archived video.")}</p></section>;
  return <section className="archive-preview"><h2>{text("프리뷰", "Preview")}</h2>{archive.artifacts.length > 1 && <div className="artifact-tabs">{archive.artifacts.map((item) => <button className={item.id === artifact?.id ? "active" : ""} onClick={() => onArtifact(item.id)} key={item.id}>{cameraLabel(cameras.find((camera) => camera.id === item.cameraId) || { id: item.cameraId, name: "", detector: false }).title}<i className={item.status} /></button>)}</div>}{artifact?.status === "verified" ? <video controls preload="metadata" src={artifact.videoUrl || rewindAPI.archiveVideo(archive.id, artifact.id)} /> : <div className="archive-unavailable"><b>{statusText[artifact?.status || archive.status] || text("확인 중", "Checking")}</b><span>{artifact?.reason ? reasonText[artifact.reason] || artifact.reason : text("검증 전에는 백업본을 재생할 수 없습니다.", "Archives cannot be played before verification.")}</span></div>}<dl><div><dt>{text("즐겨찾기", "Favorite")}</dt><dd>{new Date(archive.at).toLocaleString(language === "ko" ? "ko-KR" : "en-US", { timeZone: "Asia/Seoul", hour12: false })} KST</dd></div><div><dt>{text("원본 구간", "Source range")}</dt><dd>{artifact?.start && artifact.end ? formatKSTRange(second(artifact.start), second(artifact.end), language) : text("녹화 종료 후 확인", "Available after recording closes")}</dd></div><div><dt>{text("상태", "Status")}</dt><dd>{statusText[artifact?.status || archive.status] || archive.status}</dd></div><div><dt>{text("크기", "Size")}</dt><dd>{bytes(artifact?.size, text("크기 확인 중", "Checking size"))}</dd></div>{artifact?.sha256 && <div><dt>{text("검증", "Verification")}</dt><dd>SHA-256 {artifact.sha256.slice(0, 12)}…</dd></div>}</dl><button className="primary" onClick={onOpen}>{text("같은 시각 녹화 관제로 열기", "Open synchronized playback at this time")}</button><small className="archive-policy">{text("즐겨찾기를 제거해도 검증된 백업은 유지됩니다.", "Verified archives remain after removing a favorite.")}</small></section>;
}
