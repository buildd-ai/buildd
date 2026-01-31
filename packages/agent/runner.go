package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type WorkerRunner struct {
	serverURL string
	apiKey    string
	workerID  string
	task      Task

	running bool
	mu      sync.Mutex
	cmd     *exec.Cmd
}

func NewWorkerRunner(serverURL, apiKey, workerID string, task Task) *WorkerRunner {
	return &WorkerRunner{
		serverURL: serverURL,
		apiKey:    apiKey,
		workerID:  workerID,
		task:      task,
	}
}

func (r *WorkerRunner) IsRunning() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.running
}

func (r *WorkerRunner) Start() error {
	r.mu.Lock()
	r.running = true
	r.mu.Unlock()

	defer func() {
		r.mu.Lock()
		r.running = false
		r.mu.Unlock()
	}()

	log.Printf("[%s] Starting work on task: %s", r.workerID, r.task.Title)

	// Build prompt
	prompt := r.buildPrompt()

	// Execute Claude via node script
	// This is a simplified version - in production you'd use the Claude Agent SDK
	if err := r.executeClaude(prompt); err != nil {
		log.Printf("[%s] Error: %v", r.workerID, err)
		return err
	}

	log.Printf("[%s] Task completed", r.workerID)
	return nil
}

func (r *WorkerRunner) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.cmd != nil && r.cmd.Process != nil {
		r.cmd.Process.Kill()
	}
	r.running = false
}

func (r *WorkerRunner) buildPrompt() string {
	var b strings.Builder

	b.WriteString(fmt.Sprintf("# Task: %s\n\n", r.task.Title))

	if r.task.Description != "" {
		b.WriteString(fmt.Sprintf("%s\n\n", r.task.Description))
	}

	b.WriteString("## Guidelines\n")
	b.WriteString("- Create a brief task plan first\n")
	b.WriteString("- Make incremental commits\n")
	b.WriteString("- Ask for clarification if needed\n")
	b.WriteString("- Report progress periodically\n")

	return b.String()
}

func (r *WorkerRunner) executeClaude(prompt string) error {
	// Check which auth method to use
	if oauthToken := os.Getenv("CLAUDE_CODE_OAUTH_TOKEN"); oauthToken != "" {
		log.Printf("[%s] Using OAuth authentication (seat-based)", r.workerID)
		return r.executeViaOAuth(prompt)
	}

	if apiKey := os.Getenv("ANTHROPIC_API_KEY"); apiKey != "" {
		log.Printf("[%s] Using API authentication (pay-per-token)", r.workerID)
		return r.executeViaAPI(prompt)
	}

	return fmt.Errorf("no authentication configured - set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY")
}

func (r *WorkerRunner) executeViaOAuth(prompt string) error {
	// Use claude CLI with OAuth token
	// This uses the user's Claude Pro/Team seat - no per-token cost
	log.Printf("[%s] Executing via OAuth (seat-based, no cost tracking)", r.workerID)

	// Save prompt to temp file
	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("buildd-prompt-%s.txt", r.workerID))
	if err := os.WriteFile(tmpFile, []byte(prompt), 0644); err != nil {
		return fmt.Errorf("failed to write prompt: %w", err)
	}
	defer os.Remove(tmpFile)

	// Report progress
	r.reportProgress(0, "Starting Claude (OAuth)...")

	// Execute claude CLI
	// NOTE: In production, this would stream output and parse for progress
	cmd := exec.Command("claude", "--dangerously-skip-permissions", "-f", tmpFile)
	cmd.Env = append(os.Environ(),
		"CLAUDE_CODE_OAUTH_TOKEN="+os.Getenv("CLAUDE_CODE_OAUTH_TOKEN"))

	r.mu.Lock()
	r.cmd = cmd
	r.mu.Unlock()

	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[%s] Claude execution failed: %v\n%s", r.workerID, err, string(output))
		return fmt.Errorf("claude execution failed: %w", err)
	}

	log.Printf("[%s] Claude output:\n%s", r.workerID, string(output))

	// Mark as complete (no cost to report for OAuth)
	r.reportComplete("Task completed successfully (OAuth)")
	return nil
}

func (r *WorkerRunner) executeViaAPI(prompt string) error {
	// Use Anthropic API with API key
	// This is pay-per-token - costs are tracked
	log.Printf("[%s] Executing via API (pay-per-token, cost tracking enabled)", r.workerID)

	// For now, we'll simulate work
	// In production, this would use the Claude Agent SDK

	r.reportProgress(0, "Starting task (API)...")
	time.Sleep(2 * time.Second)

	r.reportProgress(30, "Analyzing requirements...")
	time.Sleep(2 * time.Second)

	r.reportProgress(60, "Implementing solution...")
	time.Sleep(2 * time.Second)

	r.reportProgress(90, "Finalizing...")
	time.Sleep(1 * time.Second)

	// Mark as complete
	r.reportComplete("Task completed successfully (API)")

	return nil
}

func (r *WorkerRunner) reportProgress(percent int, message string) {
	payload := map[string]interface{}{
		"progress": percent,
		"status":   "running",
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("PATCH",
		fmt.Sprintf("%s/api/workers/%s", r.serverURL, r.workerID),
		bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.apiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[%s] Failed to report progress: %v", r.workerID, err)
		return
	}
	defer resp.Body.Close()

	log.Printf("[%s] Progress: %d%% - %s", r.workerID, percent, message)
}

func (r *WorkerRunner) reportComplete(result string) {
	payload := map[string]interface{}{
		"status": "completed",
		"result": result,
	}

	body, _ := json.Marshal(payload)
	req, _ := http.NewRequest("PATCH",
		fmt.Sprintf("%s/api/workers/%s", r.serverURL, r.workerID),
		bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+r.apiKey)

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		log.Printf("[%s] Failed to report completion: %v", r.workerID, err)
		return
	}
	defer resp.Body.Close()

	log.Printf("[%s] Completed: %s", r.workerID, result)
}

// Helper to execute commands
func (r *WorkerRunner) execCommand(name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)

	r.mu.Lock()
	r.cmd = cmd
	r.mu.Unlock()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("%v: %s", err, stderr.String())
	}

	return stdout.String(), nil
}
