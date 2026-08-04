# HG TECH AC ESP32 제어 구조

## 물리 장치 구성

### TECH_ROOM 컨트롤러

기술실에 설치하는 ESP32 한 대입니다.

- `TECH_1` → 서보모터 채널 1 → 기술실 1번 에어컨
- `TECH_2` → 서보모터 채널 2 → 기술실 2번 에어컨
- 온습도 센서 1개를 기술실 대표 센서로 사용
- 두 논리 장치의 command 토픽을 모두 구독

구독 토픽:

```text
hg-tech-ac/TECH_1/command
hg-tech-ac/TECH_2/command
```

발행 토픽:

```text
hg-tech-ac/TECH_1/status
hg-tech-ac/TECH_1/telemetry
hg-tech-ac/TECH_1/result
hg-tech-ac/TECH_1/routine
hg-tech-ac/TECH_1/alert

hg-tech-ac/TECH_2/status
hg-tech-ac/TECH_2/telemetry
hg-tech-ac/TECH_2/result
hg-tech-ac/TECH_2/routine
hg-tech-ac/TECH_2/alert
```

### TECH_3D_ROOM 컨트롤러

3D 작업실에 설치하는 ESP32 한 대입니다.

- `TECH_3D` → 서보모터 채널 1 → 3D 작업실 에어컨
- 온습도 센서 1개

구독 토픽:

```text
hg-tech-ac/TECH_3D/command
```

발행 토픽:

```text
hg-tech-ac/TECH_3D/status
hg-tech-ac/TECH_3D/telemetry
hg-tech-ac/TECH_3D/result
hg-tech-ac/TECH_3D/routine
hg-tech-ac/TECH_3D/alert
```

## 명령 형식

### 전원 버튼

```json
{
  "commandId": "uuid",
  "command": "PRESS_POWER",
  "deviceId": "TECH_1",
  "requestedBy": "admin",
  "ts": 0
}
```

### 루틴 저장

```json
{
  "commandId": "uuid",
  "command": "SET_ROUTINE",
  "deviceId": "TECH_1",
  "routine": {
    "enabled": true,
    "days": ["MON", "TUE", "WED", "THU", "FRI"],
    "onTime": "07:30",
    "offTime": "16:00",
    "timezone": "Asia/Seoul"
  }
}
```

ESP32는 루틴을 NVS에 저장하고 재부팅 후에도 유지해야 합니다. 웹페이지가 닫혀 있어도 ESP32가 자체적으로 시간을 판단해 실행해야 합니다.

## 온도 이상 감시

1. 전원 버튼을 누르기 직전 기준 온도와 시간을 저장합니다.
2. 10분 뒤 현재 온도와 기준 온도를 비교합니다.
3. 온도가 충분히 내려가지 않았거나 더 높아졌으면 `COOLING_NOT_EFFECTIVE` 경고를 발행합니다.
4. ESP32는 안전 간격을 확인한 뒤 전원 재시도 동작을 수행하고 다시 10분 감시를 시작합니다.
5. 반복 횟수와 측정값을 alert payload에 포함합니다.

예시:

```json
{
  "type": "COOLING_NOT_EFFECTIVE",
  "deviceId": "TECH_1",
  "beforeTemperature": 29.4,
  "currentTemperature": 29.6,
  "humidity": 71,
  "retryCount": 1,
  "ts": 0
}
```

## 안전 조건

- 전원 버튼을 연속으로 누르지 않도록 최소 재시도 간격을 둡니다.
- 서보모터는 버튼을 누른 뒤 반드시 중립 위치로 복귀합니다.
- 센서 오류값과 통신 끊김을 냉방 실패로 오판하지 않도록 유효 범위를 검사합니다.
- 기본 재시도 상한은 3회로 권장합니다. 이후에는 자동 누름을 중단하고 관리자 경고만 반복합니다.
- 물리 전원 버튼만 누르는 방식은 실제 에어컨 상태를 알 수 없어 다시 누를 때 반대로 꺼질 수 있습니다. 최종 구성에서는 전류 센서, 표시 LED 감지 또는 IR 상태 확인 중 하나를 추가하는 것이 좋습니다.
