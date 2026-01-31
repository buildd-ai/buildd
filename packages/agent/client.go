package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"time"
)

type ClientConfig struct {
	ServerURL string
	APIKey    string
	Workspace string
	MaxTasks  int
}

type Client struct {
	config  *ClientConfig
	http    *http.Client
	runners map[string]*WorkerRunner
}

type Task struct {
	ID          string                 `json:"id"`
	WorkspaceID string                 `json:"workspaceId"`
	Title       string                 `json:"title"`
	Description string                 `json:"description"`
	Context     map[string]interface{} `json:"context"`
}

type ClaimTasksRequest struct {
	WorkspaceID  string   `json:"workspaceId,omitempty"`
	Capabilities []string `json:"capabilities,omitempty"`
	MaxTasks     int      `json:"maxTasks"`
}

type ClaimTasksResponse struct {
	Workers []struct {
		ID     string `json:"id"`
		TaskID string `json:"taskId"`
		Branch string `json:"branch"`
		Task   Task   `json:"task"`
	} `json:"workers"`
}

func NewClient(config *ClientConfig) *Client {
	return &Client{
		config: config,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
		runners: make(map[string]*WorkerRunner),
	}
}

func (c *Client) Connect() error {
	// Test connection by hitting health endpoint
	req, err := http.NewRequest("GET", c.config.ServerURL+"/health", nil)
	if err != nil {
		return err
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("failed to connect to server: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("server returned status %d", resp.StatusCode)
	}

	return nil
}

func (c *Client) Close() {
	// Stop all runners
	for _, runner := range c.runners {
		runner.Stop()
	}
}

func (c *Client) Run() {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()

	// Initial claim
	c.claimAndStartTasks()

	// Periodic polling
	for range ticker.C {
		c.claimAndStartTasks()
	}
}

func (c *Client) claimAndStartTasks() {
	// Check how many slots we have available
	activeCount := 0
	for _, runner := range c.runners {
		if runner.IsRunning() {
			activeCount++
		}
	}

	availableSlots := c.config.MaxTasks - activeCount
	if availableSlots <= 0 {
		return
	}

	// Claim tasks
	req := ClaimTasksRequest{
		WorkspaceID: c.config.Workspace,
		MaxTasks:    availableSlots,
	}

	resp, err := c.claimTasks(req)
	if err != nil {
		log.Printf("Failed to claim tasks: %v", err)
		return
	}

	// Start runners for claimed tasks
	for _, worker := range resp.Workers {
		log.Printf("Claimed task %s: %s", worker.TaskID, worker.Task.Title)

		runner := NewWorkerRunner(c.config.ServerURL, c.config.APIKey, worker.ID, worker.Task)
		c.runners[worker.ID] = runner

		go func(r *WorkerRunner) {
			if err := r.Start(); err != nil {
				log.Printf("Worker %s failed: %v", r.workerID, err)
			}
		}(runner)
	}
}

func (c *Client) claimTasks(req ClaimTasksRequest) (*ClaimTasksResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", c.config.ServerURL+"/api/workers/claim", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+c.config.APIKey)

	httpResp, err := c.http.Do(httpReq)
	if err != nil {
		return nil, err
	}
	defer httpResp.Body.Close()

	if httpResp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(httpResp.Body)
		return nil, fmt.Errorf("server returned %d: %s", httpResp.StatusCode, string(bodyBytes))
	}

	var resp ClaimTasksResponse
	if err := json.NewDecoder(httpResp.Body).Decode(&resp); err != nil {
		return nil, err
	}

	return &resp, nil
}
