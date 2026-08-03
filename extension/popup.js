const manifest = chrome.runtime.getManifest();
document.getElementById("status").textContent =
  `Ready · version ${manifest.version} · protocol 3`;
