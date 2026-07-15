package rewind

import "time"

type Camera struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Detector bool   `json:"detector"`
}
type Segment struct {
	ID       string    `json:"id"`
	CameraID string    `json:"cameraId"`
	Start    time.Time `json:"start"`
	End      time.Time `json:"end"`
	State    string    `json:"state"` // recorded, gap, corrupt
	Source   string    `json:"-"`
}
type Event struct {
	CameraID string     `json:"cameraId"`
	ID       string     `json:"id"`
	At       time.Time  `json:"at"`
	End      *time.Time `json:"end,omitempty"`
}
type Timeline struct {
	CameraID string    `json:"cameraId"`
	Segments []Segment `json:"segments"`
}
type Capabilities struct {
	Demo    bool   `json:"demo"`
	Motion  string `json:"motion"` // available, detector_off, unavailable
	Message string `json:"message"`
}
