# HG TECH AC

기술실 에어컨 3대를 관리자 로그인과 HiveMQ MQTT로 제어하는 프로젝트입니다.

## 장치

- `TECH_1`: 기술실 1번
- `TECH_2`: 기술실 2번
- `TECH_3D`: 3D 작업실

## 화면 경로

- `/` : 로그인 상태에 따라 자동 이동
- `/admin/login/` : 관리자 로그인
- `/admin/dashboard/` : 모바일 최적화 전원 제어
- `/failed-no_device/` : 장치 미연결 오류

## Apps Script

저장소의 `apps-script/Code.gs` 전체를 Apps Script에 붙여 넣습니다.

1. `setup()`을 한 번 실행합니다.
2. 실행 로그에서 임시 관리자 비밀번호를 확인합니다.
3. 새 버전으로 웹 앱을 다시 배포합니다.
4. 필요하면 `resetAdminPassword()`의 값을 수정하고 실행합니다.

연결된 Spreadsheet ID:

```text
17riM84qTJd1_XhLDrjO_a3j2tKUvtCSKKdXQHnn0f5U
```

## HiveMQ Script Properties

Apps Script의 **Project Settings → Script properties**에 다음 값을 저장합니다.

```text
MQTT_URL           wss://클러스터주소:8884/mqtt
MQTT_USERNAME      웹 대시보드용 사용자명
MQTT_PASSWORD      웹 대시보드용 비밀번호
MQTT_TOPIC_PREFIX  hg-tech-ac
```

MQTT 비밀번호는 공개 GitHub 파일에 저장하지 않습니다.

## MQTT 토픽

```text
hg-tech-ac/TECH_1/status
hg-tech-ac/TECH_1/command
hg-tech-ac/TECH_1/result

hg-tech-ac/TECH_2/status
hg-tech-ac/TECH_2/command
hg-tech-ac/TECH_2/result

hg-tech-ac/TECH_3D/status
hg-tech-ac/TECH_3D/command
hg-tech-ac/TECH_3D/result
```

장치는 `status` 토픽에 retained 온라인 상태를 게시하고, `command`에서 `PRESS_POWER`를 수신한 뒤 `result`에 실행 결과를 게시해야 합니다.
