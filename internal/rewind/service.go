package rewind

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

//go:embed web/dist/*
var web embed.FS

type Service struct {
	config     Config
	source     Source
	client     *http.Client
	mu         sync.RWMutex
	allowed    map[string]struct{}
	liveMu     sync.Mutex
	live       map[string]liveAsset
	archive    *archiveStore
	archiveErr error
}

func NewService(c Config, source Source) *Service {
	if source == nil {
		if c.Demo {
			source = NewDemoSource()
		} else {
			source = NewShinobiSource(c)
		}
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = upstreamTimeout(c)
	transport.DialContext = (&net.Dialer{Timeout: upstreamTimeout(c)}).DialContext
	service := &Service{
		config: c, source: source, allowed: map[string]struct{}{},
		live:   map[string]liveAsset{},
		client: &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
	}
	if c.ArchiveRoot != "" {
		service.archive, service.archiveErr = newArchiveStore(c.ArchiveRoot, service)
	}
	return service
}

func (s *Service) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.HandleFunc("GET /api/v1/capabilities", s.capabilities)
	mux.HandleFunc("GET /api/v1/cameras", s.cameras)
	mux.HandleFunc("GET /api/v1/timeline", s.timeline)
	mux.HandleFunc("GET /api/v1/recording-summary", s.recordingSummary)
	mux.HandleFunc("GET /api/v1/events", s.events)
	mux.HandleFunc("GET /api/v1/videos/{id}", s.video)
	mux.HandleFunc("HEAD /api/v1/videos/{id}", s.video)
	mux.HandleFunc("GET /api/v1/live/capabilities", s.liveCapabilities)
	mux.HandleFunc("GET /api/v1/live/cameras", s.liveCameras)
	mux.HandleFunc("GET /api/v1/live/{camera}/playlist.m3u8", s.livePlaylist)
	mux.HandleFunc("GET /api/v1/live/{camera}/segments/{id}", s.liveSegment)
	mux.HandleFunc("HEAD /api/v1/live/{camera}/segments/{id}", s.liveSegment)
	mux.HandleFunc("POST /api/v1/archives", s.createArchive)
	mux.HandleFunc("GET /api/v1/archives", s.listArchives)
	mux.HandleFunc("GET /api/v1/archives/{id}", s.getArchive)
	mux.HandleFunc("GET /api/v1/archives/{id}/videos/{artifact}", s.archiveVideo)
	mux.HandleFunc("HEAD /api/v1/archives/{id}/videos/{artifact}", s.archiveVideo)
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/v1/archives") {
			w.Header().Set("Allow", "GET, HEAD, POST")
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		http.NotFound(w, r)
	})
	assets, _ := fs.Sub(web, "web/dist")
	mux.Handle("/", spa(assets))
	return logging(mux)
}

func (s *Service) capabilities(w http.ResponseWriter, r *http.Request) {
	cameras, err := s.source.Cameras(r.Context())
	if err != nil {
		apiError(w, err)
		return
	}
	s.setAllowed(cameras)
	selected := strings.Split(r.URL.Query().Get("cameras"), ",")
	if len(selected) == 1 && selected[0] == "" {
		selected = nil
	}
	for _, camera := range selected {
		if !s.allowedCamera(r.Context(), camera) {
			http.Error(w, "known cameras are required", http.StatusBadRequest)
			return
		}
	}
	day := time.Now().In(seoul)
	day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, seoul)
	capability, err := s.source.Capabilities(r.Context(), cameras, selected, day, day.AddDate(0, 0, 1))
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, capability)
}

func (s *Service) cameras(w http.ResponseWriter, r *http.Request) {
	cameras, err := s.source.Cameras(r.Context())
	if err != nil {
		apiError(w, err)
		return
	}
	s.setAllowed(cameras)
	writeJSON(w, http.StatusOK, cameras)
}

