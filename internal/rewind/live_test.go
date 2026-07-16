package rewind

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

var proxiedLivePath = regexp.MustCompile(`/api/v1/live/CAM-1/segments/[0-9a-f]{32}`)

func liveTestService(t *testing.T, upstream http.Handler) (*Service, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(upstream)
	base, err := url.Parse(server.URL)
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(Config{
		ShinobiURL: base, ShinobiKey: "sensitive-api-key", ShinobiGroup: "private-group", ShinobiLowChannel: "0", HeaderTimeout: time.Second,
	}, testSource{cameras: []Camera{{ID: "CAM-1"}, {ID: "CAM-2"}}})
	return service, server
}

func TestLiveHLSProxyRewritesNestedAssetsAndStreamsOpaqueSegment(t *testing.T) {
	var segmentRange string
	var segmentIfRange string
	var requested []string
	service, upstream := liveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requested = append(requested, r.URL.RequestURI())
		switch path := r.URL.Path; {
		case strings.HasSuffix(path, "/s.m3u8"):
			w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8?upstream=secret\n")
		case strings.HasSuffix(path, "/variant.m3u8"):
			_, _ = io.WriteString(w, "#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI=\"key.bin\"\n#EXT-X-MAP:URI=\"init.mp4\"\n#EXTINF:2,\nchunk.ts?upstream=secret\n")
		case strings.HasSuffix(path, "/chunk.ts"):
			segmentRange = r.Header.Get("Range")
			segmentIfRange = r.Header.Get("If-Range")
			w.Header().Set("Content-Type", "video/mp2t")
			w.Header().Set("Content-Range", "bytes 2-6/7")
			w.Header().Set("Set-Cookie", "upstream=secret")
			w.Header().Set("Location", "https://example.invalid/leak")
			if r.Method == http.MethodHead {
				w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
				return
			}
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "frame")
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	var logs strings.Builder
	previousLog := log.Writer()
	log.SetOutput(&logs)
	t.Cleanup(func() { log.SetOutput(previousLog) })

	playlist := httptest.NewRecorder()
	service.Handler().ServeHTTP(playlist, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8?quality=high", nil))
	if playlist.Code != http.StatusOK || playlist.Header().Get("Content-Type") != "application/vnd.apple.mpegurl" {
		t.Fatalf("playlist status/content-type = %d %q body=%q upstream=%v", playlist.Code, playlist.Header().Get("Content-Type"), playlist.Body.String(), requested)
	}
	variantPath := proxiedLivePath.FindString(playlist.Body.String())
	if variantPath == "" || strings.Contains(playlist.Body.String(), upstream.URL) || strings.Contains(playlist.Body.String(), "sensitive-api-key") || strings.Contains(playlist.Body.String(), "variant.m3u8") {
		t.Fatalf("playlist was not safely rewritten: %q", playlist.Body.String())
	}

	variant := httptest.NewRecorder()
	service.Handler().ServeHTTP(variant, httptest.NewRequest(http.MethodGet, variantPath, nil))
	paths := proxiedLivePath.FindAllString(variant.Body.String(), -1)
	if variant.Code != http.StatusOK || len(paths) != 3 || strings.Contains(variant.Body.String(), "upstream=secret") {
		t.Fatalf("nested playlist = %d %q", variant.Code, variant.Body.String())
	}

	segment := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, paths[2], nil)
	request.Header.Set("Range", "bytes=2-6")
	request.Header.Set("If-Range", "version")
	service.Handler().ServeHTTP(segment, request)
	if segment.Code != http.StatusPartialContent || segment.Body.String() != "frame" || segmentRange != "bytes=2-6" || segmentIfRange != "version" || segment.Header().Get("Set-Cookie") != "" || segment.Header().Get("Location") != "" {
		t.Fatalf("segment status/body/range = %d %q %q %q", segment.Code, segment.Body.String(), segmentRange, segmentIfRange)
	}
	head := httptest.NewRecorder()
	service.Handler().ServeHTTP(head, httptest.NewRequest(http.MethodHead, paths[2], nil))
	if head.Code != http.StatusRequestedRangeNotSatisfiable || head.Body.Len() != 0 || head.Header().Get("Content-Range") != "bytes 2-6/7" {
		t.Fatalf("segment HEAD status/body/range = %d %q %q", head.Code, head.Body.String(), head.Header().Get("Content-Range"))
	}

	wrongCamera := httptest.NewRecorder()
	service.Handler().ServeHTTP(wrongCamera, httptest.NewRequest(http.MethodGet, strings.Replace(paths[2], "CAM-1", "CAM-2", 1), nil))
	if wrongCamera.Code != http.StatusNotFound {
		t.Fatalf("cross-camera token status = %d", wrongCamera.Code)
	}
	if strings.Contains(logs.String(), upstream.URL) || strings.Contains(logs.String(), "sensitive-api-key") || strings.Contains(logs.String(), "private-group") {
		t.Fatalf("logs exposed upstream credentials: %q", logs.String())
	}
}

