package main

import (
	"bufio"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"

	"github.com/gorilla/websocket"
)

var (
	upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     func(r *http.Request) bool { return true },
	}
	topicSubscribers = make(map[string][]*Client)
	subscribersMutex sync.RWMutex
	dataDir          = "data" // Directory to store message files
)

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	topic    string
	clientId string
	username string
}

func main() {
	// Ensure data directory exists
	if err := ensureDataDir(); err != nil {
		log.Fatalf("Failed to create data directory: %v", err)
	}

	http.Handle("/", http.FileServer(http.Dir("static")))
	http.HandleFunc("/ws", handleWebSocket)

	log.Println("Starting server on :8080")
	if err := http.ListenAndServe(":8080", nil); err != nil {
		log.Fatal("ListenAndServe: ", err)
	}
}

// ensureDataDir creates the data directory if it doesn't exist.
func ensureDataDir() error {
	return os.MkdirAll(dataDir, 0750)
}

// saveMessageToFile saves a single message to the topic's file.
// Each message is appended as a new line.
func saveMessageToFile(topic string, rawMessage string) error {
	filePath := filepath.Join(dataDir, topic+".txt")
	file, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	defer file.Close()

	if _, err := file.WriteString(rawMessage + "\n"); err != nil {
		return err
	}
	log.Printf("Message saved to file for topic: %s", topic)
	return nil
}

// readMessagesForTopic reads all messages for a topic from its file.
// Returns a slice of strings, where each string is one message.
func readMessagesForTopic(topic string) ([]string, error) {
	filePath := filepath.Join(dataDir, topic+".txt")
	file, err := os.Open(filePath) // Use os.Open for read-only
	if err != nil {
		if os.IsNotExist(err) {
			return []string{}, nil // No history if file doesn't exist
		}
		return nil, err
	}
	defer file.Close()

	var messages []string
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		messages = append(messages, scanner.Text())
	}
	return messages, scanner.Err()
}

func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Upgrade error:", err)
		return
	}
	defer conn.Close()

	client := &Client{conn: conn, topic: ""}

	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			log.Println("Read error:", err)
			removeClient(client)
			break
		}

		if client.topic == "" {
			client.topic = string(message)
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
			historyMessages, err := readMessagesForTopic(client.topic)
			if err != nil {
				log.Printf("Error getting message history for topic %s: %v", client.topic, err)
			} else if len(historyMessages) > 0 {
				// Wrap raw message strings into objects for client compatibility
				wrappedMessages := make([]map[string]string, len(historyMessages))
				for i, msgStr := range historyMessages {
					wrappedMessages[i] = map[string]string{"content": msgStr}
				}
				historyPacket := map[string]interface{}{
					"type":     "history",
					"messages": wrappedMessages,
				}
				jsonPacket, err := json.Marshal(historyPacket)
				if err != nil {
					log.Printf("Error marshalling history packet: %v", err)
				} else {
					if err := client.conn.WriteMessage(websocket.TextMessage, jsonPacket); err != nil {
						log.Printf("Error sending history to client %s: %v", client.clientId, err)
					}
				}
			}
			sendUserList(client) // Send user list after history
		} else {
			if err := saveMessageToFile(client.topic, string(message)); err != nil {
				log.Printf("Error saving message to file: %v", err)
			}
			broadcastToTopic(client.topic, messageType, message, client)
		}
	}
}

// addClient adds a client to the subscribers list for their topic
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
		if c.clientId != "" && c.username != "" { // Ensure client has ID and username
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
	jsonPacket, err := json.Marshal(packet)
	if err != nil {
		log.Printf("Error marshalling userlist packet: %v", err)
		return
	}
	if err := client.conn.WriteMessage(websocket.TextMessage, jsonPacket); err != nil {
		log.Printf("Error sending userlist to client %s: %v", client.clientId, err)
	}
}

// removeClient removes a client from all subscription lists
func removeClient(clientToRemove *Client) {
	subscribersMutex.Lock()
	defer subscribersMutex.Unlock()
	
	if clientToRemove.topic == "" {
		return // Client was never fully subscribed
	}
	
	// Remove the client from the specific topic list
	subscribers := topicSubscribers[clientToRemove.topic]
	for i, client := range subscribers {
		if client == clientToRemove {
			topicSubscribers[clientToRemove.topic] = append(subscribers[:i], subscribers[i+1:]...)
			log.Printf("Client %s (%s) removed from topic %s", clientToRemove.username, clientToRemove.clientId, clientToRemove.topic)
			break
		}
	}
	
	// If topic has no subscribers left, delete the topic key
	if len(topicSubscribers[clientToRemove.topic]) == 0 {
		delete(topicSubscribers, clientToRemove.topic)
		log.Printf("Topic %s removed as it has no more subscribers", clientToRemove.topic)
	}
	
	// Broadcast updated user list to remaining clients in the topic
	remainingClients := topicSubscribers[clientToRemove.topic]
	users := make([]map[string]string, 0, len(remainingClients))
	for _, c := range remainingClients {
		if c.clientId != "" && c.username != "" { // Ensure client has ID and username
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
	jsonPacket, err := json.Marshal(packet)
	if err != nil {
		log.Printf("Error marshalling userlist packet after client removal: %v", err)
		return
	}
	
	for _, client := range remainingClients {
		if err := client.conn.WriteMessage(websocket.TextMessage, jsonPacket); err != nil {
			log.Printf("Error sending updated userlist to client %s: %v", client.clientId, err)
		}
	}
}

// broadcastToTopic sends a message to all clients subscribed to a specific topic, except the sender
func broadcastToTopic(topic string, messageType int, message []byte, sender *Client) {
	subscribersMutex.RLock()
	defer subscribersMutex.RUnlock()
	
	for _, client := range topicSubscribers[topic] {
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
