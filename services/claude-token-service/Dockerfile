FROM golang:1.21-alpine AS builder

WORKDIR /app

# Copy go mod file
COPY go.mod ./

# Copy source
COPY main.go ./

# Build
RUN CGO_ENABLED=0 GOOS=linux go build -o /claude-token-service .

# Final stage
FROM alpine:3.19

RUN apk --no-cache add ca-certificates

WORKDIR /app

# Create data directory for credentials persistence
RUN mkdir -p /data

COPY --from=builder /claude-token-service /app/claude-token-service

# Default port
ENV PORT=8080
ENV CREDENTIALS_FILE=/data/credentials.json

EXPOSE 8080

ENTRYPOINT ["/app/claude-token-service"]
