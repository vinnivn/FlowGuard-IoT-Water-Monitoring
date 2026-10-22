/*
  FlowGuard live ESP32 firmware (Firebase Realtime Database)
  Libraries: Firebase ESP Client by Mobizt (Firebase_ESP_Client), installed from Arduino Library Manager.
  Board: ESP32 Dev Module. Flow sensor signal example GPIO 27.

  IMPORTANT:
  - Set Wi-Fi, Firebase API key/database URL, and a dedicated Firebase Email/Password user.
  - Enable Email/Password sign-in in Firebase Authentication.
  - In firebase-database.rules.json, replace esp32-node@yourdomain.com with that user's email.
  - Check your sensor's pulse-per-litre calibration. 450 is only a starting estimate for some YF-S201 units.
  - ESP32 GPIO is NOT 5V tolerant. Ensure the sensor output signal is safe for 3.3V GPIO.
*/
#include <WiFi.h>
#include <Wire.h>
#include <time.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include "addons/TokenHelper.h"


#define WIFI_SSID       "wifi ssid"
#define WIFI_PASSWORD   "wifi password"

#define API_KEY         "API KEY"
#define DATABASE_URL    "https://flowguard-7f648-default-rtdb.asia-southeast1.firebasedatabase.app/"

#define DEVICE_EMAIL    "email"
#define DEVICE_PASSWORD "firebase password"

#define FLOW_PIN 27
#define OLED_SDA 21
#define OLED_SCL 22
#define OLED_ADDRESS 0x3C
#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

#define PULSES_PER_LITRE 450.0f
#define NODE_ID "FG-NODE-001"

#define DEVICE_PATH "/devices/" NODE_ID

Adafruit_SSD1306 display(
  SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1
);

FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
Preferences preferences;

volatile uint32_t pulseCount = 0;

uint64_t totalPulses = 0;
uint32_t lastMeasureMs = 0;
uint32_t lastHeartbeatMs = 0;
uint32_t lastHistoryMs = 0;
uint32_t lastPersistMs = 0;
uint32_t lastSessionReadMs = 0;
uint32_t lastDisplayMs = 0;

float flowRateLpm = 0.0f;
float totalLitres = 0.0f;
float sessionStartTotalLitres = 0.0f;

bool sessionLoaded = false;
bool oledReady = false;

void IRAM_ATTR pulseISR() {
  pulseCount++;
}

uint64_t epochMillis() {
  time_t now = time(nullptr);

  if (now < 1700000000) return 0;

  return (uint64_t)now * 1000ULL
       + (millis() % 1000);
}

// ---------------- OLED ----------------

void drawOLED() {
  if (!oledReady) return;

  float sessionLitres =
    totalLitres - sessionStartTotalLitres;

  if (sessionLitres < 0) sessionLitres = 0;

  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);

  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println(F("FLOWGUARD"));
  display.drawLine(0, 11, 127, 11, SSD1306_WHITE);

  display.setCursor(0, 15);
  display.print(F("Flow: "));
  display.print(flowRateLpm, 2);
  display.println(F(" L/min"));

  display.setCursor(0, 29);
  display.print(F("Session: "));
  display.print(sessionLitres, 2);
  display.println(F(" L"));

  display.setCursor(0, 43);
  display.print(F("Lifetime: "));
  display.print(totalLitres, 2);
  display.println(F(" L"));

  display.setCursor(0, 56);
  display.print(
    sessionLoaded ? F("Session synced")
                  : F("Waiting for session")
  );

  display.display();
}

// ---------------- Firebase status ----------------

void publishStatus(uint64_t ts) {
  FirebaseJson json;

  json.set("nodeId", NODE_ID);
  json.set("flowRate", flowRateLpm);
  json.set("totalLitres", totalLitres);
  json.set("lastSeen", (double)ts);
  json.set("updatedAt", (double)ts);
  json.set("online", true);
  json.set("wifiRssi", WiFi.RSSI());

  String path = String(DEVICE_PATH) + "/status";

  if (!Firebase.RTDB.setJSON(&fbdo, path, &json)) {
    Serial.printf(
      "Status write failed: %s\n",
      fbdo.errorReason().c_str()
    );
  }
}

void publishHistory(uint64_t ts) {
  FirebaseJson json;

  json.set("nodeId", NODE_ID);
  json.set("flowRate", flowRateLpm);
  json.set("totalLitres", totalLitres);
  json.set("timestamp", (double)ts);

  String path = String(DEVICE_PATH) + "/history";

  if (!Firebase.RTDB.pushJSON(&fbdo, path, &json)) {
    Serial.printf(
      "History write failed: %s\n",
      fbdo.errorReason().c_str()
    );
  } else {
    Serial.println("History sample saved");
  }
}