func (s *Service) ready(w http.ResponseWriter, r *http.Request) {
	if err := s.source.Ready(r.Context()); err != nil {
		http.Error(w, "upstream unavailable", http.StatusServiceUnavailable)
		return
	}
	if cameras, err := s.source.Cameras(r.Context()); err == nil {
		s.setAllowed(cameras)
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ready"})
}

func (s *Service) setAllowed(cameras []Camera) {
	allowed := make(map[string]struct{}, len(cameras))
	for _, camera := range cameras {
		allowed[camera.ID] = struct{}{}
	}
	s.mu.Lock()
	s.allowed = allowed
	s.mu.Unlock()
}

func (s *Service) allowedCamera(ctx context.Context, camera string) bool {
	if camera == "" {
		return false
	}
	s.mu.RLock()
	_, ok := s.allowed[camera]
	s.mu.RUnlock()
	if ok {
		return true
	}
	cameras, err := s.source.Cameras(ctx)
	if err != nil {
		return false
	}
	s.setAllowed(cameras)
	s.mu.RLock()
	_, ok = s.allowed[camera]
	s.mu.RUnlock()
	return ok
}

func (s *Service) timeline(w http.ResponseWriter, r *http.Request) {
	day, err := parseKSTDate(r.URL.Query().Get("date"))
	camera := r.URL.Query().Get("camera")
	if err != nil || !s.allowedCamera(r.Context(), camera) {
		http.Error(w, "valid date and known camera are required", http.StatusBadRequest)
		return
	}
	data, err := s.source.Timeline(r.Context(), day, camera)
	if err != nil {
		apiError(w, err)
		return
	}
	if data.Segments == nil {
		data.Segments = []Segment{}
	}
	writeJSON(w, http.StatusOK, data)
}

func parseKSTDate(raw string) (time.Time, error) {
	return time.ParseInLocation("2006-01-02", raw, seoul)
}

func (s *Service) recordingSummary(w http.ResponseWriter, r *http.Request) {
	from, fromErr := parseKSTDate(r.URL.Query().Get("from"))
	last, toErr := parseKSTDate(r.URL.Query().Get("to"))
	to := last.AddDate(0, 0, 1)
	cameras := strings.Split(r.URL.Query().Get("cameras"), ",")
	if fromErr != nil || toErr != nil || !to.After(from) || to.Sub(from) > 31*24*time.Hour || len(cameras) == 0 || len(cameras) > 6 {
		http.Error(w, "from/to must cover 1-31 KST days and 1-6 cameras are required", http.StatusBadRequest)
		return
	}
	seen := map[string]bool{}
	for _, camera := range cameras {
		if seen[camera] || !s.allowedCamera(r.Context(), camera) {
			http.Error(w, "known unique cameras are required", http.StatusBadRequest)
			return
		}
		seen[camera] = true
	}
	type result struct {
		camera   string
		segments []Segment
		err      error
	}
	results := make(chan result, len(cameras))
	for _, camera := range cameras {
		go func(camera string) {
			segments, err := s.source.Recordings(r.Context(), from, to, camera)
			results <- result{camera: camera, segments: segments, err: err}
		}(camera)
	}
	type states struct{ recorded, gap, corrupt map[string]struct{} }
	hours := map[string]*states{}
	failed := []string{}
	for range cameras {
		result := <-results
		if result.err != nil {
			failed = append(failed, result.camera)
			continue
		}
		for _, segment := range result.segments {
			cursor := segment.Start.In(seoul)
			cursor = time.Date(cursor.Year(), cursor.Month(), cursor.Day(), cursor.Hour(), 0, 0, 0, seoul)
			for cursor.Before(segment.End) && cursor.Before(to) {
				if segment.End.After(cursor) && segment.Start.Before(cursor.Add(time.Hour)) {
					key := cursor.Format("2006-01-02T15")
					state := hours[key]
					if state == nil {
						state = &states{recorded: map[string]struct{}{}, gap: map[string]struct{}{}, corrupt: map[string]struct{}{}}
						hours[key] = state
					}
					switch segment.State {
					case "recorded":
						state.recorded[result.camera] = struct{}{}
					case "gap":
						state.gap[result.camera] = struct{}{}
					case "corrupt":
						state.corrupt[result.camera] = struct{}{}
					}
				}
				cursor = cursor.Add(time.Hour)
			}
		}
	}
	sort.Strings(failed)
	days := make([]RecordingDay, 0, int(to.Sub(from)/(24*time.Hour)))
	for day := from; day.Before(to); day = day.AddDate(0, 0, 1) {
		summary := RecordingDay{Date: day.Format("2006-01-02"), Hours: make([]RecordingHour, 24)}
		for hour := 0; hour < 24; hour++ {
			state := hours[fmt.Sprintf("%sT%02d", summary.Date, hour)]
			summary.Hours[hour].Hour = hour
			if state != nil {
				summary.Hours[hour].Recorded = len(state.recorded)
				summary.Hours[hour].Gap = len(state.gap)
				summary.Hours[hour].Corrupt = len(state.corrupt)
			}
		}
		days = append(days, summary)
	}
	writeJSON(w, http.StatusOK, RecordingSummary{Days: days, CameraCount: len(cameras), FailedCameras: failed})
}

func (s *Service) events(w http.ResponseWriter, r *http.Request) {
	from, err := time.Parse(time.RFC3339, r.URL.Query().Get("from"))
	if err != nil {
		http.Error(w, "valid from is required", http.StatusBadRequest)
		return
	}
	to, err := time.Parse(time.RFC3339, r.URL.Query().Get("to"))
	camera := r.URL.Query().Get("camera")
	if err != nil || to.Before(from) || to.Sub(from) > 24*time.Hour || !s.allowedCamera(r.Context(), camera) {
		http.Error(w, "to must be within 24 hours and camera must be known", http.StatusBadRequest)
		return
	}
	events, err := s.source.Events(r.Context(), from.In(seoul), to.In(seoul), camera)
	if err != nil {
		apiError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, events)
}

func (s *Service) video(w http.ResponseWriter, r *http.Request) {
	segment, ok := s.source.Segment(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	if segment.State != "recorded" || segment.Source == "" {
		http.Error(w, "segment is unavailable", http.StatusUnprocessableEntity)
		return
	}
	upstream, err := url.Parse(segment.Source)
	if err != nil || !upstream.IsAbs() || !s.trustedVideoURL(upstream) {
		http.Error(w, "segment is malformed", http.StatusUnprocessableEntity)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, upstream.String(), nil)
	if err != nil {
		http.Error(w, "segment request failed", http.StatusBadGateway)
		return
	}
	for _, header := range []string{"Range", "If-Range"} {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}
	response, err := s.client.Do(req)
	if err != nil {
		http.Error(w, "segment unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		http.Error(w, "segment redirect rejected", http.StatusBadGateway)
		return
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent && response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		http.Error(w, "segment is unplayable", http.StatusUnprocessableEntity)
		return
	}
	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, response.Body)
	}
}

func (s *Service) trustedVideoURL(candidate *url.URL) bool {
	if s.config.ShinobiURL == nil {
		return true
	} // tests inject a local upstream; live mode is always pinned below.
	trusted := s.config.ShinobiURL
	return candidate.Scheme == trusted.Scheme && candidate.Host == trusted.Host && candidate.User == nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
func apiError(w http.ResponseWriter, err error) {
	_ = json.NewEncoder(log.Writer()).Encode(map[string]string{"message": "upstream request failed", "error_type": fmt.Sprintf("%T", err)})
	http.Error(w, "upstream unavailable", http.StatusBadGateway)
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(data []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(data)
}
func logging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		wrapped := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(wrapped, r)
		if wrapped.status == 0 {
			wrapped.status = http.StatusOK
		}
		_ = json.NewEncoder(log.Writer()).Encode(map[string]any{"method": r.Method, "route": r.Pattern, "status": wrapped.status, "duration_ms": time.Since(started).Milliseconds()})
	})
}

func spa(assets fs.FS) http.Handler {
	files := http.FileServer(http.FS(assets))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			if file, err := assets.Open(strings.TrimPrefix(r.URL.Path, "/")); err == nil {
				file.Close()
				files.ServeHTTP(w, r)
				return
			}
		}
		r.URL.Path = "/"
		files.ServeHTTP(w, r)
	})
}

var _ = context.Background
