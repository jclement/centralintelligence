# Use the official Golang image to create a build artifact.
# This is known as a multi-stage build.
FROM golang:1.22-alpine AS builder

# Set the Current Working Directory inside the container
WORKDIR /app

# Copy go mod and sum files
COPY go.mod go.sum ./

# Download all dependencies. Dependencies will be cached if the go.mod and go.sum files are not changed
RUN go mod download

# Copy the source code into the container
COPY . .

# Build the Go app
# CGO_ENABLED=0 is important for a truly static binary, especially in Alpine
# -o /app/main creates an output file named 'main' in the /app directory
RUN CGO_ENABLED=0 go build -o /app/main .

# Start a new stage from scratch for a smaller image
FROM alpine:latest

WORKDIR /root/

# Copy the Pre-built binary file from the previous stage
COPY --from=builder /app/main .

# Copy static files
COPY static ./static

# Expose port 8080 to the outside world
EXPOSE 8080

# Command to run the executable
CMD ["./main"]
