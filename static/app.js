// Global variables
let socket;
let encryptionKey;
let topicKey;
let isConnected = false;

// Blockchain-related variables
let previousMessageHash = null; // Hash of the last message in our chain
let messageChain = {}; // Keep track of message chain for verification
let clientId = generateClientId(); // Unique identifier for this client session

// Online users tracking
let onlineUsers = {}; // Map of clientId -> username

// Generate a random client ID
function generateClientId() {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
}

// Generate a deterministic funny username from a client ID
function generateUsername(id) {
    // List of fun adjectives and animals
    const adjectives = [
        'Silly', 'Jumpy', 'Sneaky', 'Fluffy', 'Bouncy', 'Jazzy', 'Sparkly', 
        'Wiggly', 'Fuzzy', 'Zippy', 'Twinkly', 'Bubbly', 'Giggly', 'Wobbly',
        'Quirky', 'Squishy', 'Zany', 'Peppy', 'Glittery', 'Snazzy'
    ];
    
    const animals = [
        'Panda', 'Fox', 'Narwhal', 'Axolotl', 'Sloth', 'Platypus', 'Penguin', 
        'Raccoon', 'Wombat', 'Koala', 'Otter', 'Hedgehog', 'Quokka', 'Chameleon',
        'Capybara', 'Lemur', 'Dolphin', 'Lynx', 'Meerkat', 'Armadillo'
    ];
    
    // Use the client ID to deterministically select an adjective and animal
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
        hash = ((hash << 5) - hash) + id.charCodeAt(i);
        hash = hash & hash; // Convert to 32bit integer
    }
    
    // Ensure hash is positive
    hash = Math.abs(hash);
    
    // Select adjective and animal based on hash
    const adjIndex = hash % adjectives.length;
    const animalIndex = Math.floor(hash / adjectives.length) % animals.length;
    
    return adjectives[adjIndex] + animals[animalIndex];
}

// Store the username for this session
const username = generateUsername(clientId);

// DOM elements
const loginSection = document.getElementById('login-section');
const chatSection = document.getElementById('chat-section');
const loginForm = document.getElementById('login-form');
const messageForm = document.getElementById('message-form');
const messagesContainer = document.getElementById('messages');
const messageInput = document.getElementById('message-input');
const secretPhraseInput = document.getElementById('secret-phrase');
const topicDisplay = document.getElementById('topic-display');

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
    // Handle login form submission
    loginForm.addEventListener('submit', handleLogin);
    
    // Handle message form submission
    messageForm.addEventListener('submit', handleSendMessage);
    
    // Set up beforeunload handler to notify others when leaving
    window.addEventListener('beforeunload', function() {
        if (socket && socket.readyState === WebSocket.OPEN && username) {
            // Send leave message
            sendPresenceMessage('leave');
        }
    });
});

// Handle login and key generation
function handleLogin(e) {
    e.preventDefault();
    
    const secretPhrase = secretPhraseInput.value.trim();
    if (!secretPhrase) {
        alert('Please enter a secret phrase');
        return;
    }
    
    // Generate encryption key using PBKDF2 with the passphrase itself as salt
    // This still provides strong key derivation with good iteration count
    const keyBytes = CryptoJS.PBKDF2(secretPhrase, secretPhrase, {
        keySize: 256/32, // 256 bits
        iterations: 10000
    });
    encryptionKey = keyBytes.toString();
    
    // Generate topic key (SHA-256 hash of the encryption key)
    // We use SHA-256 here just to get a consistent length topic identifier
    topicKey = CryptoJS.SHA256(encryptionKey).toString();
    
    // Display a shortened version of the topic for user reference
    topicDisplay.textContent = topicKey.substring(0, 10) + '...';
    
    // Connect to WebSocket server
    connectWebSocket();
    
    // Hide login section, show chat section
    loginSection.style.display = 'none';
    chatSection.style.display = 'block';
    
    // Focus the message input
    messageInput.focus();
    
    // Initialize online users list with current user
    addOnlineUser(clientId, username);
    updateOnlineUsersList();
    
    // After connection is established, send a presence message
    setTimeout(() => {
        sendPresenceMessage('join');
    }, 1000);
}

