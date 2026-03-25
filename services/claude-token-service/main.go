package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

const (
	// Anthropic OAuth endpoints and client ID (same as used by Claude Code)
	claudeOAuthClientID  = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
	claudeOAuthTokenURL  = "https://console.anthropic.com/v1/oauth/token"
	
	// Refresh buffer - refresh 5 minutes before expiry
	refreshBufferSeconds = 5 * 60
	
	// Default server port
	defaultPort = "8080"
)

// TokenResponse from Anthropic OAuth endpoint
type TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	TokenType    string `json:"token_type"`
}

// StoredCredentials for persistence
type StoredCredentials struct {
	RefreshToken string `json:"refresh_token"`
	AccessToken  string `json:"access_token"`
	ExpiresAt    int64  `json:"expires_at"` // Unix timestamp in seconds
}

// TokenService manages Claude OAuth tokens
type TokenService struct {
	mu            sync.RWMutex
	refreshToken  string
	accessToken   string
	expiresAt     time.Time
	credFile      string
	refreshing    bool
	refreshCond   *sync.Cond
}

// NewTokenService creates a new token service
func NewTokenService(refreshToken, credFile string) *TokenService {
	ts := &TokenService{
		refreshToken: refreshToken,
		credFile:     credFile,
	}
	ts.refreshCond = sync.NewCond(&ts.mu)
	
	// Try to load existing credentials from file
	if credFile != "" {
		ts.loadCredentials()
	}
	
	return ts
}

// loadCredentials loads credentials from file
func (ts *TokenService) loadCredentials() {
	data, err := os.ReadFile(ts.credFile)
	if err != nil {
		log.Printf("No existing credentials file: %v", err)
		return
	}
	
	var creds StoredCredentials
	if err := json.Unmarshal(data, &creds); err != nil {
		log.Printf("Failed to parse credentials file: %v", err)
		return
	}
	
	// Use stored refresh token if we don't have one from env
	if ts.refreshToken == "" && creds.RefreshToken != "" {
		ts.refreshToken = creds.RefreshToken
		log.Println("Loaded refresh token from credentials file")
	}
	
	// Use stored access token if still valid
	expiresAt := time.Unix(creds.ExpiresAt, 0)
	if creds.AccessToken != "" && time.Now().Add(time.Duration(refreshBufferSeconds)*time.Second).Before(expiresAt) {
		ts.accessToken = creds.AccessToken
		ts.expiresAt = expiresAt
		log.Printf("Loaded valid access token, expires at %v", expiresAt)
	}
}

// saveCredentials persists credentials to file
func (ts *TokenService) saveCredentials() {
	if ts.credFile == "" {
		return
	}
	
	creds := StoredCredentials{
		RefreshToken: ts.refreshToken,
		AccessToken:  ts.accessToken,
		ExpiresAt:    ts.expiresAt.Unix(),
	}
	
	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		log.Printf("Failed to marshal credentials: %v", err)
		return
	}
	
	if err := os.WriteFile(ts.credFile, data, 0600); err != nil {
		log.Printf("Failed to save credentials: %v", err)
	}
}

