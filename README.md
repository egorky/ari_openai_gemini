### README.md

# Asterisk to OpenAI Real-Time Integration

This project connects Asterisk with OpenAI's real-time API to enable real-time voice interactions. It processes incoming audio from Asterisk SIP calls, sends it to OpenAI for processing, and streams the audio responses back to the caller seamlessly. (Please use headphones for testing, using speakers will constantly interrupt communication.)

## Features
1. **Asterisk Integration**:
   - Connects to Asterisk via the ARI (Asterisk REST Interface) at `http://127.0.0.1:8088` using credentials `asterisk:asterisk`.
   - Listens for SIP channels entering the Stasis application (`stasis_app`).
   - Creates a mixing bridge for each call, answers the channel, and sets up an ExternalMedia channel.

2. **RTP Audio Handling**:
   - Listens for μ-law audio from Asterisk on RTP port `12000`.
   - Receives RTP packets, strips headers, converts μ-law to 24kHz PCM with interpolation, normalizes audio (target RMS 0.15), and buffers it.

3. **OpenAI Real-Time API Integration**:
   - Establishes a WebSocket connection to OpenAI’s real-time API (`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17`).
   - Sends normalized PCM audio chunks to OpenAI as base64-encoded data every 200ms.
   - Receives PCM audio responses and transcripts from OpenAI, converting PCM back to μ-law for Asterisk.

4. **Audio Streaming**:
   - Streams OpenAI’s audio responses to Asterisk via RTP with 10ms packet timing (80 samples at 8kHz).
   - Manages buffers to avoid overflow (1MB max) and ensures real-time playback with silence padding.

5. **Voice Activity Detection (VAD)**:
   - Configures OpenAI’s server-side VAD with customizable threshold (default 0.1), prefix padding (default 300ms), and silence duration (default 500ms).
   - Stops RTP streaming to Asterisk when speech is detected to avoid overlap.

6. **Logging**:
   - Uses Winston for detailed logging with timestamps, colored output (cyan for client events, yellow for server events, gray for general logs).
   - Logs RTP packet stats, audio processing details (RMS, gain), and OpenAI interactions.

7. **File Saving (Optional)**:
   - Saves Asterisk input audio as `.raw` (μ-law) and OpenAI-processed audio as `.wav` (24kHz PCM) if `ENABLE_SENT_TO_OPENAI_RECORDING` is `true`.
   - Files are saved on call end (`StasisEnd`).

8. **Cleanup**:
   - Handles call termination (`StasisEnd`), closing WebSockets, stopping RTP streams, clearing intervals, and destroying bridges.
   - Cleans up resources on uncaught exceptions or SIGINT (Ctrl+C).

9. **Configuration**:
   - Loads settings from `.env` (e.g., `OPENAI_API_KEY`, `MAX_CALL_DURATION`, VAD settings, logging options).
   - Provides defaults for unspecified values.


## Prerequisites
- **Node.js**: Version 16 or higher.
- **Asterisk 20**: Installed with ARI enabled (default: `http://127.0.0.1:8088`, user: `asterisk`, password: `asterisk`).
- **OpenAI API Key**: Obtain from [OpenAI's platform](https://platform.openai.com/).
- **SIP Client**: A SIP client (e.g., softphone like Linphone) to make calls to Asterisk.

## Installation
1. **Clone the Repository**:
   ```bash
   git clone https://github.com/infinitocloud/asterisk_to_openai_rt.git
   cd asterisk_to_openai_rt# asterisk_to_openai_rt

2. **Rename .env.sample to .env and add your OpenAI key.

Asterisk to OpenAI RealTime
