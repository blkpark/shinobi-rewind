import { useMemo, useState } from "react";
import { cameraLabel } from "../lib/camera.js";
import { dayState, shiftMonth, type Favorite } from "../lib/interaction.js";
import type { Camera, Capability, Event, Segment } from "../lib/types";

type Props = { date: string; cameras: Camera[]; selected: string[]; segments: Segment[]; events: Event[]; favorites: Favorite[]; capability: Capability; eventState: string; timelineLoading: boolean; timelineFailed: string[]; onDate: (value: string) => void; onTime: (value: string) => void; onCamera: (value: string) => void; onOpen: () => void };
const kstDate = (seconds: number) => new Date(seconds * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" });
const second = (stamp: string) => Date.parse(stamp) / 1000;
const dateAt = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const addDays = (day: string, amount: number) => new Date(Date.parse(`${day}T00:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);

export function SearchView(props: Props) {
  const { date, cameras, selected, segments, events, favorites, capability, eventState, timelineLoading, timelineFailed, onDate, onTime, onCamera, onOpen } = props;
  const [level, setLevel] = useState<"month" | "week" | "day">("month"), [filter, setFilter] = useState("all");
  const year = Number(date.slice(0, 4)), month = Number(date.slice(5, 7));
  const day = Number(date.slice(8)), first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(), days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const weekStart = addDays(date, -new Date(Date.UTC(year, month - 1, day)).getUTCDay());
  const failed = timelineFailed.length === selected.length && selected.length ? "all" : timelineFailed.length ? "partial" : "none";
  const state = dayState({ loading: timelineLoading, failed, capability: capability.motion, events: events.length });
  const stateText = { loading: "녹화 목록 확인 중", no_data: "데이터 확인 불가", partial: "일부 카메라 확인 불가", detector_off: "모션 데이터 사용 불가 · detector off", events: `${events.length}개 이벤트`, zero_events: "확인된 이벤트 0건" }[state];
  const dayFavorites = favorites.filter((item) => kstDate(second(item.at)) === date && (!item.cameraId || selected.includes(item.cameraId)));
  const visibleItems = useMemo(() => {
    const segmentItems = segments.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.start, kind: item.state, label: item.state === "recorded" ? "녹화" : item.state === "gap" ? "녹화 공백" : "파일 손상" }));
    const eventItems = events.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.at, kind: "motion", label: "모션 이벤트" }));
    const favoriteItems = dayFavorites.map((item) => ({ id: item.id, cameraId: item.cameraId, at: item.at, kind: "favorite", label: item.label || "즐겨찾기" }));
    return [...favoriteItems, ...eventItems, ...segmentItems].filter((item) => filter === "all" || item.kind === filter).sort((a, b) => second(a.at) - second(b.at));
  }, [dayFavorites, events, filter, segments]);
  const selectDay = (value: string, next: "week" | "day") => { onDate(value); setLevel(next); };
  const goMonth = (amount: number) => { onDate(shiftMonth(date, amount)); setLevel("month"); };
  const today = () => { onDate(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date())); setLevel("month"); };
  return <section className="calendar-search">
    <aside className="search-filters"><h1>사건 찾기</h1><label>카메라<select value={selected.length === cameras.length ? "all" : selected[0] || ""} onChange={(event) => onCamera(event.target.value)}><option value="all">전체 카메라 ({cameras.length})</option>{cameras.map((camera) => { const label = cameraLabel(camera); return <option value={camera.id} key={camera.id}>{label.title}{label.subtitle ? ` · ${label.subtitle}` : ""}</option>; })}</select></label><label>상태<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">전체 내역</option><option value="recorded">녹화 있음</option><option value="favorite">★ 즐겨찾기</option><option value="motion">모션</option><option value="gap">녹화 공백</option><option value="corrupt">파일 손상</option></select></label><label>빠른 시간 이동<input type="time" step="1" onChange={(event) => onTime(event.target.value)} /></label><button className="primary" onClick={onOpen}>현재 시각 동기 관제</button><div className={`search-trust ${state}`}><b>{stateText}</b><span>{eventState === "partial" ? "응답한 카메라의 실제 내역만 표시합니다." : state === "zero_events" ? "이벤트 API가 정상 응답한 결과입니다." : "상태를 추정하지 않습니다."}</span></div></aside>
    <div className="calendar-content"><nav className="breadcrumbs" aria-label="검색 범위"><button onClick={() => goMonth(-1)} aria-label="이전 달">‹</button><button onClick={() => setLevel("month")}>{year}년 {month}월</button><button onClick={() => goMonth(1)} aria-label="다음 달">›</button><button className="today" onClick={today}>오늘</button>{level !== "month" && <><span>›</span><button onClick={() => setLevel("week")}>{month}월 {Math.ceil(day / 7)}주</button></>}{level === "day" && <><span>›</span><b>{month}월 {day}일</b></>}</nav>
      {level === "month" && <div className="month-grid"><div className="weekday-row">{["일", "월", "화", "수", "목", "금", "토"].map((item) => <b key={item}>{item}</b>)}</div><div className="month-days">{Array.from({ length: first }, (_, index) => <span key={`empty-${index}`} />)}{Array.from({ length: days }, (_, index) => { const value = dateAt(year, month, index + 1), count = favorites.filter((item) => kstDate(second(item.at)) === value).length; return <button className={value === date ? "selected" : ""} onClick={() => selectDay(value, "week")} key={value}><b>{index + 1}</b><small>{value === date ? stateText : count ? `★ ${count}개` : "내역 확인"}</small></button>; })}</div></div>}
      {level === "week" && <div className="week-grid">{Array.from({ length: 7 }, (_, index) => { const value = addDays(weekStart, index); return <button className={value === date ? "selected" : ""} onClick={() => selectDay(value, "day")} key={value}><b>{value.slice(5)}</b><span className="week-hours">{Array.from({ length: 24 }, (_, hour) => <i className={value === date && segments.some((item) => Number(new Date(item.start).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false })) === hour) ? "recorded" : ""} key={hour} />)}</span><small>{value === date ? stateText : "클릭해 확인"}</small></button>; })}</div>}
      {level === "day" && <div className="day-results"><section className="hour-list"><h2>{date} 시간대</h2>{Array.from({ length: 24 }, (_, hour) => { const items = visibleItems.filter((item) => new Date(item.at).toLocaleString("en-US", { timeZone: "Asia/Seoul", hour: "2-digit", hour12: false }).startsWith(String(hour).padStart(2, "0"))); return <button onClick={() => { onTime(`${String(hour).padStart(2, "0")}:00:00`); onOpen(); }} key={hour}><time>{String(hour).padStart(2, "0")}:00</time><span>{items.length ? `${items.length}개 내역` : timelineLoading ? "확인 중" : "표시할 내역 없음"}</span></button>; })}</section><section className="search-results"><h2>내역 {visibleItems.length}건</h2>{visibleItems.length ? visibleItems.map((item) => <button onClick={() => { onTime(new Date(item.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour12: false })); onOpen(); }} key={`${item.kind}-${item.id}`}><time>{new Date(item.at).toLocaleTimeString("en-GB", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit" })}</time><b>{item.label}</b><small>{item.cameraId ? cameraLabel(cameras.find((camera) => camera.id === item.cameraId) || { id: item.cameraId, name: "", detector: false }).title : "전체 카메라"}</small></button>) : <p>{state === "detector_off" && filter === "motion" ? "detector가 꺼져 있어 모션 0건으로 판단할 수 없습니다." : "선택한 필터에 해당하는 내역이 없습니다."}</p>}</section></div>}
    </div>
  </section>;
}
