// Import required Node.js modules
const ari = require('ari-client'); // Asterisk REST Interface client
const WebSocket = require('ws'); // WebSocket library for OpenAI real-time API
const fs = require('fs'); // File system module for saving audio files
const dgram = require('dgram'); // UDP datagram for RTP audio streaming
const winston = require('winston'); // Logging library
const chalk = require('chalk'); // Colorizes console output
const async = require('async'); // Async utilities (used for RTP queue)
require('dotenv').config(); // Loads environment variables from .env file
const { GoogleAuth } = require('google-auth-library'); // For Google Cloud authentication
const https = require('https'); // For making HTTPS requests (Gemini token)
const WaveFile = require('wavefile').WaveFile; // For WAV encoding
const redisClient = require('./redis_manager'); // Import Redis client

const GeminiApiCommunicator = require('./gemini_api_communicator'); // Import Gemini API Communicator
const prompts = require('./prompts.js'); // Load prompts

// Configuration constants loaded from environment variables or defaults
const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USERNAME || 'asterisk';
const ARI_PASS = process.env.ARI_PASSWORD || 'asterisk';
const ARI_APP = process.env.ARI_APP_NAME || 'openai-rt-app';

// AI Service Provider ("openai" or "gemini")
const AI_SERVICE_PROVIDER = (process.env.AI_SERVICE_PROVIDER || 'openai').toLowerCase();

// Redis Conversation TTL
const REDIS_CONVERSATION_TTL_S = parseInt(process.env.REDIS_CONVERSATION_TTL_S, 10) || 86400; // 24 hours

// OpenAI API Configuration (Legacy or if AI_SERVICE_PROVIDER is "openai")
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Construct REALTIME_URL carefully, ensuring ws/wss protocol
let REALTIME_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17'; // Default
if (process.env.OPENAI_API_BASE_URL) {
    let base = process.env.OPENAI_API_BASE_URL;
    if (base.startsWith('http://')) {
        base = base.replace('http://', 'ws://');
    } else if (base.startsWith('https://')) {
        base = base.replace('https://', 'wss://');
    }
    REALTIME_URL = `${base}/v1/realtime`; // Assuming model is part of query or not needed for self-hosted
}
const OPENAI_VOICE_ID = process.env.OPENAI_VOICE_ID || 'alloy';
const OPENAI_TTS_MODEL_ID = process.env.OPENAI_TTS_MODEL_ID || 'tts-1'; // Not directly used in realtime but for reference

// Google Gemini API Configuration (if AI_SERVICE_PROVIDER is "gemini")
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'models/gemini-1.5-flash-001';
const GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT = process.env.GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT ||
    (GEMINI_PROJECT_ID ? `https://generativelanguage.googleapis.com/v1beta/projects/${GEMINI_PROJECT_ID}/locations/global/authTokens:create` : null);


const RTP_PORT = parseInt(process.env.RTP_SERVER_PORT) || 12000; // Local port for RTP audio reception
const MAX_CALL_DURATION = process.env.MAX_CALL_DURATION_S ? parseInt(process.env.MAX_CALL_DURATION_S) * 1000 : 300000; // Max call duration in ms (default: 5 min)
const RTP_QUEUE_CONCURRENCY = parseInt(process.env.RTP_QUEUE_CONCURRENCY) || 50; // Concurrent RTP packet sends
const LOG_RTP_EVERY_N_PACKETS = parseInt(process.env.LOG_RTP_EVERY_N_PACKETS) || 100; // Log RTP stats every N packets
const ENABLE_RTP_LOGGING = process.env.ENABLE_RTP_LOGGING === 'true'; // Enable detailed RTP logging
const ENABLE_AUDIO_RECORDING = process.env.ENABLE_AUDIO_RECORDING === 'true'; // Controls saving of audio files

// VAD parameters (used by OpenAI, Gemini VAD is configured in BidiGenerateContentSetup)
const VAD_THRESHOLD = process.env.VAD_THRESHOLD ? parseFloat(process.env.VAD_THRESHOLD) : 0.1;
const VAD_PREFIX_PADDING_MS = process.env.VAD_PREFIX_PADDING_MS ? parseInt(process.env.VAD_PREFIX_PADDING_MS) : 300;
const VAD_SILENCE_DURATION_MS = process.env.VAD_SILENCE_DURATION_MS ? parseInt(process.env.VAD_SILENCE_DURATION_MS) : 500;

const TARGET_RMS = parseFloat(process.env.TARGET_RMS) || 0.15; // Target Root Mean Square for audio normalization
const MIN_RMS = parseFloat(process.env.MIN_RMS) || 0.001; // Minimum RMS to apply gain
const STREAM_PROCESSING_DELAY_MS = parseInt(process.env.STREAM_PROCESSING_DELAY_MS) || 20; // Delay for processing audio stream chunks

// Counters for client/server event logging
let sentEventCounter = 0; // Tracks sent events to AI Service
let receivedEventCounter = -1; // Tracks received events from AI Service

// Configure Winston logger with timestamp and colorized output
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info', // Log level
  format: winston.format.combine(
    winston.format.timestamp(), // Add timestamp to logs
    winston.format.printf(({ timestamp, level, message }) => {
      const [originPart] = message.split(' ', 1); // Extract message origin (Client/Server/System)
      let counter = 'SYS'; // Default for system messages
      let coloredMessage = chalk.gray(message); // Default color

      if (originPart === '[Client]') {
        counter = `C-${sentEventCounter.toString().padStart(4, '0')}`;
        sentEventCounter++;
        coloredMessage = chalk.cyanBright(message);
      } else if (originPart === '[Server]') {
        counter = `S-${receivedEventCounter.toString().padStart(4, '0')}`;
        receivedEventCounter++;
        coloredMessage = chalk.yellowBright(message);
      } else if (originPart.startsWith('[')) { // Other specific tags like [Auth], [AudioProc]
        counter = originPart.substring(1, originPart.length -1).padEnd(3, ' ').substring(0,3).toUpperCase();
        coloredMessage = chalk.blueBright(message); // Using blue for system components
      }
      return `${counter} | ${timestamp} [${level.toUpperCase()}] ${coloredMessage}`;
    })
  ),
  transports: [new winston.transports.Console()]
});

// Helper functions for logging AI service events
const logClient = (msg) => logger.info(`[Client] ${msg}`);
const logServer = (msg) => logger.info(`[Server] ${msg}`);
const logAuth = (msg) => logger.info(`[Auth] ${msg}`);
const logAudioProc = (msg) => logger.info(`[AudioProc] ${msg}`);

// Maps to track channel states and audio buffers
const extMap = new Map(); // Maps ExternalMedia channels to their bridges and SIP channels
const sipMap = new Map(); // Maps SIP channels to their AI service connection, bridge data, etc.
const rtpSender = dgram.createSocket('udp4'); // Single UDP socket for sending RTP packets
let rtpReceiver = dgram.createSocket('udp4'); // UDP socket for receiving RTP packets
let ariClient; // ARI client instance

const audioFromAsteriskMap = new Map(); // Buffers raw audio received from Asterisk (µ-law)
const audioToServiceMap = new Map(); // Buffers processed audio sent to AI Service (e.g., WAV for Gemini, PCM for OpenAI)
const amplificationLogFrequency = new Map(); // Tracks last amplification log time per channel
const rmsLogFrequency = new Map(); // Tracks last RMS log time per channel
const rtpSentStats = new Map(); // Tracks RTP stats per channel

// Add an ExternalMedia channel to a bridge with retry logic
async function addExtToBridge(client, channel, bridgeId, retries = 5, delay = 500) {
  try {
    const bridge = await client.bridges.get({ bridgeId }); // Fetch bridge by ID
    if (!bridge) throw new Error('Bridge not found');
    await bridge.addChannel({ channel: channel.id }); // Add channel to bridge
    logger.info(`ExternalMedia channel ${channel.id} added to bridge ${bridgeId}`);
  } catch (err) {
    if (retries) {
      logger.info(`Retrying to add ExternalMedia channel ${channel.id} to bridge ${bridgeId} (${retries} attempts remaining)`);
      await new Promise(r => setTimeout(r, delay)); // Wait before retrying
      return addExtToBridge(client, channel, bridgeId, retries - 1, delay); // Recursive retry
    }
    logger.error(`Error adding ExternalMedia channel ${channel.id} to bridge ${bridgeId}: ${err.message}`);
  }
}

