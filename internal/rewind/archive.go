package rewind

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

var errArchiveQueueFull = errors.New("archive queue is full")

const (
	archiveCatalogName = "catalog.json"
	archiveRetryDelay  = time.Minute
	archiveCopyTimeout = 30 * time.Minute
	archiveOpenGrace   = 30 * time.Second
	archiveArtifactCap = int64(2 << 30)
	archiveSpaceCheck  = int64(64 << 20)
)

type Archive struct {
	ID        string            `json:"id"`
	At        time.Time         `json:"at"`
	Label     string            `json:"label,omitempty"`
	CameraIDs []string          `json:"cameraIds"`
	Status    string            `json:"status"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
	Artifacts []ArchiveArtifact `json:"artifacts"`
}

type ArchiveArtifact struct {
	ID        string     `json:"id"`
	CameraID  string     `json:"cameraId"`
	Start     *time.Time `json:"start,omitempty"`
	End       *time.Time `json:"end,omitempty"`
	Status    string     `json:"status"`
	Size      int64      `json:"size,omitempty"`
	SHA256    string     `json:"sha256,omitempty"`
	Reason    string     `json:"reason,omitempty"`
	VideoURL  string     `json:"videoUrl,omitempty"`
	localPath string
}

type archiveCatalog struct {
	Archives []*Archive `json:"archives"`
}

type archiveStore struct {
	root    string
	service *Service
	mu      sync.RWMutex
	items   map[string]*Archive
	queue   chan string
	space   func(string) (uint64, uint64, error)
}

func newArchiveStore(root string, service *Service) (*archiveStore, error) {
	root, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("resolve archive root: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "artifacts"), 0o700); err != nil {
		return nil, fmt.Errorf("create archive root: %w", err)
	}
	store := &archiveStore{root: root, service: service, items: map[string]*Archive{}, queue: make(chan string, 128), space: diskSpace}
	if err := store.load(); err != nil {
		return nil, err
	}
	store.removePartialFiles()
	go store.worker()
	for id, item := range store.items {
		if item.Status != "verified" && item.Status != "failed" {
			if !store.tryEnqueue(id) {
				store.scheduleRetry(id)
			}
		}
	}
	return store, nil
}

func (s *archiveStore) load() error {
	data, err := os.ReadFile(filepath.Join(s.root, archiveCatalogName))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read archive catalog: %w", err)
	}
	var catalog archiveCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return fmt.Errorf("decode archive catalog: %w", err)
	}
	for _, item := range catalog.Archives {
		if item == nil || item.ID == "" {
			continue
		}
		for index := range item.Artifacts {
			artifact := &item.Artifacts[index]
			artifact.localPath = s.artifactPath(item.ID, artifact.ID)
			if artifact.Status == "copying" || artifact.Status == "verifying" {
				artifact.Status = "queued"
				artifact.Reason = ""
			}
		}
		s.items[item.ID] = item
	}
	return nil
}

func (s *archiveStore) removePartialFiles() {
	_ = filepath.WalkDir(filepath.Join(s.root, "artifacts"), func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() && strings.HasSuffix(entry.Name(), ".part") {
			_ = os.Remove(path)
		}
		return nil
	})
}

func archiveID(at time.Time, cameras []string) string {
	value := at.UTC().Format(time.RFC3339Nano) + "\x00" + strings.Join(cameras, "\x00")
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:16])
}

func artifactID(archiveID, camera string) string {
	sum := sha256.Sum256([]byte(archiveID + "\x00" + camera))
	return hex.EncodeToString(sum[:16])
}

func (s *archiveStore) create(at time.Time, cameras []string, label string) (Archive, bool, error) {
	cameras = append([]string(nil), cameras...)
	sort.Strings(cameras)
	id := archiveID(at, cameras)
	s.mu.Lock()
	if existing := s.items[id]; existing != nil {
		out := cloneArchive(existing)
		s.mu.Unlock()
		return out, false, nil
	}
	now := time.Now().UTC()
	item := &Archive{ID: id, At: at.UTC(), Label: label, CameraIDs: cameras, Status: "queued", CreatedAt: now, UpdatedAt: now}
	for _, camera := range cameras {
		id := artifactID(item.ID, camera)
		item.Artifacts = append(item.Artifacts, ArchiveArtifact{ID: id, CameraID: camera, Status: "queued", localPath: s.artifactPath(item.ID, id)})
	}
	s.items[id] = item
	if err := s.persistLocked(); err != nil {
		delete(s.items, id)
		s.mu.Unlock()
		return Archive{}, false, err
	}
	if !s.tryEnqueue(id) {
		delete(s.items, id)
		if err := s.persistLocked(); err != nil {
			logArchivePersist("queue_rollback", err)
		}
		s.mu.Unlock()
		return Archive{}, false, errArchiveQueueFull
	}
	out := cloneArchive(item)
	s.mu.Unlock()
	return out, true, nil
}

func (s *archiveStore) tryEnqueue(id string) bool {
	select {
	case s.queue <- id:
		return true
	default:
		return false
	}
}

func (s *archiveStore) scheduleRetry(id string) {
	time.AfterFunc(archiveRetryDelay, func() {
		if !s.tryEnqueue(id) {
			s.scheduleRetry(id)
		}
	})
}

func (s *archiveStore) worker() {
	for id := range s.queue {
		waiting := s.process(id)
		if waiting {
			s.scheduleRetry(id)
		}
	}
}

func (s *archiveStore) process(id string) bool {
	s.mu.RLock()
	item := s.items[id]
	if item == nil {
		s.mu.RUnlock()
		return false
	}
	at := item.At
	artifacts := append([]ArchiveArtifact(nil), item.Artifacts...)
	s.mu.RUnlock()
	waiting := false
	for _, artifact := range artifacts {
		if artifact.Status == "verified" || artifact.Status == "failed" {
			continue
		}
		segment, state, reason := s.resolveSegment(at, artifact.CameraID)
		if state == "waiting_recording" {
			s.updateArtifact(id, artifact.ID, func(target *ArchiveArtifact) {
				target.Status, target.Reason = state, ""
			})
			waiting = true
			continue
		}
		if state == "failed" {
			s.updateArtifact(id, artifact.ID, func(target *ArchiveArtifact) {
				target.Status, target.Reason = state, reason
			})
			continue
		}
		if err := s.copySegment(id, artifact.ID, segment); err != nil {
			s.updateArtifact(id, artifact.ID, func(target *ArchiveArtifact) {
				target.Status, target.Reason = "failed", archiveReason(err)
			})
		}
	}
	s.refreshStatus(id)
	return waiting
}

func (s *archiveStore) resolveSegment(at time.Time, camera string) (Segment, string, string) {
	day := at.In(seoul)
	day = time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, seoul)
	ctx, cancel := context.WithTimeout(context.Background(), archiveCopyTimeout)
	defer cancel()
	timeline, err := s.service.source.Timeline(ctx, day, camera)
	if err != nil {
		return Segment{}, "failed", "source_unavailable"
	}
	var latest time.Time
	for _, segment := range timeline.Segments {
		if segment.End.After(latest) && segment.State == "recorded" {
			latest = segment.End
		}
		if !at.Before(segment.Start) && at.Before(segment.End) {
			if segment.State != "recorded" || segment.Source == "" {
				return Segment{}, "failed", "segment_corrupt"
			}
			if sameDay(segment.End.In(seoul), time.Now().In(seoul)) && segment.End.After(time.Now().Add(-archiveOpenGrace)) {
				return Segment{}, "waiting_recording", ""
			}
			return segment, "ready", ""
		}
	}
	now := time.Now().In(seoul)
	if sameDay(at.In(seoul), now) && !at.After(now) && (latest.IsZero() || !at.Before(latest)) {
		return Segment{}, "waiting_recording", ""
	}
	return Segment{}, "failed", "segment_not_found"
}

func (s *archiveStore) copySegment(archiveID, artifactID string, segment Segment) error {
	upstream, err := url.Parse(segment.Source)
	if err != nil || !upstream.IsAbs() || !s.service.trustedVideoURL(upstream) {
		return archiveError{"source_unavailable"}
	}
	directory := filepath.Join(s.root, "artifacts", archiveID)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return archiveError{"copy_failed"}
	}
	finalPath := s.artifactPath(archiveID, artifactID)
	partPath := finalPath + ".part"
	_ = os.Remove(partPath)
	file, err := os.OpenFile(partPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return archiveError{"copy_failed"}
	}
	cleanup := func() { _ = file.Close(); _ = os.Remove(partPath) }
	s.updateArtifact(archiveID, artifactID, func(target *ArchiveArtifact) {
		target.Status, target.Reason = "copying", ""
		start, end := segment.Start, segment.End
		target.Start, target.End = &start, &end
	})
	ctx, cancel := context.WithTimeout(context.Background(), archiveCopyTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, upstream.String(), nil)
	if err != nil {
		cleanup()
		return archiveError{"source_unavailable"}
	}
	response, err := s.service.client.Do(req)
	if err != nil {
		cleanup()
		return archiveError{"source_unavailable"}
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 || response.StatusCode != http.StatusOK {
		cleanup()
		return archiveError{"source_unavailable"}
	}
	mediaType, _, _ := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaType != "video/mp4" && mediaType != "application/mp4" && mediaType != "application/octet-stream" {
		cleanup()
		return archiveError{"invalid_media"}
	}
	if response.ContentLength > archiveArtifactCap {
		cleanup()
		return archiveError{"artifact_too_large"}
	}
	if err := s.ensureSpace(response.ContentLength); err != nil {
		cleanup()
		return err
	}
	hash := sha256.New()
	written, err := s.copyWithGuards(file, hash, response.Body)
	if err != nil || written <= 0 || response.ContentLength >= 0 && written != response.ContentLength {
		cleanup()
		if err != nil {
			return err
		}
		return archiveError{"copy_failed"}
	}
	if err := file.Sync(); err != nil {
		cleanup()
		return archiveError{"copy_failed"}
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(partPath)
		return archiveError{"copy_failed"}
	}
	s.updateArtifact(archiveID, artifactID, func(target *ArchiveArtifact) { target.Status = "verifying" })
	verifiedHash, verifiedSize, err := hashFile(partPath)
	streamHash := hex.EncodeToString(hash.Sum(nil))
	mediaOK := validMP4(partPath)
	if err != nil || verifiedSize != written || verifiedHash != streamHash || !mediaOK {
		_ = os.Remove(partPath)
		if err == nil && !mediaOK {
			return archiveError{"invalid_media"}
		}
		return archiveError{"verification_failed"}
	}
	if err := os.Rename(partPath, finalPath); err != nil {
		_ = os.Remove(partPath)
		return archiveError{"copy_failed"}
	}
	if err := syncDirectory(directory); err != nil {
		_ = os.Remove(finalPath)
		return archiveError{"copy_failed"}
	}
	s.updateArtifact(archiveID, artifactID, func(target *ArchiveArtifact) {
		target.Status, target.Reason, target.Size, target.SHA256 = "verified", "", verifiedSize, verifiedHash
		target.VideoURL = "/api/v1/archives/" + archiveID + "/videos/" + artifactID
		target.localPath = finalPath
	})
	return nil
}

type archiveError struct{ reason string }

func (e archiveError) Error() string { return e.reason }
func archiveReason(err error) string {
	var target archiveError
	if errors.As(err, &target) {
		return target.reason
	}
	return "copy_failed"
}

func hashFile(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	return hex.EncodeToString(hash.Sum(nil)), size, err
}

func validMP4(path string) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || info.Size() < 16 {
		return false
	}
	fileSize := uint64(info.Size())
	var offset uint64
	foundFtyp, foundMoov := false, false
	for offset < fileSize {
		if fileSize-offset < 8 {
			return false
		}
		if _, err := file.Seek(int64(offset), io.SeekStart); err != nil {
			return false
		}
		header := make([]byte, 8)
		if _, err := io.ReadFull(file, header); err != nil {
			return false
		}
		boxSize := uint64(binary.BigEndian.Uint32(header[:4]))
		headerSize := uint64(8)
		if boxSize == 1 {
			extended := make([]byte, 8)
			if _, err := io.ReadFull(file, extended); err != nil {
				return false
			}
			boxSize = binary.BigEndian.Uint64(extended)
			headerSize = 16
		} else if boxSize == 0 {
			boxSize = fileSize - offset
		}
		if boxSize < headerSize || boxSize > fileSize-offset {
			return false
		}
		switch string(header[4:8]) {
		case "ftyp":
			if boxSize < headerSize+8 {
				return false
			}
			foundFtyp = true
		case "moov":
			if boxSize < headerSize+8 {
				return false
			}
			foundMoov = true
		}
		offset += boxSize
	}
	return offset == fileSize && foundFtyp && foundMoov
}

func diskSpace(path string) (uint64, uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, 0, err
	}
	block := uint64(stat.Bsize)
	return stat.Blocks * block, stat.Bavail * block, nil
}

func (s *archiveStore) ensureSpace(expected int64) error {
	total, available, err := s.space(s.root)
	if err != nil {
		return archiveError{"insufficient_storage"}
	}
	needed := archiveArtifactCap
	if expected >= 0 {
		needed = expected
	}
	reserve := total / 10
	if uint64(needed) > available || available-uint64(needed) < reserve {
		return archiveError{"insufficient_storage"}
	}
	return nil
}

func (s *archiveStore) copyWithGuards(destination io.Writer, hash io.Writer, source io.Reader) (int64, error) {
	limited := io.LimitReader(source, archiveArtifactCap+1)
	writer := io.MultiWriter(destination, hash)
	buffer := make([]byte, 1<<20)
	var written, checked int64
	for {
		n, readErr := limited.Read(buffer)
		if n > 0 {
			if written+int64(n) > archiveArtifactCap {
				return written, archiveError{"artifact_too_large"}
			}
			if _, err := writer.Write(buffer[:n]); err != nil {
				return written, archiveError{"copy_failed"}
			}
			written += int64(n)
			if written-checked >= archiveSpaceCheck {
				total, available, err := s.space(s.root)
				if err != nil || available < total/10 {
					return written, archiveError{"insufficient_storage"}
				}
				checked = written
			}
		}
		if errors.Is(readErr, io.EOF) {
			return written, nil
		}
		if readErr != nil {
			return written, archiveError{"copy_failed"}
		}
	}
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func (s *archiveStore) updateArtifact(archiveID, artifactID string, update func(*ArchiveArtifact)) {
	s.mu.Lock()
	item := s.items[archiveID]
	if item != nil {
		for index := range item.Artifacts {
			if item.Artifacts[index].ID == artifactID {
				update(&item.Artifacts[index])
				item.UpdatedAt = time.Now().UTC()
				break
			}
		}
		if err := s.persistLocked(); err != nil {
			logArchivePersist("artifact_update", err)
		}
	}
	s.mu.Unlock()
}

func (s *archiveStore) refreshStatus(id string) {
	s.mu.Lock()
	item := s.items[id]
	if item != nil {
		verified, failed, waiting, active := 0, 0, 0, 0
		for _, artifact := range item.Artifacts {
			switch artifact.Status {
			case "verified":
				verified++
			case "failed":
				failed++
			case "waiting_recording":
				waiting++
			default:
				active++
			}
		}
		switch {
		case verified == len(item.Artifacts):
			item.Status = "verified"
		case failed == len(item.Artifacts):
			item.Status = "failed"
		case failed > 0:
			item.Status = "partial"
		case waiting > 0:
			item.Status = "waiting_recording"
		case active > 0:
			item.Status = "copying"
		default:
			item.Status = "queued"
		}
		item.UpdatedAt = time.Now().UTC()
		if err := s.persistLocked(); err != nil {
			logArchivePersist("status_update", err)
		}
	}
	s.mu.Unlock()
}

func logArchivePersist(operation string, err error) {
	_ = json.NewEncoder(log.Writer()).Encode(map[string]string{
		"event":      "archive_catalog_persist_failed",
		"operation":  operation,
		"error_type": fmt.Sprintf("%T", err),
	})
}

func (s *archiveStore) persistLocked() error {
	items := make([]*Archive, 0, len(s.items))
	for _, item := range s.items {
		clone := cloneArchive(item)
		items = append(items, &clone)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.Before(items[j].CreatedAt) })
	data, err := json.MarshalIndent(archiveCatalog{Archives: items}, "", "  ")
	if err != nil {
		return err
	}
	part := filepath.Join(s.root, archiveCatalogName+".part")
	file, err := os.OpenFile(part, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(part)
		return err
	}
	if err := os.Rename(part, filepath.Join(s.root, archiveCatalogName)); err != nil {
		_ = os.Remove(part)
		return err
	}
	return syncDirectory(s.root)
}

func (s *archiveStore) artifactPath(archiveID, artifactID string) string {
	return filepath.Join(s.root, "artifacts", archiveID, artifactID+".mp4")
}

func cloneArchive(item *Archive) Archive {
	out := *item
	out.CameraIDs = append([]string(nil), item.CameraIDs...)
	out.Artifacts = append([]ArchiveArtifact(nil), item.Artifacts...)
	return out
}

func (s *archiveStore) get(id string) (Archive, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	item := s.items[id]
	if item == nil {
		return Archive{}, false
	}
	return cloneArchive(item), true
}

func (s *archiveStore) list(month, date string) []Archive {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]Archive, 0, len(s.items))
	for _, item := range s.items {
		kst := item.At.In(seoul)
		if month != "" && kst.Format("2006-01") != month {
			continue
		}
		if date != "" && kst.Format("2006-01-02") != date {
			continue
		}
		out = append(out, cloneArchive(item))
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out
}

func (s *Service) archiveAvailable(w http.ResponseWriter) bool {
	if s.archive == nil {
		if s.archiveErr != nil {
			http.Error(w, "archive storage unavailable", http.StatusServiceUnavailable)
		} else {
			http.Error(w, "archive storage is not configured", http.StatusNotImplemented)
		}
		return false
	}
	return true
}

func (s *Service) createArchive(w http.ResponseWriter, r *http.Request) {
	if !s.archiveAvailable(w) {
		return
	}
	var request struct {
		At        string   `json:"at"`
		CameraIDs []string `json:"cameraIds"`
		Label     string   `json:"label"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "valid archive request is required", http.StatusBadRequest)
		return
	}
	at, err := time.Parse(time.RFC3339, request.At)
	request.Label = strings.TrimSpace(request.Label)
	if err != nil || len(request.CameraIDs) == 0 || len(request.CameraIDs) > 6 || len(request.Label) > 200 {
		http.Error(w, "valid at, 1-6 cameras and a short label are required", http.StatusBadRequest)
		return
	}
	seen := map[string]struct{}{}
	for _, camera := range request.CameraIDs {
		if _, duplicate := seen[camera]; duplicate || !s.allowedCamera(r.Context(), camera) {
			http.Error(w, "unique known cameras are required", http.StatusBadRequest)
			return
		}
		seen[camera] = struct{}{}
	}
	item, created, err := s.archive.create(at, request.CameraIDs, request.Label)
	if err != nil {
		if errors.Is(err, errArchiveQueueFull) {
			http.Error(w, "archive queue is full", http.StatusServiceUnavailable)
			return
		}
		http.Error(w, "archive catalog unavailable", http.StatusServiceUnavailable)
		return
	}
	status := http.StatusOK
	if created {
		status = http.StatusAccepted
	}
	writeJSON(w, status, item)
}

