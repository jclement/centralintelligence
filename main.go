package main

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/mattn/go-sqlite3"
)

var (
	// Upgrade HTTP connection to WebSocket
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		// Allow all origins for simplicity, in production you'd restrict this
		CheckOrigin: func(r *http.Request) bool { return true },
	}
	
	// topicSubscribers maps topic keys to lists of connected clients
	topicSubscribers = make(map[string][]*Client)
	
	// Mutex to protect concurrent access to the subscribers map
	subscribersMutex sync.RWMutex
	
	// Database connection
	db *sql.DB
)

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	topic    string
	clientId string
	username string
}

// Message represents a chat message that will be stored in the database
type Message struct {
	Topic     string    `json:"topic"`
	Content   string    `json:"content"` // Encrypted content
	Timestamp time.Time `json:"timestamp"`
}

func main() {
	// Initialize database
	var err error
	db, err = sql.Open("sqlite3", "./chat.db")
	if err != nil {
		log.Fatal("Failed to open database: ", err)
	}
	defer db.Close()
	
	// Create tables if they don't exist
	if err = createTables(); err != nil {
		log.Fatal("Failed to create tables: ", err)
	}
	
	// Serve static files from the "static" directory
	fs := http.FileServer(http.Dir("static"))
	http.Handle("/", fs)
	
	// WebSocket endpoint for chat
	http.HandleFunc("/ws", handleWebSocket)
	
	// Start the server
	log.Println("Starting server on :8080")
	err = http.ListenAndServe(":8080", nil)
	if err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}

