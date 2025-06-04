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
const ciaMain = document.querySelector('.cia-main');
const chatSection = document.getElementById('chat-section');
const loginForm = document.getElementById('login-form');
const messageForm = document.getElementById('message-form');
const messagesContainer = document.getElementById('messages');

// Intercept the parody search form submission
if (loginForm) {
    loginForm.addEventListener('submit', function(event) {
        event.preventDefault();
        const secretPhraseInput = document.getElementById('secret-phrase');
        if (!secretPhraseInput) return;
        const secretPhrase = secretPhraseInput.value.trim();
        if (!secretPhrase) return;
        // Hide parody homepage, show chat UI first
        if (ciaMain) ciaMain.style.display = 'none';
        if (chatSection) chatSection.style.display = 'block';
        // Then set up encryption, topic, and connect
        handleLogin(secretPhrase);
    });
}

const messageInput = document.getElementById('message-input');
const secretPhraseInput = document.getElementById('secret-phrase');
const topicDisplay = document.getElementById('topic-display');

// Initialize the application
document.addEventListener('DOMContentLoaded', function() {
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
function handleLogin(secretPhrase) { // e is removed, secretPhrase is now the direct argument
    // secretPhrase is already trimmed and validated by the caller
    
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
    
    // DOM manipulation (hiding login, showing chat) is now handled by the calling event listener
    
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

function handleHistoryMessages(messages) {
    console.log('handleHistoryMessages called with', messages?.length || 0, 'messages');
    if (!messages || messages.length === 0) {
        console.log('No messages in history');
        previousMessageHash = null; // Ensure null if no history
        addSystemMessage('No previous messages in this briefing.');
        return;
    }
    
    addSystemMessage(`Processing ${messages.length} previous messages...`);
    
    const sortedMessages = [...messages].sort((a, b) => {
        // Assuming 'a' and 'b' are the raw encrypted strings from server history
        // We need to decrypt them to get timestamp for sorting, which is inefficient here.
        // For now, we'll assume server sends them in a somewhat reasonable order or client handles minor out-of-order issues.
        // A better approach would be for server to send structured data with timestamps, or client to decrypt all then sort.
        // Given the current structure, we'll process as received and rely on later chain validation.
        return 0; // Placeholder: Actual sorting by encrypted timestamp is complex.
    });
    
    const tempChain = {};
    const processedMessages = [];
    let failedDecryption = 0;
    const uniqueMessageBlockHashes = new Set(); // To prevent duplicate messageBlock processing
    
    sortedMessages.forEach((messageObject, index) => {
        console.log(`[HISTORY DEBUG] --------------- Processing message ${index + 1} ---------------`);
        console.log('[HISTORY DEBUG] typeof messageObject:', typeof messageObject, 'messageObject:', JSON.parse(JSON.stringify(messageObject || {})));
        // Log content safely, handling if it's undefined or not an object that can be stringified directly for the second part
        let contentLog = messageObject && messageObject.content !== undefined ? messageObject.content : null;
        try {
            contentLog = JSON.parse(JSON.stringify(contentLog)); // Attempt to deep copy if it's an object/array
        } catch (e) { /* If it's a primitive or can't be stringified/parsed, use as is or null */ }
        console.log('[HISTORY DEBUG] typeof messageObject.content:', typeof (messageObject ? messageObject.content : undefined), 'messageObject.content (logged safely):', contentLog);

        const encryptedMessageString = messageObject.content;
        console.log('[HISTORY DEBUG] Raw encrypted string from .content:', String(encryptedMessageString).substring(0, 70) + '...');
        try {
            let decryptedText;
            
            if (!encryptedMessageString || typeof encryptedMessageString !== 'string' || !encryptedMessageString.includes(':')) {
                console.warn('Skipping history message: Invalid format (null or missing HMAC separator). Message:', String(encryptedMessageString).substring(0,50));
                failedDecryption++;
                return;
            }

            const [receivedHmac, ciphertext] = encryptedMessageString.split(':', 2);
            if (!ciphertext) {
                console.warn('Skipping history message: Invalid format (missing ciphertext). Message from .content:', encryptedMessageString.substring(0,50));
                failedDecryption++;
                return;
            }
            
            const computedHmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
            if (receivedHmac !== computedHmac) {
                console.error('History message authentication failed: HMAC verification failed. Message:', encryptedMessageString.substring(0,50));
                failedDecryption++;
                return;
            }
            
            const decrypted = CryptoJS.AES.decrypt(ciphertext, encryptionKey);
            decryptedText = decrypted.toString(CryptoJS.enc.Utf8);
            console.log('[HISTORY DEBUG] Raw decryptedText (first 100 chars):', String(decryptedText).substring(0,100));
            
            if (!decryptedText) {
                console.warn('Could not decrypt history message. Ciphertext:', ciphertext.substring(0,50));
                failedDecryption++;
                return;
            }
            
            let messageBlock;
            try {
                messageBlock = JSON.parse(decryptedText);
            } catch (parseError) {
                console.error('[HISTORY DEBUG] JSON.parse FAILED for decryptedText. Error:', parseError);
                console.error('[HISTORY DEBUG] Failed decryptedText was:', decryptedText);
                failedDecryption++; // Count this as a failure
                return; // Skip this message
            }
            console.log('[HISTORY DEBUG] Successfully parsed messageBlock:', JSON.parse(JSON.stringify(messageBlock))); // Deep copy for logging
            
            if (messageBlock.content && messageBlock.timestamp && 
                messageBlock.sender && messageBlock.previousHash !== undefined) {
                
                const messageString = JSON.stringify(messageBlock);
                console.log('[HISTORY DEBUG] Stringified messageBlock for hashing:', messageString);
                const currentBlockContentHash = CryptoJS.SHA256(messageString).toString();
                console.log('[HISTORY DEBUG] Calculated currentBlockContentHash:', currentBlockContentHash);
                console.log('[HISTORY DEBUG] uniqueMessageBlockHashes before check:', Array.from(uniqueMessageBlockHashes));

                // *** Check for duplicates based on messageBlock content hash ***
                if (uniqueMessageBlockHashes.has(currentBlockContentHash)) {
                    console.log('[HISTORY DEBUG] DUPLICATE FOUND in uniqueMessageBlockHashes. Hash:', currentBlockContentHash);
                    console.log('Duplicate history messageBlock content detected, skipping. Hash:', currentBlockContentHash);
                    return; // Skip this duplicate messageBlock
                }
                uniqueMessageBlockHashes.add(currentBlockContentHash);
                // *** End of duplicate check ***

                tempChain[currentBlockContentHash] = messageBlock; // Store by its own content hash
                
                const timestamp = new Date(messageBlock.timestamp);
                const timeString = timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                const dateString = timestamp.toLocaleDateString();
                
                processedMessages.push({
                    hash: currentBlockContentHash, // This is the hash of the messageBlock itself
                    content: messageBlock.content,
                    formattedTime: `${dateString} ${timeString}`,
                    timestamp: messageBlock.timestamp,
                    previousHash: messageBlock.previousHash,
                    username: messageBlock.username || 'Anonymous'
                });
            } else {
                // This is not a structured messageBlock, might be a legacy simple string or malformed.
                // For simplicity, we'll log and skip if it doesn't fit the expected structure.
                console.warn('Skipping history message: Not a valid messageBlock structure after decryption.', decryptedText.substring(0,100));
                failedDecryption++;
            }
        } catch (error) {
            console.error('Error processing individual history message object:', messageObject, 'Error:', error);
            failedDecryption++;
        }
    });
    
    // Sort processedMessages by timestamp before chain validation and display
    processedMessages.sort((a, b) => a.timestamp - b.timestamp);

    let validMessagesCount = 0;
    let latestValidMessageHashForGlobalPrev = null;
    let expectedPrevHashInChain = null; 

    // If there's at least one message, and the first one has a previousHash (could be null for the actual start of a chain)
    if (processedMessages.length > 0 && processedMessages[0].previousHash !== undefined) {
        expectedPrevHashInChain = processedMessages[0].previousHash; 
        // For the very first message in history, its stated previousHash is the start of our expectation.
        // If it's null, that's fine. If it's something else, the next message should point to this first message's hash.
    }
    
    processedMessages.forEach(msgData => {
        // Validate chain: current message's previousHash should match the expected one.
        // For the first message, its own previousHash is the baseline (expectedPrevHashInChain).
        // For subsequent, expectedPrevHashInChain would be the hash of the *previous successfully added message*.

        if (msgData.previousHash === expectedPrevHashInChain || validMessagesCount === 0) {
            addMessage(msgData.content, false, msgData.formattedTime, msgData.username);
            validMessagesCount++;
            latestValidMessageHashForGlobalPrev = msgData.hash; // This message's own hash becomes the new expectation
            expectedPrevHashInChain = msgData.hash; 
        } else {
            console.warn(`Blockchain history validation failed: Hash mismatch for message content "${msgData.content.substring(0,20)}...". Expected prev ${expectedPrevHashInChain}, got ${msgData.previousHash}. This message hash: ${msgData.hash}`);
            addMessage(`⚠️ Chain broken. Message: "${msgData.content.substring(0,30)}..."`, false, msgData.formattedTime, msgData.username + ' (chain inconsistent)');
            // Still add the message but mark inconsistency. Reset expectation for next message.
            validMessagesCount++;
            latestValidMessageHashForGlobalPrev = msgData.hash;
            expectedPrevHashInChain = msgData.hash; 
        }
    });
    
    if (latestValidMessageHashForGlobalPrev) {
        previousMessageHash = latestValidMessageHashForGlobalPrev;
        console.log('Set global previousMessageHash from history to:', previousMessageHash);
    } else {
        previousMessageHash = null; // No valid messages processed from history or no history
        console.log('No valid history messages to set previousMessageHash, set to null.');
    }

    if (failedDecryption > 0) {
        addSystemMessage(`⚠️ ${failedDecryption} historical messages had errors.`);
    }
    addSystemMessage(`${validMessagesCount} historical messages loaded.`);
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

// Send an encrypted message
function handleSendMessage(e) {
    e.preventDefault();
    
    const messageText = messageInput.value.trim();
    if (!messageText || !socket || socket.readyState !== WebSocket.OPEN) {
        console.log('Message not sent: empty, or socket not open/ready.');
        if (!socket) console.log('Socket is null');
        else console.log('Socket readyState:', socket.readyState);
        return;
    }
    
    try {
        // Create a message block with blockchain-like structure
        const messageBlock = {
            content: messageText,
            timestamp: Date.now(),
            sender: clientId, // clientId is globally defined
            username: username, // username is globally defined
            previousHash: previousMessageHash, // previousMessageHash is globally defined
            nonce: Math.floor(Math.random() * 1000000) // Add randomness
        };
        
        // Convert the message block to a string for hashing
        const messageString = JSON.stringify(messageBlock);
        
        // Create a hash of this message for the next message in the chain
        const currentHash = CryptoJS.SHA256(messageString).toString();
        
        // Implement authenticated encryption
        // 1. Encrypt the message string (JSON of messageBlock) with AES
        const encrypted = CryptoJS.AES.encrypt(messageString, encryptionKey); // encryptionKey is globally defined
        const ciphertext = encrypted.toString();
        
        // 2. Create an HMAC for authentication (integrity check)
        const computedHmac = CryptoJS.HmacSHA256(ciphertext, encryptionKey).toString();
        
        // 3. Combine the HMAC and ciphertext
        // Format: hmac:ciphertext
        const authenticatedMessage = computedHmac + ':' + ciphertext;
        
        // Send the authenticated encrypted message
        socket.send(authenticatedMessage);
        
        // Display the message in our own chat
        // The addMessage function will use the global username for outgoing messages
        addMessage(messageText, true, new Date(messageBlock.timestamp).toLocaleTimeString());
        
        // Update the previous hash for the next message *after* successful send & local display
        previousMessageHash = currentHash;
        
        // Clear the input field
        messageInput.value = '';
        
        console.log('Sent message with hash:', currentHash);
    } catch (error) {
        console.error('Failed to encrypt and send message:', error);
        addSystemMessage('Failed to send message. Error encrypting content.');
    }
}

