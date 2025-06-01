# Asterisk to Google Gemini Live API Integration

## Overview

This project connects an Asterisk PBX to Google's Gemini Live API, enabling real-time, bidirectional voice interactions. It leverages Asterisk's Real-time Interface (ARI) and Google's Generative Language API to stream audio from Asterisk to Gemini and receive audio responses and transcriptions back, facilitating the creation of advanced voice bots, AI agents, and other conversational AI applications.

Key functionalities include:
*   Real-time audio streaming from Asterisk to the application via RTP.
*   Processing and forwarding of this audio to the Gemini API.
*   Receiving audio responses (as 24kHz PCM) and text transcriptions from Gemini.
*   Processing and streaming Gemini's audio responses back to Asterisk via RTP.
*   Secure authentication with Google Cloud and Gemini using service accounts and ephemeral tokens.
*   Conversation memory using Redis to provide context from previous turns in the current call.
*   Stateful conversation management using prompts defined in `prompts.js`.

For details on the OpenAI integration, please see `README.md`.

## Features

*   **Asterisk Integration:** Utilizes Asterisk Real-time Interface (ARI) for call control and ExternalMedia channels for RTP audio I/O.
*   **Real-time Audio Processing:**
    *   Converts µ-law audio from Asterisk to 16kHz WAV format suitable for Gemini.
    *   Converts 24kHz PCM audio received from Gemini back to µ-law for Asterisk.
*   **Google Gemini Live API Integration:**
    *   Connects to Gemini's real-time streaming API (WebSocket-based, managed by `GeminiApiCommunicator`).
    *   Handles ephemeral token authentication for secure API access.
    *   Manages session setup and real-time, bidirectional audio streaming.
    *   Receives and logs input and output transcriptions.
*   **Conversation Memory & State Management**:
    *   Stores conversation history (user and AI turns), including the conversation state at each turn, in Redis with a configurable TTL.
    *   Loads a configurable number of recent conversation turns from Redis to determine the starting state and provide historical context to Gemini at the beginning of a new call.
*   **Configurable Prompts & VAD:** System behavior, conversational flow, and Voice Activity Detection settings for Gemini can be configured via `prompts.js` and environment variables.
*   **Detailed Logging:** Uses Winston for detailed and configurable logging.
*   **Optional Audio Recording:** Can save incoming and outgoing audio streams for debugging and analysis (controlled by an environment variable).

## Conversation and Prompt Management

This system implements a stateful conversation flow, allowing Gemini's behavior and responses to be tailored to different stages of an interaction. This is primarily managed through the `prompts.js` file.

### `prompts.js` Structure

The `prompts.js` file defines initial system instructions and state-specific prompts. For the Gemini integration, the relevant part looks like this:

```javascript
// prompts.js
module.exports = {
    // ... (OpenAI section might also be present)
    gemini: {
        system_instruction: "You are a helpful AI assistant for scheduling appointments. Begin the conversation by greeting the user...",
        states: {
            greeting: "Hello! I'm an AI assistant, and I can help you schedule an appointment. First, could you tell me the reason for your visit?",
            gathering_reason: "Understood. And what is the primary reason for this appointment?",
            collecting_availability_days: "Thanks! Which days of the week are you typically available for an appointment?",
            collecting_availability_times: "Okay. And during those days, what are your preferred times for the appointment...?",
            proposing_slot: "Alright, I've found an available slot for you at {time} on {date}. Would that work?",
            confirmation: "Perfect! Your appointment for {reason} is set for {time} on {date}. Can I assist with anything else today?",
            fallback: "My apologies, I didn't catch that. Could you say that again?",
            error_handler: "Apologies, I'm encountering a technical issue. Could you please try scheduling again shortly?"
        }
    }
};
```

### Key Components:

*   `system_instruction`: This is the initial, general instruction given to Gemini at the beginning of a session. It sets the overall context, persona, and objective. This instruction, combined with the current state's prompt, forms the initial "user" turn sent to the Gemini API.
*   `states`: This object contains specific prompts for various conversational states. The application determines the current state (e.g., from Redis history or defaulting to `greeting`) and uses the corresponding prompt.
    *   `greeting`: The initial message or prompt context when a call starts.
    *   Other states (e.g., `gathering_reason`, `collecting_availability_days`) guide the AI through specific parts of the conversation.
    *   `fallback` / `error_handler`: For managing misunderstandings or system issues.

### Customization

You can customize Gemini's conversational flow by:

1.  Modifying prompts in the `gemini` section of `prompts.js`.
2.  Adding new states to `prompts.js` and updating `asterisk_to_gemini_rt.js` to use these states and manage transitions.
3.  Changing the `system_instruction` for Gemini.

The `GeminiApiCommunicator` combines the `system_instruction` and the current state-specific prompt into the first message sent to the Gemini API, effectively guiding its response based on both the overall goal and the immediate conversational context.

## Prerequisites

*   **Node.js:** v16.x or newer recommended.
*   **Asterisk:** v18.x or v20+ with ARI enabled.
*   **Redis Server**: An instance of Redis (v4.x or later recommended) must be running and accessible for conversation memory.
*   **Google Cloud Project:**
    *   Billing enabled.
    *   **Google Generative Language API** (`generativelanguage.googleapis.com`) enabled for your project.
*   **Service Account:**
    *   A service account key (JSON file).
    *   The service account needs permissions to:
        *   Create AuthTokens for the Generative Language API (e.g., via a role containing `generativelanguage.authTokens.create`).
        *   Stream content with the Gemini models (e.g., via a role containing `generativelanguage.models.streamGenerateContent`). The "Generative Language API User" or "AI Platform Model User" roles might cover these, but verify the specific permissions.
*   **SIP Client:** A softphone (e.g., Zoiper, Linphone) for making test calls.

