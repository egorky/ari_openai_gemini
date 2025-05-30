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
   - **Other**:
     - `MAX_CALL_DURATION_S`: (Optional, default: 300) Max call duration in seconds.
     - `LOG_LEVEL`: (Optional, e.g., `info`, `debug`)
     - VAD parameters (`VAD_THRESHOLD`, `VAD_PREFIX_PADDING_MS`, `VAD_SILENCE_DURATION_MS`).

4. **System Prompts (`prompts.js`)**:
   - Review and customize default system prompts in `prompts.js` if needed. Environment variables like `OPENAI_SYSTEM_INSTRUCTION` can override these.

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
[end of README.md]
