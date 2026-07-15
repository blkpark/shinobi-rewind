package rewind

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	cacheTTL      = 5 * time.Minute
	maxDayCaches  = 96
	minimumLength = time.Second
)

var seoul = time.FixedZone("Asia/Seoul", 9*60*60)

type cachedTimeline struct {
	until time.Time
	data  Timeline
}

// ShinobiSource uses only documented read endpoints. API and group keys are
// used in upstream paths and are never copied to a client response or log.
type ShinobiSource struct {
	config Config
	client *http.Client

	mu                        sync.RWMutex
	segments                  map[string]Segment
	indexExpiry               map[string]time.Time
	timelines                 map[string]cachedTimeline
	detectorKnown, detectorOn bool
}

func NewShinobiSource(c Config) *ShinobiSource {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = upstreamTimeout(c)
	transport.DialContext = (&net.Dialer{Timeout: upstreamTimeout(c)}).DialContext
	return &ShinobiSource{
		config:   c,
		client:   &http.Client{Transport: transport},
		segments: map[string]Segment{}, indexExpiry: map[string]time.Time{}, timelines: map[string]cachedTimeline{},
	}
}

func upstreamTimeout(c Config) time.Duration {
	if c.HeaderTimeout > 0 {
		return c.HeaderTimeout
	}
	return 15 * time.Second
}

func (s *ShinobiSource) endpoint(resource, camera string, query url.Values) string {
	u := *s.config.ShinobiURL
	parts := []string{s.config.ShinobiKey, resource, s.config.ShinobiGroup}
	if camera != "" {
		parts = append(parts, camera)
	}
	for _, item := range parts {
		u.Path = path.Join(u.Path, url.PathEscape(item))
	}
	u.RawQuery = query.Encode()
	return u.String()
}

func (s *ShinobiSource) request(ctx context.Context, resource, camera string, query url.Values) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.endpoint(resource, camera, query), nil)
	if err != nil {
		return nil, err
	}
	return s.client.Do(req)
}

func (s *ShinobiSource) Cameras(ctx context.Context) ([]Camera, error) {
	res, err := s.request(ctx, "monitor", "", nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("shinobi monitor request failed: %d", res.StatusCode)
	}
	var raw []struct {
		MID     string          `json:"mid"`
		Name    string          `json:"name"`
		Details json.RawMessage `json:"details"`
	}
	if err := json.NewDecoder(res.Body).Decode(&raw); err != nil {
		return nil, err
	}
	out := make([]Camera, 0, len(raw))
	on := false
	for _, monitor := range raw {
		detector := detectorEnabled(monitor.Details)
		on = on || detector
		out = append(out, Camera{ID: monitor.MID, Name: monitor.Name, Detector: detector})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	s.mu.Lock()
	s.detectorKnown, s.detectorOn = true, on
	s.mu.Unlock()
	return out, nil
}

func detectorEnabled(raw json.RawMessage) bool {
	var details map[string]any
	if err := json.Unmarshal(raw, &details); err != nil {
		var encoded string
		if json.Unmarshal(raw, &encoded) != nil || json.Unmarshal([]byte(encoded), &details) != nil {
			return false
		}
	}
	if value, ok := details["detector"]; ok && (value == true || value == "1" || value == 1.0 || strings.EqualFold(fmt.Sprint(value), "on")) {
		return true
	}
	return false
}

type shinobiVideo struct {
	MID      string          `json:"mid"`
	Time     string          `json:"time"`
	End      string          `json:"end"`
	Filename string          `json:"filename"`
	Details  json.RawMessage `json:"details"`
}

func explicitAudio(raw json.RawMessage) *bool {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil
	}
	var details map[string]any
	if err := json.Unmarshal(raw, &details); err != nil {
		var encoded string
		if json.Unmarshal(raw, &encoded) != nil || json.Unmarshal([]byte(encoded), &details) != nil {
			return nil
		}
	}
	for _, key := range []string{"hasAudio", "has_audio", "audio"} {
		if value, ok := details[key]; ok {
			switch strings.ToLower(fmt.Sprint(value)) {
			case "true", "1", "yes", "on":
				result := true
				return &result
			case "false", "0", "no", "off", "none":
				result := false
				return &result
			}
		}
	}
	for _, key := range []string{"audioCodec", "audio_codec", "codec_audio"} {
		if value, ok := details[key]; ok && strings.TrimSpace(fmt.Sprint(value)) != "" {
			result := !strings.EqualFold(strings.TrimSpace(fmt.Sprint(value)), "none")
			return &result
		}
	}
	return nil
}

