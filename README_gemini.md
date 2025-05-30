# Asterisk to Google Gemini Live API Integration

## Overview

This project connects an Asterisk PBX to Google's Gemini Live API, enabling real-time, bidirectional voice interactions. It leverages Asterisk's Real-time Interface (ARI) and Google's Generative Language API to stream audio from Asterisk to Gemini and receive audio responses and transcriptions back, facilitating the creation of advanced voice bots, AI agents, and other conversational AI applications.

Key functionalities include:
*   Real-time audio streaming from Asterisk to the application via RTP.
*   Processing and forwarding of this audio to the Gemini API.
*   Receiving audio responses (as 24kHz PCM) and text transcriptions from Gemini.
*   Processing and streaming Gemini's audio responses back to Asterisk via RTP.
*   Secure authentication with Google Cloud and Gemini using service accounts and ephemeral tokens.

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
*   **Configurable VAD:** Voice Activity Detection settings for Gemini can be configured via environment variables.
*   **Detailed Logging:** Uses Winston for detailed and configurable logging.
*   **Optional Audio Recording:** Can save incoming and outgoing audio streams for debugging and analysis (controlled by an environment variable).

## Prerequisites

*   **Node.js:** v16.x or newer recommended.
*   **Asterisk:** v18.x or v20+ with ARI enabled.
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
    ```bash
    git clone https://your-repository-url-here/project-name.git 
    cd project-name
    ```
    (Replace `https://your-repository-url-here/project-name.git` with the actual URL)

2.  **Install Dependencies:**
    ```bash
    npm install
    ```
    Key dependencies include: `ari-client`, `google-auth-library`, `wavefile`, `winston`, `dotenv`, `async`, `chalk`, and `https`.

3.  **Google Cloud Setup:**
    1.  **Create/Select Project:** Ensure you have a Google Cloud Project.
    2.  **Enable Billing:** Verify that billing is enabled for your project.
    3.  **Enable API:** In the Google Cloud Console, navigate to "APIs & Services" > "Library" and search for "Google Generative Language API". Enable it for your project.
    4.  **Create Service Account & Key:**
        *   Go to "IAM & Admin" > "Service Accounts".
        *   Click "Create Service Account".
        *   Provide a name (e.g., "gemini-asterisk-sa") and an optional description.
        *   **Grant Permissions:** Assign roles that provide the necessary permissions. "Generative Language API User" is a good starting point. For more fine-grained control, ensure permissions like `generativelanguage.authTokens.create` and `generativelanguage.models.streamGenerateContent` are included.
        *   Click "Done".
        *   After creating the service account, find it in the list, click on it, go to the "Keys" tab.
        *   Click "Add Key" > "Create new key".
        *   Select "JSON" as the key type and click "Create".
        *   A JSON key file will be downloaded. Securely store this file.

4.  **Application Configuration:**
    *   Rename the `.env.example` file to `.env`:
        ```bash
        cp .env.example .env
        ```
    *   Edit the `.env` file and provide values for all required variables:
        *   `ARI_URL`: URL for the Asterisk ARI (e.g., `http://localhost:8088`).
        *   `ARI_USER`: ARI username.
        *   `ARI_PASS`: ARI password.
        *   `ARI_APP_NAME`: The Stasis application name (e.g., `gemini-rt-app`). This must match your Asterisk dialplan.
        *   `RTP_SERVER_PORT`: The local UDP port where the application will listen for RTP audio from Asterisk (e.g., `12000`).
        *   `GOOGLE_APPLICATION_CREDENTIALS`: The **absolute path** to the downloaded service account JSON key file.
        *   `GEMINI_PROJECT_ID`: Your Google Cloud Project ID.
        *   `GEMINI_MODEL_NAME`: (Optional) The Gemini model to use (defaults to `models/gemini-1.5-flash-001`).
        *   `GEMINI_TARGET_INPUT_SAMPLE_RATE`: (Optional) Target sample rate for audio sent to Gemini (defaults to 16000).
        *   `GEMINI_VAD_ENERGY_THRESHOLD`, `GEMINI_VAD_PREFIX_REQUIRED_DURATION_MS`, `GEMINI_VAD_ACTIVITY_RATIO_THRESHOLD`, `GEMINI_VAD_SUFFIX_REQUIRED_DURATION_MS`: VAD parameters for Gemini.
        *   `LOG_LEVEL`: (Optional) Logging level (e.g., `info`, `debug`).
        *   Other optional parameters as needed (e.g., `MAX_CALL_DURATION_S`, `ENABLE_AUDIO_RECORDING`).

