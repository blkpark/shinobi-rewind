package rewind

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

type archiveTestSource struct {
	cameras   []Camera
	timelines map[string]Timeline
}

func mp4Payload(marker string) []byte {
	ftyp := []byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0}
	moov := []byte{0, 0, 0, 16, 'm', 'o', 'o', 'v', 0, 0, 0, 8, 'f', 'r', 'e', 'e'}
	free := make([]byte, 8+len(marker))
	binary.BigEndian.PutUint32(free[:4], uint32(len(free)))
	copy(free[4:8], "free")
	copy(free[8:], marker)
	return append(append(ftyp, moov...), free...)
}

func mp4WithoutMoov() []byte {
	return []byte{0, 0, 0, 16, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm', 0, 0, 0, 0}
}

func serveMP4(payload []byte) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		_, _ = w.Write(payload)
	}
}

func (s archiveTestSource) Cameras(context.Context) ([]Camera, error) { return s.cameras, nil }
func (s archiveTestSource) Timeline(_ context.Context, day time.Time, camera string) (Timeline, error) {
	return s.timelines[day.Format("2006-01-02")+"\x00"+camera], nil
}
func (s archiveTestSource) Events(context.Context, time.Time, time.Time, string) ([]Event, error) {
	return nil, nil
}
func (s archiveTestSource) Segment(string) (Segment, bool) { return Segment{}, false }
func (s archiveTestSource) Capabilities(context.Context, []Camera, []string, time.Time, time.Time) (Capabilities, error) {
	return Capabilities{}, nil
}
func (s archiveTestSource) Ready(context.Context) error { return nil }

func postArchive(t *testing.T, service *Service, body string) (int, Archive) {
	t.Helper()
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/v1/archives", strings.NewReader(body)))
	var item Archive
	if response.Code == http.StatusOK || response.Code == http.StatusAccepted {
		if err := json.Unmarshal(response.Body.Bytes(), &item); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, item
}

func waitArchive(t *testing.T, service *Service, id string, statuses ...string) Archive {
	t.Helper()
	wanted := map[string]bool{}
	for _, status := range statuses {
		wanted[status] = true
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		response := httptest.NewRecorder()
		service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/archives/"+id, nil))
		if response.Code == http.StatusOK {
			var item Archive
			if err := json.Unmarshal(response.Body.Bytes(), &item); err != nil {
				t.Fatal(err)
			}
			if wanted[item.Status] {
				return item
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("archive %s did not reach %v", id, statuses)
	return Archive{}
}

func TestArchiveCopiesCompletedSegmentIdempotentlyAndServesRange(t *testing.T) {
	video := mp4Payload("video")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "video/mp4")
		w.Header().Set("Content-Length", "45")
		_, _ = w.Write(video)
	}))
	defer upstream.Close()
	day := time.Date(2026, 7, 15, 0, 0, 0, 0, seoul)
	source := archiveTestSource{
		cameras:   []Camera{{ID: "CAM-1"}},
		timelines: map[string]Timeline{"2026-07-15\x00CAM-1": {CameraID: "CAM-1", Segments: []Segment{{ID: "source-secret", CameraID: "CAM-1", Start: day, End: day.Add(15 * time.Minute), State: "recorded", Source: upstream.URL + "/private/original.mp4?key=secret"}}}},
	}
	root := t.TempDir()
	service := NewService(Config{ArchiveRoot: root, HeaderTimeout: time.Second}, source)
	body := `{"at":"2026-07-15T00:05:00+09:00","cameraIds":["CAM-1"],"label":"Gate"}`
	status, created := postArchive(t, service, body)
	if status != http.StatusAccepted || created.ID == "" {
		t.Fatalf("create = %d %#v", status, created)
	}
	item := waitArchive(t, service, created.ID, "verified")
	if len(item.Artifacts) != 1 || item.Artifacts[0].Size != int64(len(video)) || len(item.Artifacts[0].SHA256) != 64 {
		t.Fatalf("artifact = %#v", item.Artifacts)
	}
	serialized, _ := json.Marshal(item)
	for _, secret := range []string{"source-secret", "private", "original.mp4", "secret", root} {
		if bytes.Contains(serialized, []byte(secret)) {
			t.Fatalf("response exposed %q: %s", secret, serialized)
		}
	}
	status, duplicate := postArchive(t, service, `{"at":"2026-07-14T15:05:00Z","cameraIds":["CAM-1"],"label":"changed"}`)
	if status != http.StatusOK || duplicate.ID != created.ID {
		t.Fatalf("idempotent create = %d %s, want %s", status, duplicate.ID, created.ID)
	}

	artifact := item.Artifacts[0]
	rangeResponse := httptest.NewRecorder()
	rangeRequest := httptest.NewRequest(http.MethodGet, artifact.VideoURL, nil)
	rangeRequest.Header.Set("Range", "bytes=4-7")
	service.Handler().ServeHTTP(rangeResponse, rangeRequest)
	if rangeResponse.Code != http.StatusPartialContent || rangeResponse.Body.String() != "ftyp" || rangeResponse.Header().Get("Content-Range") != "bytes 4-7/45" {
		t.Fatalf("range = %d %q %q", rangeResponse.Code, rangeResponse.Body.String(), rangeResponse.Header().Get("Content-Range"))
	}
	head := httptest.NewRecorder()
	service.Handler().ServeHTTP(head, httptest.NewRequest(http.MethodHead, artifact.VideoURL, nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != "45" {
		t.Fatalf("head = %d %q %#v", head.Code, head.Body.String(), head.Header())
	}
	if _, err := os.Stat(service.archive.artifactPath(item.ID, artifact.ID) + ".part"); !os.IsNotExist(err) {
		t.Fatalf("partial file remains: %v", err)
	}
	restarted := NewService(Config{ArchiveRoot: root, HeaderTimeout: time.Second}, source)
	restartedResponse := httptest.NewRecorder()
	restarted.Handler().ServeHTTP(restartedResponse, httptest.NewRequest(http.MethodGet, artifact.VideoURL, nil))
	if restartedResponse.Code != http.StatusOK || !bytes.Equal(restartedResponse.Body.Bytes(), video) {
		t.Fatalf("restart preview = %d %q", restartedResponse.Code, restartedResponse.Body.Bytes())
	}
}

func TestArchiveUsesHalfOpenBoundaryAndDateFilters(t *testing.T) {
	first := httptest.NewServer(serveMP4(mp4Payload("first")))
	defer first.Close()
	second := httptest.NewServer(serveMP4(mp4Payload("second")))
	defer second.Close()
	day := time.Date(2026, 7, 15, 0, 0, 0, 0, seoul)
	source := archiveTestSource{cameras: []Camera{{ID: "CAM-1"}}, timelines: map[string]Timeline{
		"2026-07-15\x00CAM-1": {CameraID: "CAM-1", Segments: []Segment{
			{CameraID: "CAM-1", Start: day, End: day.Add(15 * time.Minute), State: "recorded", Source: first.URL},
			{CameraID: "CAM-1", Start: day.Add(15 * time.Minute), End: day.Add(30 * time.Minute), State: "recorded", Source: second.URL},
		}},
	}}
	service := NewService(Config{ArchiveRoot: t.TempDir()}, source)
	_, created := postArchive(t, service, `{"at":"2026-07-15T00:15:00+09:00","cameraIds":["CAM-1"]}`)
	item := waitArchive(t, service, created.ID, "verified")
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, item.Artifacts[0].VideoURL, nil))
	if !strings.HasSuffix(response.Body.String(), "second") {
		t.Fatalf("boundary selected %q", response.Body.String())
	}
	for _, path := range []string{"/api/v1/archives?month=2026-07", "/api/v1/archives?date=2026-07-15"} {
		list := httptest.NewRecorder()
		service.Handler().ServeHTTP(list, httptest.NewRequest(http.MethodGet, path, nil))
		if list.Code != http.StatusOK || !strings.Contains(list.Body.String(), created.ID) {
			t.Fatalf("list %s = %d %q", path, list.Code, list.Body.String())
		}
	}
}

