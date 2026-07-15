package main

import (
	"log"
	"net/http"
	"time"

	"github.com/blkpark/shinobi-rewind/internal/rewind"
)

func main() {
	config, err := rewind.LoadConfig()
	if err != nil {
		log.Fatal(err)
	}
	service := rewind.NewService(config, nil)
	server := &http.Server{
		Addr:              config.ListenAddr,
		Handler:           service.Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("shinobi-rewind listening on %s (demo=%t)", config.ListenAddr, config.Demo)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}
