const redis = require('redis');
const winston = require('winston'); // Assuming winston is used for logging as per project structure
require('dotenv').config(); // Ensure environment variables are loaded

// Configure logger (this might be a shared logger instance in a larger app)
// For consistency with other files, using a simple console log for now if winston isn't set up globally.
// A more robust solution would be to pass a logger instance or use a shared logger module.
const logger = winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
            return `${timestamp} [RedisManager] [${level.toUpperCase()}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
        })
    ),
    transports: [new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ timestamp, level, message, ...meta }) => {
                return `${timestamp} [RedisManager] [${level}]: ${message} ${Object.keys(meta).length ? JSON.stringify(meta, null, 2) : ''}`;
            })
        )
    })],
});

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT, 10) || 6379; // Ensure port is an integer
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined; // `undefined` is better than `null` if password is not present for redis client options
const REDIS_DB = parseInt(process.env.REDIS_DB, 10) || 0; // Ensure DB is an integer

// Construct the Redis URL (preferred by node-redis v4)
// redis[s]://[[username][:password]@][host][:port][/db-number]
let redisUrl = `redis://`;
if (REDIS_PASSWORD) {
    // Note: If username is ever needed, it would go before password, e.g., `${username}:${REDIS_PASSWORD}@`
    // For now, assuming no username, just password.
    redisUrl += `:${encodeURIComponent(REDIS_PASSWORD)}@`;
}
redisUrl += `${REDIS_HOST}:${REDIS_PORT}`;
if (REDIS_DB !== undefined && REDIS_DB !== null && REDIS_DB !== 0) { // Typically DB 0 is default, so only add if not 0 for clarity or if specifically needed by URL format.
    // However, for node-redis v4, `database` option is preferred over including in URL if also using socket options.
    // For simplicity and directness with URL, we can include it, or use the `database` property in the client options object.
    // Let's use the dedicated `database` option for clarity with node-redis v4.
}

logger.info(`Initializing Redis client with host: ${REDIS_HOST}, port: ${REDIS_PORT}, DB: ${REDIS_DB}`);

const redisClientOptions = {
    socket: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        connectTimeout: 5000, // Optional: 5s connection timeout
    },
    password: REDIS_PASSWORD,
    database: REDIS_DB, // This is the standard way to specify DB for node-redis v4
};

// For TLS: if (process.env.REDIS_TLS_ENABLED === 'true') { redisClientOptions.socket.tls = true; if (process.env.REDIS_TLS_CA_CERT) { redisClientOptions.socket.ca = [fs.readFileSync(process.env.REDIS_TLS_CA_CERT)] } }


const redisClient = redis.createClient(redisClientOptions);

redisClient.on('connect', () => {
    // This event fires when the client is attempting to connect or re-connect.
    // Not necessarily "connected" yet, 'ready' is better for that.
    logger.info('Redis client connecting...');
});

redisClient.on('ready', () => {
    logger.info('Redis client successfully connected and ready to use.');
});

redisClient.on('error', (err) => {
    logger.error('Redis client error:', err);
});

redisClient.on('end', () => {
    // This event fires when the connection has been closed.
    logger.info('Redis client connection has been closed.');
});

redisClient.on('reconnecting', () => {
    logger.info('Redis client is reconnecting...');
});

// Asynchronously connect the client.
// Other modules that require this client should ideally wait for the 'ready' event
// or use a pattern where the connection status is checked.
// For this setup, we initiate connection on module load.
(async () => {
    try {
        await redisClient.connect();
        // The 'ready' event will confirm successful connection.
    } catch (err) {
        logger.error('Failed to initiate Redis connection on startup:', err);
        // Depending on application requirements, might want to exit or retry.
    }
})();

// Export the client instance.
// Modules using this client should be aware that connection is asynchronous.
module.exports = redisClient;

// Optional: Graceful shutdown function (can be called from main app's shutdown handler)
/*
async function closeRedisConnection() {
    if (redisClient && redisClient.isOpen) { // isOpen is true if connected or ready
        logger.info('Closing Redis connection...');
        try {
            await redisClient.quit(); // Gracefully closes the connection
            logger.info('Redis connection closed successfully.');
        } catch (err) {
            logger.error('Error closing Redis connection:', err);
            // Fallback to disconnect if quit fails for some reason
            // await redisClient.disconnect().catch(e => logger.error('Redis disconnect error:', e));
        }
    }
}
*/
// If you export closeRedisConnection, it can be used like:
// const redisClient = require('./redis_manager');
// process.on('SIGINT', async () => { await closeRedisConnection(); process.exit(0); });
