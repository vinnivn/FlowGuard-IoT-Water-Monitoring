FLOWGUARD — LIVE ESP32 WATER MONITORING
========================================
This package is wired for real Firebase Realtime Database readings. It does not create demo/simulated measurements. Until Firebase is configured and the ESP32 publishes heartbeats, the page should show setup required / offline.

FILES
- index.html, style.css, script.js: responsive live dashboard and history page
- firebase-config.js: paste your Firebase Web App config here
- esp32_flowguard.ino: ESP32 firmware example for a pulse-output flow sensor
- firebase-database.rules.json: starting security rules

1. CREATE FIREBASE PROJECT
1) Create a Firebase project at https://console.firebase.google.com/.
2) Build -> Realtime Database -> Create database. Copy its exact database URL.
3) Project settings -> General -> Add app -> Web app. Copy the Firebase config into firebase-config.js.
4) Authentication -> Sign-in method: enable Anonymous for the dashboard, and Email/Password for the ESP32 node account.
5) Authentication -> Users: create a dedicated user matching DEVICE_EMAIL in the firmware. Use a strong password and keep it out of public repositories.
6) Realtime Database -> Rules: paste firebase-database.rules.json after replacing esp32-node@yourdomain.com with the exact device user's email. Publish the rules. Do not use public read/write rules in a deployed system.
7) If your ESP32 library uses a different regional database URL, use the exact URL Firebase shows you in BOTH the web config and firmware.

2. RUN THE WEBSITE
Do not open index.html directly as file:// because browser module imports and Firebase auth may be blocked. Serve this folder using a local static server, for example:
  python -m http.server 8000
Then open http://localhost:8000. For use outside your computer, deploy the folder to Firebase Hosting or another HTTPS static host. Keep firebase-config.js alongside the other files.

3. FLASH THE ESP32
1) Install the ESP32 board support in Arduino IDE.
2) Install the "Firebase ESP Client" library by Mobizt.
3) Open esp32_flowguard.ino and enter Wi-Fi, Firebase API key, database URL, and the dedicated device account credentials.
4) Confirm FLOW_PIN and PULSES_PER_LITRE for your sensor and wiring, then upload.
5) Open Serial Monitor at 115200 baud. Check Wi-Fi and Firebase authentication/write logs.

HOW LIVE STATUS WORKS
- ESP32 writes current status /devices/FG-NODE-001/status every ~5 seconds.
- The website subscribes to that status in real time.
- If lastSeen is older than 15 seconds, the dashboard marks the ESP32 OFFLINE.
- ESP32 appends a historical sample every ~15 seconds to /devices/FG-NODE-001/history.
- The website loads the latest 1,000 saved samples, lets the user filter by date, and exports the currently filtered records to CSV.

DATA SHAPE
status: { nodeId, flowRate, totalLitres, lastSeen, updatedAt, online, wifiRssi }
history child: { nodeId, flowRate, totalLitres, timestamp }
All timestamps are Unix epoch milliseconds.

IMPORTANT HARDWARE NOTES
- Many YF-S201 sensors are often estimated around 450 pulses/litre, but actual calibration varies. Calibrate against a known volume before relying on totals.
- ESP32 GPIO pins are 3.3V logic and are not 5V tolerant. Verify sensor output type and use a safe level/interface circuit. Do not blindly connect a 5V signal to the ESP32.
- Cumulative pulse total is restored from ESP32 Preferences (NVS) at boot and checkpointed about once per minute. A sudden power loss can lose up to roughly one minute of the cumulative count. History already stored in Firebase remains saved. For a production build, add offline buffering/retries and validate persistence behaviour.
- History sample interval is 15 seconds: 1 hour creates about 240 records; 24 hours about 5,760 records. Adjust interval/retention for the expected usage and Firebase plan.
- Keep the device account password private. The browser uses anonymous auth for read access; database rules restrict writes to the dedicated device account email. Review rules and authentication before exposing a live deployment.

TROUBLESHOOTING
- Setup required: check firebase-config.js placeholders are replaced and served over http/https.
- Permission denied: enable Anonymous Auth; publish the supplied rules with the correct ESP32 account email; verify ESP32 Email/Password auth is enabled.
- Website stays offline: inspect Serial Monitor, Wi-Fi, database URL, API key, auth credentials, and whether the ESP32 has valid NTP time.
- No flow while water is running: verify sensor power/signal/pin, interrupt edge, common ground, and calibration.
