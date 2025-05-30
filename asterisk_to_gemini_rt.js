// Import required Node.js modules
const ari = require('ari-client');
const fs = require('fs');
const dgram = require('dgram');
const winston = require('winston');
const chalk = require('chalk');
const async = require('async');
require('dotenv').config();
const { GoogleAuth } = require('google-auth-library');
const https = require('https'); // Used by getGeminiEphemeralToken
const WaveFile = require('wavefile').WaveFile;
const prompts = require('./prompts'); // Added prompts
const redisClient = require('./redis_manager'); // Import Redis client

const GeminiApiCommunicator = require('./gemini_api_communicator');
const getGeminiEphemeralToken = require('./get_gemini_ephemeral_token.js');

// --- Configuration ---
const ARI_URL = process.env.ARI_URL || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USERNAME || 'asterisk';
const ARI_PASS = process.env.ARI_PASSWORD || 'asterisk';
const ARI_APP = process.env.ARI_APP_NAME || 'gemini-rt-app';

const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const GEMINI_PROJECT_ID = process.env.GEMINI_PROJECT_ID;
const GEMINI_MODEL_NAME = process.env.GEMINI_MODEL_NAME || 'models/gemini-1.5-flash-001';
const GEMINI_TARGET_INPUT_SAMPLE_RATE = parseInt(process.env.GEMINI_TARGET_INPUT_SAMPLE_RATE) || 16000;

// VAD parameters for Gemini (from environment or defaults)
const GEMINI_VAD_ENERGY_THRESHOLD = parseFloat(process.env.GEMINI_VAD_ENERGY_THRESHOLD) || -60;
const GEMINI_VAD_PREFIX_PADDING_MS = parseInt(process.env.GEMINI_VAD_PREFIX_PADDING_MS) || 200;
const GEMINI_VAD_END_SENSITIVITY = parseFloat(process.env.GEMINI_VAD_END_SENSITIVITY) || 0.8;
const GEMINI_VAD_SILENCE_DURATION_MS = parseInt(process.env.GEMINI_VAD_SILENCE_DURATION_MS) || 800;

// Redis Conversation TTL and History Max Turns
const REDIS_CONVERSATION_TTL_S = parseInt(process.env.REDIS_CONVERSATION_TTL_S, 10) || 86400; // 24 hours
const GEMINI_HISTORY_MAX_TURNS = parseInt(process.env.GEMINI_HISTORY_MAX_TURNS, 10) || 10; // Max 10 turns (user + ai)

const RTP_PORT = parseInt(process.env.RTP_SERVER_PORT) || 12000;
const MAX_CALL_DURATION_S = parseInt(process.env.MAX_CALL_DURATION_S) || 300; // Max call duration in seconds
const RTP_QUEUE_CONCURRENCY = parseInt(process.env.RTP_QUEUE_CONCURRENCY) || 50;
const LOG_RTP_EVERY_N_PACKETS = parseInt(process.env.LOG_RTP_EVERY_N_PACKETS) || 100;
const ENABLE_RTP_LOGGING = process.env.ENABLE_RTP_LOGGING === 'true';
const ENABLE_AUDIO_RECORDING = process.env.ENABLE_AUDIO_RECORDING === 'true';
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const STREAM_PROCESSING_DELAY_MS = parseInt(process.env.STREAM_PROCESSING_DELAY_MS) || 20;


// --- Logger Setup ---
const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      // Basic counter for now, can be enhanced if needed
      return `${timestamp} [${level.toUpperCase()}] ${message}`;
    })
  ),
  transports: [new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
    )
  })]
});
logger.info(`AI Service Provider is hardcoded to: Gemini`);
logger.info(`Gemini Model: ${GEMINI_MODEL_NAME}`);


// --- Global State ---
const extMap = new Map(); // Maps ExternalMedia channels to their bridges and SIP channels
const sipMap = new Map(); // Maps SIP channels (channel.id) to their call data
const rtpSender = dgram.createSocket('udp4');
let rtpReceiver = dgram.createSocket('udp4');
let ariClient;
let googleAuth;