5.  **Asterisk Configuration:**
    *   **Dialplan (`extensions.conf`):** Configure Asterisk to route calls to the Stasis application defined in `ARI_APP_NAME`.
        Example:
        ```
        exten => _X.,1,NoOp(Call to Stasis application ${ARI_APP_NAME})
           same => n,Stasis(${ARI_APP_NAME})
           same => n,Hangup()
        ```
        Ensure your test extension or DID routes to a context that includes this.
    *   **PJSIP/SIP (`pjsip.conf`):** Ensure you have a SIP peer configured for your softphone or test trunk.
        (Refer to `pjsip.conf.sample` in the original repository for examples, if available, and adapt as needed.)
    *   Ensure Asterisk is running and the ARI module is enabled and configured correctly in `ari.conf`.

## Running the Application

1.  Start the Node.js application:
    ```bash
    node asterisk_to_gemini_rt.js
    ```
2.  Make a call from your SIP client to an extension that routes to the Stasis application in your Asterisk dialplan.

## How it Works (Brief Technical Flow)

1.  The Node.js application connects to Asterisk via the Asterisk REST Interface (ARI).
2.  When a call enters the specified Stasis application context in Asterisk, ARI sends a `StasisStart` event.
3.  The application answers the call and creates an `ExternalMedia` channel. This directs Asterisk to send RTP audio (µ-law) from the caller to the Node.js application's specified UDP port (`RTP_PORT`) and receive RTP audio back from the application.
4.  **Authentication:**
    *   The application uses the provided service account credentials (`GOOGLE_APPLICATION_CREDENTIALS`) and `GoogleAuth` library to obtain an OAuth2 access token.
    *   This access token is then used to request an ephemeral token from the Gemini `AuthTokenService.CreateToken` endpoint.
5.  **Gemini Connection:**
    *   The `GeminiApiCommunicator` establishes a WebSocket connection to the Gemini Live API using the ephemeral token.
    *   It sends a configuration message including the desired model and VAD settings.
6.  **Audio to Gemini:**
    *   Incoming µ-law RTP audio from Asterisk is received by the Node.js application.
    *   It's converted from µ-law to LPCM (8kHz), then upsampled to `GEMINI_TARGET_INPUT_SAMPLE_RATE` (e.g., 16kHz).
    *   This LPCM audio is encoded into WAV format.
    *   The raw WAV audio buffer is sent to Gemini via the WebSocket connection (the `GeminiApiCommunicator` handles internal Base64 encoding if needed by the underlying library).
7.  **Audio and Transcriptions from Gemini:**
    *   Gemini processes the audio and streams back:
        *   Real-time audio responses (as 24kHz PCM).
        *   Intermediate and final transcriptions of the user's speech.
8.  **Audio to Asterisk:**
    *   The 24kHz PCM audio from Gemini is received by the application.
    *   It's converted to 8kHz LPCM and then to µ-law.
    *   This µ-law audio is packetized into RTP and streamed back to the Asterisk ExternalMedia channel, which then plays it to the caller.
9.  **Call Termination:** When the call ends or is hung up, resources (ARI channels, bridges, Gemini connection) are cleaned up.

## Logging

*   The application uses Winston for logging.
*   Log level can be configured using the `LOG_LEVEL` environment variable (e.g., `info`, `debug`, `error`).
*   Logs include information about call progression, ARI events, RTP handling, Gemini API communication, and errors.

## Troubleshooting (Optional)

*   **Authentication Errors:**
    *   Ensure `GOOGLE_APPLICATION_CREDENTIALS` points to the correct, valid service account JSON key file.
    *   Verify the service account has the necessary IAM permissions for the Generative Language API (e.g., "Generative Language API User" or roles with `generativelanguage.authTokens.create` and `generativelanguage.models.streamGenerateContent`).
    *   Check that the Google Generative Language API is enabled in your Cloud Project and that billing is active.
*   **Asterisk Connection Issues:**
    *   Verify ARI is enabled and configured in Asterisk (`ari.conf`).
    *   Ensure `ARI_URL`, `ARI_USER`, and `ARI_PASS` in `.env` are correct.
    *   Check Asterisk logs for ARI connection errors.
*   **No Audio / One-Way Audio:**
    *   Verify RTP port settings (`RTP_PORT` in `.env`) and any firewall configurations between Asterisk and the Node.js application.
    *   Ensure `rtpServerIp` in `asterisk_to_gemini_rt.js` (if hardcoded or dynamically determined) is reachable by Asterisk for sending RTP audio back.
    *   Check Asterisk console for RTP errors.
*   **"File already exists" errors during development:** This can happen if the `create_file_with_block` tool is used multiple times with the same filename. Use `overwrite_file_with_block` if you intend to replace an existing file.

This README should provide a good starting point for users of the `asterisk_to_gemini_rt.js` application.