// Start the RTP receiver to listen for audio from Asterisk
function startRTPReceiver() {
  let packetCount = 0; // Count of received RTP packets
  let totalBytes = 0; // Total bytes received
  let startTime = Date.now(); // Start time for rate calculation
  const audioInputBuffers = new Map(); // Temporary audio buffers per channel for processing input audio

  rtpReceiver.on('listening', () => {
    const address = rtpReceiver.address();
    logger.info(`RTP Receiver listening on ${address.address}:${address.port}`);
  });

  // Handle incoming RTP packets from Asterisk
  rtpReceiver.on('message', (msg, rinfo) => {
    packetCount++;
    totalBytes += msg.length;
    if (packetCount % LOG_RTP_EVERY_N_PACKETS === 0) {
      const currentTime = Date.now();
      const duration = (currentTime - startTime) / 1000;
      const rate = duration > 0 ? (packetCount / duration).toFixed(2) : "N/A";
      // logger.info(`RTP Stats: ${packetCount} packets, ${totalBytes} bytes from ${rinfo.address}:${rinfo.port} in ~${duration.toFixed(1)}s. Avg rate: ${rate} pkts/s`);
    }

    // Try to find the channelId associated with this RTP source
    let channelId = [...sipMap.entries()].find(([_, data]) => data.rtpSource && data.rtpSource.address === rinfo.address && data.rtpSource.port === rinfo.port)?.[0];

    if (!channelId) {
      // If no mapping by rtpSource (e.g. rtpSource not yet identified for a new call),
      // this packet might be handled by a temporary listener in StasisStart.
      // If it reaches here, it's either for a call that already ended or an unknown source.
      // logger.debug(`RTP from ${rinfo.address}:${rinfo.port} - no channelId mapping. Discarding.`);
      return;
    }

    const channelData = sipMap.get(channelId);
    if (!channelData) {
      logger.warn(`No channel data in sipMap for ${channelId} despite RTP source match. Discarding packet.`);
      return;
    }
    
    // Do not process or buffer audio if the AI communicator isn't ready or doesn't exist.
    const aiCommunicator = channelData.aiCommunicator;
    const isGeminiReady = AI_SERVICE_PROVIDER === 'gemini' && aiCommunicator && aiCommunicator.isReady();
    const isOpenAiReady = AI_SERVICE_PROVIDER === 'openai' && aiCommunicator && aiCommunicator.readyState === WebSocket.OPEN;

    if (!isGeminiReady && !isOpenAiReady) {
      // logger.debug(`[RTP] AI communicator not ready for channel ${channelId}. Discarding audio.`);
      return;
    }

    const muLawPayload = msg.slice(12); // Extract μ-law payload (RTP header is 12 bytes)
    
    // Store raw mu-law from Asterisk if recording is enabled
    if (ENABLE_AUDIO_RECORDING) {
        if (!audioFromAsteriskMap.has(channelId)) audioFromAsteriskMap.set(channelId, Buffer.alloc(0));
        audioFromAsteriskMap.set(channelId, Buffer.concat([audioFromAsteriskMap.get(channelId), muLawPayload]));
    }

    // Buffer for processing and sending to AI
    if (!audioInputBuffers.has(channelId)) audioInputBuffers.set(channelId, Buffer.alloc(0));
    audioInputBuffers.set(channelId, Buffer.concat([audioInputBuffers.get(channelId), muLawPayload]));

    // Process and send the buffered audio at intervals
    if (!channelData.sendTimeout) {
      channelData.sendTimeout = setInterval(() => {
        const currentAudioBuffer = audioInputBuffers.get(channelId);
        if (currentAudioBuffer && currentAudioBuffer.length > 0) {
          audioInputBuffers.set(channelId, Buffer.alloc(0)); // Clear buffer immediately after getting it

          // Ensure channel and AI communicator are still valid before processing and sending
          const activeChannelData = sipMap.get(channelId);
          if (activeChannelData && activeChannelData.aiCommunicator) {
            const { base64Audio, processedPcmBuffer, mimeType } = processInputAudioForService(currentAudioBuffer, channelId);

            if (AI_SERVICE_PROVIDER === 'gemini') {
              if (activeChannelData.aiCommunicator.isReady()) {
                // logClient(`[RTP] Sending audio to Gemini for ${channelId}: ${processedPcmBuffer.length} bytes, type ${mimeType}`);
                activeChannelData.aiCommunicator.sendAudio(processedPcmBuffer, mimeType);
              } else {
                // logClient(`[RTP] Gemini not ready for ${channelId}, processed audio chunk discarded.`);
              }
            } else if (AI_SERVICE_PROVIDER === 'openai') {
              if (activeChannelData.aiCommunicator.readyState === WebSocket.OPEN) {
                // logClient(`[RTP] Sending audio to OpenAI for ${channelId}: ${base64Audio.length} base64 chars`);
                activeChannelData.aiCommunicator.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: base64Audio }));
              } else {
                // logClient(`[RTP] OpenAI WebSocket not open for ${channelId}, processed audio chunk discarded.`);
              }
            }
          } else {
            // Interval fired but no active AI communicator or channel data, clear interval
            if (activeChannelData && activeChannelData.sendTimeout) {
                clearInterval(activeChannelData.sendTimeout);
                activeChannelData.sendTimeout = null;
            }
          }
        } else if (currentAudioBuffer && currentAudioBuffer.length === 0) {
            // Buffer is empty, do nothing this interval.
        } else { // No buffer exists, or channelData was removed from sipMap
            const chData = sipMap.get(channelId) || channelData; // Use potentially stale channelData if removed from map
            if (chData && chData.sendTimeout) {
                clearInterval(chData.sendTimeout);
                chData.sendTimeout = null;
                // logger.debug(`Cleared sendTimeout for ${channelId} as currentAudioBuffer is null/undefined.`);
            }
        }
      }, STREAM_PROCESSING_DELAY_MS);
    }
  });

  rtpReceiver.on('error', (err) => {
    logger.error(`RTP Receiver error: ${err.message}`);
  });

  rtpReceiver.bind(RTP_PORT, process.env.RTP_SERVER_IP || '127.0.0.1');
}


// --- Audio Processing Functions ---
function processInputAudioForService(muLawBuffer, channelId) {
    const pcm8kHz = muLawToLpcm8kHz(muLawBuffer);
    let processedPcmBufferForService; // This will be the buffer sent to the service (e.g. WAV or L16)
    let base64Audio; // Base64 version if needed by the specific AI client that doesn't do it internally
    let mimeType;

    if (AI_SERVICE_PROVIDER === 'gemini') {
        // Gemini: µ-law 8kHz -> LPCM 8kHz -> LPCM 16kHz -> WAV
        const pcm16kHz = upsampleLpcm8kHzTo16kHz(pcm8kHz);
        const wav = new WaveFile();
        wav.fromScratch(1, 16000, '16', pcm16kHz); // 1 channel, 16kHz, 16-bit LPCM
        processedPcmBufferForService = wav.toBuffer(); // This is the WAV file buffer
        // GeminiApiCommunicator handles base64 encoding internally if raw buffer is provided
        base64Audio = null; // Not strictly needed here as communicator handles it.
        mimeType = 'audio/wav';

        if (ENABLE_AUDIO_RECORDING && processedPcmBufferForService.length > 0) {
             if (!audioToServiceMap.has(channelId)) audioToServiceMap.set(channelId, []);
             // Store the WAV buffer directly
             audioToServiceMap.get(channelId).push({type: 'wav', data: Buffer.from(processedPcmBufferForService)});
        }
        logAudioProc(`Processed for Gemini (WAV): ${muLawBuffer.length} µ-law bytes -> ${processedPcmBufferForService.length} WAV bytes for channel ${channelId}`);

    } else { // OpenAI or default
        // OpenAI: µ-law 8kHz -> LPCM 8kHz -> LPCM 24kHz (as per original example, but OpenAI SDK might prefer 16kHz)
        // For OpenAI, the Realtime API expects audio as base64 encoded.
        // The previous code used a custom muLawToPcm24kHz.
        // Let's use LPCM 16kHz for OpenAI as a common, well-supported format.
        // If 24kHz is strictly needed, the upsampler needs to be more sophisticated or use the old one.
        const pcm16kHz = upsampleLpcm8kHzTo16kHz(pcm8kHz); // Using 16kHz for OpenAI for wider compatibility
        processedPcmBufferForService = pcm16kHz; // Raw LPCM 16kHz buffer
        base64Audio = processedPcmBufferForService.toString('base64');
        mimeType = 'audio/L16; rate=16000'; // MIME type for raw LPCM 16kHz

        if (ENABLE_AUDIO_RECORDING && processedPcmBufferForService.length > 0) {
            if (!audioToServiceMap.has(channelId)) audioToServiceMap.set(channelId, []);
            audioToServiceMap.get(channelId).push({type: 'pcm16k', data: Buffer.from(processedPcmBufferForService)});
        }
        logAudioProc(`Processed for OpenAI (LPCM16k): ${muLawBuffer.length} µ-law bytes -> ${processedPcmBufferForService.length} LPCM16k bytes for channel ${channelId}`);
    }
    // Return both the buffer that might be needed by GeminiApiCommunicator (e.g. WAV) and the base64 for OpenAI
    return { base64Audio, processedPcmBuffer: processedPcmBufferForService, mimeType };
}


