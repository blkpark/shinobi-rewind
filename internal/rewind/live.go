package rewind

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"regexp"
	"strings"
	"sync"
	"time"
)

const (
	liveAssetTTL   = 5 * time.Minute
	maxPlaylistLen = 1 << 20
	maxLiveAssets  = 4096
)

var hlsURIAttribute = regexp.MustCompile(`URI="([^"]+)"`)

type liveAsset struct {
	camera   string
	upstream *url.URL
	root     *url.URL
	cookie   string
	expires  time.Time
}

func (s *Service) liveCapabilities(w http.ResponseWriter, _ *http.Request) {
	available := !s.config.Demo && (s.config.LiveHLSURL != nil || s.config.ShinobiURL != nil)
	var transport *string
	message := "실시간 스트림이 구성되지 않았습니다."
	if available {
		value := "hls"
		transport = &value
		message = "HLS 프록시 구성됨 · 스트림 권한은 카메라 연결 시 확인"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"available":  available,
		"transport":  transport,
		"lowQuality": available && (s.config.LiveHLSURL != nil || s.config.ShinobiLowChannel != ""),
		"message":    message,
	})
}

type liveCamera struct {
	Camera
	HasAudio         *bool      `json:"hasAudio"`
	LatestRecordedAt *time.Time `json:"latestRecordedAt"`
}

func (s *Service) liveCameras(w http.ResponseWriter, r *http.Request) {
	cameras, err := s.source.Cameras(r.Context())
	if err != nil {
		apiError(w, err)
		return
	}
	s.setAllowed(cameras)
	now := time.Now().In(seoul)
	out := make([]liveCamera, len(cameras))
	var wait sync.WaitGroup
	for index, camera := range cameras {
		wait.Add(1)
		go func() {
			defer wait.Done()
			item := liveCamera{Camera: camera}
			segment, found, err := s.latestCompletedRecording(r.Context(), camera.ID, now)
			if err != nil {
				log.Printf("live camera metadata unavailable: %T", err)
				out[index] = item
				return
			}
			if found {
				item.HasAudio = segment.HasAudio
				at := segment.End.Add(-time.Millisecond)
				if at.Before(segment.Start) {
					at = segment.Start
				}
				item.LatestRecordedAt = &at
			}
			out[index] = item
		}()
	}
	wait.Wait()
	writeJSON(w, http.StatusOK, out)
}

func (s *Service) latestCompletedRecording(ctx context.Context, camera string, now time.Time) (Segment, bool, error) {
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, seoul)
	for _, candidateDay := range []time.Time{day, day.AddDate(0, 0, -1)} {
		timeline, err := s.source.Timeline(ctx, candidateDay, camera)
		if err != nil {
			return Segment{}, false, err
		}
		var latest Segment
		for _, segment := range timeline.Segments {
			if segment.State == "recorded" && !segment.End.After(now) && (latest.End.IsZero() || segment.End.After(latest.End)) {
				latest = segment
			}
		}
		if !latest.End.IsZero() {
			return latest, true, nil
		}
	}
	return Segment{}, false, nil
}

func (s *Service) livePlaylist(w http.ResponseWriter, r *http.Request) {
	camera := r.PathValue("camera")
	if !s.allowedCamera(r.Context(), camera) {
		http.NotFound(w, r)
		return
	}
	quality := r.URL.Query().Get("quality")
	if quality != "" && quality != "high" && quality != "low" {
		http.Error(w, "requested live quality is unavailable", http.StatusUnprocessableEntity)
		return
	}
	if quality == "low" && s.config.LiveHLSURL == nil && s.config.ShinobiLowChannel == "" {
		http.Error(w, "requested live quality is unavailable", http.StatusUnprocessableEntity)
		return
	}
	upstream, root, err := s.liveURLs(camera, quality)
	if err != nil {
		http.Error(w, "live stream is unavailable", http.StatusServiceUnavailable)
		return
	}
	s.serveLiveAsset(w, r, liveAsset{camera: camera, upstream: upstream, root: root})
}