// createTables creates the necessary database tables if they don't exist
func createTables() error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS messages (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			topic TEXT NOT NULL,
			content TEXT NOT NULL,
			timestamp DATETIME NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
	`)
	return err
}

// saveMessage saves an encrypted message to the database
func saveMessage(topic string, content string) error {
	_, err := db.Exec(
		"INSERT INTO messages (topic, content, timestamp) VALUES (?, ?, ?)",
		topic,
		content,
		time.Now(),
	)
	if err != nil {
		log.Printf("Error saving message: %v", err)
		return err
	}
	log.Printf("Message saved to database for topic: %s", topic)
	return nil
}

// getMessageHistory retrieves message history for a topic
func getMessageHistory(topic string) ([]Message, error) {
	rows, err := db.Query(
		"SELECT topic, content, timestamp FROM messages WHERE topic = ? ORDER BY timestamp ASC",
		topic,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	
	var messages []Message
	for rows.Next() {
		var msg Message
		var timestamp string
		if err := rows.Scan(&msg.Topic, &msg.Content, &timestamp); err != nil {
			return nil, err
		}
		// Parse the timestamp - try multiple formats
		formats := []string{
			"2006-01-02T15:04:05.999999999-07:00", // ISO-8601 with timezone
			"2006-01-02 15:04:05.999999999-07:00", // Space separator with timezone
			"2006-01-02T15:04:05-07:00",           // ISO-8601 with timezone, no fractional seconds
			"2006-01-02 15:04:05-07:00",           // Space separator with timezone, no fractional seconds
			"2006-01-02T15:04:05Z",                // UTC time
			"2006-01-02 15:04:05",                // No timezone
			time.RFC3339,                          // Standard RFC3339
		}
		
		var parseErr error
		for _, format := range formats {
			msg.Timestamp, parseErr = time.Parse(format, timestamp)
			if parseErr == nil {
				break
			}
		}
		
		if parseErr != nil {
			log.Printf("Failed to parse timestamp '%s' with any known format", timestamp)
			return nil, parseErr
		}
		messages = append(messages, msg)
	}
	
	return messages, nil
}

// handleWebSocket processes WebSocket connections
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade the HTTP connection to a WebSocket connection
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()
	
	// New client without a topic yet
	client := &Client{conn: conn, topic: ""}
	
	// Handle messages from this client
	for {
		// Read message
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error:", err)
			removeClient(client)
			break
		}
		
		// Process the message
		if client.topic == "" {
			// First message is the topic key
			client.topic = string(message)
			// Next message must be client info
			_, clientInfoMsg, err := conn.ReadMessage()
			if err != nil {
				log.Println("Failed to read client info message:", err)
				removeClient(client)
				break
			}
			var info struct {
				ClientId string `json:"clientId"`
				Username string `json:"username"`
			}
			if err := json.Unmarshal(clientInfoMsg, &info); err != nil {
				log.Println("Failed to parse client info JSON:", err)
				removeClient(client)
				break
			}
			client.clientId = info.ClientId
			client.username = info.Username
			addClient(client)
			log.Printf("Client subscribed to topic: %s as %s (%s)", client.topic, client.username, client.clientId)
			// Send message history to the new client
			sendMessageHistory(client)
			// Send userlist to the new client
			sendUserList(client)
		} else {
			// Save message to database
			if err := saveMessage(client.topic, string(message)); err != nil {
				log.Printf("Error saving message to database: %v", err)
			}
			
			// Broadcast message to all subscribers
			broadcastToTopic(client.topic, messageType, message, client)
		}
	}
}

// sendMessageHistory sends the message history to a newly connected client
func sendMessageHistory(client *Client) {
	log.Printf("Retrieving message history for topic: %s", client.topic)
	history, err := getMessageHistory(client.topic)
	if err != nil {
		log.Printf("Error retrieving message history: %v", err)
		return
	}
	
	log.Printf("Found %d messages in history for topic: %s", len(history), client.topic)
	
	if len(history) > 0 {
		// Create a history packet with all messages
		historyData, err := json.Marshal(struct {
			Type     string    `json:"type"`
			Messages []Message `json:"messages"`
		}{
			Type:     "history",
			Messages: history,
		})
		
		if err != nil {
			log.Printf("Error marshaling history data: %v", err)
			return
		}
		
		// Send the history packet
		log.Printf("Sending history packet with %d messages", len(history))
		if err := client.conn.WriteMessage(websocket.TextMessage, historyData); err != nil {
			log.Printf("Error sending history: %v", err)
		} else {
			log.Printf("Successfully sent history packet to client")
		}
	} else {
		log.Printf("No message history to send for topic: %s", client.topic)
	}
}

// addClient adds a client to a topic's subscriber list
func addClient(client *Client) {
	subscribersMutex.Lock()
	defer subscribersMutex.Unlock()
	topicSubscribers[client.topic] = append(topicSubscribers[client.topic], client)
}

// sendUserList sends the current user list for a topic to the specified client
func sendUserList(client *Client) {
	subscribersMutex.RLock()
	defer subscribersMutex.RUnlock()
	clients := topicSubscribers[client.topic]
	users := make([]map[string]string, 0, len(clients))
	for _, c := range clients {
		if c.clientId != "" && c.username != "" {
			users = append(users, map[string]string{
				"clientId": c.clientId,
				"username": c.username,
			})
		}
	}
	packet := map[string]interface{}{
		"type":  "userlist",
		"users": users,
	}
	data, err := json.Marshal(packet)
	if err != nil {
		log.Printf("Failed to marshal userlist: %v", err)
		return
	}
	if err := client.conn.WriteMessage(websocket.TextMessage, data); err != nil {
		log.Printf("Failed to send userlist: %v", err)
	}
}

// removeClient removes a client from its topic
func removeClient(client *Client) {
	if client.topic == "" {
		return
	}
	
	subscribersMutex.Lock()
	defer subscribersMutex.Unlock()
	
	// Find and remove the client
	clients := topicSubscribers[client.topic]
	for i, c := range clients {
		if c == client {
			// Remove without preserving order
			clients[i] = clients[len(clients)-1]
			topicSubscribers[client.topic] = clients[:len(clients)-1]
			break
		}
	}
	
	// If no more clients in the topic, remove the topic
	if len(topicSubscribers[client.topic]) == 0 {
		delete(topicSubscribers, client.topic)
	}
}

// broadcastToTopic sends a message to all clients in a topic except the sender
func broadcastToTopic(topic string, messageType int, message []byte, sender *Client) {
	subscribersMutex.RLock()
	defer subscribersMutex.RUnlock()
	
	for _, client := range topicSubscribers[topic] {
		// Skip the sender
		if client == sender {
			continue
		}
		
		err := client.conn.WriteMessage(messageType, message)
		if err != nil {
			log.Println("Write error:", err)
			// Don't remove here to avoid deadlock, client will be removed on read error
		}
	}
}