// Save PCM data as a WAV file
function saveWavFile(data, filename, sampleRate = 16000, isPcm = true) {
  try {
    if (isPcm) { // data is raw PCM
      const wav = new WaveFile();
      wav.fromScratch(1, sampleRate, '16', data); // Assuming 1 channel, 16-bit
      fs.writeFileSync(filename, wav.toBuffer());
    } else { // data is already a WAV file buffer
      fs.writeFileSync(filename, data);
    }
    logger.info(`Saved audio as ${filename}`);
  } catch (e) {
    logger.error(`Error saving WAV file ${filename}: ${e.message}`);
  }
}

// Save raw μ-law data to a file
function saveRawFile(data, filename) {
  try {
    fs.writeFileSync(filename, data);
    logger.info(`Saved raw μ-law as ${filename}`);
  } catch (e) {
    logger.error(`Error saving raw file ${filename}: ${e.message}`);
  }
}

// Convert 16-bit LPCM sample to μ-law (G.711)
function pcm16ToMuLaw(sample) {
  const MAX_ABS_SAMPLE = 32767;
  const MU = 255;
  // Bias can vary. For G.711, it's often implicitly handled by segmentation.
  // A common direct formula uses a bias like 33 for positive samples.
  // However, a direct lookup table or segment-based conversion is most accurate for G.711.
  // This is a common approximation.

  sample = Math.max(-MAX_ABS_SAMPLE, Math.min(MAX_ABS_SAMPLE, sample)); // Clamp
  let sign = (sample < 0) ? 0x80 : 0x00;
  let absSample = Math.abs(sample);

  // Handle true zero and near-zero inputs correctly for G.711 µ-law
  // Output for 0 is 0xFF (inverted), for -1 is 0xFF, for +1 is 0x7F (inverted)
  if (absSample <= 1) { // Simplified: map small values to G.711 "zero"
    return sign === 0x80 ? 0xFF : 0x7F; // These are inverted values
  }

  // Apply a bias before log compression (common in some approximations)
  // const bias = 33; absSample = Math.min(MAX_ABS_SAMPLE, absSample + bias);

  // Normalize sample to [0, 1] range for the log formula
  const normalizedSample = absSample / MAX_ABS_SAMPLE;
  // Apply μ-law compression formula
  let muLawCompressed = Math.floor((MU * Math.log(1 + MU * normalizedSample)) / Math.log(1 + MU));

  // Ensure the compressed value is within the 0-127 range for magnitude part
  muLawCompressed = Math.min(127, muLawCompressed);

  // Combine with sign bit and then invert all bits (standard for G.711 µ-law)
  return (~(sign | muLawCompressed)) & 0xFF;
}


// Resample 24kHz LPCM to 8kHz LPCM (simple decimation: take 1 of every 3 samples)
function resamplePcm24kHzTo8kHz(pcm24kHzBuffer) {
    const numInputSamples = pcm24kHzBuffer.length / 2;
    const numOutputSamples = Math.floor(numInputSamples / 3);
    const pcm8kHzBuffer = Buffer.alloc(numOutputSamples * 2);

    for (let i = 0; i < numOutputSamples; i++) {
        // Read the first sample of each 3-sample group
        const sample = pcm24kHzBuffer.readInt16LE(i * 3 * 2);
        pcm8kHzBuffer.writeInt16LE(sample, i * 2);
    }
    logAudioProc(`Resampled ${pcm24kHzBuffer.length} bytes (24kHz LPCM) to ${pcm8kHzBuffer.length} bytes (8kHz LPCM)`);
    return pcm8kHzBuffer;
}


// Process output audio from AI Service (e.g., 24kHz LPCM from Gemini/OpenAI) to µ-law for Asterisk
function processOutputAudioForAsterisk(pcmBuffer, inputSampleRate = 24000) {
    let pcm8kHz;
    if (inputSampleRate === 24000) {
        pcm8kHz = resamplePcm24kHzTo8kHz(pcmBuffer);
    } else if (inputSampleRate === 16000) { // If AI service output 16kHz
        const numInputSamples = pcmBuffer.length / 2;
        const numOutputSamples = Math.floor(numInputSamples / 2); // 16k -> 8k is 1/2
        pcm8kHz = Buffer.alloc(numOutputSamples * 2);
        for (let i = 0; i < numOutputSamples; i++) {
            pcm8kHz.writeInt16LE(pcmBuffer.readInt16LE(i * 2 * 2), i * 2); // Take 1 of 2 samples
        }
        logAudioProc(`Resampled ${pcmBuffer.length} bytes (16kHz LPCM) to ${pcm8kHz.length} bytes (8kHz LPCM)`);
    } else if (inputSampleRate === 8000) {
        pcm8kHz = pcmBuffer; // Already 8kHz
        logAudioProc(`Input audio is already 8kHz LPCM, no resampling needed. Bytes: ${pcm8kHz.length}`);
    } else {
        logger.warn(`[AudioProc] Unsupported input sample rate for output processing: ${inputSampleRate}. Returning empty buffer.`);
        return Buffer.alloc(0);
    }

    if (pcm8kHz.length === 0) {
        logger.warn(`[AudioProc] PCM 8kHz buffer is empty after resampling. Cannot convert to µ-law.`);
        return Buffer.alloc(0);
    }

    const muLawBuffer = Buffer.alloc(pcm8kHz.length / 2);
    for (let i = 0; i < pcm8kHz.length / 2; i++) {
        const sample = pcm8kHz.readInt16LE(i * 2);
        muLawBuffer[i] = pcm16ToMuLaw(sample);
    }
    logAudioProc(`Converted ${pcm8kHz.length} bytes (8kHz LPCM) to ${muLawBuffer.length} bytes (µ-law)`);
    return muLawBuffer;
}

// Build RTP header for a packet
function buildRTPHeader(seq, timestamp, ssrc) {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // Version 2, no padding, no extension
  header[1] = 0x00; // Payload type (0 for μ-law)
  header.writeUInt16BE(seq, 2); // Sequence number
  header.writeUInt32BE(timestamp, 4); // Timestamp
  header.writeUInt32BE(ssrc, 8); // Synchronization source
  return header;
}

// Async queue for sending RTP packets
const rtpQueue = async.queue((task, callback) => {
  rtpSender.send(task.packet, task.port, task.address, callback);
}, RTP_QUEUE_CONCURRENCY);