func (s *ShinobiSource) Timeline(ctx context.Context, day time.Time, camera string) (Timeline, error) {
	key := day.Format("2006-01-02") + "\x00" + camera
	s.mu.RLock()
	entry, ok := s.timelines[key]
	s.mu.RUnlock()
	if ok && time.Now().Before(entry.until) {
		s.indexTimeline(entry)
		return entry.data, nil
	}
	end := day.AddDate(0, 0, 1)
	query := url.Values{"start": {shinobiBound(day)}, "end": {shinobiBound(end)}, "endIsStartTo": {"1"}}
	res, err := s.request(ctx, "videos", camera, query)
	if err != nil {
		return Timeline{}, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return Timeline{}, fmt.Errorf("shinobi video request failed: %d", res.StatusCode)
	}
	var envelope struct {
		Videos []shinobiVideo `json:"videos"`
	}
	if err := json.NewDecoder(res.Body).Decode(&envelope); err != nil {
		return Timeline{}, err
	}
	timeline := Timeline{CameraID: camera, Segments: s.normalizedSegments(camera, day, envelope.Videos)}
	s.storeTimeline(key, timeline)
	return timeline, nil
}

func shinobiBound(at time.Time) string { return at.In(seoul).Format("2006-01-02T15:04:05") }

func (s *ShinobiSource) normalizedSegments(camera string, day time.Time, videos []shinobiVideo) []Segment {
	endOfDay := day.AddDate(0, 0, 1)
	items := make([]Segment, 0, len(videos))
	seen := map[string]bool{}
	for index, video := range videos {
		start, validStart := parseShinobiTime(video.Time, seoul)
		end, validEnd := parseShinobiTime(video.End, seoul)
		id := opaqueID(camera, video.Time, video.Filename)
		if seen[id] {
			continue
		}
		seen[id] = true
		state := "recorded"
		if !validStart {
			start, end, state = endOfDay.Add(-time.Duration(len(videos)-index)*time.Nanosecond), endOfDay.Add(-time.Duration(len(videos)-index-1)*time.Nanosecond), "corrupt"
		}
		if !validEnd || end.Sub(start) < minimumLength || video.Filename == "" {
			state = "corrupt"
		}
		if start.Before(day) || !start.Before(endOfDay) {
			continue
		}
		if end.After(endOfDay) {
			end = endOfDay
		}
		items = append(items, Segment{ID: id, CameraID: camera, Start: start, End: end, State: state, HasAudio: explicitAudio(video.Details), Source: s.endpoint("videos", camera, nil) + "/" + url.PathEscape(video.Filename)})
	}
	sort.Slice(items, func(i, j int) bool {
		if !items[i].Start.Equal(items[j].Start) {
			return items[i].Start.Before(items[j].Start)
		}
		if !items[i].End.Equal(items[j].End) {
			return items[i].End.Before(items[j].End)
		}
		return items[i].ID < items[j].ID
	})
	out := make([]Segment, 0, len(items)*2)
	var previous time.Time
	for _, item := range items {
		if item.State != "corrupt" && !previous.IsZero() && item.Start.After(previous) {
			out = append(out, Segment{ID: opaqueID(camera, previous.String(), item.Start.String()), CameraID: camera, Start: previous, End: item.Start, State: "gap"})
		}
		if item.End.Before(item.Start) {
			item.State = "corrupt"
			item.End = item.Start
		}
		if item.Start.Before(previous) && item.End.After(previous) {
			item.Start = previous
		} // trim overlap deterministically
		if !item.End.Before(item.Start) {
			out = append(out, item)
		}
		if item.State != "corrupt" && item.End.After(previous) {
			previous = item.End
		}
	}
	return out
}

func (s *ShinobiSource) storeTimeline(key string, timeline Timeline) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for candidate, entry := range s.timelines {
		if time.Now().After(entry.until) {
			s.dropTimeline(candidate, entry)
		}
	}
	if len(s.timelines) >= maxDayCaches {
		var oldest string
		var until time.Time
		for candidate, entry := range s.timelines {
			if oldest == "" || entry.until.Before(until) {
				oldest, until = candidate, entry.until
			}
		}
		s.dropTimeline(oldest, s.timelines[oldest])
	}
	entry := cachedTimeline{until: time.Now().Add(cacheTTL), data: timeline}
	s.timelines[key] = entry
	for _, segment := range timeline.Segments {
		s.segments[segment.ID], s.indexExpiry[segment.ID] = segment, entry.until
	}
}

