"use strict";

// ─── State ────────────────────────────────────────────────────────────────────

let refreshTimer = null;

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const previewEl      = document.getElementById("preview");
const statusEl       = document.getElementById("status");
const lineCountEl    = document.getElementById("line-count");
const downloadBtn    = document.getElementById("download");
const clearBtn       = document.getElementById("clear");
const autoScrollChk  = document.getElementById("auto-scroll");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const setStatus = (msg, type = "info") => {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
};

/** Format the transcript array into a plain-text string */
const formatTranscript = (transcript) =>
  transcript.map((e) => `[${e.ts}] ${e.speaker}: ${e.text}`).join("\n");

// ─── Get active Meet tab ───────────────────────────────────────────────────────

const getMeetTab = () =>
  new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url || !tab.url.startsWith("https://meet.google.com/")) {
        resolve(null);
      } else {
        resolve(tab);
      }
    });
  });

// ─── Transcript fetch ─────────────────────────────────────────────────────────

const fetchTranscript = async () => {
  const tab = await getMeetTab();

  if (!tab) {
    setStatus("Open a Google Meet call first.", "warn");
    previewEl.textContent = "";
    lineCountEl.textContent = "0 lines";
    return;
  }

  // Prefer live message from content script (most up-to-date)
  chrome.tabs.sendMessage(tab.id, { action: "getTranscript" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      // Content script not ready yet — fall back to storage
      chrome.storage.local.get("current_meeting_transcript", (data) => {
        renderTranscript(data.current_meeting_transcript || []);
        setStatus("CC may still be loading…", "warn");
      });
      return;
    }

    renderTranscript(response.transcript || []);
    setStatus(`Meeting: ${response.meetingId || "active"}`, "ok");
  });
};

const renderTranscript = (transcript) => {
  lineCountEl.textContent = `${transcript.length} line${transcript.length !== 1 ? "s" : ""}`;

  if (transcript.length === 0) {
    previewEl.textContent = "No captions captured yet.\nMake sure CC (Closed Captions) is ON in the Meet toolbar.";
    return;
  }

  const formatted = formatTranscript(transcript);
  previewEl.textContent = formatted;

  if (autoScrollChk.checked) {
    previewEl.scrollTop = previewEl.scrollHeight;
  }
};

// ─── Download ─────────────────────────────────────────────────────────────────

downloadBtn.addEventListener("click", async () => {
  const tab = await getMeetTab();

  const doDownload = (transcript) => {
    if (!transcript || transcript.length === 0) {
      setStatus("Nothing to download yet.", "warn");
      return;
    }
    const text = formatTranscript(transcript);
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `Meet-Transcript-${ts}.txt`;

    // Use chrome.downloads API (requires "downloads" permission)
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);

    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      URL.revokeObjectURL(url); // Always clean up
      if (chrome.runtime.lastError || downloadId === undefined) {
        setStatus("Download failed. Try again.", "error");
      } else {
        setStatus(`Saved: ${filename}`, "ok");
      }
    });
  };

  if (!tab) {
    // Still allow downloading from storage if not on Meet tab
    chrome.storage.local.get("current_meeting_transcript", (data) => {
      doDownload(data.current_meeting_transcript || []);
    });
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "getTranscript" }, (response) => {
    if (chrome.runtime.lastError || !response) {
      chrome.storage.local.get("current_meeting_transcript", (data) => {
        doDownload(data.current_meeting_transcript || []);
      });
      return;
    }
    doDownload(response.transcript || []);
  });
});

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener("click", async () => {
  if (!confirm("Clear the current transcript? This cannot be undone.")) return;

  const tab = await getMeetTab();

  const afterClear = () => {
    renderTranscript([]);
    setStatus("Transcript cleared.", "ok");
  };

  if (!tab) {
    chrome.storage.local.remove("current_meeting_transcript", afterClear);
    return;
  }

  chrome.tabs.sendMessage(tab.id, { action: "clear" }, (response) => {
    if (chrome.runtime.lastError) {
      // Content script not responding; clear storage directly
      chrome.storage.local.remove("current_meeting_transcript");
    }
    afterClear();
  });
});

// ─── Auto-refresh ─────────────────────────────────────────────────────────────

const startRefresh = () => {
  fetchTranscript();
  refreshTimer = setInterval(fetchTranscript, 1500);
};

const stopRefresh = () => {
  if (refreshTimer) clearInterval(refreshTimer);
};

// Start when popup opens, stop when it closes
document.addEventListener("DOMContentLoaded", startRefresh);
window.addEventListener("unload", stopRefresh);
