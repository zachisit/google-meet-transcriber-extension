/**
 * Meet Scribe Pro — content.js
 *
 * Strategy: Google Meet renders closed captions inside a container with
 * aria-live="polite". Within it, each speaker block is a sibling group where
 * one element holds the speaker name and another holds the spoken text.
 *
 * Because Meet's CSS class names are obfuscated and change with every deploy,
 * we rely ONLY on stable semantic/structural attributes:
 *   - aria-live="polite"  → caption root
 *   - aria-atomic="false" → individual caption line wrappers
 *
 * If Google changes the DOM structure, open DevTools on an active Meet call
 * with CC enabled and locate the aria-live container to update selectors.
 */

"use strict";

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  transcript: [],          // Array of { ts, speaker, text }
  // Per-speaker tracking so multi-speaker dedup works correctly
  lastBySpeaker: {},       // { [speaker]: lastText }
  observer: null,
  debounceTimer: null,
  storageFlushTimer: null,
  meetingId: null,         // Derived from URL to detect new meetings
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive a stable meeting ID from the current URL path */
const getMeetingId = () => {
  const match = location.pathname.match(/\/([a-z]+-[a-z]+-[a-z]+)/i);
  return match ? match[1] : location.pathname;
};

/** Format a Date as HH:MM:SS */
const formatTime = (date) =>
  date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/**
 * Flush the in-memory transcript to chrome.storage.local.
 * Throttled to at most once per 2 s to avoid hammering the storage API.
 */
const scheduleStorageFlush = () => {
  if (state.storageFlushTimer) return;
  state.storageFlushTimer = setTimeout(() => {
    state.storageFlushTimer = null;
    chrome.storage.local.set({
      current_meeting_transcript: state.transcript,
      current_meeting_id: state.meetingId,
    });
  }, 2000);
};

// ─── Caption container detection ─────────────────────────────────────────────

/**
 * Returns the caption root element, trying multiple known-stable selectors.
 * Prefer aria attributes over class names.
 */
const getCaptionContainer = () => {
  // Primary: Meet marks the live caption region with aria-live="polite"
  // There may be multiple (e.g. chat notifications also use it); we want
  // the one that contains actual caption text, identifiable by its depth.
  const candidates = document.querySelectorAll('div[aria-live="polite"]');
  for (const el of candidates) {
    // The real caption container has child elements with text
    if (el.innerText && el.innerText.trim().length > 0) return el;
  }
  return null;
};

// ─── Caption parsing ──────────────────────────────────────────────────────────

/**
 * Parses the caption container and extracts (speaker, text) pairs.
 *
 * Meet's caption DOM (as of 2024-2025) looks roughly like:
 *
 *   <div aria-live="polite">
 *     <div>                            ← speaker block root
 *       <div>Speaker Name</div>        ← first child = speaker name
 *       <div>                          ← second child = text container
 *         <span>word </span>
 *         <span>word </span>
 *       </div>
 *     </div>
 *     ... more speaker blocks
 *   </div>
 *
 * We iterate the direct children and heuristically identify speaker vs text.
 */
const parseCaptions = (container) => {
  const results = []; // [{ speaker, text }]

  // Each direct child of the aria-live div is typically one speaker's block
  const blocks = Array.from(container.children);

  for (const block of blocks) {
    const children = Array.from(block.children);
    if (children.length < 2) continue;

    // First child: speaker name (short, no nested spans usually)
    const speakerEl = children[0];
    const speakerName = (speakerEl.textContent || "").trim() || "Unknown";

    // Remaining children: concatenate all text
    const textParts = children.slice(1).map((c) => c.textContent || "").join(" ");
    const text = textParts.replace(/\s+/g, " ").trim();

    if (text) results.push({ speaker: speakerName, text });
  }

  // Fallback: if the block structure doesn't parse, treat the whole container
  // text as a single "System" line so we capture something rather than nothing.
  if (results.length === 0) {
    const fallback = (container.textContent || "").replace(/\s+/g, " ").trim();
    if (fallback) results.push({ speaker: "System", text: fallback });
  }

  return results;
};

