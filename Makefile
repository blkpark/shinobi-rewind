.PHONY: web build test lint typecheck fmt run
web:
	npm run build

build: web
	go build ./cmd/shinobi-rewind
test: web
	go test ./...
	go test -race ./...
	npm test
lint: web
	go vet ./...
	npm run lint
typecheck:
	npm run typecheck
fmt:
	gofmt -w cmd internal
run: build
	DEMO_MODE=true go run ./cmd/shinobi-rewind
