/*
  SMART LOCKER - Firmware mẫu cho ESP32 (1 ngăn tủ / 1 board)
  ------------------------------------------------------------
  Đây là code KHUNG (chưa test trên phần cứng thật) minh hoạ cách một ESP32
  gắn tại từng ngăn tủ sẽ gọi vào các API trong thư mục backend/routes/device.js.

  Cách bố trí phần cứng tham khảo, kế thừa từ các repo bạn đã tải lên trước đó:
    - Relay/solenoid mở khoá + LCD I2C 16x2  -> phong cách SmartLocker-main,
      ESP32-based-door-lock-System (LCD "MO TU A03 / HAY DAT HANG" lấy nguyên
      văn theo tài liệu nghiệp vụ của bạn)
    - Bàn phím 4x4 (Keypad.h)                -> phong cách SmartLocker-main
    - Nhiều ngăn / vòng lặp trạng thái        -> phong cách multi-smart-locker-main
  Phần MỚI so với các repo cũ (bắt buộc phải tự viết, không có sẵn):
    - Load cell (HX711) để đo khối lượng tăng/giảm
    - Cảm biến vật thể hồng ngoại (IR) độc lập với load cell
    - Gọi REST API thật của backend (guihang, dong-cua-gui, keypad OTP, camera...)
    - Cơ chế poll lệnh (mở khẩn cấp / khoá lại) từ admin

  Thư viện cần cài qua Library Manager:
    - HX711 (bogde/HX711)
    - Keypad (Chris--A/Keypad)
    - LiquidCrystal_I2C
    - ArduinoJson
    (WiFi.h, HTTPClient.h có sẵn trong ESP32 core)
*/

#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Keypad.h>
#include <LiquidCrystal_I2C.h>
#include "HX711.h"

// ================= CẤU HÌNH - SỬA THEO THỰC TẾ CỦA BẠN =================
const char* WIFI_SSID     = "TEN_WIFI";
const char* WIFI_PASSWORD = "MAT_KHAU_WIFI";
const char* SERVER_HOST   = "http://192.168.1.100:3000"; // IP/domain của backend
const char* DEVICE_KEY    = "doi-khoa-thiet-bi-nay";      // trùng với DEVICE_API_KEY trong .env
const char* LOCKER_ID     = "A01";                        // mỗi board phụ trách 1 ngăn

// Chân kết nối (ví dụ, đổi theo board thực tế của bạn - đã kiểm tra không trùng nhau)
#define RELAY_PIN       19   // relay điều khiển khoá điện / solenoid
#define DOOR_SENSOR_PIN 5    // công tắc từ cửa: LOW = đóng, HIGH = mở
#define IR_SENSOR_PIN   18   // cảm biến vật thể hồng ngoại: LOW = có vật
#define HX711_DOUT_PIN  16
#define HX711_SCK_PIN   17

LiquidCrystal_I2C lcd(0x27, 16, 2);
HX711 scale;

const byte KEYPAD_ROWS = 4, KEYPAD_COLS = 4;
char keys[KEYPAD_ROWS][KEYPAD_COLS] = {
  {'1','2','3','A'},
  {'4','5','6','B'},
  {'7','8','9','C'},
  {'*','0','#','D'}
};
byte rowPins[KEYPAD_ROWS] = {13, 12, 14, 27}; // đổi theo board thực tế nếu cần
byte colPins[KEYPAD_COLS] = {26, 25, 33, 32};
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, KEYPAD_ROWS, KEYPAD_COLS);

float baselineWeight = 0;
String inputBuffer = "";
enum Mode { IDLE, ENTER_SEND_PHONE, ENTER_PICKUP_OTP };
Mode mode = IDLE;

// ================= HÀM TIỆN ÍCH GỌI API =================
String httpPostJson(const String& path, const String& jsonBody) {
  HTTPClient http;
  http.begin(String(SERVER_HOST) + path);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.POST(jsonBody);
  String response = http.getString();
  http.end();
  Serial.printf("POST %s -> %d: %s\n", path.c_str(), code, response.c_str());
  return response;
}