// ─── Core processing ──────────────────────────────────────────────────────────

const processCaptions = () => {
  const container = getCaptionContainer();
  if (!container) return;

  const entries = parseCaptions(container);

  let changed = false;

  for (const { speaker, text } of entries) {
    const prev = state.lastBySpeaker[speaker];

    if (!text || text === prev) continue; // Nothing new for this speaker

    // Check if this is a continuation (new text starts with the previous text).
    // Meet streams words one-by-one so "Hello" → "Hello world" is a continuation.
    const isContinuation =
      prev &&
      state.transcript.length > 0 &&
      text.startsWith(prev) &&
      state.transcript[state.transcript.length - 1].speaker === speaker;

    if (isContinuation) {
      // Update the last entry in-place (the line is still being spoken)
      const last = state.transcript[state.transcript.length - 1];
      last.text = text;
      last.ts = formatTime(new Date());
    } else {
      state.transcript.push({
        ts: formatTime(new Date()),
        speaker,
        text,
      });
    }

    state.lastBySpeaker[speaker] = text;
    changed = true;
  }

  if (changed) scheduleStorageFlush();
};

// ─── MutationObserver with proper debounce ────────────────────────────────────

const DEBOUNCE_MS = 300;

const onMutation = () => {
  clearTimeout(state.debounceTimer);
  state.debounceTimer = setTimeout(processCaptions, DEBOUNCE_MS);
};

// ─── Observer lifecycle ───────────────────────────────────────────────────────

let narrowObserverAttached = false;

/**
 * Once we locate the caption container, re-scope the observer to only watch
 * that subtree (much cheaper than watching all of document.body).
 */
const tryNarrowObserver = () => {
  if (narrowObserverAttached) return;
  const container = getCaptionContainer();
  if (!container) return;

  // Disconnect the broad body observer
  if (state.observer) state.observer.disconnect();

  // Re-attach narrowly
  state.observer = new MutationObserver(onMutation);
  state.observer.observe(container, { childList: true, subtree: true, characterData: true });
  narrowObserverAttached = true;
  console.log("[Meet Scribe Pro] Narrowed observer to caption container.");
};

const init = () => {
  state.meetingId = getMeetingId();
  console.log(`[Meet Scribe Pro] Starting for meeting: ${state.meetingId}`);

  // Restore any prior transcript for this meeting
  chrome.storage.local.get(["current_meeting_transcript", "current_meeting_id"], (data) => {
    if (data.current_meeting_id === state.meetingId && Array.isArray(data.current_meeting_transcript)) {
      state.transcript = data.current_meeting_transcript;
      console.log(`[Meet Scribe Pro] Restored ${state.transcript.length} existing lines.`);
    }
  });

  // Start with a broad observer on body to detect when captions appear
  state.observer = new MutationObserver(() => {
    tryNarrowObserver();
    onMutation();
  });
  state.observer.observe(document.body, { childList: true, subtree: true });

  // Also try immediately in case captions are already active
  tryNarrowObserver();
};

// Detect SPA navigation (leaving/joining a different call)
const handleNavigation = () => {
  const newId = getMeetingId();
  if (newId !== state.meetingId) {
    console.log(`[Meet Scribe Pro] Navigation detected, resetting for new meeting.`);
    state.transcript = [];
    state.lastBySpeaker = {};
    state.meetingId = newId;
    narrowObserverAttached = false;
    chrome.storage.local.remove(["current_meeting_transcript", "current_meeting_id"]);
    tryNarrowObserver();
  }
};

// Poll for URL changes (Meet is a SPA)
setInterval(handleNavigation, 2000);

init();

// ─── Message handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getTranscript") {
    sendResponse({ transcript: state.transcript, meetingId: state.meetingId });
    return true;
  }
  if (request.action === "clear") {
    state.transcript = [];
    state.lastBySpeaker = {};
    chrome.storage.local.remove(["current_meeting_transcript"]);
    sendResponse({ status: "cleared" });
    return true;
  }
});
