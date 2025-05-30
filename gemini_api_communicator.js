// gemini_api_communicator.js

const WebSocket = require('ws');
const getGeminiEphemeralToken = require('./get_gemini_ephemeral_token');

const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || "models/gemini-1.5-flash-001";
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID;
const VAD_THRESHOLD = parseFloat(process.env.GEMINI_VAD_ENERGY_THRESHOLD) || -60;
const VAD_PREFIX_DURATION_MS = parseInt(process.env.GEMINI_VAD_PREFIX_PADDING_MS) || 200;
const VAD_SILENCE_DURATION_MS = parseInt(process.env.GEMINI_VAD_SILENCE_DURATION_MS) || 800;

class GeminiApiCommunicator {
    constructor(callbacks) {
        this.callbacks = callbacks;
        this.ws = null;
        this.sessionReady = false;
        this.callSpecificData = null;

        this._handleOpen = this._handleOpen.bind(this);
        this._handleMessage = this._handleMessage.bind(this);
        this._handleError = this._handleError.bind(this);
        this._handleClose = this._handleClose.bind(this);
    }

    _createBidiGenerateContentSetup(modelName) {
        return {
            model: modelName,
            generationConfig: {
                responseModalities: ["AUDIO", "TEXT"]
            },
            realtimeInputConfig: {
                automaticActivityDetection: {
                    vadTuningConfig: {
                        activityRatioThreshold: 0.8,
                        energyThreshold: VAD_THRESHOLD,
                        prefixRequiredDurationMs: VAD_PREFIX_DURATION_MS,
                        suffixRequiredDurationMs: VAD_SILENCE_DURATION_MS,
                    },
                },
                activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
        };
    }

    async connect(apiKey = null, modelName = GEMINI_MODEL_NAME, callSpecificData = {}) {
        console.log(`[GeminiApiCommunicator] Attempting to connect for model: ${modelName}`);
        this.callSpecificData = callSpecificData;
        this.sessionReady = false;

        const setup = this._createBidiGenerateContentSetup(modelName);

        try {
            const { GoogleAuth } = require('google-auth-library');
            const auth = new GoogleAuth({
                keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
                scopes: 'https://www.googleapis.com/auth/generativelanguage'
            });

            const ephemeralToken = await getGeminiEphemeralToken(GEMINI_PROJECT_ID, modelName, setup, auth);

            if (!ephemeralToken) {
                console.error("[GeminiApiCommunicator] Failed to obtain ephemeral token. Connection aborted.");
                if (this.callbacks.onError) {
                    this.callbacks.onError(new Error("Failed to obtain ephemeral token."));
                }
                return;
            }

            const wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent`;
            const headers = {
                'Authorization': `Token ${ephemeralToken}`,
            };

            console.log(`[GeminiApiCommunicator] Connecting to WebSocket: ${wsUrl}`);
            this.ws = new WebSocket(wsUrl, { headers });

            this.ws.on('open', () => this._handleOpen(setup));
            this.ws.on('message', this._handleMessage);
            this.ws.on('error', this._handleError);
            this.ws.on('close', this._handleClose);

        } catch (error) {
            console.error("[GeminiApiCommunicator] Error during connection setup:", error);
            if (this.callbacks.onError) {
                this.callbacks.onError(error);
            }
            if (this.ws && this.ws.readyState !== WebSocket.OPEN && this.ws.readyState !== WebSocket.CONNECTING) {
                this._handleClose(1006, `Connection setup failed: ${error.message}`);
            } else if (!this.ws) {
                this._handleClose(1006, `Connection setup failed before WebSocket instantiation: ${error.message}`);
            }
        }
    }

    _handleOpen(setupMessage) {
        console.log("[GeminiApiCommunicator] WebSocket connection opened.");
        try {
            this.ws.send(JSON.stringify({ bidiGenerateContentSetup: setupMessage }));
            console.log("[GeminiApiCommunicator] BidiGenerateContentSetup sent.");
        } catch (error) {
            console.error("[GeminiApiCommunicator] Error sending BidiGenerateContentSetup:", error);
            if (this.callbacks.onError) {
                this.callbacks.onError(error);
            }
            this.close(1011, "Failed to send setup message");
        }
    }

    _handleMessage(messageData) {
        try {
            const message = JSON.parse(messageData.toString());
            if (message.setupComplete) {
                this.sessionReady = true;
                console.log("[GeminiApiCommunicator] Session setup complete. Ready to send audio.");
                if (this.callbacks.onSetupComplete) {
                    this.callbacks.onSetupComplete(this.callSpecificData);
                }
            } else if (message.serverContent) {
                const serverContent = message.serverContent;
                if (serverContent.inputTranscription?.text) {
                    this.callbacks.onInputTranscription?.(serverContent.inputTranscription.text, this.callSpecificData);
                }
                if (serverContent.modelTurn?.parts) {
                    serverContent.modelTurn.parts.forEach(part => {
                        if (part.audioBlob?.audio) {
                            const pcmData = Buffer.from(part.audioBlob.audio, 'base64');
                            this.callbacks.onOutputAudio?.(pcmData, this.callSpecificData);
                        }
                        if (part.outputTranscription?.text) {
                            this.callbacks.onOutputTranscription?.(part.outputTranscription.text, this.callSpecificData);
                        }
                    });
                }
            } else if (message.error) {
                console.error("[GeminiApiCommunicator] API error:", message.error);
                this.callbacks.onError?.(new Error(message.error.message || JSON.stringify(message.error)));
            } else if (message.goAway) {
                console.warn("[GeminiApiCommunicator] Received goAway message.");
                this.close(1000, "Received goAway from server");
            } else {
                console.log("[GeminiApiCommunicator] Received unknown message:", message);
            }
        } catch (error) {
            console.error("[GeminiApiCommunicator] Error processing message:", error);
            this.callbacks.onError?.(error);
        }
    }

    sendAudio(audioChunk) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.sessionReady) {
            console.warn("[GeminiApiCommunicator] Cannot send audio, WebSocket not ready.");
            return;
        }
        try {
            const audioB64 = Buffer.from(audioChunk).toString('base64');
            const message = {
                bidiGenerateContentRealtimeInput: {
                    audioBlob: {
                        audio: audioB64
                    }
                }
            };
            this.ws.send(JSON.stringify(message));
        } catch (error) {
            console.error("[GeminiApiCommunicator] Error sending audio:", error);
            this.callbacks.onError?.(error);
        }
    }

    _handleError(error) {
        console.error("[GeminiApiCommunicator] WebSocket error:", error);
        this.sessionReady = false;
        this.callbacks.onError?.(error);
    }

    _handleClose(code, reason) {
        console.log(`[GeminiApiCommunicator] WebSocket closed. Code: ${code}, Reason: ${reason}`);
        this.ws = null;
        this.sessionReady = false;
        this.callbacks.onConnectionClose?.(this.callSpecificData, code, reason);
        this.callSpecificData = null;
    }

    close(code = 1000, reason = "Client requested closure") {
        if (this.ws) {
            console.log(`[GeminiApiCommunicator] Closing WebSocket. Code: ${code}, Reason: ${reason}`);
            this.ws.close(code, reason);
        }
    }

    isReady() {
        return this.ws && this.ws.readyState === WebSocket.OPEN && this.sessionReady;
    }
}

module.exports = GeminiApiCommunicator;
