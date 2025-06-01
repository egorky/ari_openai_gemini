// prompts.js

// Prompts for the AI services.
// You can customize these instructions to fit your specific use case.

module.exports = {
    openai: {
        // This instruction is sent to OpenAI when a new session is established.
        // It guides the assistant's behavior.
        system_instruction: "You are a helpful voice assistant. Please respond concisely and clearly. Your responses will be converted to speech."
    },
    gemini: {
        // This is the initial system prompt / context to send to Gemini.
        // For Gemini's BidiGenerateContent, this would typically be the first 'text' part
        // in the 'contents' array of the initial request or the first turn.
        // Note: The Gemini API is more about conversational turns. This initial text
        // sets the stage for the conversation.
        system_instruction: "You are a helpful AI assistant. Begin the conversation by greeting the user and asking how you can help. Keep your responses suitable for voice output."
    }
};