if (GOOGLE_APPLICATION_CREDENTIALS && GEMINI_PROJECT_ID) {
    try {
        googleAuth = new GoogleAuth({
            keyFilename: GOOGLE_APPLICATION_CREDENTIALS,
            scopes: 'https://www.googleapis.com/auth/generativelanguage',
        });
        logger.info('GoogleAuth initialized successfully.');
    } catch (e) {
        logger.error(`Failed to initialize GoogleAuth: ${e.message}`);
        process.exit(1);
    }
} else {
    logger.warn('Google credentials or Project ID not set. Gemini functionality will be disabled.');
}


// --- Audio Processing Functions ---

// Convert a single μ-law sample to 16-bit LPCM
function muLawToPcm16(muLawSample) {
    muLawSample = ~muLawSample & 0xFF;
    const sign = (muLawSample & 0x80) ? -1 : 1;
    const exponent = (muLawSample & 0x70) >> 4;
    const mantissa = muLawSample & 0x0F;
    let pcmSample = (exponent === 0) ? (mantissa * 8 + 16) : (1 << (exponent + 3)) * (mantissa + 16) - 128;
    pcmSample *= sign;
    return Math.max(-32768, Math.min(32767, pcmSample));
}

// Convert μ-law buffer to 8kHz LPCM S16LE
function muLawToLpcm8kHz(muLawBuffer) {
    const pcmBuffer = Buffer.alloc(muLawBuffer.length * 2);
    for (let i = 0; i < muLawBuffer.length; i++) {
        pcmBuffer.writeInt16LE(muLawToPcm16(muLawBuffer[i]), i * 2);
    }
    return pcmBuffer;
}

// Upsample 8kHz LPCM to targetRate LPCM (simple sample duplication)
function upsampleLpcm(pcm8kHzBuffer, targetRate = 16000) {
    if (targetRate === 8000) return pcm8kHzBuffer;
    if (targetRate % 8000 !== 0) {
        logger.warn(`Target sample rate ${targetRate} is not a multiple of 8000. Using duplication, quality may vary.`);
    }
    const ratio = Math.floor(targetRate / 8000); // Should be integer for simple duplication
    const pcmTargetRateBuffer = Buffer.alloc(pcm8kHzBuffer.length * ratio);
    for (let i = 0; i < pcm8kHzBuffer.length / 2; i++) {
        const sample = pcm8kHzBuffer.readInt16LE(i * 2);
        for (let j = 0; j < ratio; j++) {
            pcmTargetRateBuffer.writeInt16LE(sample, (i * ratio + j) * 2);
        }
    }
    return pcmTargetRateBuffer;
}

function processInputAudioForGemini(muLawBuffer, channelId) {
    const pcm8kHz = muLawToLpcm8kHz(muLawBuffer);
    const pcm16kHz = upsampleLpcm(pcm8kHz, GEMINI_TARGET_INPUT_SAMPLE_RATE); // Upsample to 16kHz (or target)

    const wav = new WaveFile();
    wav.fromScratch(1, GEMINI_TARGET_INPUT_SAMPLE_RATE, '16', pcm16kHz); // 1 channel, 16kHz, 16-bit
    const wavBuffer = wav.toBuffer();
    
    // GeminiApiCommunicator expects a raw buffer (it will base64 encode internally)
    // However, the prompt asked for base64 here. Let's stick to the prompt for now.
    const base64Wav = wavBuffer.toString('base64');

    if (ENABLE_AUDIO_RECORDING && wavBuffer.length > 0) {
        if (!audioToServiceMap.has(channelId)) audioToServiceMap.set(channelId, []);
        audioToServiceMap.get(channelId).push({type: 'wav-input', data: wavBuffer});
    }
    // logger.debug(`[AudioProc] Processed for Gemini (WAV base64): ${muLawBuffer.length} µ-law bytes -> ${base64Wav.length} base64 chars for channel ${channelId}`);
    return base64Wav; // Return base64 encoded WAV string
}