// Send a presence message to inform others about our status
function sendPresenceMessage(type) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        console.log('Cannot send presence message: WebSocket not open');
        return;
    }
    
    // Create a presence message
    const presenceMsg = {
        type: 'presence',
        action: type, // 'join' or 'leave'
        clientId: clientId,
        username: username,
        timestamp: Date.now()
    };
    
    // Encrypt the presence message
    const presenceString = JSON.stringify(presenceMsg);
    const encrypted = CryptoJS.AES.encrypt(presenceString, encryptionKey);
    const ciphertext = encrypted.toString();
    
    // Create HMAC for authentication
    const hmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
    
    // Send authenticated presence message
    // Format: hmac:presence:ciphertext to distinguish from regular messages
    const authenticatedMessage = hmac + ':presence:' + ciphertext;
    socket.send(authenticatedMessage);
    
    console.log('Sent presence message:', type);
}

// Connect to WebSocket server
function connectWebSocket() {
    // Determine WebSocket URL (use wss:// for HTTPS sites)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;
    
    // Create WebSocket connection
    socket = new WebSocket(wsUrl);
    
    // Connection opened
    socket.addEventListener('open', function(event) {
        console.log('WebSocket connection established');
        
        // Send the topic key to join/create the chat room
        socket.send(topicKey);
        // Immediately send client info (clientId, username)
        const clientInfo = { clientId: clientId, username: username };
        socket.send(JSON.stringify(clientInfo));
        
        // Add system message
        addSystemMessage('Connected to chat. Messages are end-to-end encrypted.');
    });
    
    // Handle WebSocket close
    socket.addEventListener('close', function(event) {
        console.log('WebSocket connection closed');
        addSystemMessage('Disconnected from chat. Refresh to reconnect.');
    });

    // Handle incoming WebSocket messages
    socket.addEventListener('message', handleSocketMessage);
}

