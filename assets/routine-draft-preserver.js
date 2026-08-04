(() => {
  "use strict";

  const SELECTED_KEY = "hgTechAcSelectedDevice";
  const ROUTINE_PREFIX = "hgTechAcRoutine:";

  function saveDraft() {
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
    ["routineEnabled", "routineOnTime", "routineOffTime"].forEach(id => {
      const control = document.getElementById(id);
      control?.addEventListener("input", saveDraft);
      control?.addEventListener("change", saveDraft);
    });

    document.querySelectorAll(".day-chip").forEach(button => {
      button.addEventListener("click", () => setTimeout(saveDraft, 0));
    });
  });
})();
