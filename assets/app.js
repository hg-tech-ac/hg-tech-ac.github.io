(() => {
  "use strict";

  const API_URL = String(window.HG_CONFIG?.API_URL || "").trim();
  const serverState = document.getElementById("serverState");
  const toast = document.getElementById("toast");

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function setDeviceState(deviceId, message, type = "") {
    const element = document.getElementById(`state-${deviceId}`);
    if (!element) return;
    element.textContent = message;
    element.className = `command-state ${type}`.trim();
  }

  function jsonp(params) {
    return new Promise((resolve, reject) => {
      if (!API_URL) {
        reject(new Error("Apps Script URL이 아직 설정되지 않았습니다."));
        return;
      }

      const callbackName = `hgCallback_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      const timeout = window.setTimeout(() => cleanup(new Error("서버 응답 시간이 초과되었습니다.")), 15000);

      function cleanup(error, data) {
        window.clearTimeout(timeout);
        script.remove();
        try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
        if (error) reject(error);
        else resolve(data);
      }

      window[callbackName] = data => cleanup(null, data);

      const query = new URLSearchParams({
        ...params,
        callback: callbackName,
        _: Date.now().toString()
      });

      script.src = `${API_URL}?${query.toString()}`;
      script.onerror = () => cleanup(new Error("Apps Script에 연결하지 못했습니다."));
      document.head.appendChild(script);
    });
  }

  async function checkServer() {
    if (!API_URL) {
      serverState.textContent = "API 연결 전";
      return;
    }

    serverState.textContent = "연결 확인 중";

    try {
      const response = await jsonp({ action: "health" });
      if (!response?.ok) throw new Error(response?.message || "서버 오류");
      serverState.textContent = "서버 연결됨";
      serverState.classList.add("connected");
    } catch (error) {
      serverState.textContent = "서버 연결 실패";
      serverState.classList.remove("connected");
      showToast(error.message);
    }
  }

  async function pressPower(button) {
    const deviceId = button.dataset.device;
    const deviceName = button.dataset.name;

    const accepted = window.confirm(`${deviceName} 컨트롤러의 전원 버튼을 한 번 누릅니다.\n계속할까요?`);
    if (!accepted) return;

    button.disabled = true;
    button.classList.remove("sent");
    setDeviceState(deviceId, "명령 전송 중…");

    try {
      const response = await jsonp({
        action: "pressPower",
        deviceId,
        requestedBy: "GITHUB_WEB"
      });

      if (!response?.ok) throw new Error(response?.message || "명령 생성 실패");

      button.classList.add("sent");
      setDeviceState(deviceId, "전원버튼 명령 대기 중", "success");
      showToast(`${deviceName} 전원 명령을 저장했습니다.`);
    } catch (error) {
      setDeviceState(deviceId, error.message, "error");
      showToast(error.message);
    } finally {
      window.setTimeout(() => {
        button.disabled = false;
        button.classList.remove("sent");
      }, 1800);
    }
  }

  document.querySelectorAll(".power-button").forEach(button => {
    button.addEventListener("click", () => pressPower(button));
  });

  checkServer();
})();