// Handle incoming WebSocket messages
function handleSocketMessage(event) {
    console.log('Received message:', event.data.substring(0, 100) + '...');
    try {
        // Try to parse the message as JSON first (for history/userlist packets)
        const data = JSON.parse(event.data);
        if (data.type === 'history') {
            handleHistoryMessages(data.messages);
            return;
        } else if (data.type === 'userlist') {
            // Populate onlineUsers from server-provided userlist
            onlineUsers = {};
            if (Array.isArray(data.users)) {
                data.users.forEach(function(u) {
                    if (u.clientId && u.username) {
                        onlineUsers[u.clientId] = u.username;
                    }
                });
            }
            updateOnlineUsersList();
            return;
        }
    } catch (e) {
        // Not JSON, treat as a regular encrypted message
    }
    
    try {
        let decryptedText;
        
        // Check if this is an authenticated message (contains HMAC)
        if (event.data.includes(':')) {
            // Check for special message types
            if (event.data.includes(':presence:')) {
                // Handle presence message
                const [receivedHmac, messageType, ciphertext] = event.data.split(':', 3);
                
                // Verify the HMAC
                const computedHmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
                
                if (receivedHmac !== computedHmac) {
                    console.error('Presence message authentication failed');
                    return;
                }
                
                // Decrypt and process the presence message
                const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey);
                const presenceData = JSON.parse(decrypted.toString(CryptoJS.enc.Utf8));
                
                // Process user presence update
                if (presenceData.action === 'join') {
                    // Add user to online users
                    addOnlineUser(presenceData.clientId, presenceData.username);
                    if (presenceData.clientId !== clientId) {
                        addSystemMessage(`${presenceData.username} joined the chat`);
                    }
                } else if (presenceData.action === 'leave') {
                    // Remove user from online users
                    if (presenceData.clientId !== clientId) {
                        addSystemMessage(`${onlineUsers[presenceData.clientId] || 'Someone'} left the chat`);
                        removeOnlineUser(presenceData.clientId);
                    }
                }
                
                return; // Skip regular message processing
            }
            
            // Regular authenticated message
            const [receivedHmac, ciphertext] = event.data.split(':', 2);
            
            // Verify the HMAC
            const computedHmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
            
            // If HMACs don't match, message has been tampered with
            if (receivedHmac !== computedHmac) {
                console.error('Message authentication failed: HMAC verification failed');
                addMessage('⚠️ Received a message that failed authentication (possible tampering)', false, null, 'System');
                return;
            }
            
            // HMAC is valid, now decrypt the message
            const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey);
            decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        } else {
            // Legacy message without authentication (for backward compatibility)
            const decrypted = CryptoJS.AES.decrypt(event.data, encryptionKey);
            decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
        }
        
        // Check if decryption was successful
        if (!decryptedText) {
            console.error('Failed to decrypt message');
            return;
        }
        
        try {
            // Parse the decrypted text as a message block
            const messageBlock = JSON.parse(decryptedText);
            
            // Validate the message structure
            if (!messageBlock.content || !messageBlock.timestamp || 
                !messageBlock.sender || messageBlock.previousHash === undefined) {
                console.error('Invalid message structure:', messageBlock);
                return;
            }
            
            // Compute the hash of this message
            const messageString = JSON.stringify(messageBlock);
            const currentHash = CryptoJS.SHA256(messageString).toString();
            
            // Check if we've already seen this message (prevent replay)
            if (messageChain[currentHash]) {
                console.log('Duplicate message detected, ignoring:', currentHash);
                return;
            }
            
            // Verify the previous hash if this isn't the first message
            if (messageBlock.previousHash) {
                // If the previous hash doesn't exist in our chain and isn't null
                // this could be a forged message or we missed some messages
                if (messageBlock.previousHash !== null && !messageChain[messageBlock.previousHash]) {
                    console.warn('Message references unknown previous hash:', messageBlock.previousHash);
                    // We still accept the message, but with a warning
                    // In a stricter implementation, we might reject it
                }
            }
            
            // Message passed verification, add to our chain
            messageChain[currentHash] = messageBlock;
            
            // Update our previous hash if needed
            if (previousMessageHash === null || 
                messageBlock.timestamp > (messageChain[previousMessageHash]?.timestamp || 0)) {
                previousMessageHash = currentHash;
            }
            
            // Display the message content with username
            addMessage(messageBlock.content, false, null, messageBlock.username || 'Anonymous');
            
            console.log('Verified and added message to chain:', currentHash);
        } catch (parseError) {
            console.error('Failed to parse message as JSON:', parseError);
            // Fallback for messages using the old format (not blockchain)
            addMessage(decryptedText, false);
        }
    } catch (error) {
        console.error('Failed to decrypt message:', error);
        // Silently ignore messages that fail to decrypt
        // This means they were either not encrypted with our key or were corrupted
    }
}

