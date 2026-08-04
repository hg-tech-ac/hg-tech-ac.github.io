(() => {
  "use strict";

  const CONFIG = window.HG_CONFIG || {};
  const AUTH = window.HG_AUTH;
  const devices = CONFIG.DEVICES || [];
  const state = new Map(devices.map(device => [device.deviceId, {
    online: false,
    lastSeen: 0,
    lastResult: ""
  }]));

  let session = null;
  let mqttClient = null;
  let mqttConfig = null;
  let brokerConnected = false;

  const brokerState = document.getElementById("brokerState");
  const toast = document.getElementById("toast");

  function showToast(message, type = "") {
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`.trim();
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => {
      toast.className = "toast";
    }, 2800);
  }

  function setBrokerState(message, connected = false) {
    brokerState.textContent = message;
    brokerState.classList.toggle("connected", connected);
  }

  function setDeviceUi(deviceId, online, message) {
    const badge = document.getElementById(`mqtt-${deviceId}`);
    const text = document.getElementById(`state-${deviceId}`);
    const button = document.querySelector(`[data-device="${deviceId}"]`);

    if (badge) {
      badge.textContent = online ? "온라인" : "미연결";
      badge.className = `device-badge ${online ? "online" : "offline"}`;
    }
    if (text) text.textContent = message || (online ? "명령 전송 가능" : "장치 연결 대기 중");
    if (button) button.classList.toggle("ready", online);
  }

  function parseTimestamp(value) {
    if (typeof value === "number") return value;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function handleStatus(deviceId, payload) {
    if (!state.has(deviceId)) return;
    const online = payload?.online === true;
    const lastSeen = parseTimestamp(payload?.ts || payload?.timestamp || Date.now());
    const current = state.get(deviceId);
    current.online = online;
    current.lastSeen = lastSeen;
    state.set(deviceId, current);
    setDeviceUi(deviceId, online, online ? "명령 전송 가능" : "장치가 오프라인입니다.");
  }

  function handleResult(deviceId, payload) {
    if (!state.has(deviceId)) return;
    const current = state.get(deviceId);
    current.lastResult = payload?.result || payload?.status || "RESULT";
    current.lastSeen = Date.now();
    state.set(deviceId, current);

    const text = document.getElementById(`state-${deviceId}`);
    if (text) {
      text.textContent = payload?.success === false
        ? `실행 실패: ${current.lastResult}`
        : `실행 완료: ${current.lastResult}`;
      text.className = `command-state ${payload?.success === false ? "error" : "success"}`;
    }
  }

  function processMqttMessage(topic, message) {
    const prefix = mqttConfig.topicPrefix;
    if (!topic.startsWith(`${prefix}/`)) return;

    const parts = topic.slice(prefix.length + 1).split("/");
    const deviceId = parts[0];
    const channel = parts[1];
    if (!deviceId || !channel) return;

    let payload = {};
    try { payload = JSON.parse(message.toString()); }
    catch (_) { payload = { value: message.toString() }; }

    if (channel === "status") handleStatus(deviceId, payload);
    if (channel === "result") handleResult(deviceId, payload);
  }

  function connectMqtt(config) {
    mqttConfig = config;

    if (!config?.configured || !config?.url) {
      setBrokerState("MQTT 설정 필요", false);
      devices.forEach(device => setDeviceUi(device.deviceId, false, "HiveMQ 설정이 필요합니다."));
      return;
    }

    if (!window.mqtt?.connect) {
      setBrokerState("MQTT 라이브러리 오류", false);
      return;
    }

    setBrokerState("HiveMQ 연결 중", false);

    mqttClient = window.mqtt.connect(config.url, {
      username: config.username,
      password: config.password,
      clientId: `hg-web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 3000,
      connectTimeout: 12000,
      keepalive: 30
    });

    mqttClient.on("connect", () => {
      brokerConnected = true;
      setBrokerState("HiveMQ 연결됨", true);
      mqttClient.subscribe(`${config.topicPrefix}/+/status`, { qos: 1 });
      mqttClient.subscribe(`${config.topicPrefix}/+/result`, { qos: 1 });
    });

    mqttClient.on("reconnect", () => {
      brokerConnected = false;
      setBrokerState("HiveMQ 재연결 중", false);
    });

    mqttClient.on("close", () => {
      brokerConnected = false;
      setBrokerState("HiveMQ 연결 끊김", false);
    });

    mqttClient.on("offline", () => {
      brokerConnected = false;
      setBrokerState("HiveMQ 오프라인", false);
    });

    mqttClient.on("error", error => {
      brokerConnected = false;
      setBrokerState("HiveMQ 연결 오류", false);
      showToast(error?.message || "MQTT 연결 오류", "error");
    });

    mqttClient.on("message", processMqttMessage);
  }

  function isDeviceOnline(deviceId) {
    const item = state.get(deviceId);
    if (!brokerConnected || !item?.online) return false;
    const offlineAfterMs = Number(mqttConfig?.offlineAfterMs || 45000);
    return Date.now() - item.lastSeen <= offlineAfterMs;
  }

  function goToNoDevice(deviceId, deviceName, reason) {
    const params = new URLSearchParams({
      device: deviceId,
      name: deviceName,
      reason: reason || "장치가 HiveMQ에 연결되어 있지 않습니다."
    });
    location.href = `../../failed-no_device/?${params.toString()}`;
  }

  async function publishPower(button) {
    const deviceId = button.dataset.device;
    const deviceName = button.dataset.name;

    if (!mqttConfig?.configured) {
      goToNoDevice(deviceId, deviceName, "HiveMQ 접속정보가 아직 설정되지 않았습니다.");
      return;
    }

    if (!isDeviceOnline(deviceId)) {
      goToNoDevice(deviceId, deviceName, "장치가 오프라인이거나 최근 상태신호가 없습니다.");
      return;
    }

    const accepted = window.confirm(`${deviceName}의 물리 전원 버튼을 한 번 누릅니다.\n계속할까요?`);
    if (!accepted) return;

    const commandId = crypto.randomUUID ? crypto.randomUUID() : `CMD-${Date.now()}-${Math.random()}`;
    const topic = `${mqttConfig.topicPrefix}/${deviceId}/command`;
    const payload = JSON.stringify({
      commandId,
      command: "PRESS_POWER",
      deviceId,
      requestedBy: session.userId,
      ts: Date.now()
    });

    button.disabled = true;
    const text = document.getElementById(`state-${deviceId}`);
    if (text) {
      text.textContent = "MQTT 명령 전송 중…";
      text.className = "command-state";
    }

    mqttClient.publish(topic, payload, { qos: 1, retain: false }, async error => {
      button.disabled = false;

      if (error) {
        if (text) {
          text.textContent = "명령 전송 실패";
          text.className = "command-state error";
        }
        showToast("MQTT 명령 전송에 실패했습니다.", "error");
        return;
      }

      if (text) {
        text.textContent = "장치 실행 응답 대기 중";
        text.className = "command-state success";
      }
      showToast(`${deviceName} 전원 명령을 전송했습니다.`, "success");

      try {
        await AUTH.jsonp({
          action: "logMqttCommand",
          token: session.token,
          commandId,
          deviceId,
          command: "PRESS_POWER"
        });
      } catch (_) {
        // MQTT 전송 성공을 우선하며, 로그 기록 실패는 제어 실패로 취급하지 않습니다.
      }
    });
  }

  function monitorOfflineDevices() {
    window.setInterval(() => {
      if (!mqttConfig?.configured) return;
      devices.forEach(device => {
        const item = state.get(device.deviceId);
        if (!item?.online) return;
        const offlineAfterMs = Number(mqttConfig.offlineAfterMs || 45000);
        if (Date.now() - item.lastSeen > offlineAfterMs) {
          item.online = false;
          state.set(device.deviceId, item);
          setDeviceUi(device.deviceId, false, "상태신호 시간이 초과되었습니다.");
        }
      });
    }, 5000);
  }

  async function initialize() {
    session = await AUTH.validateSession();
    if (!session) {
      location.replace("../login/");
      return;
    }

    document.getElementById("adminName").textContent = session.displayName || session.userId;

    document.getElementById("logoutButton").addEventListener("click", async () => {
      await AUTH.logout();
      location.replace("../login/");
    });

    document.querySelectorAll(".power-button").forEach(button => {
      button.addEventListener("click", () => publishPower(button));
    });

    try {
      const result = await AUTH.jsonp({ action: "mqttConfig", token: session.token });
      if (!result?.ok) throw new Error(result?.message || "MQTT 설정을 불러오지 못했습니다.");
      connectMqtt(result);
    } catch (error) {
      setBrokerState("MQTT 설정 오류", false);
      showToast(error.message, "error");
    }

    monitorOfflineDevices();
  }

  document.addEventListener("DOMContentLoaded", initialize);
})();