func (s *ShinobiSource) indexTimeline(entry cachedTimeline) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, segment := range entry.data.Segments {
		s.segments[segment.ID], s.indexExpiry[segment.ID] = segment, entry.until
	}
}

func (s *ShinobiSource) dropTimeline(key string, entry cachedTimeline) {
	delete(s.timelines, key)
	for _, segment := range entry.data.Segments {
		if expiry, ok := s.indexExpiry[segment.ID]; ok && !expiry.After(entry.until) {
			delete(s.segments, segment.ID)
			delete(s.indexExpiry, segment.ID)
		}
	}
}

func parseShinobiTime(raw string, loc *time.Location) (time.Time, bool) {
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05"} {
		if value, err := time.ParseInLocation(layout, raw, loc); err == nil {
			return value, true
		}
	}
	return time.Time{}, false
}

func opaqueID(camera, at, file string) string {
	sum := sha256.Sum256([]byte(camera + "\x00" + at + "\x00" + file))
	return hex.EncodeToString(sum[:16])
}

func (s *ShinobiSource) Events(ctx context.Context, from, to time.Time, camera string) ([]Event, error) {
	query := url.Values{"start": {shinobiBound(from)}, "end": {shinobiBound(to)}}
	res, err := s.request(ctx, "events", camera, query)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode/100 != 2 {
		return nil, fmt.Errorf("shinobi event request failed: %d", res.StatusCode)
	}
	var payload json.RawMessage
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return nil, err
	}
	rows, err := shinobiEventRows(payload)
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(rows))
	for _, event := range rows {
		if event.MID != "" && event.MID != camera {
			continue
		}
		at, ok := parseShinobiTime(event.Time, seoul)
		if !ok || at.Before(from) || at.After(to) {
			continue
		}
		var end *time.Time
		if parsed, ok := parseShinobiTime(event.End, seoul); ok {
			end = &parsed
		}
		out = append(out, Event{ID: opaqueEventID(camera, at, event.Details), CameraID: camera, At: at, End: end})
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	return out, nil
}

type shinobiEvent struct {
	MID     string          `json:"mid"`
	Time    string          `json:"time"`
	End     string          `json:"end"`
	Details json.RawMessage `json:"details"`
}

func shinobiEventRows(payload json.RawMessage) ([]shinobiEvent, error) {
	payload = bytes.TrimSpace(payload)
	var rows []shinobiEvent
	if len(payload) > 0 && payload[0] == '[' {
		return rows, json.Unmarshal(payload, &rows)
	}
	var envelope struct {
		Events json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, err
	}
	if envelope.Events == nil {
		return nil, fmt.Errorf("shinobi event response has no events")
	}
	return rows, json.Unmarshal(envelope.Events, &rows)
}

func opaqueEventID(camera string, at time.Time, details json.RawMessage) string {
	var value any
	if json.Unmarshal(details, &value) == nil {
		if encoded, err := json.Marshal(value); err == nil {
			details = encoded
		}
	}
	return opaqueID(camera, at.UTC().Format(time.RFC3339Nano), string(details))
}

func (s *ShinobiSource) Segment(id string) (Segment, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	segment, ok := s.segments[id]
	if ok && time.Now().After(s.indexExpiry[id]) {
		delete(s.segments, id)
		delete(s.indexExpiry, id)
		return Segment{}, false
	}
	return segment, ok
}
func (s *ShinobiSource) Capabilities(ctx context.Context, cameras []Camera, selected []string, from, to time.Time) (Capabilities, error) {
	byID := make(map[string]Camera, len(cameras))
	for _, camera := range cameras {
		byID[camera.ID] = camera
	}
	if len(selected) == 0 {
		return Capabilities{Motion: "unavailable", Message: "모션 데이터 사용 불가 · 카메라를 선택하세요"}, nil
	}
	for _, id := range selected {
		camera, ok := byID[id]
		if !ok || !camera.Detector {
			return Capabilities{Motion: "detector_off", Message: "모션 데이터 사용 불가 · detector off"}, nil
		}
		if _, err := s.Events(ctx, from, to, id); err != nil {
			return Capabilities{Motion: "unavailable", Message: "모션 데이터 사용 불가 · 이벤트 소스 확인 필요"}, nil
		}
	}
	return Capabilities{Motion: "available", Message: "모션 이벤트 사용 가능"}, nil
}
func (s *ShinobiSource) Ready(ctx context.Context) error { _, err := s.Cameras(ctx); return err }