## Setup Instructions

1.  **Clone the Repository:**
    Clone the repository from the source. If you haven't already, navigate into the project directory:
    ```bash
    cd your-project-directory-name 
    ```
    (Replace `your-project-directory-name` with the actual directory name).

2.  **Install Dependencies:**
    ```bash
    npm install
    ```
    Key dependencies include: `ari-client`, `google-auth-library`, `wavefile`, `winston`, `dotenv`, `async`, `chalk`, `ws`, and `redis`. (Note: `https` is a built-in Node.js module).

3.  **Google Cloud Setup:**
    (As previously described - ensure API is enabled, service account created with correct permissions, and JSON key downloaded).

4.  **Application Configuration (`.env` file):**
    *   Rename the `.env.example` file to `.env`:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and provide values for all required variables:
        *   **Asterisk & RTP**:
            *   `ARI_URL`, `ARI_USER`, `ARI_PASS`, `ARI_APP_NAME`
            *   `RTP_SERVER_PORT`, `RTP_SERVER_IP_FOR_ASTERISK` (optional)
        *   **Google Cloud & Gemini**:
            *   `GOOGLE_APPLICATION_CREDENTIALS`: The **absolute path** to the downloaded service account JSON key file.
            *   `GEMINI_PROJECT_ID`: Your Google Cloud Project ID.
            *   `GEMINI_MODEL_NAME`: (Optional) The Gemini model to use (defaults to `models/gemini-1.5-flash-001`).
            *   `GEMINI_TARGET_INPUT_SAMPLE_RATE`: (Optional, default: 16000).
            *   `GEMINI_SYSTEM_INSTRUCTION`: (Optional) Custom system prompt for Gemini. Defaults are in `prompts.js`. See the "Conversation and Prompt Management" section for more details.
            *   **VAD Parameters**:
                *   `GEMINI_VAD_ENERGY_THRESHOLD`: (Optional, default: -60) Energy threshold for VAD.
                *   `GEMINI_VAD_PREFIX_PADDING_MS`: (Optional, default: 200) Duration of audio to include before speech starts.
                *   `GEMINI_VAD_SILENCE_DURATION_MS`: (Optional, default: 800) Duration of silence to consider speech ended.
                *   `GEMINI_VAD_ACTIVITY_RATIO_THRESHOLD`: (Optional, default: 0.8) VAD parameter influencing sensitivity to speech activity.
        *   **Redis Configuration (for Conversation Memory)**:
            *   `REDIS_HOST`: Hostname for the Redis server (default: `127.0.0.1`).
            *   `REDIS_PORT`: Port for the Redis server (default: 6379).
            *   `REDIS_PASSWORD`: Password for Redis authentication (optional, default: none).
            *   `REDIS_DB`: Redis database number (optional, default: 0).
            *   `REDIS_CONVERSATION_TTL_S`: Time-to-live for conversation history in Redis, in seconds (default: 86400).
            *   `GEMINI_HISTORY_MAX_TURNS`: Maximum number of recent conversation turns (user + AI messages) to load from Redis for providing context to Gemini (default: 10).
            *   Redis is also used to store the current conversation state alongside each message turn, allowing for better context tracking.
        *   **Other**:
            *   `LOG_LEVEL`: (Optional, e.g., `info`, `debug`).
            *   `MAX_CALL_DURATION_S`: (Optional, default: 300).
            *   `ENABLE_AUDIO_RECORDING`: (Optional).
    *   **System Prompts (`prompts.js`)**:
        *   Review and customize default system prompts and state-specific prompts in the `gemini` section of `prompts.js`. See the "Conversation and Prompt Management" section for more details.

5.  **Asterisk Configuration:**
    (As previously described - dialplan, SIP peer, ARI enabled).

## Running the Application

1.  Ensure your Redis server is running and accessible.
2.  Start the Node.js application:
    ```bash
    node asterisk_to_gemini_rt.js
    ```
3.  Make a call from your SIP client to an extension that routes to the Stasis application in your Asterisk dialplan.

## How it Works (Brief Technical Flow)

1.  ARI Connection: Application connects to Asterisk via ARI.
2.  Call Handling: On `StasisStart`, an `ExternalMedia` channel is set up for RTP.
3.  **Conversation History & State Loading**: The application attempts to load the last `GEMINI_HISTORY_MAX_TURNS` from Redis for the current `channelId`. The state of the last message (if available) determines the initial `currentConversationState`.
4.  **Authentication & Gemini Connection**:
    *   Obtains an ephemeral token for Gemini using service account credentials.
    *   The `GeminiApiCommunicator` establishes a WebSocket connection.
    *   The initial setup message to Gemini now includes the loaded conversation history, the system prompt from `prompts.js` (or environment variable), and the current state-specific prompt, all combined into `initialContents`.
5.  **Audio to Gemini**: µ-law audio from Asterisk is converted to WAV and streamed to Gemini.
6.  **Storing User Input**: When Gemini transcribes user speech (`onInputTranscription`), the text is saved to Redis with a timestamp, speaker "user", and the `currentState` at that point.
7.  **Audio and Transcriptions from Gemini**: Gemini streams back audio responses and transcriptions.
8.  **Storing AI Response**: When Gemini provides its own transcription (`onOutputTranscription`), this text is saved to Redis with a timestamp, speaker "ai", and the `currentState`.
9.  **Audio to Asterisk**: Gemini's audio response is converted back to µ-law and streamed to Asterisk via RTP.
10. **Call Termination**: Resources are cleaned up. Conversation history in Redis expires based on TTL.

## Logging
(As previously described).

## Troubleshooting (Optional)
(As previously described, consider adding notes for Redis connection issues if they become common).

This README should provide a good starting point for users of the `asterisk_to_gemini_rt.js` application.
