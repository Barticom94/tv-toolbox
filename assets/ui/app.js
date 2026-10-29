// Stub shell (Task 3): shows the device bridge answer. Task 7 replaces it with the Apps screens.
window.app = { key() { return false; }, onResume() {} };
document.getElementById('device').textContent = window.TV ? TV.device() : '(no bridge: open inside the app)';