// Send an RTP packet with μ-law data
async function sendAudioPacket(muLawData, port, address, seq, timestamp, ssrc) {
  const startTime = process.hrtime.bigint();
  const header = buildRTPHeader(seq, timestamp, ssrc);
  const rtpPacket = Buffer.concat([header, muLawData]);
  await new Promise((resolve, reject) => {
    rtpQueue.push({ packet: rtpPacket, port, address }, (err) => {
      const elapsedMs = Number(process.hrtime.bigint() - startTime) / 1e6;
      if (ENABLE_RTP_LOGGING && seq % LOG_RTP_EVERY_N_PACKETS === 0) {
        logger.info(`Sent packet seq=${seq}, timestamp=${timestamp}, elapsed=${elapsedMs.toFixed(2)}ms`);
      }
      if (err) {
        logger.error(`Error sending RTP packet: ${err.message}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

// Stream audio to Asterisk via RTP
const MAX_BUFFER_SIZE = 1024 * 1024; // Max buffer size (1MB)
async function streamAudio(channelId, rtpSource, initialBuffer = Buffer.alloc(0)) {
  const samplesPerPacket = 80; // 10 ms at 8000 Hz
  const packetIntervalNs = BigInt(10 * 1e6); // 10 ms in nanoseconds
  const { address, port } = rtpSource; // rtpSource is where Asterisk expects to receive audio FROM this app

  logger.info(`Initializing Output RTP stream to ${address}:${port} for channel ${channelId}`);

  let rtpSequence = Math.floor(Math.random() * 65535);
  let rtpTimestamp = Math.floor(Math.random() * 4294967295); // Initial timestamp can be random
  const rtpSSRC = Math.floor(Math.random() * 4294967295);
  let streamStartTimeNs = process.hrtime.bigint();
  let isStreaming = true;
  let totalBytesSent = 0;
  let totalPacketsSent = 0;
  let stopRequested = false;

  let muLawBufferForRtp = Buffer.alloc(0); // Buffer for µ-law data to be sent via RTP
  let rtpBufferOffset = 0;

  if (!rtpSentStats.has(channelId)) {
    rtpSentStats.set(channelId, { packets: 0, bytes: 0, startTime: null });
  }

  const sendPacketsFromBuffer = async () => {
    let packetsSentInBatch = 0;
    while (muLawBufferForRtp.length - rtpBufferOffset >= samplesPerPacket && !stopRequested) {
      const packetData = muLawBufferForRtp.slice(rtpBufferOffset, rtpBufferOffset + samplesPerPacket);
      await sendAudioPacket(packetData, port, address, rtpSequence, rtpTimestamp, rtpSSRC);

      rtpSequence = (rtpSequence + 1) % 65536;
      rtpTimestamp = (rtpTimestamp + samplesPerPacket) % 4294967296; // Timestamp increments by num samples
      totalBytesSent += packetData.length;
      totalPacketsSent++;
      packetsSentInBatch++;

      const stats = rtpSentStats.get(channelId);
      stats.packets++;
      stats.bytes += packetData.length;
      if (!stats.startTime) stats.startTime = Date.now();

      rtpBufferOffset += samplesPerPacket;

      const expectedElapsedTimeNs = BigInt(totalPacketsSent) * packetIntervalNs;
      const actualElapsedTimeNs = process.hrtime.bigint() - streamStartTimeNs;
      const timeDiffNs = expectedElapsedTimeNs - actualElapsedTimeNs;

      if (timeDiffNs > 0) {
        const delayMs = Number(timeDiffNs) / 1e6;
        if (delayMs > 1) {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, delayMs))); // Ensure non-negative delay
        }
      }
    }

    if (rtpBufferOffset > 0 && muLawBufferForRtp.length - rtpBufferOffset < samplesPerPacket && muLawBufferForRtp.length > MAX_BUFFER_SIZE / 2) {
      muLawBufferForRtp = muLawBufferForRtp.slice(rtpBufferOffset);
      rtpBufferOffset = 0;
    } else if (rtpBufferOffset >= muLawBufferForRtp.length) {
        muLawBufferForRtp = Buffer.alloc(0);
        rtpBufferOffset = 0;
    }
    return packetsSentInBatch;
  };

  const silencePacket = Buffer.alloc(samplesPerPacket, 0x7F); // µ-law silence
  for (let i = 0; i < 5; i++) {
      if (stopRequested) break;
      await sendAudioPacket(silencePacket, port, address, rtpSequence, rtpTimestamp, rtpSSRC);
      rtpSequence = (rtpSequence + 1) % 65536;
      rtpTimestamp = (rtpTimestamp + samplesPerPacket) % 4294967296;
  }
  logger.info(`Initial silence packets sent for Output RTP stream for channel ${channelId}`);
  streamStartTimeNs = process.hrtime.bigint();


  const writePcmData = async (pcmChunk, inputSampleRate = 24000) => {
    if (stopRequested || !isStreaming) {
        // logger.debug(`[StreamAudio] Not writing PCM for ${channelId}, stream stopped or not streaming.`);
        return;
    }
    const muLawData = processOutputAudioForAsterisk(pcmChunk, inputSampleRate);
    if (muLawData.length > 0) {
        muLawBufferForRtp = Buffer.concat([muLawBufferForRtp, muLawData]);
        if (muLawBufferForRtp.length > MAX_BUFFER_SIZE) {
             logger.warn(`Output RTP send buffer for channel ${channelId} exceeded MAX_BUFFER_SIZE, trimming.`);
             const excess = muLawBufferForRtp.length - MAX_BUFFER_SIZE;
             muLawBufferForRtp = muLawBufferForRtp.slice(excess);
             rtpBufferOffset = Math.max(0, rtpBufferOffset - excess);
        }
        await sendPacketsFromBuffer();
    }
  };


  const stop = async () => {
    logger.info(`Stopping Output RTP stream for channel ${channelId}. Pending packets: ${Math.floor((muLawBufferForRtp.length - rtpBufferOffset)/samplesPerPacket)}`);
    stopRequested = true;
    await sendPacketsFromBuffer(); // Try to send any remaining buffered data
    isStreaming = false;
    muLawBufferForRtp = Buffer.alloc(0);
    rtpBufferOffset = 0;

    const totalDuration = Number(process.hrtime.bigint() - streamStartTimeNs) / 1e9;
    logger.info(`Finished Output RTP stream for channel ${channelId} | Duration: ${totalDuration.toFixed(2)}s | Total Bytes: ${totalBytesSent} | Total Packets: ${totalPacketsSent}`);
    rtpSentStats.delete(channelId); // Clear stats for this ended stream
  };

  return {
    stop,
    write: writePcmData,
    isStreaming: () => isStreaming && !stopRequested,
  };
}

// --- AI Service Integration ---

// Function to get Ephemeral Token for Gemini
async function getGeminiEphemeralToken(bidiGenerateContentSetup) {
    if (!GOOGLE_APPLICATION_CREDENTIALS || !GEMINI_PROJECT_ID || !GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT) {
        logAuth('Missing Google credentials, project ID, or token service endpoint for Gemini. Cannot get ephemeral token.');
        throw new Error('Google credentials, project ID, or token service endpoint not configured for Gemini.');
    }

    try {
        logAuth(`Attempting to get Google OAuth2 token for scope: https://www.googleapis.com/auth/generativelanguage using credentials from ${GOOGLE_APPLICATION_CREDENTIALS}`);
        const auth = new GoogleAuth({
            keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
            scopes: ['https://www.googleapis.com/auth/generativelanguage'],
        });
        const client = await auth.getClient();
        const accessToken = await client.getAccessToken();

        if (!accessToken || !accessToken.token) {
            logAuth('Failed to obtain Google OAuth2 access token.');
            throw new Error('Failed to obtain Google OAuth2 access token.');
        }
        logAuth('Successfully obtained Google OAuth2 access token.');

        const postData = JSON.stringify({
            // model: GEMINI_MODEL_NAME, // Model is part of bidiGenerateContentSetup
            bidiGenerateContentSetup: bidiGenerateContentSetup,
            // ttl: "3600s" // Optional: set time-to-live for the token
        });

        const endpointUrl = new URL(GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT);
        const options = {
            hostname: endpointUrl.hostname,
            path: endpointUrl.pathname + endpointUrl.search, // Include query params if any in the endpoint URL
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken.token}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };

        return new Promise((resolve, reject) => {
            logAuth(`Requesting ephemeral token from: ${GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT}`);
            const req = https.request(options, (res) => {
                let responseBody = '';
                res.on('data', (chunk) => responseBody += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            const responseJson = JSON.parse(responseBody);
                            if (!responseJson.token) {
                                logAuth(`Ephemeral token missing in response: ${responseBody}`);
                                reject(new Error('Ephemeral token missing in response from AuthTokenService.'));
                                return;
                            }
                            logAuth(`Successfully obtained ephemeral token for Gemini: ${responseJson.token ? responseJson.token.substring(0,20) + '...' : 'N/A'}`);
                            resolve(responseJson.token);
                        } catch (parseError) {
                            logAuth(`Error parsing ephemeral token response JSON: ${parseError.message}. Body: ${responseBody}`);
                            reject(new Error(`Error parsing ephemeral token response: ${parseError.message}`));
                        }
                    } else {
                        logAuth(`Error getting ephemeral token: ${res.statusCode} ${res.statusMessage} - ${responseBody}`);
                        reject(new Error(`Failed to get ephemeral token: ${res.statusCode} - ${responseBody}`));
                    }
                });
            });
            req.on('error', (error) => {
                logAuth(`Error during ephemeral token request: ${error.message}`);
                reject(error);
            });
            req.write(postData);
            req.end();
        });
    } catch (error) {
        logAuth(`Exception while getting ephemeral token: ${error.message} - ${error.stack}`);
        throw error;
    }
}


// Start WebSocket connection or Gemini connection for the selected AI service
async function startAiServiceSession(channelId, channelDataForSipMap) {
  logger.info(`Attempting to start AI Service session for channel ${channelId} using ${AI_SERVICE_PROVIDER}`);

  let aiCommunicator = null;
  // streamHandler is for sending audio TO Asterisk. It's initialized after rtpSource is known.
  // It will be assigned to channelDataForSipMap.streamHandler by initializeAndAssignStreamHandler.

  let callStartTime = Date.now();
  let maxCallTimeoutId = null;

  const initializeAndAssignStreamHandler = async () => {
    const currentChannelData = sipMap.get(channelId); // Get latest channel data
    if (currentChannelData && currentChannelData.rtpSource) {
        // Ensure streamAudio is only called once per session or if it needs re-initialization.
        if (!currentChannelData.streamHandler || !currentChannelData.streamHandler.isStreaming()) {
            currentChannelData.streamHandler = await streamAudio(channelId, currentChannelData.rtpSource);
            logger.info(`Output RTP StreamHandler initialized/re-initialized for channel ${channelId}.`);
        }
    } else {
        logger.error(`Cannot initialize Output RTP StreamHandler: No RTP source for channel ${channelId}`);
    }
    return currentChannelData ? currentChannelData.streamHandler : null;
  };
  
  const hangupCallIfActive = async (reason) => {
    logger.warn(`Hanging up call ${channelId} due to: ${reason}`);
    const chData = sipMap.get(channelId); // Use the current state from sipMap
    if (chData && chData.bridge) {
        try {
            // Check if channel is still in Stasis, otherwise hangup might fail or be irrelevant
            const ariChannel = await ariClient.channels.get({channelId: channelId}).catch(()=>null);
            if (ariChannel && ariChannel.state === 'Stasis') {
                 await ariClient.channels.hangup({ channelId: channelId });
                 logger.info(`Channel ${channelId} hung up.`);
            } else if (ariChannel) {
                logger.info(`Channel ${channelId} is in state ${ariChannel.state}, not attempting hangup.`);
            } else {
                logger.info(`Channel ${channelId} not found on ARI, likely already hung up.`);
            }
        } catch (err) {
            logger.error(`Failed to hang up channel ${channelId}: ${err.message}`);
        }
    } else {
        logger.info(`Channel ${channelId} data not found in sipMap or no bridge associated, cannot hang up.`);
    }
  };

  const cleanupSession = async (reason = "Session ended") => {
    logger.info(`Cleaning up AI session for channel ${channelId}. Reason: ${reason}`);
    if (maxCallTimeoutId) clearTimeout(maxCallTimeoutId);
    maxCallTimeoutId = null;

    const chData = sipMap.get(channelId);
    if (chData) {
        if (chData.streamHandler && typeof chData.streamHandler.stop === 'function') {
            logger.info(`Stopping output RTP stream handler for channel ${channelId} during session cleanup.`);
            await chData.streamHandler.stop().catch(e => logger.error(`Error stopping stream handler for ${channelId}: ${e.message}`));
            chData.streamHandler = null;
        }
        if (chData.aiCommunicator) {
            if (typeof chData.aiCommunicator.close === 'function') {
                logger.info(`Closing AI communicator for channel ${channelId} with reason: ${reason}`);
                chData.aiCommunicator.close(1000, reason);
            } else if (typeof chData.aiCommunicator.terminate === 'function') { // For raw WebSocket
                logger.info(`Terminating raw WebSocket for channel ${channelId}`);
                chData.aiCommunicator.terminate();
            }
            chData.aiCommunicator = null;
        }
        // Do not remove from sipMap here, StasisEnd will handle that
    }
  };

  maxCallTimeoutId = setTimeout(async () => {
      logClient(`Max call duration (${(MAX_CALL_DURATION / 1000).toFixed(0)}s) reached for channel ${channelId}.`);
      await cleanupSession("Max call duration reached");
      await hangupCallIfActive("Max call duration reached");
  }, MAX_CALL_DURATION);

  if (AI_SERVICE_PROVIDER === 'gemini') {
    if (!GEMINI_PROJECT_ID || !GOOGLE_APPLICATION_CREDENTIALS || !GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT) {
        const errMsg = "Gemini provider selected, but GOOGLE_APPLICATION_CREDENTIALS, GEMINI_PROJECT_ID or GEMINI_AUTH_TOKEN_SERVICE_ENDPOINT is not set.";
        logger.error(errMsg);
        await cleanupSession(errMsg); 
        await hangupCallIfActive(errMsg);
        throw new Error(errMsg);
    }

    const geminiCallbacks = {
        onOutputAudio: async (pcmData_24kHz, callData) => {
            // logServer(`[Gemini] Received output audio for call ${callData.channelId}, ${pcmData_24kHz.length} bytes (24kHz PCM)`);
            const chData = sipMap.get(callData.channelId);
            if (chData && chData.streamHandler && chData.streamHandler.isStreaming()) {
                await chData.streamHandler.write(pcmData_24kHz, 24000);
            } else {
                logger.warn(`[Gemini] No active stream handler or not streaming for channel ${callData.channelId} to send audio.`);
            }
        },
        onInputTranscription: (text, callData) => {
            logServer(`[Gemini] Input transcription for ${callData.channelId}: ${text}`);
        },
        onOutputTranscription: (text, callData) => {
            logServer(`[Gemini] Output transcription for ${callData.channelId}: ${text}`);
        },
        onConnectionClose: async (callData, code, reasonStr) => {
            logServer(`[Gemini] Connection closed for call ${callData.channelId}. Code: ${code}, Reason: ${reasonStr}`);
            await cleanupSession(`Gemini connection closed: ${reasonStr}`);
            if (code !== 1000 && code !== 1005) { 
                 logger.warn(`[Gemini] Unexpected close (code ${code}). Hanging up call ${callData.channelId}.`);
                 await hangupCallIfActive(`Gemini connection closed unexpectedly: ${code} ${reasonStr}`);
            }
        },
        onSetupComplete: async (callData) => {
            logServer(`[Gemini] Session setup complete for call ${callData.channelId}. Ready for audio.`);
            const chData = sipMap.get(callData.channelId);
            if (chData && (!chData.streamHandler || !chData.streamHandler.isStreaming())) {
                 logger.info(`[Gemini] Setup complete, ensuring output RTP stream handler is initialized for ${callData.channelId}.`);
                 await initializeAndAssignStreamHandler();
            }
        },
        onError: async (error, callData) => {
            const errChId = callData ? callData.channelId : channelId;
            logger.error(`[Gemini] Error for call ${errChId}: ${error.message} - ${error.stack}`);
            await cleanupSession(`Gemini error: ${error.message}`);
            await hangupCallIfActive(`Gemini error: ${error.message}`);
        }
    };
    aiCommunicator = new GeminiApiCommunicator(geminiCallbacks);
    channelDataForSipMap.aiCommunicator = aiCommunicator;

    try {
        const bidiGenerateContentSetup = aiCommunicator._createBidiGenerateContentSetup(GEMINI_MODEL_NAME);
        const ephemeralToken = await getGeminiEphemeralToken(bidiGenerateContentSetup);
        await aiCommunicator.connect(null, GEMINI_MODEL_NAME, { channelId: channelId, token: ephemeralToken }); // Pass token via callSpecificData
        logger.info(`[Gemini] Initiated connection for channel ${channelId}`);
    } catch (error) {
        logger.error(`[Gemini] Failed to connect for channel ${channelId}: ${error.message} - ${error.stack}`);
        await cleanupSession(`Gemini connection failure: ${error.message}`);
        await hangupCallIfActive(`Gemini connection failure: ${error.message}`);
        throw error;
    }

  } else if (AI_SERVICE_PROVIDER === 'openai') {
    if (!OPENAI_API_KEY) {
        const errMsg = "OpenAI provider selected, but OPENAI_API_KEY is not set.";
        logger.error(errMsg);
        await cleanupSession(errMsg);
        await hangupCallIfActive(errMsg);
        throw new Error(errMsg);
    }
    logger.info(`Attempting to start OpenAI WebSocket for channel ${channelId} at ${REALTIME_URL}`);
    const ws = new WebSocket(REALTIME_URL, {
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' }
    });
    aiCommunicator = ws; 
    channelDataForSipMap.aiCommunicator = aiCommunicator;

    let responseTimestamp = null;
    let audioDeltaCount = 0;
    let transcriptDeltaCount = 0;
    let audioReceivedLogged = false;
    let audioSentTime = null;

    ws.on('open', async () => {
        logClient(`[OpenAI] WebSocket connection established for channel ${channelId}`);
        const chData = sipMap.get(channelId);
        if (chData && (!chData.streamHandler || !chData.streamHandler.isStreaming())) {
            await initializeAndAssignStreamHandler();
        }
        ws.send(JSON.stringify({
            type: 'session.update',
            session: {
                modalities: ['audio', 'text'],
                voice: OPENAI_VOICE_ID,
                instructions: prompts.openai.system_instruction,
                turn_detection: {
                    type: 'server_vad',
                    threshold: VAD_THRESHOLD,
                    prefix_padding_ms: VAD_PREFIX_PADDING_MS,
                    silence_duration_ms: VAD_SILENCE_DURATION_MS
                },
                input_audio_transcription: { model: 'whisper-1' }
            }
        }));
        logClient(`[OpenAI] Session updated for channel ${channelId}`);
    });

    ws.on('message', async (data) => {
        const response = JSON.parse(data.toString());
        switch (response.type) {
            case 'session.created':
                logServer(`[OpenAI] Session created for ${channelId}.`);
                break;
            case 'input_audio_buffer.speech_started':
                logServer(`[OpenAI] Speech started for ${channelId}.`);
                break;
            case 'input_audio_buffer.speech_stopped':
                logServer(`[OpenAI] Speech stopped for ${channelId}.`);
                audioSentTime = Date.now();
                break;
            case 'conversation.item.input_audio_transcription.completed':
                {
                    const userText = response.transcript.trim();
                    logServer(`[OpenAI] Input transcription for ${channelId}: "${userText}"`);
                    if (userText) {
                        const userMessage = { speaker: "user", text: userText, timestamp: Date.now() };
                        const redisKey = `conv:${channelId}`;
                        try {
                            if (redisClient && redisClient.isReady) { // Check if client is connected
                                await redisClient.rPush(redisKey, JSON.stringify(userMessage));
                                await redisClient.expire(redisKey, REDIS_CONVERSATION_TTL_S);
                                logger.debug(`[Redis] Stored user message for ${channelId}`);
                            } else {
                                logger.warn(`[Redis] Client not ready, cannot store user message for ${channelId}`);
                            }
                        } catch (err) {
                            logger.error(`[Redis] Error storing user message for ${channelId}: ${err.message}`);
                        }
                    }
                }
                break;
            case 'response.audio.delta':
                audioDeltaCount++;
                if (!audioReceivedLogged) {
                    responseTimestamp = Date.now();
                    logServer(`[OpenAI] Audio reception started for ${channelId}.`);
                    audioReceivedLogged = true;
                }
                const pcmChunk = Buffer.from(response.delta, 'base64'); 
                const chData = sipMap.get(channelId);
                if (chData && chData.streamHandler && chData.streamHandler.isStreaming()) {
                    await chData.streamHandler.write(pcmChunk, 24000); // OpenAI output is 24kHz
                } else {
                     logger.warn(`[OpenAI] No stream handler or not streaming for ${channelId} to send audio delta.`);
                }
                break;
            case 'response.audio_transcript.delta':
                transcriptDeltaCount++;
                break;
            case 'response.audio_transcript.done':
                {
                    const aiText = response.transcript.trim();
                    logServer(`[OpenAI] Output transcription for ${channelId}: "${aiText}"`);
                    if (aiText) {
                        const aiMessage = { speaker: "ai", text: aiText, timestamp: Date.now() };
                        const redisKey = `conv:${channelId}`;
                        try {
                            if (redisClient && redisClient.isReady) { // Check if client is connected
                                await redisClient.rPush(redisKey, JSON.stringify(aiMessage));
                                await redisClient.expire(redisKey, REDIS_CONVERSATION_TTL_S);
                                logger.debug(`[Redis] Stored AI message for ${channelId}`);
                            } else {
                                logger.warn(`[Redis] Client not ready, cannot store AI message for ${channelId}`);
                            }
                        } catch (err) {
                            logger.error(`[Redis] Error storing AI message for ${channelId}: ${err.message}`);
                        }
                    }
                }
                break;
            case 'response.done':
                logServer(`[OpenAI] Response completed for ${channelId}. Audio deltas: ${audioDeltaCount}, Transcript deltas: ${transcriptDeltaCount}`);
                audioReceivedLogged = false;
                audioDeltaCount = 0;
                transcriptDeltaCount = 0;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'input_audio_buffer.clear' }));
                    logClient(`[OpenAI] Cleared input audio buffer for ${channelId}`);
                }
                break;
            case 'error':
                logger.error(`[OpenAI] Error for ${channelId}: ${response.error.message} (Code: ${response.error.code || 'N/A'})`);
                await cleanupSession(`OpenAI error: ${response.error.message}`);
                await hangupCallIfActive(`OpenAI error: ${response.error.message}`);
                break;
            default:
                logServer(`[OpenAI] Unhandled message type ${response.type} for ${channelId}`);
                break;
        }
    });

    ws.on('error', async (error) => {
        logger.error(`[OpenAI] WebSocket error for channel ${channelId}: ${error.message}`);
        await cleanupSession(`OpenAI WebSocket error: ${error.message}`);
        await hangupCallIfActive(`OpenAI WebSocket error: ${error.message}`);
    });

    ws.on('close', async (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'N/A';
        logger.info(`[OpenAI] WebSocket connection closed for channel ${channelId}. Code: ${code}, Reason: ${reasonStr}`);
        await cleanupSession(`OpenAI WebSocket closed: ${reasonStr}`);
        if (code !== 1000 && code !== 1005) {
             logger.warn(`[OpenAI] Unexpected close (code ${code}). Hanging up call ${channelId}.`);
             await hangupCallIfActive(`OpenAI WebSocket closed unexpectedly: ${code} ${reasonStr}`);
        }
    });

  } else {
    const errMsg = `Unsupported AI_SERVICE_PROVIDER: ${AI_SERVICE_PROVIDER}`;
    logger.error(errMsg);
    await cleanupSession(errMsg);
    await hangupCallIfActive(errMsg);
    throw new Error(errMsg);
  }
  // Note: streamHandler (for sending audio TO Asterisk) is initialized by onSetupComplete (Gemini) or onOpen (OpenAI)
  // after rtpSource is confirmed.
  return { 
    aiCommunicator, // This is either GeminiApiCommunicator or WebSocket
    stopSession: cleanupSession 
  };
}


