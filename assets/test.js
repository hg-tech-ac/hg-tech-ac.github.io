(() => {
  "use strict";

  const AUTH = window.HG_AUTH;
  const CFG = window.HG_CONFIG || {};
  const $ = id => document.getElementById(id);

  const deviceState = new Map((CFG.DEVICES || []).map(device => [device.deviceId, {
    online: false,
    temperature: null,
    humidity: null
  }]));

  let session = null;
  let mqttConfig = null;
  let client = null;
  let mqttConnected = false;
  let roundTripResolver = null;
  let roundTripTopic = "";
  let roundTripTimer = null;

  const els = {
    sessionState: $("sessionState"),
    apiState: $("apiState"),
    mqttState: $("mqttState"),
    roundTripState: $("roundTripState"),
    log: $("testLog"),
    runAll: $("runAllButton"),
    apiTest: $("apiTestButton"),
    mqttTest: $("mqttTestButton"),
    routineResult: $("routineTestResult"),
    onTime: $("testOnTime"),
    offTime: $("testOffTime"),
    modal: $("testModal"),
    modalIcon: $("testModalIcon"),
    modalTitle: $("testModalTitle"),
    modalMessage: $("testModalMessage"),
    modalDetails: $("testModalDetails"),
    modalClose: $("testModalClose"),
    modalAction: $("testModalAction")
  };

  function now() {
    return new Date().toLocaleTimeString("ko-KR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
  }

  function log(message, type = "INFO") {
    const line = `[${now()}] [${type}] ${message}`;
    els.log.textContent = `${line}\n${els.log.textContent}`.trim();
  }

  function setState(element, text, status = "") {
    element.textContent = text;
    element.className = status;
  }

  function openModal({
    title,
    message,
    details = "",
    icon = "!",
    actionText = "",
    onAction = null
  }) {
    els.modalIcon.textContent = icon;
    els.modalTitle.textContent = title;
    els.modalMessage.textContent = message;
    els.modalDetails.textContent = details;
    els.modalDetails.hidden = !details;
    els.modalAction.hidden = !actionText;
    els.modalAction.textContent = actionText || "확인";
    els.modalAction.onclick = typeof onAction === "function" ? onAction : null;
    els.modal.hidden = false;
    document.body.style.overflow = "hidden";
  }

  function closeModal() {
    els.modal.hidden = true;
    document.body.style.overflow = "";
    els.modalAction.onclick = null;
  }

  async function testApi() {
    setState(els.apiState, "확인 중");
    log("Apps Script health API 호출");

    try {
      const result = await AUTH.jsonp({ action: "health" });
      if (!result?.ok) {
        throw new Error(result?.message || "API 응답이 올바르지 않습니다.");
      }

      setState(els.apiState, "정상", "ok");
      log(`Apps Script 정상 · ${result.service || "API"} ${result.version || ""}`, "PASS");
      return true;
    } catch (error) {
      setState(els.apiState, "실패", "error");
      log(error.message || "Apps Script 연결 실패", "FAIL");
      return false;
    }
  }

  function endMqtt() {
    clearTimeout(roundTripTimer);
    roundTripTimer = null;
    roundTripResolver = null;
    roundTripTopic = "";

    if (client) {
      try { client.end(true); } catch (_) {}
    }

    client = null;
    mqttConnected = false;
  }

  async function loadMqttConfig() {
    if (mqttConfig?.configured) return mqttConfig;

    const result = await AUTH.jsonp({
      action: "mqttConfig",
      token: session.token
    });

    if (!result?.ok || !result?.configured) {
      throw new Error(result?.message || "MQTT 설정을 불러오지 못했습니다.");
    }

    mqttConfig = result;
    return result;
  }

  function connectMqtt(config) {
    return new Promise((resolve, reject) => {
      endMqtt();
      setState(els.mqttState, "연결 중");
      log("HiveMQ TLS WebSocket 연결 시도");

      const timeout = setTimeout(() => {
        endMqtt();
        reject(new Error("HiveMQ 연결 시간이 초과되었습니다."));
      }, 12000);

      client = window.mqtt.connect(config.url, {
        username: config.username,
        password: config.password,
        clientId: `hg-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        clean: true,
        protocolVersion: 4,
        reconnectPeriod: 0,
        connectTimeout: 10000,
        keepalive: 30
      });

      client.once("connect", () => {
        clearTimeout(timeout);
        mqttConnected = true;
        setState(els.mqttState, "연결됨", "ok");
        log("HiveMQ 연결 성공", "PASS");
        resolve(client);
      });

      client.once("error", error => {
        clearTimeout(timeout);
        setState(els.mqttState, "실패", "error");
        endMqtt();
        reject(error || new Error("HiveMQ 연결 오류"));
      });

      client.on("close", () => {
        mqttConnected = false;
        if (els.mqttState.textContent === "연결됨") {
          setState(els.mqttState, "연결 끊김", "error");
        }
      });

      client.on("message", (topic, payload) => {
        if (!roundTripResolver || topic !== roundTripTopic) return;

        let data;
        try { data = JSON.parse(payload.toString()); }
        catch (_) { data = { value: payload.toString() }; }

        const resolver = roundTripResolver;
        roundTripResolver = null;
        clearTimeout(roundTripTimer);
        roundTripTimer = null;
        resolver(data);
      });
    });
  }

  async function testMqttRoundTrip() {
    setState(els.roundTripState, "확인 중");

    try {
      const config = await loadMqttConfig();
      if (!mqttConnected || !client?.connected) {
        await connectMqtt(config);
      }

      const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const topic = `${config.topicPrefix}/TEST/ping/${token}`;
      roundTripTopic = topic;

      log(`TEST 토픽 구독 · ${topic}`);

      await new Promise((resolve, reject) => {
        client.subscribe(topic, { qos: 1 }, error => {
          if (error) reject(error);
          else resolve();
        });
      });

      const received = new Promise((resolve, reject) => {
        roundTripResolver = resolve;
        roundTripTimer = setTimeout(() => {
          roundTripResolver = null;
          reject(new Error("발행한 TEST 메시지를 다시 수신하지 못했습니다."));
        }, 8000);
      });

      const payload = {
        type: "PING",
        token,
        requestedBy: session.userId,
        ts: Date.now()
      };

      await new Promise((resolve, reject) => {
        client.publish(topic, JSON.stringify(payload), { qos: 1 }, error => {
          if (error) reject(error);
          else resolve();
        });
      });

      log("TEST ping 발행 완료");
      const result = await received;

      if (result?.token !== token) {
        throw new Error("수신 메시지의 테스트 토큰이 일치하지 않습니다.");
      }

      setState(els.roundTripState, "정상", "ok");
      log("HiveMQ 발행·구독 왕복 테스트 성공", "PASS");
      return true;
    } catch (error) {
      setState(els.mqttState, mqttConnected ? "연결됨" : "실패", mqttConnected ? "ok" : "error");
      setState(els.roundTripState, "실패", "error");
      log(error.message || "MQTT 왕복 테스트 실패", "FAIL");
      return false;
    }
  }

  function renderDevice(deviceId) {
    const state = deviceState.get(deviceId);
    if (!state) return;

    const badge = $(`badge-${deviceId}`);
    const temperature = $(`temp-${deviceId}`);
    const humidity = $(`humidity-${deviceId}`);

    badge.textContent = state.online ? "온라인" : "오프라인";
    badge.className = `device-badge ${state.online ? "online" : "offline"}`;
    temperature.textContent = Number.isFinite(state.temperature)
      ? `${state.temperature.toFixed(1)}°C`
      : "--.-°C";
    humidity.textContent = Number.isFinite(state.humidity)
      ? `${Math.round(state.humidity)}%`
      : "--%";
  }

  function simulateOnline(deviceId) {
    const state = deviceState.get(deviceId);
    if (!state) return;

    state.online = !state.online;
    if (state.online && !Number.isFinite(state.temperature)) {
      state.temperature = 27.5;
      state.humidity = 61;
    }

    renderDevice(deviceId);
    log(`${deviceId} 가상 상태: ${state.online ? "온라인" : "오프라인"}`, "SIM");
  }

  function simulateTelemetry(deviceId) {
    const state = deviceState.get(deviceId);
    if (!state) return;

    state.online = true;
    state.temperature = 23 + Math.random() * 9;
    state.humidity = 40 + Math.random() * 38;
    renderDevice(deviceId);
    log(`${deviceId} 센서 값 변경 · ${state.temperature.toFixed(1)}°C / ${Math.round(state.humidity)}%`, "SIM");
  }

  function simulatePower(deviceId) {
    const state = deviceState.get(deviceId);
    if (!state?.online) {
      log(`${deviceId} 전원 결과 실패 · 장치가 오프라인입니다.`, "FAIL");
      openModal({
        title: "장치 미연결",
        message: "가상 장치를 먼저 온라인으로 전환하세요.",
        details: `${deviceId} 상태가 오프라인입니다.`,
        icon: "×"
      });
      return;
    }

    log(`${deviceId} PRESS_POWER 실행 결과: SUCCESS`, "PASS");
    openModal({
      title: "전원 명령 성공",
      message: "가상 ESP32가 전원 버튼 명령을 정상 처리했습니다.",
      details: `${deviceId} · PRESS_POWER · SUCCESS`,
      icon: "✓"
    });
  }

  function selectedDays() {
    return [...document.querySelectorAll(".test-day.selected")].map(button => button.dataset.day);
  }

  function validateRoutine() {
    const days = selectedDays();
    const onTime = els.onTime.value;
    const offTime = els.offTime.value;
    let error = "";

    if (!days.length) error = "요일을 한 개 이상 선택해야 합니다.";
    else if (onTime < "07:30") error = "켜지는 시간은 오전 7시 30분 이후여야 합니다.";
    else if (offTime > "16:00") error = "꺼지는 시간은 오후 4시 이하여야 합니다.";
    else if (onTime >= offTime) error = "꺼지는 시간은 켜지는 시간보다 늦어야 합니다.";

    if (error) {
      els.routineResult.textContent = error;
      els.routineResult.className = "error";
      log(`루틴 검사 실패 · ${error}`, "FAIL");
      return false;
    }

    els.routineResult.textContent = `${days.length}개 요일 · ${onTime}~${offTime} · 정상`;
    els.routineResult.className = "success";
    log(`루틴 검사 성공 · ${days.join(",")} ${onTime}~${offTime}`, "PASS");
    return true;
  }

  function showCoolingAlert() {
    log("COOLING_NOT_EFFECTIVE 관리자 경고 표시", "SIM");
    openModal({
      title: "냉방 효과 확인 필요",
      message: "에어컨을 켠 뒤 10분이 지났지만 온도가 내려가지 않았습니다.",
      details: "가동 전 29.4°C · 10분 후 29.6°C · 자동 재시도 1회",
      icon: "!",
      actionText: "다시 켜기 시도",
      onAction: () => {
        log("RETRY_POWER 가상 명령 실행", "SIM");
        closeModal();
      }
    });
  }

  function showMqttFailure() {
    log("MQTT 1분 연결 실패 팝업 표시", "SIM");
    openModal({
      title: "MQTT 연결 실패",
      message: "MQTT에 연결하지 못하였습니다.",
      details: "관리자 로그인 후 1분 동안 HiveMQ에 계속 연결을 시도했지만 연결되지 않았습니다.",
      icon: "×",
      actionText: "다시 연결",
      onAction: async () => {
        closeModal();
        await testMqttRoundTrip();
      }
    });
  }

  async function runAllTests() {
    els.runAll.disabled = true;
    log("전체 테스트 시작", "START");

    const apiOk = await testApi();
    const mqttOk = await testMqttRoundTrip();
    const routineOk = validateRoutine();

    (CFG.DEVICES || []).forEach(device => {
      const state = deviceState.get(device.deviceId);
      state.online = true;
      state.temperature = 26.5 + Math.random() * 2;
      state.humidity = 52 + Math.random() * 10;
      renderDevice(device.deviceId);
    });

    const passed = [apiOk, mqttOk, routineOk].filter(Boolean).length;
    log(`전체 테스트 완료 · ${passed}/3 통과`, passed === 3 ? "PASS" : "CHECK");
    els.runAll.disabled = false;
  }

  function bindEvents() {
    els.apiTest.addEventListener("click", testApi);
    els.mqttTest.addEventListener("click", testMqttRoundTrip);
    els.runAll.addEventListener("click", runAllTests);
    $("routineTestButton").addEventListener("click", validateRoutine);
    $("coolingAlertButton").addEventListener("click", showCoolingAlert);
    $("mqttFailureButton").addEventListener("click", showMqttFailure);
    $("clearLogButton").addEventListener("click", () => {
      els.log.textContent = "로그를 지웠습니다.";
    });

    document.querySelectorAll(".test-day").forEach(button => {
      button.addEventListener("click", () => button.classList.toggle("selected"));
    });

    document.querySelectorAll("[data-test-action]").forEach(button => {
      button.addEventListener("click", () => {
        const action = button.dataset.testAction;
        const deviceId = button.dataset.device;
        if (action === "online") simulateOnline(deviceId);
        if (action === "telemetry") simulateTelemetry(deviceId);
        if (action === "power") simulatePower(deviceId);
      });
    });

    els.modalClose.addEventListener("click", closeModal);
    els.modal.addEventListener("click", event => {
      if (event.target === els.modal) closeModal();
    });

    window.addEventListener("beforeunload", endMqtt);
  }

  async function init() {
    bindEvents();
    (CFG.DEVICES || []).forEach(device => renderDevice(device.deviceId));

    try {
      session = await AUTH.validateSession();
    } catch (_) {
      session = null;
    }

    if (!session) {
      setState(els.sessionState, "로그인 필요", "error");
      log("관리자 세션이 없어 로그인 화면으로 이동합니다.", "AUTH");
      setTimeout(() => location.replace("../admin/login/"), 700);
      return;
    }

    setState(els.sessionState, "정상", "ok");
    log(`관리자 세션 정상 · ${session.userId}`, "PASS");
    await testApi();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