func TestArchiveReportsWaitingAndPerCameraPartial(t *testing.T) {
	video := httptest.NewServer(serveMP4(mp4Payload("video")))
	defer video.Close()
	t.Run("waiting current open recording", func(t *testing.T) {
		now := time.Now().In(seoul).Truncate(time.Second)
		day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoul)
		source := archiveTestSource{cameras: []Camera{{ID: "CAM-1"}}, timelines: map[string]Timeline{
			day.Format("2006-01-02") + "\x00CAM-1": {CameraID: "CAM-1", Segments: []Segment{{CameraID: "CAM-1", Start: now.Add(-time.Minute), End: now.Add(time.Minute), State: "recorded", Source: video.URL}}},
		}}
		service := NewService(Config{ArchiveRoot: t.TempDir()}, source)
		body, _ := json.Marshal(map[string]any{"at": now.Format(time.RFC3339), "cameraIds": []string{"CAM-1"}})
		_, created := postArchive(t, service, string(body))
		item := waitArchive(t, service, created.ID, "waiting_recording")
		if item.Artifacts[0].Status != "waiting_recording" || item.Artifacts[0].Reason != "" {
			t.Fatalf("waiting artifact = %#v", item.Artifacts[0])
		}
	})
	t.Run("one verified and one missing", func(t *testing.T) {
		day := time.Date(2026, 7, 15, 0, 0, 0, 0, seoul)
		source := archiveTestSource{cameras: []Camera{{ID: "CAM-1"}, {ID: "CAM-2"}}, timelines: map[string]Timeline{
			"2026-07-15\x00CAM-1": {CameraID: "CAM-1", Segments: []Segment{{CameraID: "CAM-1", Start: day, End: day.Add(time.Hour), State: "recorded", Source: video.URL}}},
			"2026-07-15\x00CAM-2": {CameraID: "CAM-2"},
		}}
		service := NewService(Config{ArchiveRoot: t.TempDir()}, source)
		_, created := postArchive(t, service, `{"at":"2026-07-15T00:30:00+09:00","cameraIds":["CAM-2","CAM-1"]}`)
		item := waitArchive(t, service, created.ID, "partial")
		statuses := map[string]string{}
		for _, artifact := range item.Artifacts {
			statuses[artifact.CameraID] = artifact.Status
		}
		if statuses["CAM-1"] != "verified" || statuses["CAM-2"] != "failed" {
			t.Fatalf("statuses = %#v", statuses)
		}
	})
}