// --- ARI Event Handlers ---

// Main async function to initialize ARI and handle events
(async () => {
  try {
    logger.info(`Connecting to ARI at ${ARI_URL} with user ${ARI_USER}`);
    ariClient = await ari.connect(ARI_URL, ARI_USER, ARI_PASS);
    logger.info(`Connected to ARI. Starting application "${ARI_APP}" with provider "${AI_SERVICE_PROVIDER}".`);
    await ariClient.start(ARI_APP);
    logger.info(`ARI application "${ARI_APP}" started.`);

    startRTPReceiver(); // Start RTP receiver

    // Handle new channel entering Stasis
    ariClient.on('StasisStart', async (evt, channel) => {
      logger.info(`StasisStart event for channel ${channel.id}, name: ${channel.name}, state: ${channel.state}`);
      if (channel.name && channel.name.startsWith('UnicastRTP')) {
        logger.info(`ExternalMedia channel ${channel.id} entered Stasis.`);
        let mapping = extMap.get(channel.id);
        if (!mapping) {
          logger.warn(`No mapping found for UnicastRTP channel ${channel.id} immediately. Waiting briefly...`);
          await new Promise(r => setTimeout(r, 250)); // Short delay for mapping to settle
          mapping = extMap.get(channel.id);
        }

        if (mapping) {
          logger.info(`Mapping found for ${channel.id}: Bridge ${mapping.bridgeId}, SIP Channel ${mapping.channelId}`);
          try {
            await addExtToBridge(ariClient, channel, mapping.bridgeId);
            const sipChannelData = sipMap.get(mapping.channelId);
            // rtpSource on sipChannelData is populated by the RTP receiver when it gets the first packet.
            // No specific action needed here for rtpSource.
            logger.info(`ExternalMedia channel ${channel.id} added to bridge. Associated with SIP channel ${mapping.channelId}.`);
          } catch (bridgeErr) {
             logger.error(`Error adding ExternalMedia channel ${channel.id} to bridge ${mapping.bridgeId}: ${bridgeErr.message}`);
          }
        } else {
            logger.error(`Could not find mapping for UnicastRTP channel ${channel.id} even after delay. Cannot associate with SIP call.`);
        }
        return;
      }

      logger.info(`SIP channel ${channel.id} (name: ${channel.name}) entered Stasis.`);
      try {
        const bridge = await ariClient.bridges.create({ type: 'mixing,proxy_media' });
        logger.info(`Bridge ${bridge.id} created for channel ${channel.id}`);
        await bridge.addChannel({ channel: channel.id });
        logger.info(`Channel ${channel.id} added to bridge ${bridge.id}`);

        await channel.answer();
        logger.info(`Channel ${channel.id} answered.`);

        const rtpServerIp = process.env.RTP_SERVER_IP_FOR_ASTERISK || process.env.RTP_SERVER_IP || '127.0.0.1';
        const extParams = {
          app: ARI_APP,
          external_host: `${rtpServerIp}:${RTP_PORT}`,
          format: 'ulaw',
          transport: 'udp',
          encapsulation: 'rtp',
          connection_type: 'client',
          direction: 'both'
        };
        const extChannel = await ariClient.channels.externalMedia(extParams);
        logger.info(`ExternalMedia channel ${extChannel.id} created for SIP channel ${channel.id}, external_host: ${extParams.external_host}`);
        extMap.set(extChannel.id, { bridgeId: bridge.id, channelId: channel.id });


        const channelDataForSipMap = {
            bridge: bridge,
            channelId: channel.id,
            sendTimeout: null,
            aiCommunicator: null,
            streamHandler: null, // For sending audio TO Asterisk
            rtpSource: null,     // Info about where Asterisk is sending FROM
        };
        sipMap.set(channel.id, channelDataForSipMap);

        // Wait for the first RTP packet to identify the source port and address from Asterisk
        // This rtpSource is crucial for the streamAudio (output RTP sender) to know where to send audio back.
        // However, the RTP receiver itself just needs to know which channelId to associate with an incoming packet.
        // The current RTP receiver logic looks up channelId from sipMap based on rinfo. This is a problem for new calls.
        // Let's modify the RTP receiver to temporarily hold packets from unknown sources or use a more direct mapping.
        // For now, we'll proceed and assume rtpSource gets populated.
        // The streamAudio (output RTP) will be initialized inside startAiServiceSession after rtpSource is known.

        // A more robust way to get rtpSource:
        const rtpSourcePromise = new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                logger.error(`Timeout waiting for initial RTP packet on channel ${channel.id} to determine rtpSource.`);
                reject(new Error(`Timeout waiting for initial RTP packet on channel ${channel.id}`));
            }, 7000); // Increased timeout

            const tempRtpListener = (msg, rinfo) => {
                // Heuristic: If this is the first packet after extMedia setup, it's likely for this call.
                // This is still not foolproof if multiple calls start simultaneously.
                // A better way would be for Asterisk to signal the remote RTP port it's using for this specific call leg.
                // Or, use unique local RTP ports per call for the externalMedia leg if ARI supports it well.
                const currentSipData = sipMap.get(channel.id);
                if (currentSipData && !currentSipData.rtpSource) { // Only set if not already set
                    logger.info(`RTP Source identified for channel ${channel.id} via temp listener: ${rinfo.address}:${rinfo.port}`);
                    currentSipData.rtpSource = rinfo;
                    rtpReceiver.removeListener('message', tempRtpListener); // IMPORTANT: Remove this temporary listener
                    clearTimeout(timeoutHandle);
                    resolve(rinfo);
                } else if (!currentSipData) {
                     logger.warn(`[TempRtpListener] Received RTP but no sipMap entry for ${channel.id}. Stale listener?`);
                     rtpReceiver.removeListener('message', tempRtpListener);
                     clearTimeout(timeoutHandle);
                     // Not rejecting, might be a listener from a previous failed setup.
                }
                // If rtpSource is already set, this listener should have been removed.
            };
            rtpReceiver.on('message', tempRtpListener);
            // Add a cleanup for this listener if the call ends before RTP is received.
            channelDataForSipMap.cleanupTempRtpListener = () => {
                rtpReceiver.removeListener('message', tempRtpListener);
                clearTimeout(timeoutHandle);
                logger.info(`Cleaned up temporary RTP listener for ${channel.id}`);
            };
        });


        try {
            logger.info(`Waiting for initial RTP packet to confirm rtpSource for channel ${channel.id}...`);
            await rtpSourcePromise;
            logger.info(`RTP source confirmed for channel ${channel.id}. Proceeding with AI service session.`);
            if (channelDataForSipMap.cleanupTempRtpListener) {
                channelDataForSipMap.cleanupTempRtpListener(); // Clean up listener once source is known
                delete channelDataForSipMap.cleanupTempRtpListener;
            }

            await startAiServiceSession(channel.id, channelDataForSipMap);
            // channelDataForSipMap (which is sipMap.get(channel.id)) should now be updated
            logger.info(`AI Service session started for channel ${channel.id}.`);

        } catch (e) {
            logger.error(`Error during RTP source confirmation or AI session start for ${channel.id}: ${e.message} - ${e.stack}`);
            if (channelDataForSipMap.cleanupTempRtpListener) { // Ensure temp listener is cleaned up on error too
                channelDataForSipMap.cleanupTempRtpListener();
                delete channelDataForSipMap.cleanupTempRtpListener;
            }
            await channel.hangup().catch(err => logger.error(`Failed to hangup channel ${channel.id} after setup error: ${err.message}`));
            // StasisEnd will handle further cleanup of sipMap, bridge etc.
        }

      } catch (e) {
        logger.error(`Error setting up SIP channel ${channel.id} in StasisStart: ${e.message} - ${e.stack}`);
        try {
          await channel.hangup();
        } catch (hangupErr) {
          logger.error(`Failed to hangup channel ${channel.id} after error: ${hangupErr.message}`);
        }
        // Full cleanup for this channel if it was partially added to sipMap
        const chData = sipMap.get(channel.id);
        if (chData) {
            if (chData.cleanupTempRtpListener) chData.cleanupTempRtpListener();
            if (chData.sendTimeout) clearInterval(chData.sendTimeout);
            if (chData.streamHandler && typeof chData.streamHandler.stop === 'function') await chData.streamHandler.stop().catch(err => logger.error(`Cleanup streamHandler error: ${err.message}`));
            if (chData.aiCommunicator && typeof chData.aiCommunicator.close === 'function') chData.aiCommunicator.close(1011, "Setup error");
            if (chData.bridge) await chData.bridge.destroy().catch(err => logger.error(`Cleanup bridge error: ${err.message}`));
            sipMap.delete(channel.id);
        }
      }
    });

    // Handle channel leaving Stasis (call end)
    ariClient.on('StasisEnd', async (evt, channel) => {
      logger.info(`StasisEnd event for channel ${channel.id}, name: ${channel.name}`);
      if (channel.name && channel.name.startsWith('UnicastRTP')) {
        const mapping = extMap.get(channel.id);
        if (mapping) {
            logger.info(`ExternalMedia channel ${channel.id} (linked to SIP channel ${mapping.channelId}) ended.`);
        } else {
            logger.info(`ExternalMedia channel ${channel.id} (no mapping found or already cleaned) ended.`);
        }
        extMap.delete(channel.id);
      } else { // SIP channel or other endpoint
        const channelData = sipMap.get(channel.id);
        if (channelData) {
          logger.info(`Cleaning up resources for SIP channel ${channel.id} in StasisEnd.`);
          if (channelData.cleanupTempRtpListener) { // Cleanup temp listener if it's still there
            channelData.cleanupTempRtpListener();
            delete channelData.cleanupTempRtpListener;
          }
          if (channelData.sendTimeout) {
            clearInterval(channelData.sendTimeout);
            channelData.sendTimeout = null;
            logger.info(`Input audio processing interval cleared for channel ${channel.id}`);
          }

          if (channelData.streamHandler && typeof channelData.streamHandler.stop === 'function') {
            await channelData.streamHandler.stop().catch(e => logger.error(`Error stopping output stream: ${e.message}`));
            logger.info(`Output audio stream handler stopped for channel ${channel.id}`);
          }

          if (channelData.aiCommunicator) {
            if (typeof channelData.aiCommunicator.close === 'function') {
              logger.info(`Closing AI communicator for channel ${channel.id} from StasisEnd.`);
              channelData.aiCommunicator.close(1000, "Call ended"); // Normal closure
            } else if (typeof channelData.aiCommunicator.terminate === 'function') {
                logger.info(`Terminating AI communicator WebSocket for channel ${channel.id} from StasisEnd.`);
                channelData.aiCommunicator.terminate();
            }
          }

          try {
            if (channelData.bridge) {
                logger.info(`Destroying bridge ${channelData.bridge.id} for channel ${channel.id}`);
                await channelData.bridge.destroy();
            }
          } catch (e) {
            logger.error(`Error destroying bridge for channel ${channel.id}: ${e.message}`);
          }
          sipMap.delete(channel.id);
          logger.info(`SIP channel ${channel.id} data removed from sipMap.`);
        } else {
            logger.warn(`No data found in sipMap for ended SIP channel ${channel.id} to clean up (already cleaned or never fully added).`);
        }

        // Save audio files if enabled
        if (ENABLE_AUDIO_RECORDING) {
            if (audioFromAsteriskMap.has(channel.id) && audioFromAsteriskMap.get(channel.id).length > 0) {
                saveRawFile(audioFromAsteriskMap.get(channel.id), `channel_${channel.id}_input_from_asterisk.ulaw`);
                audioFromAsteriskMap.delete(channel.id);
            }
            const serviceRecordings = audioToServiceMap.get(channel.id);
            if (serviceRecordings && serviceRecordings.length > 0) {
                serviceRecordings.forEach((rec, index) => {
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    if (rec.type === 'wav') {
                        saveWavFile(rec.data, `channel_${channel.id}_to_gemini_${timestamp}_${index}.wav`, 16000, false);
                    } else if (rec.type === 'pcm16k') {
                        saveWavFile(rec.data, `channel_${channel.id}_to_openai_${timestamp}_${index}.pcm16k.wav`, 16000, true);
                    }
                });
                audioToServiceMap.delete(channel.id);
            }
        }
      }
    });

    ariClient.on('error', (err) => logger.error(`ARI client error: ${err.message} - ${err.stack}`));
    ariClient.on('close', async () => { // Make listener async
        logger.info('ARI WebSocket connection closed. Attempting to clean up...');
        await cleanup(true); // Full cleanup as ARI is down
        // Optionally, implement reconnection logic here or exit.
        logger.info('Exiting application due to ARI connection closure.');
        process.exit(1); // Exit if ARI connection is lost and not reconnecting
    });

  } catch (err) {
    logger.error(`ARI connection error: ${err.message} - ${err.stack}`);
    await cleanup(true);
    process.exit(1); // Exit on initial connection failure
  }
})();

