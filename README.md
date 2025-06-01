### README.md

# Asterisk to AI Real-Time Integration

## Overview

This repository provides solutions for connecting Asterisk with real-time AI services. It includes two primary integration scripts:

*   `asterisk_to_openai_rt.js`: Connects Asterisk with OpenAI's real-time API for voice interactions.
*   `asterisk_to_gemini_rt.js`: Connects Asterisk with Google's Gemini Live API for voice interactions.

The `package.json` file includes a `start` script which currently executes `node asterisk_to_openai_rt.js` by default.

This document (`README.md`) primarily focuses on the OpenAI integration (`asterisk_to_openai_rt.js`). For Gemini integration details, please see `README_gemini.md`.

---

This project connects Asterisk with OpenAI's real-time API to enable real-time voice interactions. It processes incoming audio from Asterisk SIP calls, sends it to OpenAI for processing, and streams the audio responses back to the caller seamlessly. (Please use headphones for testing, using speakers will constantly interrupt communication.)

## Features
1. **Asterisk Integration**:
   - Connects to Asterisk via the ARI (Asterisk REST Interface).
   - Manages call setup, audio bridging, and RTP stream handling.
2. **RTP Audio Handling**:
   - Processes incoming µ-law audio from Asterisk.
   - Converts and normalizes audio for the AI service.
3. **OpenAI Real-Time API Integration**:
   - Establishes a WebSocket connection to OpenAI’s real-time API.
   - Streams audio and receives transcriptions and audio responses.
4. **Conversation Memory (New)**:
   - User and AI conversation turns are stored in Redis for each call.
   - This provides a history of the conversation, which is valuable for logging, debugging, and potential future enhancements.
   - **Note**: For the current OpenAI Realtime API integration, this stored history is *not* explicitly fed back into the API as ongoing context within the same call beyond the initial system prompt. The API's design makes continuous context injection challenging.
5. **Voice Activity Detection (VAD)**:
   - Utilizes OpenAI’s server-side VAD.
6. **Detailed Logging**:
   - Employs Winston for comprehensive logging.
7. **Configuration**:
   - Settings are managed via `.env` file and `prompts.js`.
8. **Stateful Conversation Management**:
   - Implements a state machine to guide conversations, with prompts defined in `prompts.js`.

## Conversation and Prompt Management

This system implements a stateful conversation flow, allowing the AI's behavior and responses to be tailored to different stages of an interaction. This is managed through the `prompts.js` file.

### `prompts.js` Structure

The `prompts.js` file defines the initial system instructions and state-specific prompts for both OpenAI and Gemini integrations. Here's an example structure:

```javascript
// prompts.js
module.exports = {
    openai: {
        system_instruction: "You are a helpful voice assistant scheduling appointments...",
        states: {
            greeting: "Hello! I'm here to help you schedule an appointment...",
            gathering_reason: "Okay, and could you briefly tell me the reason for this appointment?",
            // ... other states like collecting_availability_days, proposing_slot, etc.
            confirmation: "Excellent! Your appointment for {reason} is confirmed...",
            fallback: "I'm sorry, I didn't quite understand...",
            error_handler: "I seem to be having some trouble..."
        }
    },
    gemini: {
        system_instruction: "You are a helpful AI assistant for scheduling appointments...",
        states: {
            greeting: "Hello! I'm an AI assistant, and I can help you schedule an appointment...",
            gathering_reason: "Understood. And what is the primary reason for this appointment?",
            // ... other states
            confirmation: "Perfect! Your appointment for {reason} is set...",
            fallback: "My apologies, I didn't catch that...",
            error_handler: "Apologies, I'm encountering a technical issue..."
        }
    }
};
```

### Key Components:

*   `system_instruction`: This is the initial, general instruction given to the AI at the beginning of a session. It sets the overall context, persona, and objective for the AI. For OpenAI, this is part of the initial `session.update` message. For Gemini, this is the first part of the `initialContents` sent during connection setup.
*   `states`: This object contains specific prompts for various conversational states. The application transitions through these states (though advanced state transition logic is managed within the application scripts, not `prompts.js` itself).
    *   `greeting`: The initial message from the AI when a call starts.
    *   `gathering_reason`: Prompt to ask for the purpose of the call/appointment.
    *   Other states like `collecting_availability_days`, `collecting_availability_times`, `proposing_slot` guide the conversation flow for tasks like scheduling.
    *   `confirmation`: Used when an action is successfully completed.
    *   `fallback`: A generic response when the AI doesn't understand the user.
    *   `error_handler`: A prompt for when the system encounters an internal error.