func TestArchiveValidationAndDisabledState(t *testing.T) {
	disabled := NewService(Config{}, archiveTestSource{})
	response := httptest.NewRecorder()
	disabled.Handler().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/v1/archives", nil))
	if response.Code != http.StatusNotImplemented {
		t.Fatalf("disabled status = %d", response.Code)
	}
	service := NewService(Config{ArchiveRoot: t.TempDir()}, archiveTestSource{cameras: []Camera{{ID: "CAM-1"}}})
	for _, body := range []string{
		`{"at":"bad","cameraIds":["CAM-1"]}`,
		`{"at":"2026-07-15T00:00:00+09:00","cameraIds":[]}`,
		`{"at":"2026-07-15T00:00:00+09:00","cameraIds":["CAM-1","CAM-1"]}`,
		`{"at":"2026-07-15T00:00:00+09:00","cameraIds":["UNKNOWN"]}`,
	} {
		status, _ := postArchive(t, service, body)
		if status != http.StatusBadRequest {
			t.Fatalf("body %s status = %d", body, status)
		}
	}
	deleteResponse := httptest.NewRecorder()
	service.Handler().ServeHTTP(deleteResponse, httptest.NewRequest(http.MethodDelete, "/api/v1/archives/anything", nil))
	if deleteResponse.Code != http.StatusMethodNotAllowed {
		t.Fatalf("delete status = %d", deleteResponse.Code)
	}
}

func TestArchiveRejectsUnsafeCopies(t *testing.T) {
	day := time.Date(2026, 7, 15, 0, 0, 0, 0, seoul)
	for _, test := range []struct {
		name    string
		handler http.Handler
		reason  string
		space   func(string) (uint64, uint64, error)
	}{
		{
			name: "content length over hard cap",
			handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "video/mp4")
				w.Header().Set("Content-Length", "2147483649")
				w.WriteHeader(http.StatusOK)
			}),
			reason: "artifact_too_large",
		},
		{
			name: "html success response",
			handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "text/html")
				_, _ = w.Write([]byte("<html>login</html>"))
			}),
			reason: "invalid_media",
		},
		{
			name:    "mp4 without moov",
			handler: serveMP4(mp4WithoutMoov()),
			reason:  "invalid_media",
		},
		{
			name:    "secondary reserve",
			handler: serveMP4(mp4Payload("video")),
			reason:  "insufficient_storage",
			space:   func(string) (uint64, uint64, error) { return 1000, 50, nil },
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			upstream := httptest.NewServer(test.handler)
			defer upstream.Close()
			source := archiveTestSource{cameras: []Camera{{ID: "CAM-1"}}, timelines: map[string]Timeline{
				"2026-07-15\x00CAM-1": {CameraID: "CAM-1", Segments: []Segment{{CameraID: "CAM-1", Start: day, End: day.Add(time.Hour), State: "recorded", Source: upstream.URL}}},
			}}
			service := NewService(Config{ArchiveRoot: t.TempDir()}, source)
			if test.space != nil {
				service.archive.space = test.space
			}
			_, created := postArchive(t, service, `{"at":"2026-07-15T00:30:00+09:00","cameraIds":["CAM-1"]}`)
			item := waitArchive(t, service, created.ID, "failed")
			if got := item.Artifacts[0].Reason; got != test.reason {
				t.Fatalf("reason = %q, want %q", got, test.reason)
			}
		})
	}
}

func TestArchiveQueueIsBounded(t *testing.T) {
	store := &archiveStore{queue: make(chan string, 1)}
	if !store.tryEnqueue("first") {
		t.Fatal("first queue item was rejected")
	}
	if store.tryEnqueue("second") {
		t.Fatal("full queue accepted another item")
	}

	root := t.TempDir()
	if err := os.MkdirAll(root+"/artifacts", 0o700); err != nil {
		t.Fatal(err)
	}
	service := NewService(Config{}, archiveTestSource{cameras: []Camera{{ID: "CAM-1"}}})
	service.archive = &archiveStore{
		root: root, service: service, items: map[string]*Archive{}, queue: make(chan string, 1), space: diskSpace,
	}
	service.archive.queue <- "occupied"
	status, _ := postArchive(t, service, `{"at":"2026-07-15T00:30:00+09:00","cameraIds":["CAM-1"]}`)
	if status != http.StatusServiceUnavailable {
		t.Fatalf("queue full status = %d", status)
	}
	if items := service.archive.list("", ""); len(items) != 0 {
		t.Fatalf("queue-full request remained in catalog: %#v", items)
	}
}