func (s *Service) listArchives(w http.ResponseWriter, r *http.Request) {
	if !s.archiveAvailable(w) {
		return
	}
	month, date := r.URL.Query().Get("month"), r.URL.Query().Get("date")
	if month != "" && date != "" {
		http.Error(w, "month and date are mutually exclusive", http.StatusBadRequest)
		return
	}
	if month != "" {
		if _, err := time.Parse("2006-01", month); err != nil {
			http.Error(w, "valid month is required", http.StatusBadRequest)
			return
		}
	}
	if date != "" {
		if _, err := parseKSTDate(date); err != nil {
			http.Error(w, "valid date is required", http.StatusBadRequest)
			return
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"archives": s.archive.list(month, date)})
}

func (s *Service) getArchive(w http.ResponseWriter, r *http.Request) {
	if !s.archiveAvailable(w) {
		return
	}
	item, ok := s.archive.get(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Service) archiveVideo(w http.ResponseWriter, r *http.Request) {
	if !s.archiveAvailable(w) {
		return
	}
	item, ok := s.archive.get(r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	var artifact *ArchiveArtifact
	for index := range item.Artifacts {
		if item.Artifacts[index].ID == r.PathValue("artifact") {
			artifact = &item.Artifacts[index]
			break
		}
	}
	if artifact == nil {
		http.NotFound(w, r)
		return
	}
	if artifact.Status != "verified" {
		http.Error(w, "archive artifact is not verified", http.StatusConflict)
		return
	}
	path := s.archive.artifactPath(item.ID, artifact.ID)
	file, err := os.Open(path)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != artifact.Size {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "video/mp4")
	w.Header().Set("ETag", `"sha256-`+artifact.SHA256+`"`)
	http.ServeContent(w, r, artifact.ID+".mp4", item.UpdatedAt, file)
}