func TestLiveHLSProxyRejectsUnsafeAndOversizedPlaylists(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{name: "external host", body: "#EXTM3U\nhttps://example.invalid/chunk.ts\n"},
		{name: "parent traversal", body: "#EXTM3U\n../chunk.ts\n"},
		{name: "encoded traversal", body: "#EXTM3U\n%252e%252e/chunk.ts\n"},
		{name: "oversized", body: "#EXTM3U\n" + strings.Repeat("x", maxPlaylistLen)},
	} {
		t.Run(test.name, func(t *testing.T) {
			service, upstream := liveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, _ = io.WriteString(w, test.body)
			}))
			defer upstream.Close()
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8", nil))
			if response.Code != http.StatusBadGateway || strings.Contains(response.Body.String(), upstream.URL) || strings.Contains(response.Body.String(), "sensitive-api-key") {
				t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
			}
		})
	}

	service, redirect := liveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://example.invalid/stream.m3u8", http.StatusFound)
	}))
	defer redirect.Close()
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8", nil))
	if response.Code != http.StatusBadGateway {
		t.Fatalf("redirect status = %d", response.Code)
	}

	service, forbidden := liveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "upstream detail must not pass through", http.StatusUnauthorized)
	}))
	defer forbidden.Close()
	response = httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8", nil))
	if response.Code != http.StatusForbidden || strings.Contains(response.Body.String(), "upstream detail") {
		t.Fatalf("forbidden status/body = %d %q", response.Code, response.Body.String())
	}
}

func TestLiveHLSProxyHonorsAllowlistQualityAndCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	var once sync.Once
	service, upstream := liveTestService(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/s.m3u8") {
			_, _ = io.WriteString(w, "#EXTM3U\nslow.ts\n")
			return
		}
		close(started)
		<-r.Context().Done()
		once.Do(func() { close(cancelled) })
	}))
	defer upstream.Close()

	for raw, want := range map[string]int{
		"/api/v1/live/unknown/playlist.m3u8":              http.StatusNotFound,
		"/api/v1/live/CAM-1/playlist.m3u8?quality=medium": http.StatusUnprocessableEntity,
	} {
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, raw, nil))
		if response.Code != want {
			t.Fatalf("%s status = %d, want %d", raw, response.Code, want)
		}
	}

	playlist := httptest.NewRecorder()
	service.Handler().ServeHTTP(playlist, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8", nil))
	segmentPath := proxiedLivePath.FindString(playlist.Body.String())
	service.liveMu.Lock()
	for id, asset := range service.live {
		asset.expires = time.Now().Add(-time.Second)
		service.live[id] = asset
	}
	service.liveMu.Unlock()
	expired := httptest.NewRecorder()
	service.Handler().ServeHTTP(expired, httptest.NewRequest(http.MethodGet, segmentPath, nil))
	if expired.Code != http.StatusNotFound {
		t.Fatalf("expired token status = %d", expired.Code)
	}

	playlist = httptest.NewRecorder()
	service.Handler().ServeHTTP(playlist, httptest.NewRequest(http.MethodGet, "/api/v1/live/CAM-1/playlist.m3u8", nil))
	segmentPath = proxiedLivePath.FindString(playlist.Body.String())
	ctx, cancel := context.WithCancel(context.Background())
	request := httptest.NewRequest(http.MethodGet, segmentPath, nil).WithContext(ctx)
	done := make(chan struct{})
	go func() {
		service.Handler().ServeHTTP(httptest.NewRecorder(), request)
		close(done)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("live segment request did not start")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("upstream did not observe cancellation")
	}
	<-done
}

type liveMetadataSource struct {
	testSource
	timelines map[string]Timeline
	errors    map[string]error
}

func (s liveMetadataSource) Timeline(_ context.Context, day time.Time, camera string) (Timeline, error) {
	if err := s.errors[camera]; err != nil {
		return Timeline{}, err
	}
	return s.timelines[camera+"\x00"+day.Format("2006-01-02")], nil
}

