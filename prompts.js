// prompts.js

// Prompts for the AI services.
// You can customize these instructions to fit your specific use case.

module.exports = {
    openai: {
        system_instruction: "You are a helpful voice assistant scheduling appointments. Please respond concisely and clearly. Your responses will be converted to speech. Guide the user through the process of providing their availability and confirming a time slot.",
        states: {
            greeting: "Hello! I'm here to help you schedule an appointment. What is the reason for your appointment?",
            gathering_reason: "Okay, and could you briefly tell me the reason for this appointment?",
            collecting_availability_days: "Which days of the week are you generally available?",
            collecting_availability_times: "Great. And on those days, what times are you usually free (e.g., morning, afternoon, specific hours)?",
            proposing_slot: "Based on your availability, I have a slot at {time} on {date}. Does that work for you?",
            confirmation: "Excellent! Your appointment for {reason} is confirmed for {time} on {date}. Is there anything else I can help you with?",
            fallback: "I'm sorry, I didn't quite understand. Could you please rephrase that?",
            error_handler: "I seem to be having some trouble. Please try again in a few moments."
        }
    },
    gemini: {
        system_instruction: "You are a helpful AI assistant for scheduling appointments. Begin the conversation by greeting the user and asking for the reason for their appointment. Guide them through providing their availability (days and times), then propose a suitable time slot, and finally confirm the appointment. Keep your responses suitable for voice output and aim for a natural, conversational flow.",
        states: {
            greeting: "Hello! I'm an AI assistant, and I can help you schedule an appointment. First, could you tell me the reason for your visit?",
            gathering_reason: "Understood. And what is the primary reason for this appointment?",
            collecting_availability_days: "Thanks! Which days of the week are you typically available for an appointment?",
            collecting_availability_times: "Okay. And during those days, what are your preferred times for the appointment (e.g., morning, afternoon, or specific times like 2 PM to 4 PM)?",
            proposing_slot: "Alright, I've found an available slot for you at {time} on {date}. Would that work?",
            confirmation: "Perfect! Your appointment for {reason} is set for {time} on {date}. Can I assist with anything else today?",
            fallback: "My apologies, I didn't catch that. Could you say that again?",
            error_handler: "Apologies, I'm encountering a technical issue. Could you please try scheduling again shortly?"
        }
    }
};
