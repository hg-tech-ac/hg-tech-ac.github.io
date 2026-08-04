(() => {
  "use strict";

  const FAILURE_DELAY_MS = 60000;
  const SELECTED_KEY = "hgTechAcSelectedDevice";
  const ROUTINE_PREFIX = "hgTechAcRoutine:";
  let timer = null;

  function showFailureModal() {
    const overlay = document.getElementById("modalOverlay");
    const icon = document.getElementById("modalIcon");
    const title = document.getElementById("modalTitle");
    const message = document.getElementById("modalMessage");
    const details = document.getElementById("modalDetails");
    const primary = document.getElementById("modalPrimaryButton");
    const secondary = document.getElementById("modalSecondaryButton");
    if (!overlay || !title || !message) return;

    if (icon) icon.textContent = "×";
    title.textContent = "MQTT 연결 실패";
    message.textContent = "MQTT에 연결하지 못하였습니다.";
    if (details) {
      details.hidden = false;
      details.textContent = "관리자 로그인 후 1분 동안 HiveMQ에 계속 연결을 시도했지만 연결되지 않았습니다.";
    }
    if (primary) {
      primary.hidden = false;
      primary.textContent = "다시 연결";
      primary.onclick = () => location.reload();
    }
    if (secondary) {
      secondary.textContent = "닫기";
      secondary.onclick = () => {
        overlay.hidden = true;
        document.body.classList.remove("modal-open");
      };
    }
    overlay.hidden = false;
    document.body.classList.add("modal-open");
  }

  function startTimer() {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const broker = document.getElementById("brokerState");
      if (!broker?.classList.contains("connected")) showFailureModal();
    }, FAILURE_DELAY_MS);
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
  }

  function saveRoutineDraft() {
    const deviceId = localStorage.getItem(SELECTED_KEY);
    if (!deviceId) return;

    const enabled = document.getElementById("routineEnabled");
    const onTime = document.getElementById("routineOnTime");
    const offTime = document.getElementById("routineOffTime");
    const dayButtons = [...document.querySelectorAll(".day-chip")];
    if (!enabled || !onTime || !offTime) return;

    const draft = {
      enabled: enabled.checked,
      days: dayButtons
        .filter(button => button.classList.contains("selected"))
        .map(button => button.dataset.day),
      onTime: onTime.value || "07:30",
      offTime: offTime.value || "16:00",
      timezone: "Asia/Seoul"
    };

    localStorage.setItem(`${ROUTINE_PREFIX}${deviceId}`, JSON.stringify(draft));
  }

  document.addEventListener("DOMContentLoaded", () => {
    const broker = document.getElementById("brokerState");
    if (broker) {
      const inspect = () => {
        if (broker.classList.contains("connected")) stopTimer();
        else startTimer();
      };

      new MutationObserver(inspect).observe(broker, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        characterData: true,
        subtree: true
      });

      inspect();
    }

    ["routineEnabled", "routineOnTime", "routineOffTime"].forEach(id => {
      const control = document.getElementById(id);
      control?.addEventListener("input", saveRoutineDraft);
      control?.addEventListener("change", saveRoutineDraft);
    });

    document.querySelectorAll(".day-chip").forEach(button => {
      button.addEventListener("click", () => setTimeout(saveRoutineDraft, 0));
    });
  });
})();
