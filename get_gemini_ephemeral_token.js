const https = require('https');

/**
 * Obtains an ephemeral token for Gemini API WebSocket authentication.
 *
 * @async
 * @param {string} projectId - The Google Cloud Project ID.
 * @param {string} modelName - The Gemini model resource name (e.g., "models/gemini-1.5-flash-001").
 * @param {object} bidiGenerateContentSetup - The JavaScript object representing the BidiGenerateContentSetup.
 * @param {object} googleAuthClient - An authenticated instance of GoogleAuth from google-auth-library.
 * @returns {Promise<string>} A promise that resolves with the ephemeral token string.
 * @throws {Error} If any step of the token generation process fails.
 */
async function getGeminiEphemeralToken(projectId, modelName, bidiGenerateContentSetup, googleAuthClient) {
    if (!projectId || !modelName || !bidiGenerateContentSetup || !googleAuthClient) {
        throw new Error('Missing required arguments: projectId, modelName, bidiGenerateContentSetup, or googleAuthClient.');
    }

    // Step 1: Obtain Standard OAuth2 Access Token
    let accessToken;
    try {
        accessToken = await googleAuthClient.getAccessToken();
        if (!accessToken || !accessToken.token) {
            throw new Error('Failed to obtain OAuth2 access token from GoogleAuthClient.');
        }
        // console.log('[Auth] Successfully obtained Google OAuth2 access token.');
    } catch (error) {
        // console.error('[Auth] Error getting OAuth2 access token:', error);
        throw new Error(`Error getting OAuth2 access token: ${error.message}`);
    }

    // Step 2: Call AuthTokenService.CreateToken REST API
    const tokenServiceUrl = `https://generativelanguage.googleapis.com/v1beta/projects/${projectId}/locations/global/authTokens:create`;
    
    // Calculate expireTime: 30 minutes from now
    const expireTimeInSeconds = Math.floor(Date.now() / 1000) + 30 * 60;

    const requestBody = {
        authToken: {
            model: modelName,
            bidiGenerateContentSetup: bidiGenerateContentSetup,
            // expireTime: { // Optional: Example for 30 minutes expiry
            //     seconds: expireTimeInSeconds 
            // }
            // "newSessionExpireTime" could also be used if preferred for longer sessions,
            // consult Gemini documentation for specifics on behavior if both are set or which is preferred.
        }
    };
    const postData = JSON.stringify(requestBody);

    const endpointUrl = new URL(tokenServiceUrl);
    const options = {
        hostname: endpointUrl.hostname,
        path: endpointUrl.pathname + endpointUrl.search,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken.token}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData),
        },
    };

    return new Promise((resolve, reject) => {
        // console.log(`[Auth] Requesting ephemeral token from: ${tokenServiceUrl}`);
        const req = https.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => responseBody += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    try {
                        const responseJson = JSON.parse(responseBody);
                        // The exact field for the token might vary based on API version or specific service response.
                        // Common patterns include `token` directly, or nested like `authToken.name` or `authToken.token`.
                        // Based on common Google API patterns, `authToken.name` or just `token` are plausible.
                        // Let's assume the token is in `responseJson.authToken.name` as per some Google API styles for resource names.
                        // Or if it's `responseJson.token` directly.
                        // The prompt mentioned "token" or "authToken.name". Let's check for `authToken.name` first, then `token`.
                        
                        let ephemeralToken;
                        if (responseJson.authToken && responseJson.authToken.name) {
                            ephemeralToken = responseJson.authToken.name;
                        } else if (responseJson.token) {
                            ephemeralToken = responseJson.token;
                        } else {
                            // console.error('[Auth] Ephemeral token missing in response:', responseBody);
                            reject(new Error('Ephemeral token missing in response from AuthTokenService. Response: ' + responseBody));
                            return;
                        }
                        
                        // console.log(`[Auth] Successfully obtained ephemeral token (first 20 chars): ${ephemeralToken.substring(0,20)}...`);
                        resolve(ephemeralToken);
                    } catch (parseError) {
                        // console.error('[Auth] Error parsing ephemeral token response JSON:', parseError.message, 'Body:', responseBody);
                        reject(new Error(`Error parsing ephemeral token response: ${parseError.message}. Response Body: ${responseBody}`));
                    }
                } else {
                    // console.error(`[Auth] Error getting ephemeral token: ${res.statusCode} ${res.statusMessage} - ${responseBody}`);
                    reject(new Error(`Failed to get ephemeral token from AuthTokenService: ${res.statusCode} ${res.statusMessage}. Response: ${responseBody}`));
                }
            });
        });

        req.on('error', (error) => {
            // console.error('[Auth] Error during ephemeral token request:', error.message);
            reject(new Error(`HTTPS request error for ephemeral token: ${error.message}`));
        });

        req.write(postData);
        req.end();
    });
}

// Example Usage (Illustrative - requires a BidiGenerateContentSetup object and auth client)
/*
async function testGetToken() {
    // This is a conceptual BidiGenerateContentSetup.
    // The actual structure should match what Gemini API expects.
    const exampleBidiGenerateContentSetup = {
        model: "models/gemini-1.5-flash-001", // This is also passed as modelName parameter
        generationConfig: {
            responseModalities: ["AUDIO", "TEXT"],
        },
        realtimeInputConfig: {
            automaticActivityDetection: {
                vadTuningConfig: {
                    activityRatioThreshold: 0.8,
                    energyThreshold: -60,
                    prefixRequiredDurationMs: 200,
                    suffixRequiredDurationMs: 800,
                },
            },
            activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
    };

    // Mock GoogleAuth client for local testing if not running in GCP context
    // or if GOOGLE_APPLICATION_CREDENTIALS is not set up for this test.
    const mockGoogleAuthClient = {
        getAccessToken: async () => {
            // In a real test outside GCP, you might get a token manually for testing
            // or mock the entire auth flow.
            // For this example, let's assume a placeholder token.
            console.log("[Auth Mock] Mock getAccessToken called.");
            return { token: "mock-oauth2-access-token" };
        }
    };

    const projectId = process.env.GEMINI_PROJECT_ID || "your-gcp-project-id"; // Replace if not in .env
    const modelName = process.env.GEMINI_MODEL_NAME || "models/gemini-1.5-flash-001";
    
    // Ensure GOOGLE_APPLICATION_CREDENTIALS is set in your environment for real test
    // const { GoogleAuth } = require('google-auth-library');
    // const auth = new GoogleAuth({
    //   keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    //   scopes: 'https://www.googleapis.com/auth/generativelanguage',
    // });

    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
        console.warn("GOOGLE_APPLICATION_CREDENTIALS not set. Using mock auth client for testing getGeminiEphemeralToken.");
    }
    const authClient = process.env.GOOGLE_APPLICATION_CREDENTIALS ? new GoogleAuth({
        keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: 'https://www.googleapis.com/auth/generativelanguage',
      }) : mockGoogleAuthClient;


    try {
        console.log(`Attempting to get ephemeral token for project: ${projectId}, model: ${modelName}`);
        const ephemeralToken = await getGeminiEphemeralToken(
            projectId,
            modelName,
            exampleBidiGenerateContentSetup,
            authClient // Use real auth or mockGoogleAuthClient
        );
        console.log('Obtained ephemeral token:', ephemeralToken);
    } catch (error) {
        console.error('Failed to get ephemeral token during test:', error);
    }
}

// To run the test (ensure .env is set up or mock client is used):
// require('dotenv').config(); // if you haven't already
// if (require.main === module) {
//     testGetToken();
// }
*/

module.exports = getGeminiEphemeralToken;
