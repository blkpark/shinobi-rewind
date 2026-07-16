package rewind

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"
)

type testSource struct {
	segment Segment
	cameras []Camera
	ready   error
}

func (t testSource) Cameras(context.Context) ([]Camera, error) { return t.cameras, nil }
func (t testSource) Timeline(_ context.Context, day time.Time, camera string) (Timeline, error) {
	return Timeline{CameraID: camera, Segments: []Segment{{ID: "day", CameraID: camera, Start: day, End: day.Add(time.Minute), State: "recorded"}}}, nil
}
func (t testSource) Events(context.Context, time.Time, time.Time, string) ([]Event, error) {
	return nil, nil
}
func (t testSource) Segment(id string) (Segment, bool) { return t.segment, id == t.segment.ID }
func (t testSource) Capabilities(context.Context, []Camera, []string, time.Time, time.Time) (Capabilities, error) {
	return Capabilities{Motion: "detector_off"}, nil
}
func (t testSource) Ready(context.Context) error { return t.ready }

func newTestService(segment Segment) *Service {
	return NewService(Config{HeaderTimeout: time.Second}, testSource{segment: segment, cameras: []Camera{{ID: "CAM-1"}}})
}

func TestDroppingOldTimelineKeepsNewerSegmentIndex(t *testing.T) {
	segment := Segment{ID: "shared", State: "recorded"}
	old := cachedTimeline{until: time.Now().Add(time.Minute), data: Timeline{Segments: []Segment{segment}}}
	newer := cachedTimeline{until: old.until.Add(time.Minute), data: Timeline{Segments: []Segment{segment}}}
	source := &ShinobiSource{
		segments:    map[string]Segment{},
		indexExpiry: map[string]time.Time{},
		timelines:   map[string]cachedTimeline{"old": old, "new": newer},
	}
	source.indexTimeline(newer)
	source.dropTimeline("old", old)
	if _, ok := source.Segment(segment.ID); !ok {
		t.Fatal("newer timeline segment was removed with the old cache entry")
	}
}

func TestVideoProxyForwardsRangeIfRangeAndStreamingStatus(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Range"); got != "bytes=2-4" {
			t.Errorf("range = %q", got)
		}
		if got := r.Header.Get("If-Range"); got != "version" {
			t.Errorf("if-range = %q", got)
		}
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Range", "bytes 2-4/6")
		w.Header().Set("ETag", "version")
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte("cde"))
	}))
	defer upstream.Close()
	s := newTestService(Segment{ID: "safe", State: "recorded", Source: upstream.URL})
	req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/safe", nil)
	req.Header.Set("Range", "bytes=2-4")
	req.Header.Set("If-Range", "version")
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, req)
	if res.Code != http.StatusPartialContent || res.Header().Get("Content-Range") != "bytes 2-4/6" {
		t.Fatalf("status/headers = %d %q", res.Code, res.Header().Get("Content-Range"))
	}
	body, _ := io.ReadAll(res.Result().Body)
	if string(body) != "cde" {
		t.Fatalf("body = %q", body)
	}
}

func TestVideoProxyHead200And416(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusRequestedRangeNotSatisfiable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodHead {
					t.Errorf("method = %s", r.Method)
				}
				w.Header().Set("Content-Range", "bytes */6")
				w.WriteHeader(status)
				_, _ = w.Write([]byte("not forwarded"))
			}))
			defer upstream.Close()
			s := newTestService(Segment{ID: "safe", State: "recorded", Source: upstream.URL})
			res := httptest.NewRecorder()
			s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodHead, "/api/v1/videos/safe", nil))
			if res.Code != status || res.Body.Len() != 0 {
				t.Fatalf("status/body = %d %q", res.Code, res.Body.String())
			}
		})
	}
}

func TestVideoProxyRejectsRedirectAndCancelsUpstream(t *testing.T) {
	t.Run("redirect", func(t *testing.T) {
		redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://example.invalid/video", http.StatusFound)
		}))
		defer redirect.Close()
		res := httptest.NewRecorder()
		newTestService(Segment{ID: "safe", State: "recorded", Source: redirect.URL}).Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/videos/safe", nil))
		if res.Code != http.StatusBadGateway {
			t.Fatalf("status = %d", res.Code)
		}
	})
	t.Run("cancel", func(t *testing.T) {
		started := make(chan struct{})
		cancelled := make(chan struct{})
		var once sync.Once
		upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			close(started)
			<-r.Context().Done()
			once.Do(func() { close(cancelled) })
		}))
		defer upstream.Close()
		ctx, cancel := context.WithCancel(context.Background())
		req := httptest.NewRequest(http.MethodGet, "/api/v1/videos/safe", nil).WithContext(ctx)
		go newTestService(Segment{ID: "safe", State: "recorded", Source: upstream.URL}).Handler().ServeHTTP(httptest.NewRecorder(), req)
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatal("upstream did not start")
		}
		cancel()
		select {
		case <-cancelled:
		case <-time.After(time.Second):
			t.Fatal("upstream did not observe client cancellation")
		}
	})
}

