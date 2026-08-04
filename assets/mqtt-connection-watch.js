(() => {
  "use strict";

  const FAILURE_DELAY_MS = 60000;
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

  document.addEventListener("DOMContentLoaded", () => {
    const broker = document.getElementById("brokerState");
    if (!broker) return;

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
  });
})();