// refreshAccessToken exchanges the refresh token for a new access token
func (ts *TokenService) refreshAccessToken() error {
	ts.mu.Lock()
	
	// If another goroutine is already refreshing, wait for it
	for ts.refreshing {
		ts.refreshCond.Wait()
	}
	
	// Check if token was refreshed while waiting
	if ts.accessToken != "" && time.Now().Add(time.Duration(refreshBufferSeconds)*time.Second).Before(ts.expiresAt) {
		ts.mu.Unlock()
		return nil
	}
	
	// Mark as refreshing and capture refresh token
	ts.refreshing = true
	refreshToken := ts.refreshToken
	ts.mu.Unlock()
	
	// Ensure we always clean up the refreshing state
	var refreshErr error
	var tokenResp TokenResponse
	defer func() {
		ts.mu.Lock()
		if refreshErr == nil {
			ts.accessToken = tokenResp.AccessToken
			ts.expiresAt = time.Now().Add(time.Duration(tokenResp.ExpiresIn) * time.Second)
			if tokenResp.RefreshToken != "" {
				ts.refreshToken = tokenResp.RefreshToken
				log.Println("Received new refresh token (rotation)")
			}
			ts.saveCredentials()
			log.Printf("Access token refreshed, expires at %v", ts.expiresAt)
		}
		ts.refreshing = false
		ts.refreshCond.Broadcast()
		ts.mu.Unlock()
	}()
	
	// Perform the refresh (without holding the lock)
	log.Println("Refreshing access token...")
	
	reqBody := map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
		"client_id":     claudeOAuthClientID,
	}
	
	jsonBody, err := json.Marshal(reqBody)
	if err != nil {
		refreshErr = fmt.Errorf("failed to marshal request: %w", err)
		return refreshErr
	}
	
	req, err := http.NewRequest("POST", claudeOAuthTokenURL, bytes.NewReader(jsonBody))
	if err != nil {
		refreshErr = fmt.Errorf("failed to create request: %w", err)
		return refreshErr
	}
	
	req.Header.Set("Content-Type", "application/json")
	
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		refreshErr = fmt.Errorf("failed to send request: %w", err)
		return refreshErr
	}
	defer resp.Body.Close()
	
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		refreshErr = fmt.Errorf("failed to read response: %w", err)
		return refreshErr
	}
	
	if resp.StatusCode != http.StatusOK {
		refreshErr = fmt.Errorf("token refresh failed (status %d): %s", resp.StatusCode, string(body))
		return refreshErr
	}
	
	if err := json.Unmarshal(body, &tokenResp); err != nil {
		refreshErr = fmt.Errorf("failed to parse response: %w", err)
		return refreshErr
	}
	
	return nil
}

// GetAccessToken returns a valid access token, refreshing if necessary
func (ts *TokenService) GetAccessToken() (string, time.Time, error) {
	ts.mu.RLock()
	
	// Check if we have a valid token
	if ts.accessToken != "" && time.Now().Add(time.Duration(refreshBufferSeconds)*time.Second).Before(ts.expiresAt) {
		token := ts.accessToken
		expiresAt := ts.expiresAt
		ts.mu.RUnlock()
		return token, expiresAt, nil
	}
	ts.mu.RUnlock()
	
	// Need to refresh
	if err := ts.refreshAccessToken(); err != nil {
		return "", time.Time{}, err
	}
	
	ts.mu.RLock()
	defer ts.mu.RUnlock()
	return ts.accessToken, ts.expiresAt, nil
}

// API response types
type TokenAPIResponse struct {
	AccessToken string `json:"access_token"`
	ExpiresAt   int64  `json:"expires_at"` // Unix timestamp in seconds
	ExpiresIn   int    `json:"expires_in"` // Seconds until expiry
}

type ErrorResponse struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// authMiddleware checks for valid AUTH_TOKEN bearer authentication
func authMiddleware(authToken string, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if authToken == "" {
			// No auth configured, allow all
			next(w, r)
			return
		}
		
		auth := r.Header.Get("Authorization")
		expected := "Bearer " + authToken
		if auth != expected {
			w.WriteHeader(http.StatusUnauthorized)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "unauthorized", Message: "Invalid or missing Authorization header"})
			return
		}
		next(w, r)
	}
}