func TestKSTBoundaryAndAllowlist(t *testing.T) {
	day, err := parseKSTDate("2026-07-15")
	if err != nil {
		t.Fatal(err)
	}
	if got := day.Format(time.RFC3339); got != "2026-07-15T00:00:00+09:00" {
		t.Fatalf("date = %s", got)
	}
	s := NewService(Config{}, testSource{cameras: []Camera{{ID: "CAM-1"}}})
	for _, raw := range []string{"/api/v1/timeline?date=2026-07-15&camera=CAM-1", "/api/v1/timeline?date=2026-07-15&camera=unknown"} {
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, raw, nil))
		if strings.Contains(raw, "unknown") && res.Code != http.StatusBadRequest {
			t.Fatalf("unknown camera status = %d", res.Code)
		}
		if !strings.Contains(raw, "unknown") && res.Code != http.StatusOK {
			t.Fatalf("known camera status = %d", res.Code)
		}
	}
	for _, raw := range []string{
		"/api/v1/events?from=2026-07-14T15:00:00Z&to=2026-07-15T15:00:00Z&camera=CAM-1",
		"/api/v1/events?from=2026-07-14T14:59:59Z&to=2026-07-15T15:00:00Z&camera=CAM-1",
	} {
		res := httptest.NewRecorder()
		s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, raw, nil))
		if strings.Contains(raw, "14:59") && res.Code != http.StatusBadRequest {
			t.Fatalf("over 24h status = %d", res.Code)
		}
		if !strings.Contains(raw, "14:59") && res.Code != http.StatusOK {
			t.Fatalf("boundary status = %d", res.Code)
		}
	}
}

func TestCapabilitiesWithoutCameraDoesNotPanic(t *testing.T) {
	s := NewService(Config{}, testSource{cameras: []Camera{{ID: "CAM-1"}}})
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/v1/capabilities", nil))
	if res.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %q", res.Code, res.Body.String())
	}
}

func TestShinobiRouteEnvelopeAndIndexContract(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.URL.RequestURI())
		switch {
		case strings.Contains(r.URL.Path, "/monitor/"):
			_, _ = w.Write([]byte(`[{"mid":"CAM-1","name":"Gate","details":"{\"detector\":\"1\"}"}]`))
		case strings.Contains(r.URL.Path, "/videos/"):
			_, _ = w.Write([]byte(`{"videos":[{"mid":"CAM-1","time":"2026-07-15T00:00:00","end":"2026-07-15T00:10:00","filename":"one.mp4"},{"mid":"CAM-1","time":"2026-07-15T00:10:20","end":"2026-07-15T00:10:30","filename":"two.mp4"},{"mid":"CAM-1","time":"bad","end":"bad","filename":"bad.mp4"},{"mid":"CAM-1","time":"2026-07-15T00:10:20","end":"2026-07-15T00:10:30","filename":"two.mp4"}]}`))
		case strings.Contains(r.URL.Path, "/events/"):
			_, _ = w.Write([]byte(`[{"mid":"CAM-1","time":"2026-07-15T00:10:22","details":{"plug":"motion","score":2}}]`))
		}
	}))
	defer server.Close()
	base, _ := url.Parse(server.URL)
	source := NewShinobiSource(Config{ShinobiURL: base, ShinobiKey: "api-key", ShinobiGroup: "group", HeaderTimeout: time.Second})
	if cameras, err := source.Cameras(context.Background()); err != nil || len(cameras) != 1 || !cameras[0].Detector {
		t.Fatalf("cameras = %#v, %v", cameras, err)
	}
	day, _ := parseKSTDate("2026-07-15")
	if capability, err := source.Capabilities(context.Background(), []Camera{{ID: "CAM-1", Detector: true}}, []string{"CAM-1"}, day, day.AddDate(0, 0, 1)); err != nil || capability.Motion != "available" {
		t.Fatalf("capability = %#v, %v", capability, err)
	}
	timeline, err := source.Timeline(context.Background(), day, "CAM-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(timeline.Segments) != 4 || timeline.Segments[1].State != "gap" || timeline.Segments[3].State != "corrupt" {
		t.Fatalf("segments = %#v", timeline.Segments)
	}
	events, err := source.Events(context.Background(), day, day.Add(24*time.Hour), "CAM-1")
	if err != nil || len(events) != 1 || events[0].ID == "" || events[0].End != nil {
		t.Fatalf("events = %#v, %v", events, err)
	}
	encoded, _ := json.Marshal(events)
	if strings.Contains(string(encoded), `"end"`) {
		t.Fatalf("point event contains end: %s", encoded)
	}
	joined := strings.Join(requests, "\n")
	if !strings.Contains(joined, "/api-key/videos/group/CAM-1?end=2026-07-16T00%3A00%3A00&endIsStartTo=1&start=2026-07-15T00%3A00%3A00") {
		t.Fatalf("video route/query = %s", joined)
	}
	if !strings.Contains(joined, "/api-key/events/group/CAM-1?end=2026-07-16T00%3A00%3A00&start=2026-07-15T00%3A00%3A00") {
		t.Fatalf("event route/query = %s", joined)
	}
}

