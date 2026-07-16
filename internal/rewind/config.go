package rewind

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"
)

type Config struct {
	ListenAddr    string
	Demo          bool
	ShinobiURL    *url.URL
	ShinobiGroup  string
	ShinobiKey    string
	HeaderTimeout time.Duration
	ArchiveRoot   string
}

func LoadConfig() (Config, error) {
	demo, err := parseDemo(value("DEMO_MODE", "true"))
	if err != nil {
		return Config{}, err
	}
	c := Config{ListenAddr: value("LISTEN_ADDR", ":8080"), Demo: demo, ShinobiGroup: os.Getenv("SHINOBI_GROUP_KEY"), ShinobiKey: os.Getenv("SHINOBI_API_KEY"), HeaderTimeout: 15 * time.Second, ArchiveRoot: strings.TrimSpace(os.Getenv("ARCHIVE_ROOT"))}
	if c.Demo {
		return c, nil
	}
	raw := os.Getenv("SHINOBI_URL")
	if raw == "" || c.ShinobiGroup == "" || c.ShinobiKey == "" {
		return Config{}, fmt.Errorf("SHINOBI_URL, SHINOBI_GROUP_KEY and SHINOBI_API_KEY are required when DEMO_MODE=false")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return Config{}, fmt.Errorf("SHINOBI_URL must be an absolute URL")
	}
	if u.User != nil || strings.Contains(u.RawQuery, "key") {
		return Config{}, fmt.Errorf("SHINOBI_URL must not contain credentials or API keys")
	}
	c.ShinobiURL = u
	return c, nil
}

func parseDemo(raw string) (bool, error) {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "true":
		return true, nil
	case "false":
		return false, nil
	default:
		return false, fmt.Errorf("DEMO_MODE must be exactly true or false")
	}
}

func value(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