// Resample 24kHz LPCM to 8kHz LPCM (simple decimation: take 1 of every 3 samples)
function resamplePcm24kHzTo8kHz(pcm24kHzBuffer) {
    const numInputSamples = pcm24kHzBuffer.length / 2;
    const numOutputSamples = Math.floor(numInputSamples / 3);
    const pcm8kHzBuffer = Buffer.alloc(numOutputSamples * 2);
    for (let i = 0; i < numOutputSamples; i++) {
        const sample = pcm24kHzBuffer.readInt16LE(i * 3 * 2);
        pcm8kHzBuffer.writeInt16LE(sample, i * 2);
    }
    return pcm8kHzBuffer;
}

function pcm16ToMuLaw(sample) {
  const MAX_ABS_SAMPLE = 32767;
  const MU = 255;
  sample = Math.max(-MAX_ABS_SAMPLE, Math.min(MAX_ABS_SAMPLE, sample));
  let sign = (sample < 0) ? 0x80 : 0x00;
  let absSample = Math.abs(sample);
  if (absSample <= 1) return sign === 0x80 ? 0xFF : 0x7F;
  const normalizedSample = absSample / MAX_ABS_SAMPLE;
  let muLawValue = Math.floor((MU * Math.log(1 + MU * normalizedSample)) / Math.log(1 + MU));
  muLawValue = Math.min(127, muLawValue);
  return (~(sign | muLawValue)) & 0xFF;
}

function processOutputAudioForAsterisk(pcm24kHzData, channelId) {
    const pcm8kHz = resamplePcm24kHzTo8kHz(pcm24kHzData); // Input is 24kHz from Gemini
    const muLawBuffer = Buffer.alloc(pcm8kHz.length / 2);
    for (let i = 0; i < pcm8kHz.length / 2; i++) {
        muLawBuffer[i] = pcm16ToMuLaw(pcm8kHz.readInt16LE(i * 2));
    }
    // logger.debug(`[AudioProc] Converted ${pcm24kHzData.length} 24kHz PCM bytes to ${muLawBuffer.length} µ-law bytes for channel ${channelId}`);
    return muLawBuffer;
}


// --- RTP Handling ---
function buildRTPHeader(seq, timestamp, ssrc) {
  const header = Buffer.alloc(12);
  header[0] = 0x80; 
  header[1] = 0x00; // Payload Type: PCMU (0)
  header.writeUInt16BE(seq, 2);
  header.writeUInt32BE(timestamp, 4);
  header.writeUInt32BE(ssrc, 8);
  return header;
}

const rtpQueue = async.queue((task, callback) => {
  rtpSender.send(task.packet, task.port, task.address, callback);
}, RTP_QUEUE_CONCURRENCY);

