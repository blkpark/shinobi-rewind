.PHONY: build test lint typecheck fmt run
build:
	npm run build
	go build ./cmd/shinobi-rewind
test:
	go test ./...
	go test -race ./...
	npm test
lint:
	go vet ./...
	npm run lint
typecheck:
	npm run typecheck
fmt:
	gofmt -w cmd internal
run: build
	DEMO_MODE=true go run ./cmd/shinobi-rewind