String httpGetJson(const String& path) {
  HTTPClient http;
  http.begin(String(SERVER_HOST) + path);
  http.addHeader("X-Device-Key", DEVICE_KEY);
  int code = http.GET();
  String response = http.getString();
  http.end();
  return response;
}

void lcdShow(const String& line1, const String& line2) {
  lcd.clear();
  lcd.setCursor(0, 0); lcd.print(line1);
  lcd.setCursor(0, 1); lcd.print(line2);
}

// ================= ĐIỀU KHIỂN KHOÁ =================
void openLock() {
  digitalWrite(RELAY_PIN, HIGH); // tuỳ loại relay, có thể cần đảo mức
}
void closeLock() {
  digitalWrite(RELAY_PIN, LOW);
}

// ================= LUỒNG 1: GỬI HÀNG QUA BÀN PHÍM (FALLBACK) =================
// Quy ước: A = gửi hàng, B = nhận hàng, * = xoá hết, # = xác nhận, D = xoá 1 ký tự
void handleKeypadSendFlow(char key) {
  if (key == '*') { inputBuffer = ""; lcdShow("SDT NGUOI NHAN:", ""); return; }
  if (key == 'D') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); lcdShow("SDT NGUOI NHAN:", inputBuffer); return; }
  if (key == '#') {
    String body = String("{\"recipientPhone\":\"") + inputBuffer + "\"}";
    String res = httpPostJson("/api/device/keypad/gui-hang", body);

    StaticJsonDocument<512> doc;
    deserializeJson(doc, res);
    if (doc["success"] == true) {
      String lockerId = doc["lockerId"].as<String>();
      lcdShow(String("MO TU ") + lockerId, "HAY DAT HANG");
      if (lockerId == LOCKER_ID) { openLock(); waitForCloseAndConfirmSend(); }
    } else {
      String msg = doc["message"].as<String>();
      lcdShow("LOI:", msg.substring(0, 16));
      delay(3000);
    }
    inputBuffer = ""; mode = IDLE; lcdShow("A:Gui  B:Nhan", "hang");
    return;
  }
  if (isDigit(key)) { inputBuffer += key; lcdShow("SDT NGUOI NHAN:", inputBuffer); }
}

// ================= LUỒNG 2: XÁC NHẬN CẢM BIẾN SAU KHI ĐÓNG CỬA (GỬI HÀNG) =================
void waitForCloseAndConfirmSend() {
  baselineWeight = scale.get_units(5);
  lcdShow("DANG CHO", "DONG CUA...");

  unsigned long openedAt = millis();
  while (digitalRead(DOOR_SENSOR_PIN) == HIGH) { // HIGH = đang mở
    if (millis() - openedAt > 60000) break; // timeout an toàn phía thiết bị, server cũng tự kiểm tra song song
    delay(200);
  }

  delay(500); // chờ cảm biến ổn định
  float newWeight = scale.get_units(5);
  bool weightIncreased = (newWeight - baselineWeight) > 0.05; // ngưỡng 50g, tự hiệu chỉnh theo tải thực tế
  bool objectDetected = digitalRead(IR_SENSOR_PIN) == LOW;
  bool doorClosed = digitalRead(DOOR_SENSOR_PIN) == LOW;

  closeLock();

  String body = String("{\"doorClosed\":") + (doorClosed ? "true" : "false") +
                ",\"weightIncreased\":" + (weightIncreased ? "true" : "false") +
                ",\"objectDetected\":" + (objectDetected ? "true" : "false") + "}";
  String res = httpPostJson(String("/api/device/") + LOCKER_ID + "/dong-cua-gui", body);

  StaticJsonDocument<256> doc;
  deserializeJson(doc, res);
  bool hasPackage = doc["hasPackage"] | false;
  lcdShow(hasPackage ? "GIAO HANG" : "DA HUY DON", hasPackage ? "THANH CONG" : "KHONG CO HANG");
  delay(2500);
}

