(() => {
  "use strict";

  const CFG = window.HG_CONFIG || {};
  const AUTH = window.HG_AUTH;
  const DEVICES = CFG.DEVICES || [];
  const state = new Map(DEVICES.map(d => [d.deviceId, {
    online: false, lastSeen: 0, temperature: null, humidity: null, routine: null
  }]));
  const SELECTED_KEY = "hgTechAcSelectedDevice";
  const ROUTINE_KEY = id => `hgTechAcRoutine:${id}`;
  const $ = id => document.getElementById(id);

  let session = null;
  let client = null;
  let mqttCfg = null;
  let brokerOnline = false;
  let selectedId = localStorage.getItem(SELECTED_KEY) || "";
  let mqttFailTimer = null;
  let modalPrimary = null;
  let modalSecondary = null;

  const el = {
    broker: $("brokerState"), toast: $("toast"), picker: $("devicePicker"),
    pickerBtn: $("devicePickerButton"), pickerValue: $("devicePickerValue"),
    menu: $("deviceMenu"), menuList: $("deviceMenuList"), empty: $("deviceEmptyState"),
    panel: $("selectedDevicePanel"), name: $("selectedDeviceName"),
    meta: $("selectedDeviceMeta"), badge: $("selectedDeviceBadge"),
    temp: $("selectedTemperature"), humidity: $("selectedHumidity"),
    seen: $("selectedLastSeen"), power: $("selectedPowerButton"),
    command: $("selectedCommandState"), routineName: $("routineDeviceName"),
    routineEnabled: $("routineEnabled"), onTime: $("routineOnTime"),
    offTime: $("routineOffTime"), routineMsg: $("routineMessage"),
    saveRoutine: $("saveRoutineButton"), modal: $("modalOverlay"),
    modalIcon: $("modalIcon"), modalTitle: $("modalTitle"),
    modalMessage: $("modalMessage"), modalDetails: $("modalDetails"),
    modalPrimary: $("modalPrimaryButton"), modalSecondary: $("modalSecondaryButton")
  };
  const dayButtons = [...document.querySelectorAll(".day-chip")];

  function device(id) { return DEVICES.find(d => d.deviceId === id) || null; }
  function stamp(v) {
    if (typeof v === "number") return v;
    const parsed = Date.parse(v || "");
    return Number.isFinite(parsed) ? parsed : Date.now();
  }
  function toast(message, type = "") {
    el.toast.textContent = message;
    el.toast.className = `toast show ${type}`.trim();
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.toast.className = "toast"; }, 3200);
  }
  function setBroker(message, ok = false) {
    el.broker.textContent = message;
    el.broker.classList.toggle("connected", ok);
  }
  function openModal({ title, message, details = "", icon = "!", primaryText = "", secondaryText = "닫기", onPrimary = null, onSecondary = null }) {
    el.modalIcon.textContent = icon;
    el.modalTitle.textContent = title;
    el.modalMessage.textContent = message;
    el.modalDetails.textContent = details;
    el.modalDetails.hidden = !details;
    el.modalPrimary.hidden = !primaryText;
    el.modalPrimary.textContent = primaryText || "확인";
    el.modalSecondary.textContent = secondaryText;
    modalPrimary = onPrimary;
    modalSecondary = onSecondary;
    el.modal.hidden = false;
    document.body.classList.add("modal-open");
  }
  function closeModal() {
    el.modal.hidden = true;
    document.body.classList.remove("modal-open");
    modalPrimary = modalSecondary = null;
  }
  function startMqttFailureTimer() {
    clearTimeout(mqttFailTimer);
    mqttFailTimer = setTimeout(() => {
      if (brokerOnline) return;
      openModal({
        title: "MQTT 연결 실패",
        message: "MQTT에 연결하지 못하였습니다.",
        details: "로그인 후 1분 동안 HiveMQ에 반복 연결을 시도했습니다. 네트워크와 HiveMQ 설정을 확인하세요.",
        icon: "×",
        primaryText: "다시 연결",
        onPrimary: () => {
          closeModal();
          try { client?.reconnect(); } catch (_) {}
          startMqttFailureTimer();
        }
      });
    }, 60000);
  }
  function clearMqttFailureTimer() {
    clearTimeout(mqttFailTimer);
    mqttFailTimer = null;
  }
  function online(id) {
    const s = state.get(id);
    const maxAge = Number(mqttCfg?.offlineAfterMs || 45000);
    return Boolean(brokerOnline && s?.online && Date.now() - s.lastSeen <= maxAge);
  }
  function lastSeenLabel(ms) {
    if (!ms) return "대기 중";
    const age = Math.max(0, Date.now() - ms);
    if (age < 10000) return "방금 전";
    if (age < 60000) return `${Math.floor(age / 1000)}초 전`;
    return new Date(ms).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function setRoutineEnabled(enabled) {
    [el.routineEnabled, el.onTime, el.offTime, el.saveRoutine, ...dayButtons]
      .forEach(control => { control.disabled = !enabled; });
    if (!enabled) el.routineMsg.textContent = "연결된 장치를 먼저 선택하세요.";
  }
  function defaultRoutine() {
    return { enabled: true, days: ["MON", "TUE", "WED", "THU", "FRI"], onTime: "07:30", offTime: "16:00" };
  }
  function loadRoutine(id, remote = null) {
    let routine = remote;
    if (!routine) {
      try { routine = JSON.parse(localStorage.getItem(ROUTINE_KEY(id)) || "null"); }
      catch (_) { routine = null; }
    }
    routine ||= defaultRoutine();
    el.routineEnabled.checked = routine.enabled !== false;
    el.onTime.value = routine.onTime || "07:30";
    el.offTime.value = routine.offTime || "16:00";
    const selected = new Set(Array.isArray(routine.days) ? routine.days : []);
    dayButtons.forEach(btn => {
      const active = selected.has(btn.dataset.day);
      btn.classList.toggle("selected", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    el.routineMsg.textContent = "루틴 변경 후 저장을 누르세요.";
    el.routineMsg.className = "routine-message";
  }
  function refreshSelected() {
    const d = device(selectedId);
    const s = state.get(selectedId);
    if (!d || !s) {
      el.panel.hidden = true;
      setRoutineEnabled(false);
      return;
    }
    const isOnline = online(selectedId);
    el.panel.hidden = false;
    el.name.textContent = d.name;
    el.meta.textContent = `${d.controllerId || d.deviceId}${d.servoChannel ? ` · 서보 채널 ${d.servoChannel}` : ""}`;
    el.badge.textContent = isOnline ? "온라인" : "미연결";
    el.badge.className = `device-badge ${isOnline ? "online" : "offline"}`;
    el.temp.textContent = Number.isFinite(s.temperature) ? `${s.temperature.toFixed(1)}°C` : "--.-°C";
    el.humidity.textContent = Number.isFinite(s.humidity) ? `${Math.round(s.humidity)}%` : "--%";
    el.seen.textContent = lastSeenLabel(s.lastSeen);
    el.power.disabled = !isOnline;
    el.power.classList.toggle("ready", isOnline);
    el.command.textContent = isOnline ? "전원 명령 전송 가능" : "장치 연결 대기 중";
    el.command.className = "command-state";
    el.routineName.textContent = `${d.name} 루틴`;
    setRoutineEnabled(isOnline);
    loadRoutine(d.deviceId, s.routine);
  }
  function renderPicker() {
    const connected = DEVICES.filter(d => online(d.deviceId));
    el.menuList.innerHTML = "";
    if (!connected.length) {
      el.menuList.innerHTML = '<p class="device-menu-empty">연결된 장치가 없습니다.</p>';
      el.pickerValue.textContent = "연결 대기";
      el.empty.hidden = false;
      el.panel.hidden = true;
      setRoutineEnabled(false);
      return;
    }
    connected.forEach(d => {
      const s = state.get(d.deviceId);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "device-menu-item";
      button.innerHTML = `<span><strong>${d.name}</strong><small>${d.controllerId || d.deviceId}${d.servoChannel ? ` · Servo ${d.servoChannel}` : ""}</small></span><span class="device-menu-sensor">${Number.isFinite(s?.temperature) ? `${s.temperature.toFixed(1)}°C` : "온라인"}</span>`;
      button.addEventListener("click", () => selectDevice(d.deviceId));
      el.menuList.appendChild(button);
    });
    if (!online(selectedId)) {
      selectedId = connected[0].deviceId;
      localStorage.setItem(SELECTED_KEY, selectedId);
    }
    el.pickerValue.textContent = device(selectedId)?.name || "장치 선택";
    el.empty.hidden = true;
    refreshSelected();
  }
  function selectDevice(id) {
    if (!online(id)) return;
    selectedId = id;
    localStorage.setItem(SELECTED_KEY, id);
    el.menu.hidden = true;
    el.pickerBtn.setAttribute("aria-expanded", "false");
    renderPicker();
  }

  function makeCommand(id, command, extra = {}) {
    const commandId = crypto.randomUUID ? crypto.randomUUID() : `CMD-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return { commandId, body: { commandId, command, deviceId: id, requestedBy: session.userId, ts: Date.now(), ...extra } };
  }
  function publish(id, command, extra = {}) {
    return new Promise((resolve, reject) => {
      if (!device(id) || !mqttCfg?.configured || !online(id) || !client) {
        reject(new Error("장치가 오프라인이거나 MQTT가 연결되지 않았습니다."));
        return;
      }
      const cmd = makeCommand(id, command, extra);
      client.publish(`${mqttCfg.topicPrefix}/${id}/command`, JSON.stringify(cmd.body), { qos: 1 }, error => {
        if (error) return reject(error);
        AUTH.jsonp({ action: "logMqttCommand", token: session.token, commandId: cmd.commandId, deviceId: id, command }).catch(() => {});
        resolve(cmd);
      });
    });
  }
  async function pressPower() {
    const d = device(selectedId);
    if (!d || !online(selectedId)) return toast("연결된 장치를 선택하세요.", "error");
    if (!confirm(`${d.name}의 물리 전원 버튼을 한 번 누릅니다.\n계속할까요?`)) return;
    el.power.disabled = true;
    el.command.textContent = "MQTT 명령 전송 중…";
    try {
      await publish(d.deviceId, "PRESS_POWER");
      el.command.textContent = "장치 실행 응답 대기 중";
      el.command.className = "command-state success";
      toast(`${d.name} 전원 명령을 전송했습니다.`, "success");
    } catch (error) {
      el.command.textContent = "명령 전송 실패";
      el.command.className = "command-state error";
      toast(error.message || "명령 전송에 실패했습니다.", "error");
    } finally { el.power.disabled = !online(d.deviceId); }
  }
  function validateRoutine(r) {
    if (!r.days.length) return "실행할 요일을 한 개 이상 선택하세요.";
    if (r.onTime < "07:30") return "켜지는 시간은 오전 7시 30분 이전으로 설정할 수 없습니다.";
    if (r.offTime > "16:00") return "꺼지는 시간은 오후 4시 이후로 설정할 수 없습니다.";
    if (r.onTime >= r.offTime) return "꺼지는 시간은 켜지는 시간보다 늦어야 합니다.";
    return "";
  }
  async function saveRoutine() {
    const d = device(selectedId);
    if (!d || !online(selectedId)) return toast("연결된 장치를 먼저 선택하세요.", "error");
    const routine = {
      enabled: el.routineEnabled.checked,
      days: dayButtons.filter(b => b.classList.contains("selected")).map(b => b.dataset.day),
      onTime: el.onTime.value,
      offTime: el.offTime.value,
      timezone: "Asia/Seoul"
    };
    const errorMessage = validateRoutine(routine);
    if (errorMessage) {
      el.routineMsg.textContent = errorMessage;
      el.routineMsg.className = "routine-message error";
      return;
    }
    el.saveRoutine.disabled = true;
    el.routineMsg.textContent = "ESP32에 루틴 전송 중…";
    try {
      await publish(d.deviceId, "SET_ROUTINE", { routine });
      localStorage.setItem(ROUTINE_KEY(d.deviceId), JSON.stringify(routine));
      state.get(d.deviceId).routine = routine;
      el.routineMsg.textContent = "루틴을 저장하고 장치에 전송했습니다.";
      el.routineMsg.className = "routine-message success";
      toast(`${d.name} 루틴을 저장했습니다.`, "success");
    } catch (error) {
      el.routineMsg.textContent = error.message || "루틴 저장에 실패했습니다.";
      el.routineMsg.className = "routine-message error";
    } finally { el.saveRoutine.disabled = !online(d.deviceId); }
  }

  function updateTelemetry(id, payload, forceOnline = false) {
    if (!state.has(id)) return;
    const s = state.get(id);
    s.online = forceOnline || payload?.online === true;
    s.lastSeen = stamp(payload?.ts || payload?.timestamp || Date.now());
    const temp = Number(payload?.temperature);
    const humidity = Number(payload?.humidity);
    if (Number.isFinite(temp)) s.temperature = temp;
    if (Number.isFinite(humidity)) s.humidity = humidity;
    renderPicker();
  }
  function handleResult(id, payload) {
    if (!state.has(id)) return;
    const s = state.get(id);
    s.lastSeen = Date.now();
    const success = payload?.success !== false;
    const result = payload?.result || payload?.status || "RESULT";
    if (id === selectedId) {
      el.command.textContent = success ? `실행 완료: ${result}` : `실행 실패: ${result}`;
      el.command.className = `command-state ${success ? "success" : "error"}`;
    }
    if (payload?.commandId) {
      AUTH.jsonp({ action: "logMqttResult", token: session.token, commandId: payload.commandId, deviceId: id, success: String(success), result }).catch(() => {});
    }
  }
  function handleRoutine(id, payload) {
    if (!state.has(id)) return;
    const routine = payload?.routine || payload;
    state.get(id).routine = routine;
    localStorage.setItem(ROUTINE_KEY(id), JSON.stringify(routine));
    if (id === selectedId) loadRoutine(id, routine);
  }
  function notify(title, body) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    try { new Notification(title, { body, tag: "hg-tech-ac-alert" }); } catch (_) {}
  }
  function handleAlert(id, payload) {
    const d = device(id);
    if (!d) return;
    const type = payload?.type || payload?.alertType || "DEVICE_ALERT";
    const before = Number(payload?.beforeTemperature);
    const current = Number(payload?.temperature ?? payload?.currentTemperature);
    const retryCount = Number(payload?.retryCount || 0);
    const cooling = type === "COOLING_NOT_EFFECTIVE";
    const title = cooling ? "냉방 효과 확인 필요" : "장치 알림";
    const message = cooling ? `${d.name}을 켠 뒤 10분이 지났지만 온도가 내려가지 않았습니다.` : String(payload?.message || `${d.name}에서 알림이 발생했습니다.`);
    const details = [
      Number.isFinite(before) ? `가동 전 온도: ${before.toFixed(1)}°C` : "",
      Number.isFinite(current) ? `10분 후 온도: ${current.toFixed(1)}°C` : "",
      retryCount ? `자동 재시도 횟수: ${retryCount}` : ""
    ].filter(Boolean).join(" · ");
    notify(title, message);
    openModal({
      title, message, details, icon: "!", primaryText: "다시 켜기 시도",
      onPrimary: async () => {
        el.modalPrimary.disabled = true;
        try {
          await publish(id, "RETRY_POWER", { reason: type, retryCount: retryCount + 1 });
          closeModal();
          toast(`${d.name} 재시도 명령을 전송했습니다.`, "success");
        } catch (error) {
          el.modalDetails.hidden = false;
          el.modalDetails.textContent = error.message || "재시도 명령 전송에 실패했습니다.";
        } finally { el.modalPrimary.disabled = false; }
      }
    });
  }
  function onMessage(topic, raw) {
    const prefix = mqttCfg.topicPrefix;
    if (!topic.startsWith(`${prefix}/`)) return;
    const [id, channel] = topic.slice(prefix.length + 1).split("/");
    if (!id || !channel) return;
    let payload;
    try { payload = JSON.parse(raw.toString()); }
    catch (_) { payload = { value: raw.toString() }; }
    if (channel === "status") updateTelemetry(id, payload, false);
    if (channel === "telemetry") updateTelemetry(id, payload, true);
    if (channel === "result") handleResult(id, payload);
    if (channel === "routine") handleRoutine(id, payload);
    if (channel === "alert") handleAlert(id, payload);
  }

  function connectMqtt(config) {
    mqttCfg = config;
    if (!config?.configured || !config?.url || !window.mqtt?.connect) {
      setBroker("MQTT 설정 오류");
      startMqttFailureTimer();
      return;
    }
    setBroker("HiveMQ 연결 중");
    startMqttFailureTimer();
    client = window.mqtt.connect(config.url, {
      username: config.username, password: config.password,
      clientId: `hg-web-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      clean: true, protocolVersion: 4, reconnectPeriod: 2000, connectTimeout: 10000, keepalive: 30
    });
    client.on("connect", () => {
      brokerOnline = true;
      clearMqttFailureTimer();
      setBroker("HiveMQ 연결됨", true);
      ["status", "telemetry", "result", "routine", "alert"].forEach(channel => {
        client.subscribe(`${config.topicPrefix}/+/${channel}`, { qos: 1 });
      });
    });
    const disconnected = label => {
      brokerOnline = false;
      setBroker(label);
      startMqttFailureTimer();
      renderPicker();
    };
    client.on("reconnect", () => disconnected("HiveMQ 재연결 중"));
    client.on("close", () => disconnected("HiveMQ 연결 끊김"));
    client.on("offline", () => disconnected("HiveMQ 오프라인"));
    client.on("error", () => disconnected("HiveMQ 연결 오류"));
    client.on("message", onMessage);
  }

  function bindUi() {
    el.pickerBtn.addEventListener("click", event => {
      event.stopPropagation();
      const open = el.menu.hidden;
      el.menu.hidden = !open;
      el.pickerBtn.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", event => {
      if (!el.picker.contains(event.target)) {
        el.menu.hidden = true;
        el.pickerBtn.setAttribute("aria-expanded", "false");
      }
    });
    dayButtons.forEach(btn => btn.addEventListener("click", () => {
      if (btn.disabled) return;
      btn.classList.toggle("selected");
      btn.setAttribute("aria-pressed", String(btn.classList.contains("selected")));
    }));
    el.power.addEventListener("click", pressPower);
    el.saveRoutine.addEventListener("click", saveRoutine);
    el.modalPrimary.addEventListener("click", () => typeof modalPrimary === "function" ? modalPrimary() : closeModal());
    el.modalSecondary.addEventListener("click", () => { if (typeof modalSecondary === "function") modalSecondary(); closeModal(); });
    el.modal.addEventListener("click", event => { if (event.target === el.modal) closeModal(); });
    document.addEventListener("click", () => {
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    }, { once: true });
  }

  function monitor() {
    setInterval(() => {
      const maxAge = Number(mqttCfg?.offlineAfterMs || 45000);
      let changed = false;
      DEVICES.forEach(d => {
        const s = state.get(d.deviceId);
        if (s?.online && Date.now() - s.lastSeen > maxAge) { s.online = false; changed = true; }
      });
      if (changed) renderPicker();
      else if (selectedId) refreshSelected();
    }, 5000);
  }

  async function init() {
    session = await AUTH.validateSession();
    if (!session) return location.replace("../login/");
    $("adminName").textContent = session.displayName || session.userId;
    bindUi();
    renderPicker();
    $("logoutButton").addEventListener("click", async () => {
      clearMqttFailureTimer();
      client?.end(true);
      await AUTH.logout();
      location.replace("../login/");
    });
    try {
      const config = await AUTH.jsonp({ action: "mqttConfig", token: session.token });
      if (!config?.ok) throw new Error(config?.message || "MQTT 설정을 불러오지 못했습니다.");
      connectMqtt(config);
    } catch (error) {
      setBroker("MQTT 설정 오류");
      startMqttFailureTimer();
      toast(error.message, "error");
    }
    monitor();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