// ---------------- Session synchronization ----------------

void readActiveSession() {
  String path =
    String(DEVICE_PATH) + "/activeSession";

  if (!Firebase.RTDB.getJSON(&fbdo, path)) {
    Serial.printf(
      "Session read failed: %s\n",
      fbdo.errorReason().c_str()
    );
    return;
  }

  FirebaseJson &json = fbdo.jsonObject();
  FirebaseJsonData result;

  json.get(result, "startTotalLitres");

  if (!result.success || result.type == "null") {
    Serial.println(
      "activeSession has no startTotalLitres field"
    );
    return;
  }

  float newStartTotal = result.to<float>();

  if (!sessionLoaded ||
      fabs(newStartTotal - sessionStartTotalLitres) > 0.0001f) {

    sessionStartTotalLitres = newStartTotal;
    sessionLoaded = true;

    Serial.printf(
      "Session synchronized. Starting total: %.3f L\n",
      sessionStartTotalLitres
    );

    drawOLED();
  }
}

// ---------------- Setup ----------------

void setup() {
  Serial.begin(115200);

  preferences.begin("flowguard", false);

  totalPulses = preferences.getULong64(
    "totalPulses", 0
  );

  totalLitres =
    totalPulses / PULSES_PER_LITRE;

  Wire.begin(OLED_SDA, OLED_SCL);

  oledReady = display.begin(
    SSD1306_SWITCHCAPVCC, OLED_ADDRESS
  );

  if (oledReady) {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.println(F("FlowGuard starting..."));
    display.display();
  } else {
    Serial.println(
      "OLED not detected. Check I2C wiring/address."
    );
  }

  pinMode(FLOW_PIN, INPUT_PULLUP);

  attachInterrupt(
    digitalPinToInterrupt(FLOW_PIN),
    pulseISR,
    FALLING
  );

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  Serial.print("Connecting to Wi-Fi");

  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }

  Serial.printf(
    "\nWi-Fi connected: %s\n",
    WiFi.localIP().toString().c_str()
  );

  configTime(
    0, 0, "pool.ntp.org", "time.google.com"
  );

  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;

  auth.user.email = DEVICE_EMAIL;
  auth.user.password = DEVICE_PASSWORD;

  config.token_status_callback = tokenStatusCallback;

  Firebase.reconnectWiFi(true);
  Firebase.begin(&config, &auth);

  lastMeasureMs = millis();

  drawOLED();

  Serial.println(
    "FlowGuard booted; waiting for Firebase."
  );
}

// ---------------- Main loop ----------------

void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    WiFi.reconnect();
    delay(100);
    return;
  }

  if (!Firebase.ready()) {
    drawOLED();
    delay(50);
    return;
  }

  uint32_t now = millis();

  // Measure flow every second.
  if (now - lastMeasureMs >= 1000) {
    noInterrupts();
    uint32_t pulses = pulseCount;
    pulseCount = 0;
    interrupts();

    uint32_t elapsed = now - lastMeasureMs;
    lastMeasureMs = now;

    totalPulses += pulses;

    float litresThisInterval =
      pulses / PULSES_PER_LITRE;

    totalLitres =
      totalPulses / PULSES_PER_LITRE;

    flowRateLpm =
      litresThisInterval * (60000.0f / elapsed);

    if (now - lastPersistMs >= 60000) {
      preferences.putULong64(
        "totalPulses", totalPulses
      );
      lastPersistMs = now;
    }

    Serial.printf(
      "Flow: %.3f L/min | Session: %.3f L | Lifetime: %.3f L\n",
      flowRateLpm,
      sessionLoaded
        ? max(0.0f, totalLitres - sessionStartTotalLitres)
        : 0.0f,
      totalLitres
    );
  }

  // Check Firebase for website session resets.
  if (now - lastSessionReadMs >= 3000) {
    lastSessionReadMs = now;
    readActiveSession();
  }

  uint64_t ts = epochMillis();

  if (ts && now - lastHeartbeatMs >= 5000) {
    lastHeartbeatMs = now;
    publishStatus(ts);
  }

  if (ts && now - lastHistoryMs >= 15000) {
    lastHistoryMs = now;
    publishHistory(ts);
  }

  // Refresh OLED regularly.
  if (now - lastDisplayMs >= 1000) {
    lastDisplayMs = now;
    drawOLED();
  }

  delay(10);
}
