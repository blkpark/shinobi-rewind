package rewind

import (
	"context"
	"fmt"
	"sort"
	"time"
)

type Source interface {
	Cameras(context.Context) ([]Camera, error)
	Timeline(context.Context, time.Time, string) (Timeline, error)
	Events(context.Context, time.Time, time.Time, string) ([]Event, error)
	Segment(string) (Segment, bool)
	Capabilities(context.Context, []Camera, []string, time.Time, time.Time) (Capabilities, error)
	Ready(context.Context) error
}

type demoSource struct{ segments map[string]Segment }

func NewDemoSource() Source {
	location := time.FixedZone("KST", 9*3600)
	now := time.Now().In(location)
	day := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, location)
	items := map[string]Segment{}
	for n, id := range []string{"CAM-201", "CAM-202", "CAM-203", "CAM-204", "CAM-205", "CAM-206"} {
		for i := 0; i < 8; i++ {
			start := day.Add(time.Duration(8+i*2)*time.Hour + time.Duration(n)*time.Minute)
			state := "recorded"
			if i == 2 && n == 1 {
				state = "gap"
			}
			if i == 5 && n == 3 {
				state = "corrupt"
			}
			key := fmt.Sprintf("d-%d-%d", n, i)
			items[key] = Segment{ID: key, CameraID: id, Start: start, End: start.Add(95 * time.Minute), State: state}
		}
	}
	return &demoSource{segments: items}
}
func (d *demoSource) Cameras(context.Context) ([]Camera, error) {
	return []Camera{{"CAM-201", "Camera 1", false}, {"CAM-202", "Camera 2", false}, {"CAM-203", "Camera 3", false}, {"CAM-204", "Area A", false}, {"CAM-205", "Area B", false}, {"CAM-206", "Camera 6", false}}, nil
}
func (d *demoSource) Timeline(_ context.Context, day time.Time, camera string) (Timeline, error) {
	var out []Segment
	for _, s := range d.segments {
		if s.CameraID == camera && sameDay(s.Start, day) {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].Start.Equal(out[j].Start) {
			return out[i].Start.Before(out[j].Start)
		}
		return out[i].ID < out[j].ID
	})
	return Timeline{CameraID: camera, Segments: out}, nil
}
func (d *demoSource) Events(context.Context, time.Time, time.Time, string) ([]Event, error) {
	return nil, nil
}
func (d *demoSource) Segment(id string) (Segment, bool) { s, ok := d.segments[id]; return s, ok }
func (d *demoSource) Capabilities(context.Context, []Camera, []string, time.Time, time.Time) (Capabilities, error) {
	return Capabilities{Demo: true, Motion: "detector_off", Message: "모션 데이터 사용 불가 · detector off"}, nil
}
func (d *demoSource) Ready(context.Context) error { return nil }
func sameDay(a, b time.Time) bool {
	ay, am, ad := a.Date()
	by, bm, bd := b.Date()
	return ay == by && am == bm && ad == bd
}