func main() {
	// Get configuration from environment
	refreshToken := os.Getenv("CLAUDE_REFRESH_TOKEN")
	credFile := os.Getenv("CREDENTIALS_FILE")
	port := os.Getenv("PORT")
	authToken := os.Getenv("AUTH_TOKEN") // Optional: protect endpoints
	
	if port == "" {
		port = defaultPort
	}
	
	// Default credentials file location
	if credFile == "" {
		credFile = "/data/credentials.json"
	}
	
	// Create token service
	tokenService := NewTokenService(refreshToken, credFile)
	
	// Verify we have a refresh token
	if tokenService.refreshToken == "" {
		log.Fatal("No refresh token available. Set CLAUDE_REFRESH_TOKEN environment variable or provide a credentials file.")
	}
	
	// Initial token fetch
	log.Println("Performing initial token refresh...")
	if _, _, err := tokenService.GetAccessToken(); err != nil {
		log.Printf("Warning: Initial token refresh failed: %v", err)
		log.Println("Will retry on first request...")
	}
	
	// Set up HTTP mux
	mux := http.NewServeMux()
	
	mux.HandleFunc("/token", authMiddleware(authToken, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "method_not_allowed", Message: "Use GET"})
			return
		}
		
		token, expiresAt, err := tokenService.GetAccessToken()
		if err != nil {
			log.Printf("Failed to get access token: %v", err)
			w.WriteHeader(http.StatusServiceUnavailable)
			json.NewEncoder(w).Encode(ErrorResponse{Error: "token_error", Message: err.Error()})
			return
		}
		
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(TokenAPIResponse{
			AccessToken: token,
			ExpiresAt:   expiresAt.Unix(),
			ExpiresIn:   int(time.Until(expiresAt).Seconds()),
		})
	}))
	
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("OK"))
	})
	
	mux.HandleFunc("/status", authMiddleware(authToken, func(w http.ResponseWriter, r *http.Request) {
		tokenService.mu.RLock()
		hasToken := tokenService.accessToken != ""
		expiresAt := tokenService.expiresAt
		tokenService.mu.RUnlock()
		
		status := map[string]interface{}{
			"has_access_token": hasToken,
			"healthy":          hasToken && time.Now().Before(expiresAt),
		}
		
		if hasToken {
			status["expires_at"] = expiresAt.Unix()
			status["expires_in"] = int(time.Until(expiresAt).Seconds())
		}
		
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(status)
	}))
	
	// Create server with graceful shutdown support
	server := &http.Server{
		Addr:    ":" + port,
		Handler: mux,
	}
	
	// Channel to signal shutdown
	shutdownChan := make(chan struct{})
	
	// Background refresh goroutine
	go func() {
		for {
			tokenService.mu.RLock()
			expiresAt := tokenService.expiresAt
			tokenService.mu.RUnlock()
			
			// Calculate when to refresh (5 minutes before expiry, or 1 minute if already past that)
			refreshAt := expiresAt.Add(-time.Duration(refreshBufferSeconds) * time.Second)
			sleepDuration := time.Until(refreshAt)
			
			if sleepDuration < time.Minute {
				sleepDuration = time.Minute
			}
			
			log.Printf("Next background refresh in %v", sleepDuration.Round(time.Second))
			
			select {
			case <-time.After(sleepDuration):
				if _, _, err := tokenService.GetAccessToken(); err != nil {
					log.Printf("Background refresh failed: %v", err)
				}
			case <-shutdownChan:
				log.Println("Background refresh goroutine shutting down")
				return
			}
		}
	}()
	
	// Handle graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan
		log.Printf("Received signal %v, shutting down...", sig)
		
		// Stop background refresh
		close(shutdownChan)
		
		// Graceful shutdown with timeout
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		
		if err := server.Shutdown(ctx); err != nil {
			log.Printf("Shutdown error: %v", err)
		}
	}()
	
	log.Printf("Claude Token Service starting on port %s", port)
	if authToken != "" {
		log.Printf("Authentication enabled (AUTH_TOKEN set)")
	} else {
		log.Printf("WARNING: No AUTH_TOKEN set - endpoints are unprotected!")
	}
	log.Printf("Endpoints:")
	log.Printf("  GET /token  - Get a valid access token")
	log.Printf("  GET /health - Health check (no auth required)")
	log.Printf("  GET /status - Service status with token expiry info")
	
	if err := server.ListenAndServe(); err != http.ErrServerClosed {
		log.Fatal(err)
	}
	log.Println("Server stopped")
}