func (s *Service) liveSegment(w http.ResponseWriter, r *http.Request) {
	camera := r.PathValue("camera")
	if !s.allowedCamera(r.Context(), camera) {
		http.NotFound(w, r)
		return
	}
	asset, ok := s.takeLiveAsset(camera, r.PathValue("id"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	s.serveLiveAsset(w, r, asset)
}

func (s *Service) liveURLs(camera, quality string) (*url.URL, *url.URL, error) {
	if s.config.LiveHLSURL != nil {
		if !safeURLComponent(camera) {
			return nil, nil, fmt.Errorf("invalid live path component")
		}
		if quality == "" {
			quality = "high"
		}
		root := s.config.LiveHLSURL.JoinPath("cam" + strings.ToLower(camera) + quality)
		root.RawQuery, root.Fragment = "", ""
		playlist := root.JoinPath("index.m3u8")
		playlist.RawQuery = "cookieCheck=1"
		return playlist, root, nil
	}
	if s.config.ShinobiURL == nil || s.config.ShinobiKey == "" || s.config.ShinobiGroup == "" {
		return nil, nil, fmt.Errorf("live upstream is not configured")
	}
	for _, component := range []string{s.config.ShinobiKey, s.config.ShinobiGroup, camera} {
		if !safeURLComponent(component) {
			return nil, nil, fmt.Errorf("invalid live path component")
		}
	}
	root := s.config.ShinobiURL.JoinPath(s.config.ShinobiKey, "hls", s.config.ShinobiGroup, camera)
	if quality == "low" {
		root = root.JoinPath(s.config.ShinobiLowChannel)
	}
	root.RawQuery, root.Fragment = "", ""
	playlist := root.JoinPath("s.m3u8")
	return playlist, root, nil
}

func safeURLComponent(value string) bool {
	return value != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\\r\n\x00")
}

func (s *Service) serveLiveAsset(w http.ResponseWriter, r *http.Request, asset liveAsset) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !s.trustedLiveURL(asset.upstream, asset.root) {
		http.Error(w, "live asset is malformed", http.StatusBadGateway)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, asset.upstream.String(), nil)
	if err != nil {
		http.Error(w, "live asset request failed", http.StatusBadGateway)
		return
	}
	for _, header := range []string{"Range", "If-Range"} {
		if value := r.Header.Get(header); value != "" {
			req.Header.Set(header, value)
		}
	}
	if asset.cookie != "" {
		req.Header.Set("Cookie", asset.cookie)
	}
	response, err := s.client.Do(req)
	if err != nil {
		http.Error(w, "live asset unavailable", http.StatusBadGateway)
		return
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 {
		http.Error(w, "live asset redirect rejected", http.StatusBadGateway)
		return
	}
	if response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden {
		http.Error(w, "live stream forbidden", http.StatusForbidden)
		return
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusPartialContent && response.StatusCode != http.StatusRequestedRangeNotSatisfiable {
		http.Error(w, "live asset unavailable", http.StatusBadGateway)
		return
	}

	isPlaylist := strings.HasSuffix(strings.ToLower(asset.upstream.Path), ".m3u8") || strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "mpegurl")
	if isPlaylist && r.Method != http.MethodHead && response.StatusCode == http.StatusOK {
		body, err := io.ReadAll(io.LimitReader(response.Body, maxPlaylistLen+1))
		if err != nil || len(body) > maxPlaylistLen {
			http.Error(w, "live playlist unavailable", http.StatusBadGateway)
			return
		}
		cookie := asset.cookie
		if cookies := response.Cookies(); len(cookies) > 0 {
			parts := make([]string, 0, len(cookies))
			for _, item := range cookies {
				parts = append(parts, (&http.Cookie{Name: item.Name, Value: item.Value}).String())
			}
			cookie = strings.Join(parts, "; ")
		}
		rewritten, err := s.rewritePlaylist(asset.camera, asset.upstream, asset.root, cookie, string(body))
		if err != nil {
			http.Error(w, "live playlist rejected", http.StatusBadGateway)
			return
		}
		w.Header().Set("Content-Type", "application/vnd.apple.mpegurl")
		w.Header().Set("Cache-Control", "no-store")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, rewritten)
		return
	}

	for _, header := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"} {
		if value := response.Header.Get(header); value != "" {
			w.Header().Set(header, value)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(response.StatusCode)
	if r.Method != http.MethodHead {
		_, _ = io.Copy(w, response.Body)
	}
}

func (s *Service) rewritePlaylist(camera string, current, root *url.URL, cookie, playlist string) (string, error) {
	lines := strings.Split(playlist, "\n")
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		if !strings.HasPrefix(trimmed, "#") {
			rewritten, err := s.registerLiveAsset(camera, current, root, cookie, trimmed)
			if err != nil {
				return "", err
			}
			lines[i] = strings.Replace(line, trimmed, rewritten, 1)
			continue
		}
		var rewriteErr error
		lines[i] = hlsURIAttribute.ReplaceAllStringFunc(line, func(match string) string {
			if rewriteErr != nil {
				return match
			}
			parts := hlsURIAttribute.FindStringSubmatch(match)
			rewritten, err := s.registerLiveAsset(camera, current, root, cookie, parts[1])
			if err != nil {
				rewriteErr = err
				return match
			}
			return `URI="` + rewritten + `"`
		})
		if rewriteErr != nil {
			return "", rewriteErr
		}
	}
	rewritten := strings.Join(lines, "\n")
	if s.config.ShinobiKey != "" && strings.Contains(rewritten, s.config.ShinobiKey) {
		return "", fmt.Errorf("playlist contains protected credentials")
	}
	if s.config.ShinobiURL != nil && strings.Contains(rewritten, s.config.ShinobiURL.Host) {
		return "", fmt.Errorf("playlist contains upstream host")
	}
	if s.config.LiveHLSURL != nil && strings.Contains(rewritten, s.config.LiveHLSURL.Host) {
		return "", fmt.Errorf("playlist contains live upstream host")
	}
	return rewritten, nil
}

func (s *Service) registerLiveAsset(camera string, current, root *url.URL, cookie, raw string) (string, error) {
	reference, err := url.Parse(raw)
	if err != nil || reference.User != nil || reference.Fragment != "" || hasTraversal(reference) {
		return "", fmt.Errorf("invalid live asset URI")
	}
	resolved := current.ResolveReference(reference)
	if !s.trustedLiveURL(resolved, root) {
		return "", fmt.Errorf("untrusted live asset URI")
	}
	var tokenBytes [16]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return "", err
	}
	token := hex.EncodeToString(tokenBytes[:])
	now := time.Now()
	s.liveMu.Lock()
	for id, asset := range s.live {
		if now.After(asset.expires) {
			delete(s.live, id)
		}
	}
	if len(s.live) >= maxLiveAssets {
		var oldestID string
		var oldestExpiry time.Time
		for id, asset := range s.live {
			if oldestID == "" || asset.expires.Before(oldestExpiry) {
				oldestID, oldestExpiry = id, asset.expires
			}
		}
		delete(s.live, oldestID)
	}
	s.live[token] = liveAsset{camera: camera, upstream: resolved, root: root, cookie: cookie, expires: now.Add(liveAssetTTL)}
	s.liveMu.Unlock()
	return "/api/v1/live/" + url.PathEscape(camera) + "/segments/" + token, nil
}

