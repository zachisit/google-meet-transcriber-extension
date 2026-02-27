let transcript = [];
let lastProcessedText = "";
let lastSpeaker = "";

// Helper to find the caption container regardless of obfuscated classes
const getCaptionContainer = () => {
  // Google Meet usually wraps captions in a div with aria-live="polite"
  return document.querySelector('div[aria-live="polite"]') || 
         document.querySelector('.u73Ppc'); // Fallback to common class
};

const processCaptions = () => {
  const container = getCaptionContainer();
  if (!container) return;

  const speakerNodes = container.querySelectorAll('div[data-speaker-id]');
  
  speakerNodes.forEach(node => {
    const speakerName = node.querySelector('div:first-child')?.innerText || "System";
    const textSegments = node.querySelectorAll('span');
    const fullText = Array.from(textSegments).map(s => s.innerText).join(" ").trim();

    // EDGE CASE: Meet "flickers" text as it's being typed. 
    // We only commit if the text has actually changed or the speaker changed.
    if (fullText && fullText !== lastProcessedText) {
      const timestamp = new Date().toLocaleTimeString();
      
      // If same speaker, update the last entry if it's an extension of the previous thought
      if (speakerName === lastSpeaker && transcript.length > 0) {
        transcript[transcript.length - 1] = `[${timestamp}] ${speakerName}: ${fullText}`;
      } else {
        transcript.push(`[${timestamp}] ${speakerName}: ${fullText}`);
      }
      
      lastProcessedText = fullText;
      lastSpeaker = speakerName;

      // Persist to storage
      chrome.storage.local.set({ current_meeting_transcript: transcript });
    }
  });
};

// MutationObserver with a throttle to prevent CPU spikes
const observer = new MutationObserver((mutations) => {
  requestAnimationFrame(processCaptions);
});

// Setup observer on the body to wait for the caption container to exist
const init = () => {
  observer.observe(document.body, { childList: true, subtree: true });
  console.log("Meet Scribe Pro: Monitoring started.");
};

init();

// Handle messages from Popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "download") {
    sendResponse({ transcript });
  }
  if (request.action === "clear") {
    transcript = [];
    chrome.storage.local.remove("current_meeting_transcript");
    sendResponse({ status: "cleared" });
  }
});