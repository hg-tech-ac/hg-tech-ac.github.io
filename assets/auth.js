(() => {
  "use strict";

  const CONFIG = window.HG_CONFIG || {};
  const API_URL = String(CONFIG.API_URL || "").trim();
  const SESSION_KEY = CONFIG.SESSION_KEY || "hgTechAcAdminSession";

  function jsonp(params) {
    return new Promise((resolve, reject) => {
      if (!API_URL) {
        reject(new Error("Apps Script API 주소가 설정되지 않았습니다."));
        return;
      }

      const callbackName = `hgApi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement("script");
      let finished = false;

      const timer = window.setTimeout(() => {
        cleanup();
        reject(new Error("서버 응답 시간이 초과되었습니다."));
      }, 15000);

      function cleanup() {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        script.remove();
        try { delete window[callbackName]; } catch (_) { window[callbackName] = undefined; }
      }

      window[callbackName] = data => {
        cleanup();
        resolve(data);
      };

      const query = new URLSearchParams({
        ...params,
        callback: callbackName,
        _: Date.now().toString()
      });

      script.src = `${API_URL}?${query.toString()}`;
      script.onerror = () => {
        cleanup();
        reject(new Error("Apps Script 서버에 연결하지 못했습니다."));
      };
      document.head.appendChild(script);
    });
  }

  async function sha256(text) {
    const data = new TextEncoder().encode(String(text));
    const hash = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash))
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  function getSession() {
    try {
      const session = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
      if (!session?.token || !session?.expiresAt) return null;
      if (Date.now() >= Number(session.expiresAt)) {
        localStorage.removeItem(SESSION_KEY);
        return null;
      }
      return session;
    } catch (_) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function login(userId, password) {
    const passwordDigest = await sha256(password);
    const result = await jsonp({ action: "login", userId, passwordDigest });
    if (!result?.ok) throw new Error(result?.message || "로그인에 실패했습니다.");

    const session = {
      token: result.token,
      userId: result.userId,
      displayName: result.displayName || result.userId,
      role: result.role || "admin",
      expiresAt: Number(result.expiresAt)
    };
    saveSession(session);
    return session;
  }

  async function validateSession() {
    const session = getSession();
    if (!session) return null;

    try {
      const result = await jsonp({ action: "validateSession", token: session.token });
      if (!result?.ok) throw new Error(result?.message || "세션이 만료되었습니다.");
      session.expiresAt = Number(result.expiresAt || session.expiresAt);
      session.displayName = result.displayName || session.displayName;
      saveSession(session);
      return session;
    } catch (_) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
  }

  async function logout() {
    const session = getSession();
    if (session?.token) {
      try { await jsonp({ action: "logout", token: session.token }); } catch (_) {}
    }
    localStorage.removeItem(SESSION_KEY);
  }

  window.HG_AUTH = Object.freeze({
    jsonp,
    login,
    logout,
    getSession,
    validateSession,
    sessionKey: SESSION_KEY
  });
})();