func TestDetectorRequiresDetectorFlag(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want bool
	}{
		{`{"detector":"1"}`, true},
		{`{"detector":"on"}`, true},
		{`{"detector":"0","detector_trigger":"1","detector_save":"1"}`, false},
		{`{"detector_save":"1"}`, false},
	} {
		if got := detectorEnabled(json.RawMessage(test.raw)); got != test.want {
			t.Fatalf("detectorEnabled(%s) = %v, want %v", test.raw, got, test.want)
		}
	}
}

func TestExplicitAudioMetadataNeverGuesses(t *testing.T) {
	for _, test := range []struct {
		raw  string
		want *bool
	}{
		{`{"hasAudio":true}`, boolPointer(true)},
		{`"{\"audio\":\"0\"}"`, boolPointer(false)},
		{`{"audio_codec":"aac"}`, boolPointer(true)},
		{`{"unrelated":"value"}`, nil},
		{`bad`, nil},
	} {
		got := explicitAudio(json.RawMessage(test.raw))
		if (got == nil) != (test.want == nil) || got != nil && *got != *test.want {
			t.Fatalf("explicitAudio(%s) = %v, want %v", test.raw, got, test.want)
		}
	}
}

func boolPointer(value bool) *bool { return &value }

func TestEventsAcceptRawRowsAndLegacyEnvelopeWithStableOpaqueIDs(t *testing.T) {
	var opaque string
	for _, payload := range []string{
		`[{"mid":"CAM-1","time":"2026-07-15T00:10:22","details":{"score":2,"plug":"motion"}}]`,
		`{"events":[{"id":"legacy","mid":"CAM-1","time":"2026-07-15T00:10:22","details":{"plug":"motion","score":2},"end":"2026-07-15T00:10:24"}]}`,
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(payload)) }))
		base, _ := url.Parse(server.URL)
		source := NewShinobiSource(Config{ShinobiURL: base, ShinobiKey: "api-key", ShinobiGroup: "group"})
		from, _ := time.Parse(time.RFC3339, "2026-07-14T15:00:00Z")
		events, err := source.Events(context.Background(), from, from.Add(time.Hour), "CAM-1")
		server.Close()
		if err != nil || len(events) != 1 || events[0].ID == "legacy" {
			t.Fatalf("events = %#v, %v", events, err)
		}
		if opaque == "" {
			opaque = events[0].ID
		} else if events[0].ID != opaque {
			t.Fatalf("opaque ID changed: %q != %q", events[0].ID, opaque)
		}
		if payload[0] == '[' && events[0].End != nil {
			t.Fatalf("raw event invented end: %#v", events[0])
		}
	}
}

func TestDemoTimelineOrdering(t *testing.T) {
	demo := NewDemoSource()
	day := time.Now().In(seoul)
	day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, seoul)
	timeline, err := demo.Timeline(context.Background(), day, "CAM-201")
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < len(timeline.Segments); i++ {
		if timeline.Segments[i].Start.Before(timeline.Segments[i-1].Start) {
			t.Fatalf("segments not ordered: %#v", timeline.Segments)
		}
	}
}

func TestStrictDemoAndReadiness(t *testing.T) {
	if _, err := parseDemo("yes"); err == nil {
		t.Fatal("accepted invalid DEMO_MODE")
	}
	if enabled, err := parseDemo("false"); err != nil || enabled {
		t.Fatalf("false = %v %v", enabled, err)
	}
	s := NewService(Config{Demo: false}, testSource{ready: context.DeadlineExceeded})
	res := httptest.NewRecorder()
	s.Handler().ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if res.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready status = %d", res.Code)
	}
}
