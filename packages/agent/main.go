package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

var (
	serverURL = flag.String("server", getEnv("BUILDD_SERVER", "http://localhost:3000"), "buildd server URL")
	apiKey    = flag.String("api-key", getEnv("BUILDD_API_KEY", ""), "buildd API key")
	workspace = flag.String("workspace", "", "workspace ID to claim tasks from")
	maxTasks  = flag.Int("max-tasks", 3, "maximum concurrent tasks")
)

func main() {
	flag.Parse()

	if *apiKey == "" {
		log.Fatal("BUILDD_API_KEY is required (set via env or --api-key)")
	}

	config := &ClientConfig{
		ServerURL: *serverURL,
		APIKey:    *apiKey,
		Workspace: *workspace,
		MaxTasks:  *maxTasks,
	}

	client := NewClient(config)

	// Connect to server
	if err := client.Connect(); err != nil {
		log.Fatalf("Failed to connect: %v", err)
	}
	defer client.Close()

	log.Printf("Connected to buildd server at %s", *serverURL)

	// Handle shutdown gracefully
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	// Start claiming and working on tasks
	go client.Run()

	<-sigCh
	log.Println("Shutting down gracefully...")
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
