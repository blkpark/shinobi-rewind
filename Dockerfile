FROM node:22-alpine AS web
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.mjs ./
COPY src ./src
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /app
COPY go.mod ./
RUN go mod download
COPY . .
COPY --from=web /app/internal/rewind/web/dist ./internal/rewind/web/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /shinobi-rewind ./cmd/shinobi-rewind

FROM alpine:3.22
COPY --from=build /shinobi-rewind /shinobi-rewind
COPY LICENSE THIRD_PARTY_NOTICES.md /licenses/
ENV LISTEN_ADDR=:8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
USER 65532:65532
ENTRYPOINT ["/shinobi-rewind"]
