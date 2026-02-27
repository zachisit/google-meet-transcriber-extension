const updatePreview = () => {
  chrome.storage.local.get("current_meeting_transcript", (data) => {
    const transcript = data.current_meeting_transcript || [];
    document.getElementById('preview').innerText = transcript.join('\n') || "No data yet. Make sure CC is ON.";
  });
};

// Update preview every second when popup is open
setInterval(updatePreview, 1000);
updatePreview();

document.getElementById('download').addEventListener('click', () => {
  chrome.storage.local.get("current_meeting_transcript", (data) => {
    const text = (data.current_meeting_transcript || []).join('\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Meet-Transcript-${new Date().getTime()}.txt`;
    a.click();
  });
});

document.getElementById('clear').addEventListener('click', () => {
  if (confirm("Clear current transcript?")) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { action: "clear" }, () => {
        updatePreview();
      });
    });
  }
});