func TestLiveMetadataUsesOnlyCompletedRecordedSegments(t *testing.T) {
	now := time.Now().In(seoul)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoul)
	yesterday := today.AddDate(0, 0, -1)
	audio := true
	source := liveMetadataSource{
		testSource: testSource{cameras: []Camera{{ID: "CAM-1", Name: "Gate"}, {ID: "CAM-2", Name: "Yard"}, {ID: "CAM-3", Name: "Empty"}, {ID: "CAM-4", Name: "Failed"}}},
		timelines: map[string]Timeline{
			"CAM-1\x00" + today.Format("2006-01-02"): {CameraID: "CAM-1", Segments: []Segment{
				{CameraID: "CAM-1", Start: today, End: today.Add(time.Minute), State: "recorded", HasAudio: &audio},
				{CameraID: "CAM-1", Start: now.Add(-time.Minute), End: now.Add(time.Minute), State: "recorded", HasAudio: &audio},
				{CameraID: "CAM-1", Start: today.Add(2 * time.Minute), End: today.Add(3 * time.Minute), State: "corrupt", HasAudio: &audio},
			}},
			"CAM-2\x00" + yesterday.Format("2006-01-02"): {CameraID: "CAM-2", Segments: []Segment{
				{CameraID: "CAM-2", Start: yesterday, End: yesterday.Add(time.Minute), State: "recorded"},
			}},
		},
		errors: map[string]error{"CAM-4": context.DeadlineExceeded},
	}
	service := NewService(Config{}, source)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/cameras", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status/body = %d %q", response.Code, response.Body.String())
	}
	var cameras []struct {
		ID               string     `json:"id"`
		HasAudio         *bool      `json:"hasAudio"`
		LatestRecordedAt *time.Time `json:"latestRecordedAt"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &cameras); err != nil {
		t.Fatal(err)
	}
	if len(cameras) != 4 || cameras[0].HasAudio == nil || !*cameras[0].HasAudio || cameras[0].LatestRecordedAt == nil || cameras[1].LatestRecordedAt == nil || cameras[2].LatestRecordedAt != nil || cameras[3].LatestRecordedAt != nil {
		t.Fatalf("live cameras = %#v", cameras)
	}
	if want := today.Add(time.Minute).Add(-time.Millisecond); !cameras[0].LatestRecordedAt.Equal(want) {
		t.Fatalf("latest completed timestamp = %s, want %s", cameras[0].LatestRecordedAt, want)
	}
}

func TestLiveCapabilitiesAndRegistryBound(t *testing.T) {
	service, upstream := liveTestService(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer upstream.Close()
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/capabilities", nil))
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"lowQuality":true`) || !strings.Contains(response.Body.String(), `"transport":"hls"`) {
		t.Fatalf("capabilities = %d %q", response.Code, response.Body.String())
	}

	_, root, err := service.liveURLs("CAM-1", "high")
	if err != nil {
		t.Fatal(err)
	}
	low, lowRoot, err := service.liveURLs("CAM-1", "low")
	if err != nil || !strings.HasSuffix(low.Path, "/CAM-1/0/s.m3u8") || !strings.HasSuffix(lowRoot.Path, "/CAM-1/0") {
		t.Fatalf("low live URL = %v, root = %v, err = %v", low, lowRoot, err)
	}
	service.liveMu.Lock()
	for i := 0; i < maxLiveAssets; i++ {
		service.live[fmt.Sprintf("%032x", i)] = liveAsset{camera: "CAM-1", upstream: root.JoinPath("old.ts"), root: root, expires: time.Now().Add(time.Hour + time.Duration(i))}
	}
	service.liveMu.Unlock()
	if _, err := service.registerLiveAsset("CAM-1", root.JoinPath("s.m3u8"), root, "new.ts"); err != nil {
		t.Fatal(err)
	}
	service.liveMu.Lock()
	count := len(service.live)
	service.liveMu.Unlock()
	if count != maxLiveAssets {
		t.Fatalf("registry size = %d, want %d", count, maxLiveAssets)
	}

	demo := NewService(Config{Demo: true}, testSource{cameras: []Camera{{ID: "CAM-1"}}})
	response = httptest.NewRecorder()
	demo.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/capabilities", nil))
	if !strings.Contains(response.Body.String(), `"transport":null`) {
		t.Fatalf("demo capabilities = %q", response.Body.String())
	}
}

func TestDedicatedLiveBridgeUsesSeparateHighAndLowPaths(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer upstream.Close()
	base, err := url.Parse(upstream.URL + "/hls")
	if err != nil {
		t.Fatal(err)
	}
	service := NewService(Config{LiveHLSURL: base}, testSource{cameras: []Camera{{ID: "CAM-1"}}})
	high, highRoot, err := service.liveURLs("CAM-1", "high")
	if err != nil || !strings.HasSuffix(high.Path, "/hls/cam-1_high/index.m3u8") || !strings.HasSuffix(highRoot.Path, "/hls/cam-1_high") {
		t.Fatalf("high live URL = %v, root = %v, err = %v", high, highRoot, err)
	}
	low, lowRoot, err := service.liveURLs("CAM-1", "low")
	if err != nil || !strings.HasSuffix(low.Path, "/hls/cam-1_low/index.m3u8") || !strings.HasSuffix(lowRoot.Path, "/hls/cam-1_low") {
		t.Fatalf("low live URL = %v, root = %v, err = %v", low, lowRoot, err)
	}
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/live/capabilities", nil))
	if !strings.Contains(response.Body.String(), `"lowQuality":true`) {
		t.Fatalf("capabilities = %q", response.Body.String())
	}
}