// Handle history messages received when joining a chat
function handleHistoryMessages(messages) {
    console.log('handleHistoryMessages called with', messages?.length || 0, 'messages');
    if (!messages || messages.length === 0) {
        console.log('No messages in history');
        return;
    }
    
    console.log('Processing message history:', messages);
    // Add a system message indicating history is being loaded
    addSystemMessage(`Loading ${messages.length} previous messages...`);
    
    // Sort messages by timestamp to ensure proper chain order
    const sortedMessages = [...messages].sort((a, b) => {
        return new Date(a.timestamp) - new Date(b.timestamp);
    });
    
    // Reset chain variables to handle history as a fresh chain
    const tempChain = {};
    let earliestHash = null;
    let latestHash = null;
    let failedDecryption = 0;
    
    // First pass: Decrypt and verify all messages
    const processedMessages = [];
    
    sortedMessages.forEach(message => {
        try {
            let decryptedText;
            
            // Check if this is an authenticated message (contains HMAC)
            if (message.content.includes(':')) {
                // Split the HMAC and ciphertext
                const [receivedHmac, ciphertext] = message.content.split(':', 2);
                
                // Verify the HMAC
                const computedHmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
                
                // If HMACs don't match, message has been tampered with
                if (receivedHmac !== computedHmac) {
                    console.error('History message authentication failed: HMAC verification failed');
                    failedDecryption++;
                    return; // Skip this message
                }
                
                // HMAC is valid, now decrypt the message
                const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey);
                decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            } else {
                // Legacy message without authentication
                const decrypted = CryptoJS.AES.decrypt(message.content, encryptionKey);
                decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            }
            
            if (!decryptedText) {
                console.warn('Could not decrypt history message');
                failedDecryption++;
                return; // Skip this message
            }
            
            try {
                // Try to parse as a blockchain message
                const messageBlock = JSON.parse(decryptedText);
                
                // Check if it has the blockchain structure
                if (messageBlock.content && messageBlock.timestamp && 
                    messageBlock.sender && messageBlock.previousHash !== undefined) {
                    
                    // Compute the hash of this message
                    const messageString = JSON.stringify(messageBlock);
                    const currentHash = CryptoJS.SHA256(messageString).toString();
                    
                    // Store in our temporary chain
                    tempChain[currentHash] = messageBlock;
                    
                    // Track the latest hash (newest message)
                    if (latestHash === null || messageBlock.timestamp > tempChain[latestHash].timestamp) {
                        latestHash = currentHash;
                    }
                    
                    // Track the earliest hash (oldest message)
                    if (earliestHash === null || messageBlock.timestamp < tempChain[earliestHash].timestamp) {
                        earliestHash = currentHash;
                    }
                    
                    // Format the timestamp
                    const timestamp = new Date(messageBlock.timestamp);
                    const timeString = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const dateString = timestamp.toLocaleDateString();
                    
                    processedMessages.push({
                        hash: currentHash,
                        content: messageBlock.content,
                        formattedTime: `${dateString} ${timeString}`,
                        timestamp: messageBlock.timestamp,
                        previousHash: messageBlock.previousHash,
                        username: messageBlock.username || 'Anonymous'
                    });
                    
                    return; // Skip to next message
                }
            } catch (parseError) {
                // Not a blockchain message, continue with legacy format
            }
            
            // Legacy format (not blockchain) - just display with timestamp
            const timestamp = new Date(message.timestamp);
            const timeString = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const dateString = timestamp.toLocaleDateString();
            
            // Add to processed messages
            processedMessages.push({
                legacy: true,
                content: decryptedText,
                formattedTime: `${dateString} ${timeString}`,
                timestamp: message.timestamp
            });
        } catch (error) {
            console.log('Failed to decrypt history message:', error);
            failedDecryption++;
            // Silently ignore messages that fail to decrypt
        }
    });
    
    // Second pass: Verify chain integrity and display messages
    let verifiedCount = 0;
    let brokenChains = 0;
    
    // Display all messages in order
    processedMessages.forEach(msg => {
        if (msg.legacy) {
            // Display legacy message
            addMessage(msg.content, false, msg.formattedTime);
        } else {
            // Verify chain integrity if possible
            const prevHash = msg.previousHash;
            if (prevHash !== null && !tempChain[prevHash] && Object.keys(tempChain).length > 1) {
                console.warn('History message references unknown previous hash:', prevHash);
                brokenChains++;
            } else {
                verifiedCount++;
            }
            
            // Display the message with username
            addMessage(msg.content, false, msg.formattedTime, msg.username);
        }
    });
    
    // Update our main chain with the history
    Object.assign(messageChain, tempChain);
    
    // Set the previousMessageHash to the latest message's hash
    if (latestHash) {
        previousMessageHash = latestHash;
    }
    
    // Add a system message with chain verification status
    if (verifiedCount > 0) {
        if (brokenChains > 0) {
            addSystemMessage(`End of message history. Verified ${verifiedCount} messages, found ${brokenChains} chain discontinuities.`);
        } else {
            addSystemMessage(`End of message history. Verified ${verifiedCount} messages with intact blockchain.`);
        }
    } else {
        addSystemMessage('End of message history.');
    }
    
    // Scroll to the bottom of the chat
    scrollToBottom();
}

// Handle WebSocket connection close
function handleSocketClose() {
    addSystemMessage('Disconnected from chat. Refresh the page to reconnect.');
}

// Handle WebSocket errors
function handleSocketError(error) {
    console.error('WebSocket error:', error);
    addSystemMessage('Error connecting to chat server.');
}