### Customization

You can customize the AI's behavior and conversational flow by:

1.  **Modifying existing prompts** in `prompts.js` to change the AI's language or persona for each state.
2.  **Adding new states** in `prompts.js` and updating the application logic (e.g., in `asterisk_to_openai_rt.js` or `asterisk_to_gemini_rt.js`) to use these new states and manage transitions between them.
3.  Changing the `system_instruction` to alter the AI's core objective or constraints.

The application dynamically combines the `system_instruction` with the prompt for the current state to guide the AI's responses. For instance, in the OpenAI integration, the `instructions` field of the `session.update` message becomes a combination of `system_instruction` and the current state's prompt. Similarly, for Gemini, these are combined in the initial user message.

## Prerequisites
- **Node.js**: Version 16 or higher.
- **Asterisk 20**: Installed with ARI enabled.
- **OpenAI API Key**.
- **Redis Server**: An instance of Redis (v4.x or later recommended) must be running and accessible for conversation memory.
- **SIP Client**.

## Installation
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/infinitocloud/asterisk_to_openai_rt.git
   cd asterisk_to_openai_rt
   ```

2. **Install Dependencies**:
   ```bash
   npm install
   ```
   (This will install `ari-client`, `ws`, `winston`, `chalk`, `async`, `dotenv`, `google-auth-library`, `wavefile`, and `redis`.)

3. **Environment Configuration (`.env` file)**:
   - Rename `.env.example` to `.env`.
   - **Essential**:
     - `OPENAI_API_KEY`: Your OpenAI API key.
   - **Asterisk & RTP**:
     - `ARI_URL`: (e.g., `http://127.0.0.1:8088`)
     - `ARI_USER`: (e.g., `asterisk`)
     - `ARI_PASS`: (e.g., `asterisk`)
     - `ARI_APP_NAME`: (e.g., `openai-rt-app`) - Must match your Asterisk dialplan.
     - `RTP_SERVER_PORT`: (e.g., `12000`) - Port for this app to listen for RTP from Asterisk.
     - `RTP_SERVER_IP_FOR_ASTERISK`: (Optional) IP address Asterisk should send RTP to, if different from where this app runs.
   - **AI Behavior**:
     - `OPENAI_SYSTEM_INSTRUCTION`: (Optional) Custom system prompt for OpenAI. Defaults are in `prompts.js`.
     - `OPENAI_VOICE_ID`: (Optional, e.g., `alloy`, default: `alloy`)
   - **Redis Configuration (for Conversation Memory)**:
     - `REDIS_HOST`: Hostname for the Redis server (default: `127.0.0.1`).
     - `REDIS_PORT`: Port for the Redis server (default: 6379).
     - `REDIS_PASSWORD`: Password for Redis authentication (optional, default: none).
     - `REDIS_DB`: Redis database number (optional, default: 0).
     - `REDIS_CONVERSATION_TTL_S`: Time-to-live for conversation history in Redis, in seconds (default: 86400, i.e., 24 hours).
     - Redis is also used to store the current conversation state alongside each message turn, allowing for better context tracking.
   - **Other**:
     - `MAX_CALL_DURATION_S`: (Optional, default: 300) Max call duration in seconds.
     - `LOG_LEVEL`: (Optional, e.g., `info`, `debug`)
     - VAD parameters (`VAD_THRESHOLD`, `VAD_PREFIX_PADDING_MS`, `VAD_SILENCE_DURATION_MS`).

4. **System Prompts (`prompts.js`)**:
   - Review and customize default system prompts and state-specific prompts in `prompts.js`. The new "Conversation and Prompt Management" section provides more details.

5. **Asterisk Setup**:
   - Ensure Asterisk is running and ARI is enabled.
   - Configure your `extensions.conf` to route calls to the Stasis application named in `ARI_APP_NAME`. Example:
     ```
     exten => _X.,1,NoOp(Call to Stasis application ${ARI_APP_NAME})
        same => n,Stasis(${ARI_APP_NAME})
        same => n,Hangup()
     ```
   - Set up a SIP peer for your client.

## Running the Application
1. Start the application:
   ```bash
   npm start 
   ```
   (This runs `node asterisk_to_openai_rt.js` by default)

   Alternatively, to run the Gemini version (ensure `README_gemini.md` is consulted for its specific setup):
   ```bash
   node asterisk_to_gemini_rt.js
   ```

2. Ensure your Redis server is running and accessible.
3. Make a call from your SIP client to an extension routed to your Stasis application.

Use headphones for the best experience, as using speakers might cause echo and interrupt the AI's speech detection.