func (s *Service) takeLiveAsset(camera, token string) (liveAsset, bool) {
	s.liveMu.Lock()
	defer s.liveMu.Unlock()
	asset, ok := s.live[token]
	if !ok || asset.camera != camera || time.Now().After(asset.expires) {
		delete(s.live, token)
		return liveAsset{}, false
	}
	return asset, true
}

func (s *Service) trustedLiveURL(candidate, root *url.URL) bool {
	if candidate == nil || root == nil || candidate.User != nil || candidate.Fragment != "" {
		return false
	}
	trusted := s.config.ShinobiURL
	if s.config.LiveHLSURL != nil {
		trusted = s.config.LiveHLSURL
	}
	if trusted == nil {
		return false
	}
	if candidate.Scheme != trusted.Scheme || candidate.Host != trusted.Host {
		return false
	}
	rootPath := path.Clean("/" + strings.TrimPrefix(root.Path, "/"))
	candidatePath := path.Clean("/" + strings.TrimPrefix(candidate.Path, "/"))
	return candidatePath == rootPath || strings.HasPrefix(candidatePath, rootPath+"/")
}

func hasTraversal(reference *url.URL) bool {
	if strings.Contains(reference.Path, "\\") {
		return true
	}
	value := reference.EscapedPath()
	for range 3 {
		decoded, err := url.PathUnescape(value)
		if err != nil {
			return true
		}
		for _, component := range strings.Split(strings.ReplaceAll(decoded, "\\", "/"), "/") {
			if component == ".." {
				return true
			}
		}
		if decoded == value {
			break
		}
		value = decoded
	}
	return false
}
