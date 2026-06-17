/* eslint-disable */
(function () {
  try {
    // 1. Client-side Bot Filtering
    const botPattern = /bot|spider|crawl|slurp|crawler|mediapartners-google|adsbot|ahrefs|semrush|python|curl|wget|go-http-client|node-fetch/i;
    if (botPattern.test(navigator.userAgent)) {
      return;
    }

    // Find the script element
    let currentScript = document.currentScript;
    if (!currentScript) {
      const scripts = document.getElementsByTagName("script");
      for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src && scripts[i].src.indexOf("/tracker.js") > -1) {
          currentScript = scripts[i];
          break;
        }
      }
    }

    if (!currentScript) return;

    // Parse configuration from script URL
    const scriptUrl = new URL(currentScript.src);
    const monitorId = scriptUrl.searchParams.get("id");
    const token = scriptUrl.searchParams.get("token");
    if (!monitorId || !token) {
      return;
    }

    const API_HOST = scriptUrl.origin;
    const RETRY_QUEUE_KEY = "wp_retry_queue";
    const SESSION_EXPIRY_KEY = "wp_session_expiry";
    const SESSION_TOKEN_KEY = "wp_session_token";

    const pageLoadStartTime = Date.now();
    const initialHiddenState = document.hidden;
    
    // Safe storage access layers to handle incognito restriction policies
    function safeGetItem(key) {
      try {
        return localStorage.getItem(key);
      } catch (e) {
        return null;
      }
    }
    
    function safeSetItem(key, value) {
      try {
        localStorage.setItem(key, value);
        return true;
      } catch (e) {
        return false;
      }
    }

    function safeRemoveItem(key) {
      try {
        localStorage.removeItem(key);
        return true;
      } catch (e) {
        return false;
      }
    }
    let mouseMoved = false;
    let interacted = false;

    // Event listeners for bot signals
    document.addEventListener("mousemove", function onMouseMove() {
      mouseMoved = true;
      document.removeEventListener("mousemove", onMouseMove);
    }, { passive: true });

    function markInteracted() {
      interacted = true;
      document.removeEventListener("scroll", markInteracted);
      document.removeEventListener("click", markInteracted);
      document.removeEventListener("keypress", markInteracted);
    }
    document.addEventListener("scroll", markInteracted, { passive: true });
    document.addEventListener("click", markInteracted, { passive: true });
    document.addEventListener("keypress", markInteracted, { passive: true });

    // Helper to generate a unique random token
    function generateToken() {
      const array = new Uint32Array(4);
      if (typeof window !== "undefined" && window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(array);
        return "wp_" + Array.from(array, dec => dec.toString(36)).join("");
      }
      return "wp_" + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }

    // 30 Minutes Inactivity Session Model
    function getSessionToken() {
      const now = Date.now();
      const expiry = safeGetItem(SESSION_EXPIRY_KEY);
      let sessionToken = safeGetItem(SESSION_TOKEN_KEY);

      if (!sessionToken || !expiry || now > parseInt(expiry, 10)) {
        sessionToken = generateToken();
        safeSetItem(SESSION_TOKEN_KEY, sessionToken);
      }
      
      // Extend session expiry by 30 minutes
      safeSetItem(SESSION_EXPIRY_KEY, (now + 30 * 60 * 1000).toString());
      return sessionToken;
    }

    // Visitor Token
    let visitorToken = safeGetItem("webpulse_visitor");
    if (!visitorToken) {
      visitorToken = generateToken();
      safeSetItem("webpulse_visitor", visitorToken);
    }

    // Font detection
    async function detectFonts() {
      try {
        const fonts = [
          "Arial", "Helvetica", "Times New Roman", "Courier New", "Georgia",
          "Verdana", "Comic Sans MS", "Impact", "Trebuchet MS", "Arial Black",
          "Palatino", "Garamond", "Bookman", "Avant Garde", "Monaco", "Lucida Console"
        ];
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return "unsupported";
        const base = "monospace";
        ctx.font = "72px " + base;
        const baseWidth = ctx.measureText("mmmmmmmmmmlli").width;
        return fonts.filter(f => {
          ctx.font = "72px " + f + "," + base;
          return ctx.measureText("mmmmmmmmmmlli").width !== baseWidth;
        }).join(",");
      } catch (e) {
        return "error";
      }
    }

    // Collect browser signals
    async function collectFingerprint() {
      const signals = {};
      
      // Canvas fingerprint
      try {
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.textBaseline = "top";
          ctx.font = "14px Arial";
          ctx.fillText("WebPulse🔍", 2, 2);
          signals.canvas = canvas.toDataURL().slice(-50);
        } else {
          signals.canvas = "unsupported";
        }
      } catch(e) {
        signals.canvas = "blocked";
      }
      
      // WebGL fingerprint  
      try {
        const gl = document.createElement("canvas").getContext("webgl");
        if (gl) {
          signals.webgl = gl.getParameter(gl.RENDERER) + "|" + gl.getParameter(gl.VENDOR);
        } else {
          signals.webgl = "unsupported";
        }
      } catch(e) {
        signals.webgl = "blocked";
      }
      
      // Audio fingerprint
      try {
        const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 44100, 44100);
        const osc = ctx.createOscillator();
        osc.connect(ctx.destination);
        osc.start(0);
        const buffer = await ctx.startRendering();
        const data = buffer.getChannelData(0);
        signals.audio = data.slice(4500, 4510).reduce((a, b) => a + Math.abs(b), 0).toString().slice(0, 8);
      } catch(e) {
        signals.audio = "blocked";
      }
      
      // System signals
      signals.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      signals.language = navigator.language;
      signals.platform = navigator.platform;
      signals.cores = navigator.hardwareConcurrency || 0;
      signals.memory = navigator.deviceMemory || 0;
      signals.screen = screen.width + "x" + screen.height + "@" + (window.devicePixelRatio || 1);
      signals.plugins = Array.from(navigator.plugins || []).map(p => p.name).join(",").slice(0, 100);
      signals.fonts = await detectFonts();
      signals.touchPoints = navigator.maxTouchPoints || 0;
      
      Object.freeze(signals);
      return signals;
    }

    // FNV-1a Hash
    function fnv1aHash(str) {
      let hash = 2166136261;
      for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = (hash * 16777619) >>> 0;
      }
      return hash.toString(36);
    }

    // Get stable fingerprint ID
    async function getStableVisitorId() {
      try {
        const cached = safeGetItem("_wp_fid");
        if (cached) return cached;

        const signals = await collectFingerprint();
        const raw = JSON.stringify(signals);
        const fpId = fnv1aHash(raw);
        
        safeSetItem("_wp_fid", fpId);
        return fpId;
      } catch (err) {
        return "fp_fallback_" + Math.random().toString(36).substring(2, 10);
      }
    }

    const stableVisitorIdPromise = getStableVisitorId();

    // Modern User Agent Data + Fallback UA parsing
    function getDeviceType() {
      if (navigator.userAgentData && navigator.userAgentData.mobile !== undefined) {
        return navigator.userAgentData.mobile ? "mobile" : "desktop";
      }
      const ua = navigator.userAgent.toLowerCase();
      if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) {
        return "tablet";
      }
      if (/mobile|iphone|ipod|android|blackberry|iemobile|kindle|silk-accelerated|(hpw|web)os|opera m(obi|ini)/.test(ua)) {
        return "mobile";
      }
      return "desktop";
    }

    function getBrowserName() {
      if (navigator.userAgentData && navigator.userAgentData.brands) {
        const brands = navigator.userAgentData.brands.map(b => b.brand);
        if (brands.includes("Google Chrome")) return "Chrome";
        if (brands.includes("Microsoft Edge")) return "Edge";
      }
      const ua = navigator.userAgent;
      if (ua.indexOf("Firefox") > -1) return "Firefox";
      if (ua.indexOf("SamsungBrowser") > -1) return "Samsung Browser";
      if (ua.indexOf("Opera") > -1 || ua.indexOf("OPR") > -1) return "Opera";
      if (ua.indexOf("Trident") > -1) return "Internet Explorer";
      if (ua.indexOf("Edge") > -1 || ua.indexOf("Edg") > -1) return "Edge";
      if (ua.indexOf("Chrome") > -1) return "Chrome";
      if (ua.indexOf("Safari") > -1) return "Safari";
      return "Unknown";
    }

    function getOSName() {
      if (navigator.userAgentData && navigator.userAgentData.platform) {
        const platform = navigator.userAgentData.platform;
        if (platform === "Windows") return "Windows";
        if (platform === "macOS") return "MacOS";
        if (platform === "Linux") return "Linux";
        if (platform === "Android") return "Android";
        if (platform === "iOS") return "iOS";
      }
      const ua = navigator.userAgent;
      if (ua.indexOf("Win") > -1) return "Windows";
      if (ua.indexOf("Mac") > -1) return "MacOS";
      if (ua.indexOf("X11") > -1) return "UNIX";
      if (ua.indexOf("Linux") > -1) return "Linux";
      if (/Android/.test(ua)) return "Android";
      if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
      return "Unknown";
    }

    // In-memory batch event queue
    let eventQueue = [];

    // Push events to batch queue
    function pushToQueue(type, data) {
      // Extend session expiry on user action
      const sessionToken = getSessionToken();
      const timeOnPage = Date.now() - pageLoadStartTime;
      
      eventQueue.push({
        eventId: generateToken(),
        type,
        monitorId,
        token,
        sessionToken,
        visitorToken,
        timestamp: Date.now(),
        _hp: "", // Honeypot field (always empty string for legitimate traffic)
        botSignals: {
          noMouseMovement: (Date.now() - pageLoadStartTime >= 5000) ? !mouseMoved : false,
          instantPageLoad: timeOnPage < 500,
          hiddenTabLoad: initialHiddenState,
          noInteraction: (Date.now() - pageLoadStartTime >= 10000) ? !interacted : false
        },
        ...data
      });
    }

    // Flush batch queue to server
    function flushQueue() {
      if (eventQueue.length === 0) return;
      
      stableVisitorIdPromise.then(function (fpId) {
        eventQueue.forEach(function (ev) {
          ev.fingerprintId = fpId;
          // Refresh time-sensitive signals at transmission time
          if (ev.botSignals) {
            ev.botSignals.noMouseMovement = (Date.now() - pageLoadStartTime >= 5000) ? !mouseMoved : ev.botSignals.noMouseMovement;
            ev.botSignals.noInteraction = (Date.now() - pageLoadStartTime >= 10000) ? !interacted : ev.botSignals.noInteraction;
          }
        });

        const batch = [...eventQueue];
        eventQueue = [];

        const payloadString = JSON.stringify({ events: batch });

        if (!navigator.onLine) {
          queueFailedBatch(batch);
          return;
        }

        try {
          if (navigator.sendBeacon) {
            const blob = new Blob([payloadString], { type: "application/json" });
            const success = navigator.sendBeacon(API_HOST + "/api/events", blob);
            if (success) return;
          }
        } catch (e) {}

        fetch(API_HOST + "/api/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: payloadString,
          keepalive: true
        }).catch(function () {
          queueFailedBatch(batch);
        });
      });
    }

    // Offline localStorage queueing
    function queueFailedBatch(batch) {
      try {
        const offlineQueue = JSON.parse(safeGetItem(RETRY_QUEUE_KEY) || "[]");
        // Combine batches, keeping only the last 100 events to save storage
        const combined = offlineQueue.concat(batch).slice(-100);
        safeSetItem(RETRY_QUEUE_KEY, JSON.stringify(combined));
      } catch (e) {}
    }

    function processOfflineQueue() {
      if (!navigator.onLine) return;
      try {
        const offlineQueue = JSON.parse(safeGetItem(RETRY_QUEUE_KEY) || "[]");
        if (offlineQueue.length === 0) return;
        safeRemoveItem(RETRY_QUEUE_KEY);

        const payloadString = JSON.stringify({ events: offlineQueue });
        fetch(API_HOST + "/api/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: payloadString,
          keepalive: true
        }).catch(function () {
          // Put them back if request failed
          safeSetItem(RETRY_QUEUE_KEY, JSON.stringify(offlineQueue));
        });
      } catch (e) {}
    }

    // Track Pageview
    let lastUrlPath = window.location.pathname;
    function trackPageview() {
      lastUrlPath = window.location.pathname;
      pushToQueue("pageview", {
        url: window.location.pathname,
        title: document.title || "",
        referrer: document.referrer || "",
        screenSize: window.innerWidth + "x" + window.innerHeight,
        browser: getBrowserName(),
        device: getDeviceType(),
        os: getOSName()
      });
      // Flush pageviews immediately
      flushQueue();
    }

    // Track Heartbeat
    function sendHeartbeat() {
      if (document.visibilityState === "visible") {
        pushToQueue("heartbeat", {
          url: window.location.pathname
        });
      }
    }

    // Trigger pageview immediately on load
    if (document.readyState === "complete") {
      trackPageview();
    } else {
      window.addEventListener("load", trackPageview);
    }

    // Heartbeat interval (15s)
    setInterval(sendHeartbeat, 15000);
    // Queue flush interval (5s) to batch heartbeats
    setInterval(flushQueue, 5000);

    // Process offline queue on reconnect
    window.addEventListener("online", processOfflineQueue);
    setTimeout(processOfflineQueue, 1000);

    // Trigger heartbeat on return
    document.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "visible") {
        sendHeartbeat();
      }
    });

    // Flush batch queue before page unload
    window.addEventListener("beforeunload", flushQueue);
    window.addEventListener("visibilitychange", function() {
      if (document.visibilityState === "hidden") {
        flushQueue();
      }
    });

    // SPA Route Changes: Patch pushState, replaceState & listen to popstate
    const nativePushState = history.pushState;
    if (nativePushState) {
      history.pushState = function () {
        nativePushState.apply(this, arguments);
        if (window.location.pathname !== lastUrlPath) {
          trackPageview();
        }
      };
    }

    const nativeReplaceState = history.replaceState;
    if (nativeReplaceState) {
      history.replaceState = function () {
        nativeReplaceState.apply(this, arguments);
        if (window.location.pathname !== lastUrlPath) {
          trackPageview();
        }
      };
    }

    window.addEventListener("popstate", function () {
      if (window.location.pathname !== lastUrlPath) {
        trackPageview();
      }
    });

  } catch (error) {
    // Fail silently
  }
})();