// Send an encrypted message
function handleSendMessage(e) {
    e.preventDefault();
    
    const messageText = messageInput.value.trim();
    if (!messageText || !socket || socket.readyState !== WebSocket.OPEN) {
        return;
    }
    
    try {
        // Create a message block with blockchain-like structure
        const messageBlock = {
            content: messageText,
            timestamp: Date.now(),
            sender: clientId,
            username: username, // Include the funny username
            previousHash: previousMessageHash,
            nonce: Math.floor(Math.random() * 1000000) // Add randomness
        };
        
        // Convert the message block to a string for hashing
        const messageString = JSON.stringify(messageBlock);
        
        // Create a hash of this message for the next message in the chain
        const currentHash = CryptoJS.SHA256(messageString).toString();
        
        // Update the previous hash for the next message
        previousMessageHash = currentHash;
        
        // Store this message in our chain
        messageChain[currentHash] = messageBlock;
        
        // Implement authenticated encryption
        // 1. Encrypt the message with AES
        const encrypted = CryptoJS.AES.encrypt(messageString, encryptionKey);
        const ciphertext = encrypted.toString();
        
        // 2. Create an HMAC for authentication (integrity check)
        const hmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
        
        // 3. Combine the HMAC and ciphertext
        // Format: hmac:ciphertext
        const authenticatedMessage = hmac + ':' + ciphertext;
        
        // Send the authenticated encrypted message
        socket.send(authenticatedMessage);
        
        // Display the message in our own chat
        addMessage(messageText, true);
        
        // Clear the input field
        messageInput.value = '';
        
        console.log('Sent message with hash:', currentHash);
    } catch (error) {
        console.error('Failed to encrypt and send message:', error);
        addSystemMessage('Failed to send message. Error encrypting content.');
    }
}

// Add a message to the chat
function addMessage(message, isOutgoing = false, timestamp = null, senderUsername = null) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message');
    if (isOutgoing) {
        messageElement.classList.add('outgoing');
    }
    
    // Create header div for username and timestamp
    const headerDiv = document.createElement('div');
    headerDiv.classList.add('message-header');
    
    // Add username if provided, otherwise use our own username for outgoing messages
    const displayUsername = senderUsername || (isOutgoing ? username : null);
    if (displayUsername) {
        const usernameSpan = document.createElement('span');
        usernameSpan.classList.add('username');
        usernameSpan.textContent = displayUsername;
        headerDiv.appendChild(usernameSpan);
    }
    
    // Add timestamp if provided
    if (timestamp) {
        const timeSpan = document.createElement('span');
        timeSpan.classList.add('timestamp');
        timeSpan.textContent = timestamp;
        headerDiv.appendChild(timeSpan);
    }
    
    // Add the header if it has any content
    if (headerDiv.childNodes.length > 0) {
        messageElement.appendChild(headerDiv);
        messageElement.appendChild(document.createElement('br'));
    }
    
    // Add the message text
    const textNode = document.createTextNode(message);
    messageElement.appendChild(textNode);
    
    messagesContainer.appendChild(messageElement);
    
    // Scroll to the bottom
    scrollToBottom();
}

// Scroll to the bottom of the messages container
function scrollToBottom() {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Add a system message to the chat
function addSystemMessage(message) {
    const messageElement = document.createElement('div');
    messageElement.classList.add('message', 'system');
    const textNode = document.createTextNode(message);
    messageElement.appendChild(textNode);
    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// Update the online users list in the UI
function updateOnlineUsersList() {
    const usersList = document.getElementById('online-users-list');
    usersList.innerHTML = '';
    
    // First add current user at the top
    const currentUserItem = document.createElement('li');
    currentUserItem.classList.add('current-user');
    currentUserItem.textContent = username + ' (you)';
    usersList.appendChild(currentUserItem);
    
    // Then add all other users sorted alphabetically
    Object.entries(onlineUsers)
        .filter(([id, _]) => id !== clientId) // Exclude current user
        .sort(([_, usernameA], [__, usernameB]) => usernameA.localeCompare(usernameB))
        .forEach(([id, username]) => {
            const userItem = document.createElement('li');
            userItem.textContent = username;
            usersList.appendChild(userItem);
        });
}

// Add a user to the online users list
function addOnlineUser(id, username) {
    if (id && username && !onlineUsers[id]) {
        onlineUsers[id] = username;
        updateOnlineUsersList();
    }
}

// Remove a user from the online users list
function removeOnlineUser(id) {
    if (onlineUsers[id]) {
        delete onlineUsers[id];
        updateOnlineUsersList();
    }
}