// ================= LUỒNG 3: NGƯỜI NHẬN NHẬP OTP =================
void handleKeypadOtpFlow(char key) {
  if (key == '*') { inputBuffer = ""; lcdShow("NHAP MA OTP:", ""); return; }
  if (key == 'D') { if (inputBuffer.length() > 0) inputBuffer.remove(inputBuffer.length() - 1); lcdShow("NHAP MA OTP:", inputBuffer); return; }
  if (key == '#') {
    String body = String("{\"otp\":\"") + inputBuffer + "\"}";
    String res = httpPostJson("/api/device/keypad/mo-tu-nhan-hang", body);

    StaticJsonDocument<256> doc;
    deserializeJson(doc, res);
    if (doc["success"] == true && doc["lockerId"].as<String>() == LOCKER_ID) {
      lcdShow("DA MO TU", "MOI LAY HANG");
      openLock();
      waitForCloseAndConfirmPickup();
    } else {
      lcdShow("MA OTP SAI", "HOAC HET HAN");
      delay(2500);
    }
    inputBuffer = ""; mode = IDLE; lcdShow("A:Gui  B:Nhan", "hang");
    return;
  }
  if (isDigit(key)) { inputBuffer += key; lcdShow("NHAP MA OTP:", inputBuffer); }
}

void waitForCloseAndConfirmPickup() {
  unsigned long openedAt = millis();
  while (digitalRead(DOOR_SENSOR_PIN) == HIGH) {
    if (millis() - openedAt > 60000) break;
    delay(200);
  }
  delay(500);

  bool doorClosed = digitalRead(DOOR_SENSOR_PIN) == LOW;
  bool objectCleared = digitalRead(IR_SENSOR_PIN) == HIGH;
  bool weightBackToZero = abs(scale.get_units(5) - baselineWeight) < 0.05;

  closeLock();

  String body = String("{\"doorClosed\":") + (doorClosed ? "true" : "false") +
                ",\"weightBackToZero\":" + (weightBackToZero ? "true" : "false") +
                ",\"objectCleared\":" + (objectCleared ? "true" : "false") + "}";
  httpPostJson(String("/api/device/") + LOCKER_ID + "/dong-cua-nhan", body);

  lcdShow("CAM ON BAN", "HEN GAP LAI");
  delay(2000);
}

// ================= POLL LỆNH TỪ ADMIN (mở khẩn cấp / khoá lại) =================
void pollAdminCommand() {
  String res = httpGetJson(String("/api/device/") + LOCKER_ID + "/lenh");
  StaticJsonDocument<256> doc;
  deserializeJson(doc, res);
  if (!doc["pendingCommand"].isNull()) {
    String type = doc["pendingCommand"]["type"].as<String>();
    if (type == "mo_khan_cap") { openLock(); lcdShow("ADMIN MO", "KHAN CAP"); }
    else if (type == "khoa_lai") { closeLock(); lcdShow("DA KHOA LAI", "THEO LENH ADMIN"); }
    delay(1500);
    httpPostJson(String("/api/device/") + LOCKER_ID + "/lenh/hoan-thanh", "{}");
  }
}

// ================= SETUP / LOOP =================
void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(DOOR_SENSOR_PIN, INPUT_PULLUP);
  pinMode(IR_SENSOR_PIN, INPUT_PULLUP);
  closeLock();

  lcd.init(); lcd.backlight();
  lcdShow("KET NOI WIFI...", "");

  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); }

  scale.begin(HX711_DOUT_PIN, HX711_SCK_PIN);
  scale.tare();

  lcdShow("A:Gui  B:Nhan", "hang");
}

unsigned long lastPoll = 0;
void loop() {
  char key = keypad.getKey();
  if (key) {
    if (mode == IDLE) {
      if (key == 'A') { mode = ENTER_SEND_PHONE; inputBuffer = ""; lcdShow("SDT NGUOI NHAN:", ""); }
      else if (key == 'B') { mode = ENTER_PICKUP_OTP; inputBuffer = ""; lcdShow("NHAP MA OTP:", ""); }
    } else if (mode == ENTER_SEND_PHONE) {
      handleKeypadSendFlow(key);
    } else if (mode == ENTER_PICKUP_OTP) {
      handleKeypadOtpFlow(key);
    }
  }

  // Poll lệnh admin mỗi 5 giây khi đang rảnh (không làm gián đoạn luồng nhập bàn phím)
  if (mode == IDLE && millis() - lastPoll > 5000) {
    pollAdminCommand();
    lastPoll = millis();
  }
}