async function sendAudioPacket(muLawData, port, address, seq, timestamp, ssrc) {
  const header = buildRTPHeader(seq, timestamp, ssrc);
  const rtpPacket = Buffer.concat([header, muLawData]);
  await new Promise((resolve, reject) => {
    rtpQueue.push({ packet: rtpPacket, port, address }, (err) => {
      if (err) {
        logger.error(`Error sending RTP packet: ${err.message}`);
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function streamAudio(channelId, rtpSource) {
  const samplesPerPacket = 160; // For 20ms packets of ulaw (8000Hz * 0.020s = 160 samples)
  const packetIntervalNs = BigInt(20 * 1e6); // 20 ms in nanoseconds

  logger.info(`Initializing Output RTP stream to ${rtpSource.address}:${rtpSource.port} for channel ${channelId}`);
  let rtpSequence = Math.floor(Math.random() * 65535);
  let rtpTimestamp = Math.floor(Math.random() * 4294967295);
  const rtpSSRC = Math.floor(Math.random() * 4294967295);
  let streamStartTimeNs = process.hrtime.bigint();
  let isStreaming = true;
  let stopRequested = false;
  let muLawBufferForRtp = Buffer.alloc(0);
  let rtpBufferOffset = 0;

  const sendPacketsFromBuffer = async () => {
    while (muLawBufferForRtp.length - rtpBufferOffset >= samplesPerPacket && !stopRequested) {
      const packetData = muLawBufferForRtp.slice(rtpBufferOffset, rtpBufferOffset + samplesPerPacket);
      await sendAudioPacket(packetData, rtpSource.port, rtpSource.address, rtpSequence, rtpTimestamp, rtpSSRC);
      rtpSequence = (rtpSequence + 1) % 65536;
      rtpTimestamp = (rtpTimestamp + samplesPerPacket) % 4294967296;
      rtpBufferOffset += samplesPerPacket;
      // Simple pacing, can be improved
      await new Promise(resolve => setTimeout(resolve, 18)); // Approx 20ms, less processing time
    }
    if (rtpBufferOffset > 0 && muLawBufferForRtp.length - rtpBufferOffset < samplesPerPacket) {
      muLawBufferForRtp = muLawBufferForRtp.slice(rtpBufferOffset);
      rtpBufferOffset = 0;
    } else if (rtpBufferOffset >= muLawBufferForRtp.length) {
        muLawBufferForRtp = Buffer.alloc(0);
        rtpBufferOffset = 0;
    }
  };
  
  // Send initial silence packets
  const silencePacket = Buffer.alloc(samplesPerPacket, 0x7F); // μ-law silence
  for (let i = 0; i < 5; i++) { 
      if (stopRequested) break;
      await sendAudioPacket(silencePacket, rtpSource.port, rtpSource.address, rtpSequence, rtpTimestamp, rtpSSRC);
      rtpSequence = (rtpSequence + 1) % 65536;
      rtpTimestamp = (rtpTimestamp + samplesPerPacket) % 4294967296;
  }
  logger.info(`Initial silence packets sent for channel ${channelId}`);
  streamStartTimeNs = process.hrtime.bigint(); // Reset start time

  const writeProcessedAudio = async (muLawDataChunk) => {
    if (stopRequested || !isStreaming) return;
    if (muLawDataChunk.length > 0) {
        muLawBufferForRtp = Buffer.concat([muLawBufferForRtp, muLawDataChunk]);
        await sendPacketsFromBuffer();
    }
  };

  const stop = async () => {
    logger.info(`Stopping Output RTP stream for channel ${channelId}.`);
    stopRequested = true;
    await sendPacketsFromBuffer(); // Send any remaining data
    isStreaming = false;
  };
  return { stop, write: writeProcessedAudio, isStreaming: () => isStreaming && !stopRequested };
}


// --- Main Application Logic ---
(async () => {
  try {
    ariClient = await ari.connect(ARI_URL, ARI_USER, ARI_PASS);
    logger.info(`Connected to ARI. Starting application "${ARI_APP}".`);
    await ariClient.start(ARI_APP);
    logger.info(`ARI application "${ARI_APP}" started successfully.`);
    startRTPReceiver();

    ariClient.on('StasisStart', async (evt, channel) => {
      logger.info(`StasisStart event for channel ${channel.id}, name: ${channel.name}, state: ${channel.state}`);
      if (channel.name && channel.name.startsWith('UnicastRTP')) {
        logger.info(`ExternalMedia channel ${channel.id} entered Stasis.`);
        const mapping = extMap.get(channel.id);
        if (mapping) {
          logger.info(`Mapping found for ${channel.id}: Bridge ${mapping.bridgeId}, SIP Channel ${mapping.channelId}`);
          try {
            await addExtToBridge(ariClient, channel, mapping.bridgeId);
          } catch (bridgeErr) {
             logger.error(`Error adding ExternalMedia channel ${channel.id} to bridge ${mapping.bridgeId}: ${bridgeErr.message}`);
          }
        } else {
            logger.warn(`Could not find mapping for UnicastRTP channel ${channel.id}. This might be an issue.`);
        }
        return;
      }

      logger.info(`SIP channel ${channel.id} (name: ${channel.name}) entered Stasis.`);
      const callSpecificData = { channelId: channel.id, bridgeId: null, rtpSource: null }; // For GeminiApiCommunicator

      try {
        const bridge = await ariClient.bridges.create({ type: 'mixing,proxy_media' });
        callSpecificData.bridgeId = bridge.id;
        logger.info(`Bridge ${bridge.id} created for channel ${channel.id}`);
        await bridge.addChannel({ channel: channel.id });
        logger.info(`Channel ${channel.id} added to bridge ${bridge.id}`);
        await channel.answer();
        logger.info(`Channel ${channel.id} answered.`);

        const rtpServerIp = process.env.RTP_SERVER_IP_FOR_ASTERISK || process.env.RTP_SERVER_IP || '127.0.0.1';
        const extChannel = await ariClient.channels.externalMedia({
          app: ARI_APP,
          external_host: `${rtpServerIp}:${RTP_PORT}`,
          format: 'ulaw',
        });
        extMap.set(extChannel.id, { bridgeId: bridge.id, channelId: channel.id });
        logger.info(`ExternalMedia channel ${extChannel.id} created for SIP channel ${channel.id}`);
        
        const channelDataForSipMap = {
            bridge: bridge,
            aiCommunicator: null,
            streamHandler: null, 
            rtpSource: null,
            geminiSessionReady: false,
            sendTimeout: null,
        };
        sipMap.set(channel.id, channelDataForSipMap);

        const rtpSourcePromise = new Promise((resolve, reject) => {
            const timeoutHandle = setTimeout(() => {
                logger.error(`Timeout waiting for initial RTP packet for channel ${channel.id} to identify rtpSource.`);
                reject(new Error(`Timeout waiting for initial RTP packet on channel ${channel.id}`));
            }, 7000); 

            const tempRtpListener = (msg, rinfo) => {
                const currentSipData = sipMap.get(channel.id);
                if (currentSipData && !currentSipData.rtpSource) {
                    logger.info(`RTP Source identified for channel ${channel.id} via temp listener: ${rinfo.address}:${rinfo.port}`);
                    currentSipData.rtpSource = rinfo; // Store rtpSource
                    callSpecificData.rtpSource = rinfo; // Also for GeminiApiCommunicator context if needed elsewhere
                    rtpReceiver.removeListener('message', tempRtpListener);
                    clearTimeout(timeoutHandle);
                    resolve(rinfo);
                } else if (!currentSipData) {
                     logger.warn(`[TempRtpListener] Received RTP but no sipMap entry for ${channel.id}.`);
                     rtpReceiver.removeListener('message', tempRtpListener);
                     clearTimeout(timeoutHandle);
                }
            };
            rtpReceiver.on('message', tempRtpListener);
            channelDataForSipMap.cleanupTempRtpListener = () => {
                rtpReceiver.removeListener('message', tempRtpListener);
                clearTimeout(timeoutHandle);
            };
rtpReceiver.on('message', (msg, rinfo) => {
  const sipEntry = Array.from(sipMap.entries()).find(([_, chData]) =>
    chData.rtpSource?.address === rinfo.address && chData.rtpSource?.port === rinfo.port
  );
  if (!sipEntry) return;

  const [channelId, chData] = sipEntry;
  if (!chData.aiCommunicator || !chData.aiCommunicator.isReady()) return;

  try {
    const base64Audio = processInputAudioForGemini(msg, channelId);
    const wavBuffer = Buffer.from(base64Audio, 'base64');
    chData.aiCommunicator.sendAudio(wavBuffer);
  } catch (err) {
    logger.error(`[RTP->Gemini] Error processing audio for channel ${channelId}: ${err.message}`);
  }
});

        });

        await rtpSourcePromise; // Wait for rtpSource
        logger.info(`RTP source confirmed for ${channel.id}. Initializing Gemini session.`);
        if (channelDataForSipMap.cleanupTempRtpListener) {
            channelDataForSipMap.cleanupTempRtpListener();
            delete channelDataForSipMap.cleanupTempRtpListener;
        }
        
        // Initialize and assign stream handler *after* rtpSource is known
        channelDataForSipMap.streamHandler = await streamAudio(channel.id, channelDataForSipMap.rtpSource);

        // --- Gemini Specific Setup ---
        if (!googleAuth) {
            throw new Error("GoogleAuth client not initialized. Check credentials.");
        }

        const aiCommunicator = new GeminiApiCommunicator({
            onOutputAudio: async (pcmData_24kHz, csd) => {
                const chData = sipMap.get(csd.channelId);
                if (chData && chData.streamHandler && chData.streamHandler.isStreaming()) {
                    const muLawData = processOutputAudioForAsterisk(pcmData_24kHz, csd.channelId);
                    await chData.streamHandler.write(muLawData); // Use the renamed write method
                } else {
                    logger.warn(`[Gemini] No active stream handler for channel ${csd.channelId} to send audio.`);
                }
            },
            onInputTranscription: async (text, csd) => {
                logger.info(`[Gemini] Input transcription for ${csd.channelId}: ${text}`);
                if (text) {
                    const userMessage = { speaker: "user", text: text, timestamp: Date.now() };
                    const redisKey = `conv:${csd.channelId}`;
                    try {
                        if (redisClient && redisClient.isReady) {
                            await redisClient.rPush(redisKey, JSON.stringify(userMessage));
                            await redisClient.expire(redisKey, REDIS_CONVERSATION_TTL_S);
                            logger.debug(`[Redis] Stored user message for ${csd.channelId}`);
                        } else {
                            logger.warn(`[Redis] Client not ready, cannot store user message for ${csd.channelId}`);
                        }
                    } catch (err) {
                        logger.error(`[Redis] Error storing user message for ${csd.channelId}: ${err.message}`);
                    }
                }
            },
            onOutputTranscription: async (text, csd) => {
                logger.info(`[Gemini] Output transcription for ${csd.channelId}: ${text}`);
                if (text) {
                    const aiMessage = { speaker: "ai", text: text, timestamp: Date.now() };
                    const redisKey = `conv:${csd.channelId}`;
                    try {
                        if (redisClient && redisClient.isReady) {
                            await redisClient.rPush(redisKey, JSON.stringify(aiMessage));
                            await redisClient.expire(redisKey, REDIS_CONVERSATION_TTL_S);
                            logger.debug(`[Redis] Stored AI message for ${csd.channelId}`);
                        } else {
                            logger.warn(`[Redis] Client not ready, cannot store AI message for ${csd.channelId}`);
                        }
                    } catch (err) {
                        logger.error(`[Redis] Error storing AI message for ${csd.channelId}: ${err.message}`);
                    }
                }
            },
            onConnectionClose: async (csd, code, reason) => {
                logger.info(`[Gemini] Connection closed for ${csd.channelId}. Code: ${code}, Reason: ${reason}`);
                const chData = sipMap.get(csd.channelId);
                if (chData) {
                    chData.geminiSessionReady = false;
                    if (chData.aiCommunicator) chData.aiCommunicator = null; // Clear communicator
                }
                if (code !== 1000 && code !== 1005) { // 1000 Normal, 1005 No Status Recvd
                    logger.warn(`[Gemini] Unexpected close (code ${code}). Hanging up call ${csd.channelId}.`);
                    await hangupCallIfActive(csd.channelId, `Gemini WS closed: ${code}`);
                }
            },
            onSetupComplete: (csd) => {
                logger.info(`[Gemini] Session setup complete for ${csd.channelId}.`);
                const chData = sipMap.get(csd.channelId);
                if (chData) chData.geminiSessionReady = true;
            },
            onError: async (error, csd) => {
                logger.error(`[Gemini] Error for channel ${csd.channelId}: ${error.message}`);
                await hangupCallIfActive(csd.channelId, `Gemini error: ${error.message}`);
            }
        });
        channelDataForSipMap.aiCommunicator = aiCommunicator;

        const bidiGenerateContentSetup = aiCommunicator._createBidiGenerateContentSetup(GEMINI_MODEL_NAME);
        bidiGenerateContentSetup.realtimeInputConfig.automaticActivityDetection.vadTuningConfig = {
            activityRatioThreshold: VAD_ACTIVITY_RATIO_THRESHOLD,
            energyThreshold: VAD_ENERGY_THRESHOLD,
            prefixRequiredDurationMs: VAD_PREFIX_REQUIRED_DURATION_MS,
            suffixRequiredDurationMs: VAD_SUFFIX_REQUIRED_DURATION_MS,
        };

        const ephemeralToken = await getGeminiEphemeralToken(GEMINI_PROJECT_ID, GEMINI_MODEL_NAME, bidiGenerateContentSetup, googleAuth);
        const geminiSystemPrompt = prompts.gemini.system_instruction; // Get prompt
        
        let conversationHistory = [];
        const redisKey = `conv:${channel.id}`;
        try {
            if (redisClient && redisClient.isReady) {
                const historyJson = await redisClient.lRange(redisKey, -GEMINI_HISTORY_MAX_TURNS, -1);
                conversationHistory = historyJson.map(item => JSON.parse(item));
                logger.info(`[Redis] Retrieved ${conversationHistory.length} messages for channel ${channel.id}`);
            } else {
                logger.warn(`[Redis] Client not ready, cannot retrieve history for ${channel.id}`);
            }
        } catch (err) {
            logger.error(`[Redis] Error retrieving history for ${channel.id}: ${err.message}`);
        }
        
        await aiCommunicator.connect(
            null, 
            GEMINI_MODEL_NAME, 
            { ...callSpecificData, token: ephemeralToken }, 
            geminiSystemPrompt,
            conversationHistory // Pass retrieved history
        ); 
        logger.info(`[Gemini] Connection initiated for channel ${channel.id} with prompt and history.`);

      } catch (e) {
        logger.error(`Error in StasisStart for channel ${channel.id}: ${e.message} - ${e.stack}`);
        await hangupCallIfActive(channel.id, `StasisStart error: ${e.message}`);
        // Cleanup sipMap entry if partially created
        const chData = sipMap.get(channel.id);
        if (chData) {
            if(chData.cleanupTempRtpListener) chData.cleanupTempRtpListener();
            if(chData.sendTimeout) clearInterval(chData.sendTimeout);
            if(chData.streamHandler) await chData.streamHandler.stop().catch(err => logger.error(`Error stopping stream handler on StasisStart error: ${err.message}`));
            if(chData.aiCommunicator) chData.aiCommunicator.close(1011, "StasisStart error");
            sipMap.delete(channel.id);
        }
      }
    });

    ariClient.on('StasisEnd', async (evt, channel) => {
      logger.info(`StasisEnd event for channel ${channel.id}, name: ${channel.name}`);
      const mapping = extMap.get(channel.id); // If it's an ExternalMedia channel
      if (mapping) {
          extMap.delete(channel.id);
          logger.info(`ExternalMedia channel ${channel.id} (linked to SIP ${mapping.channelId}) ended and removed from extMap.`);
      } else { // SIP channel
        const channelData = sipMap.get(channel.id);
        if (channelData) {
          logger.info(`Cleaning up resources for SIP channel ${channel.id} in StasisEnd.`);
          if (channelData.cleanupTempRtpListener) channelData.cleanupTempRtpListener();
          if (channelData.sendTimeout) clearInterval(channelData.sendTimeout);
          if (channelData.streamHandler) await channelData.streamHandler.stop().catch(e => logger.error(`StasisEnd streamHandler stop error: ${e.message}`));
          if (channelData.aiCommunicator) channelData.aiCommunicator.close(1000, "Call ended");
          if (channelData.bridge) await channelData.bridge.destroy().catch(e => logger.error(`StasisEnd bridge destroy error: ${e.message}`));
          sipMap.delete(channel.id);
          logger.info(`SIP channel ${channel.id} data removed from sipMap.`);
        } else {
            logger.warn(`No data found in sipMap for ended SIP channel ${channel.id}.`);
        }
        // Audio recording save logic
        if (ENABLE_AUDIO_RECORDING) {
            if (audioFromAsteriskMap.has(channel.id)) {
                saveRawFile(audioFromAsteriskMap.get(channel.id), `channel_${channel.id}_input_from_asterisk.ulaw`);
                audioFromAsteriskMap.delete(channel.id);
            }
            const serviceRecordings = audioToServiceMap.get(channel.id);
            if (serviceRecordings && serviceRecordings.length > 0) {
                serviceRecordings.forEach((rec, index) => {
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    if (rec.type === 'wav-input') { // Ensure this type matches what's saved
                        saveWavFile(rec.data, `channel_${channel.id}_to_gemini_${timestamp}_${index}.wav`, GEMINI_TARGET_INPUT_SAMPLE_RATE, false); // data is already wav
                    }
                });
                audioToServiceMap.delete(channel.id);
            }
        }
      }
    });

    ariClient.on('error', (err) => logger.error(`ARI client error: ${err.message} - ${err.stack}`));
    ariClient.on('close', async () => { 
        logger.info('ARI WebSocket connection closed. Attempting to clean up and exit...');
        await cleanup(true); 
        process.exit(1); 
    });

  } catch (err) {
    logger.error(`ARI connection error: ${err.message} - ${err.stack}`);
    await cleanup(true);
    process.exit(1); 
  }
})();

// Handle process termination signals
async function signalHandler(signal) {
    logger.info(`Received ${signal}, initiating graceful shutdown...`);
    await cleanup(true);
    process.exit(signal === 'SIGINT' ? 0 : 1); // Exit with 0 for SIGINT, 1 for others
}
process.on('SIGINT', () => signalHandler('SIGINT'));
process.on('SIGTERM', () => signalHandler('SIGTERM'));
process.on('uncaughtException', async (err) => {
  logger.error(`Uncaught Exception: ${err.message} - ${err.stack}`);
  await cleanup(true);
  process.exit(1);
});


// Cleanup function to close sockets and connections
async function cleanup(fullCleanup = false) {
  logger.info(`Starting cleanup process. Full cleanup: ${fullCleanup}`);
  const cleanupPromises = [];
  const channelIds = Array.from(sipMap.keys());

  for (const channelId of channelIds) {
    const data = sipMap.get(channelId);
    if (!data) continue; 

    logger.info(`Cleaning up channel ${channelId}`);
    if (data.sendTimeout) clearInterval(data.sendTimeout);
    if (data.cleanupTempRtpListener) data.cleanupTempRtpListener();
    if (data.streamHandler) cleanupPromises.push(data.streamHandler.stop().catch(e => logger.error(`Error stopping stream handler for ${channelId}: ${e.message}`)));
    if (data.aiCommunicator) {
        try { data.aiCommunicator.close(1000, "Application shutting down"); } catch (e) { logger.error(`Error closing AI communicator for ${channelId}: ${e.message}`); }
    }
    if (fullCleanup && data.bridge && ariClient && ariClient.connected) {
        cleanupPromises.push(ariClient.bridges.destroy({bridgeId: data.bridge.id}).catch(e => logger.error(`Error destroying bridge ${data.bridge.id}: ${e.message}`)));
    }
  }

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
  if (rtpSender && typeof rtpSender.close === 'function' && rtpSender._handle) { 
    socketClosePromises.push(new Promise(resolve => rtpSender.close(resolve)));
  }
  if (rtpReceiver && typeof rtpReceiver.close === 'function' && rtpReceiver._handle) { 
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
    } catch (e) {
      logger.error(`Error stopping ARI client: ${e.message}`);
    }
  }
  logger.info('Cleanup finished.');
}

[end of asterisk_to_gemini_rt.js]
