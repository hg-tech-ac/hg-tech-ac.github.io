(() => {
  "use strict";

  const CONFIG = window.HG_CONFIG || {};
  const AUTH = window.HG_AUTH;
  const devices = CONFIG.DEVICES || [];
  const states = new Map(devices.map(d => [d.deviceId, { online: false, lastSeen: 0 }]));

  let session = null;
  let client = null;
  let mqttConfig = null;
  let brokerOnline = false;

  const brokerState = document.getElementById("brokerState");
  const toast = document.getElementById("toast");

  function showToast(message, type = "") {
    toast.textContent = message;
    toast.className = `toast show ${type}`.trim();
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { toast.className = "toast"; }, 2800);
  }

  function setBroker(message, connected = false) {
    brokerState.textContent = message;
    brokerState.classList.toggle("connected", connected);
  }

  function setDevice(deviceId, online, message) {
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

  function timestamp(value) {
    if (typeof value === "number") return value;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function statusMessage(deviceId, payload) {
    if (!states.has(deviceId)) return;
    const item = states.get(deviceId);
    item.online = payload?.online === true;
    item.lastSeen = timestamp(payload?.ts || payload?.timestamp || Date.now());
    states.set(deviceId, item);
    setDevice(deviceId, item.online, item.online ? "명령 전송 가능" : "장치가 오프라인입니다.");
  }

  function resultMessage(deviceId, payload) {
    if (!states.has(deviceId)) return;
    const result = payload?.result || payload?.status || "RESULT";
    const success = payload?.success !== false;
    const item = states.get(deviceId);
    item.lastSeen = Date.now();
    states.set(deviceId, item);

    const text = document.getElementById(`state-${deviceId}`);
    if (text) {
      text.textContent = success ? `실행 완료: ${result}` : `실행 실패: ${result}`;
      text.className = `command-state ${success ? "success" : "error"}`;
    }

    if (payload?.commandId && session?.token) {
      AUTH.jsonp({
        action: "logMqttResult",
        token: session.token,
        commandId: payload.commandId,
        deviceId,
        success: String(success),
        result
      }).catch(() => {});
    }
  }

  function onMessage(topic, data) {
    const prefix = mqttConfig.topicPrefix;
    if (!topic.startsWith(`${prefix}/`)) return;
    const [deviceId, channel] = topic.slice(prefix.length + 1).split("/");
    if (!deviceId || !channel) return;

    let payload;
    try { payload = JSON.parse(data.toString()); }
    catch (_) { payload = { value: data.toString() }; }

    if (channel === "status") statusMessage(deviceId, payload);
    if (channel === "result") resultMessage(deviceId, payload);
  }

  function connectMqtt(config) {
    mqttConfig = config;
    if (!config?.configured || !config?.url) {
      setBroker("MQTT 설정 필요");
      devices.forEach(d => setDevice(d.deviceId, false, "HiveMQ 설정이 필요합니다."));
      return;
    }
    if (!window.mqtt?.connect) {
      setBroker("MQTT 라이브러리 오류");
      return;
    }

    setBroker("HiveMQ 연결 중");
    client = window.mqtt.connect(config.url, {
      username: config.username,
      password: config.password,
      clientId: `hg-web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      clean: true,
      protocolVersion: 4,
      reconnectPeriod: 3000,
      connectTimeout: 12000,
      keepalive: 30
    });

    client.on("connect", () => {
      brokerOnline = true;
      setBroker("HiveMQ 연결됨", true);
      client.subscribe(`${config.topicPrefix}/+/status`, { qos: 1 });
      client.subscribe(`${config.topicPrefix}/+/result`, { qos: 1 });
    });
    client.on("reconnect", () => { brokerOnline = false; setBroker("HiveMQ 재연결 중"); });
    client.on("close", () => { brokerOnline = false; setBroker("HiveMQ 연결 끊김"); });
    client.on("offline", () => { brokerOnline = false; setBroker("HiveMQ 오프라인"); });
    client.on("error", error => {
      brokerOnline = false;
      setBroker("HiveMQ 연결 오류");
      showToast(error?.message || "MQTT 연결 오류", "error");
    });
    client.on("message", onMessage);
  }

  function isOnline(deviceId) {
    const item = states.get(deviceId);
    const limit = Number(mqttConfig?.offlineAfterMs || 45000);
    return Boolean(brokerOnline && item?.online && Date.now() - item.lastSeen <= limit);
  }

  function noDevice(deviceId, name, reason) {
    const query = new URLSearchParams({ device: deviceId, name, reason });
    location.href = `../../failed-no_device/?${query}`;
  }

  function publishPower(button) {
    const deviceId = button.dataset.device;
    const deviceName = button.dataset.name;

    if (!mqttConfig?.configured) {
      noDevice(deviceId, deviceName, "HiveMQ 접속정보가 아직 설정되지 않았습니다.");
      return;
    }
    if (!isOnline(deviceId)) {
      noDevice(deviceId, deviceName, "장치가 오프라인이거나 최근 상태신호가 없습니다.");
      return;
    }
    if (!confirm(`${deviceName}의 물리 전원 버튼을 한 번 누릅니다.\n계속할까요?`)) return;

    const commandId = crypto.randomUUID ? crypto.randomUUID() : `CMD-${Date.now()}-${Math.random()}`;
    const payload = JSON.stringify({
      commandId,
      command: "PRESS_POWER",
      deviceId,
      requestedBy: session.userId,
      ts: Date.now()
    });
    const text = document.getElementById(`state-${deviceId}`);
    button.disabled = true;
    if (text) { text.textContent = "MQTT 명령 전송 중…"; text.className = "command-state"; }

    client.publish(`${mqttConfig.topicPrefix}/${deviceId}/command`, payload, { qos: 1 }, error => {
      button.disabled = false;
      if (error) {
        if (text) { text.textContent = "명령 전송 실패"; text.className = "command-state error"; }
        showToast("MQTT 명령 전송에 실패했습니다.", "error");
        return;
      }

      if (text) { text.textContent = "장치 실행 응답 대기 중"; text.className = "command-state success"; }
      showToast(`${deviceName} 전원 명령을 전송했습니다.`, "success");
      AUTH.jsonp({
        action: "logMqttCommand",
        token: session.token,
        commandId,
        deviceId,
        command: "PRESS_POWER"
      }).catch(() => {});
    });
  }

  function monitorOffline() {
    setInterval(() => {
      if (!mqttConfig?.configured) return;
      const limit = Number(mqttConfig.offlineAfterMs || 45000);
      devices.forEach(d => {
        const item = states.get(d.deviceId);
        if (item?.online && Date.now() - item.lastSeen > limit) {
          item.online = false;
          setDevice(d.deviceId, false, "상태신호 시간이 초과되었습니다.");
        }
      });
    }, 5000);
  }

  async function init() {
    session = await AUTH.validateSession();
    if (!session) { location.replace("../login/"); return; }
    document.getElementById("adminName").textContent = session.displayName || session.userId;
    document.getElementById("logoutButton").addEventListener("click", async () => {
      if (client) client.end(true);
      await AUTH.logout();
      location.replace("../login/");
    });
    document.querySelectorAll(".power-button").forEach(button => {
      button.addEventListener("click", () => publishPower(button));
    });

    try {
      const config = await AUTH.jsonp({ action: "mqttConfig", token: session.token });
      if (!config?.ok) throw new Error(config?.message || "MQTT 설정을 불러오지 못했습니다.");
      connectMqtt(config);
    } catch (error) {
      setBroker("MQTT 설정 오류");
      showToast(error.message, "error");
    }
    monitorOffline();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