// Handle uncaught exceptions
process.on('uncaughtException', async (err) => {
  logger.error(`Uncaught Exception: ${err.message} - ${err.stack}`);
  await cleanup(true); // Attempt full cleanup
  process.exit(1);
});

// Handle SIGINT (Ctrl+C)
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, initiating graceful shutdown...');
  await cleanup(true); // Attempt full cleanup
  process.exit(0);
});

// Graceful shutdown for other signals like SIGTERM
process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, initiating graceful shutdown...');
  await cleanup(true); // Attempt full cleanup
  process.exit(0);
});


// Cleanup function to close sockets and connections
async function cleanup(fullCleanup = false) {
  logger.info(`Starting cleanup process. Full cleanup: ${fullCleanup}`);
  const cleanupPromises = [];

  // Create a copy of channel IDs to iterate over, as sipMap might be modified during cleanup
  const channelIds = Array.from(sipMap.keys());

  for (const channelId of channelIds) {
    const data = sipMap.get(channelId);
    if (!data) continue; // Should not happen if iterating keys from map, but good practice

    logger.info(`Cleaning up channel ${channelId}`);
    if (data.sendTimeout) {
      clearInterval(data.sendTimeout);
      data.sendTimeout = null;
    }
    // Cleanup temporary RTP listener if it exists
    if (data.cleanupTempRtpListener && typeof data.cleanupTempRtpListener === 'function') {
        data.cleanupTempRtpListener();
        delete data.cleanupTempRtpListener;
    }

    if (data.streamHandler && typeof data.streamHandler.stop === 'function') {
      logger.info(`Stopping output RTP stream handler for ${channelId}`);
      cleanupPromises.push(data.streamHandler.stop().catch(e => logger.error(`Error stopping stream handler for ${channelId}: ${e.message}`)));
    }
    if (data.aiCommunicator) {
      if (typeof data.aiCommunicator.close === 'function') {
        logger.info(`Closing AI communicator for ${channelId}`);
        try { data.aiCommunicator.close(1000, "Application shutting down"); } catch (e) { logger.error(`Error closing AI communicator for ${channelId}: ${e.message}`); }
      } else if (typeof data.aiCommunicator.terminate === 'function') { // For raw WebSockets
        logger.info(`Terminating AI communicator for ${channelId}`);
        try { data.aiCommunicator.terminate(); } catch (e) { logger.error(`Error terminating AI communicator for ${channelId}: ${e.message}`); }
      }
    }
    // Bridge destruction and hanging up calls should ideally be handled by StasisEnd
    // or if ARI connection is lost and we are doing a full sweep.
    if (fullCleanup && ariClient && ariClient.connected) {
        if (data.bridge) {
            logger.info(`Destroying bridge ${data.bridge.id} for channel ${channelId}`);
            cleanupPromises.push(ariClient.bridges.destroy({bridgeId: data.bridge.id}).catch(e => logger.error(`Error destroying bridge ${data.bridge.id}: ${e.message}`)));
        }
        // Optionally, try to hang up the channel if it's still active
        // This might be redundant if StasisEnd is also triggered by ARI shutdown.
        // cleanupPromises.push(ariClient.channels.hangup({channelId: channelId}).catch(e => logger.warn(`Error hanging up channel ${channelId} during cleanup: ${e.message}`)));
    }
  }

  // Wait for all stop/close operations on per-channel resources
  try {
    await Promise.all(cleanupPromises);
    logger.info('All per-channel resource cleanup operations completed.');
  } catch (e) {
    logger.error(`Error during parallel per-channel cleanup operations: ${e.message}`);
  }

  sipMap.clear();
  extMap.clear();
  logger.info('Cleared sipMap and extMap.');

  const socketClosePromises = [];
  if (rtpSender && typeof rtpSender.close === 'function' && rtpSender._handle) { // Check if socket is open
    socketClosePromises.push(new Promise(resolve => rtpSender.close(resolve)));
  }
  if (rtpReceiver && typeof rtpReceiver.close === 'function' && rtpReceiver._handle) { // Check if socket is open
    socketClosePromises.push(new Promise(resolve => rtpReceiver.close(resolve)));
  }


  try {
    await Promise.all(socketClosePromises);
    logger.info('RTP sender and receiver sockets closed (if they were open).');
  } catch (e) {
    logger.error(`Error closing RTP sockets: ${e.message}`);
  }


  if (fullCleanup && ariClient && ariClient.connected) {
    logger.info('Stopping ARI client application.');
    try {
      await ariClient.stop();
      logger.info('ARI Stasis application stopped.');
      // ariClient.close(); // This should happen automatically or via the 'close' event handler
    } catch (e) {
      logger.error(`Error stopping ARI client: ${e.message}`);
    }
  }
  logger.info('Cleanup finished.');
}
