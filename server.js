/* eslint-disable */
const { loadEnvConfig } = require("@next/env");
loadEnvConfig(process.cwd());

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { Server } = require("socket.io");
const Redis = require("ioredis");

const dev = process.env.NODE_ENV !== "production";
const hostname = "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

// Validate critical environment variables at startup
const requiredEnvs = ["DATABASE_URL", "ADMIN_EMAIL", "ADMIN_PASSCODE"];
const missingEnvs = requiredEnvs.filter(env => !process.env[env] || process.env[env].trim() === "");
const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
if (!authSecret || authSecret.trim() === "" || authSecret === "webpulsesecretkey1234567890abcdef") {
  missingEnvs.push("AUTH_SECRET/NEXTAUTH_SECRET");
}
if (missingEnvs.length > 0) {
  const errMsg = `FATAL STARTUP ERROR: Missing or insecure configuration for: ${missingEnvs.join(", ")}`;
  console.error("\x1b[31m%s\x1b[0m", errMsg);
  process.exit(1);
}

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  // Setup global IO object for fallback in-memory pub-sub
  global.io = io;

  // Initialize Redis Pub/Sub if connection succeeds
  let redisSub;
  let redisPub;

  if (process.env.REDIS_URL) {
    try {
      redisSub = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });
      redisPub = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 1
      });

      redisSub.on("error", () => {});
      redisPub.on("error", () => {});

      Promise.all([redisSub.connect(), redisPub.connect()])
        .then(() => {
          global.redisPub = redisPub;

          redisSub.subscribe("webpulse-events", "webpulse-active-sync", (err) => {});

          redisSub.on("message", async (channel, message) => {
            if (channel === "webpulse-events") {
              try {
                const data = JSON.parse(message);
                if (data.monitorId) {
                  io.to(`monitor:${data.monitorId}`).emit(data.event, data.payload);
                }
              } catch (e) {
                // Ignore parse errors
              }
            } else if (channel === "webpulse-active-sync") {
              try {
                const data = JSON.parse(message);
                const monitorId = data.monitorId;
                if (monitorId && redisPub) {
                  const zsetKey = `active-visitors:${monitorId}`;
                  const now = Date.now();
                  // Prune expired members
                  await redisPub.zremrangebyscore(zsetKey, "-inf", now);
                  const count = await redisPub.zcard(zsetKey);
                  io.to(`monitor:${monitorId}`).emit("active-visitors-count", {
                    monitorId,
                    count
                  });
                }
              } catch (e) {
                // Ignore parse errors
              }
            }
          });
        })
        .catch((err) => {
          redisSub = null;
          redisPub = null;
        });
    } catch (e) {
      // Silent catch
    }
  }

  // Active visitors list in-memory tracker (fallback)
  const monitorActiveVisitors = new Map();

  async function trackActiveVisitor(monitorId, visitorToken, action) {
    if (!redisPub) {
      // Fallback: local Map tracking
      if (!monitorActiveVisitors.has(monitorId)) {
        monitorActiveVisitors.set(monitorId, new Set());
      }
      if (action === "add" && visitorToken) {
        monitorActiveVisitors.get(monitorId).add(visitorToken);
      } else if (action === "remove" && visitorToken) {
        monitorActiveVisitors.get(monitorId).delete(visitorToken);
      }
      
      const count = monitorActiveVisitors.get(monitorId).size;
      io.to(`monitor:${monitorId}`).emit("active-visitors-count", {
        monitorId,
        count
      });
      return;
    }

    try {
      const zsetKey = `active-visitors:${monitorId}`;
      const now = Date.now();
      
      if (action === "add" && visitorToken) {
        // Expiry in 30 seconds for heartbeat window
        const expiry = now + 30000;
        await redisPub.zadd(zsetKey, expiry, visitorToken);
        await redisPub.expire(zsetKey, 300);
      } else if (action === "remove" && visitorToken) {
        await redisPub.zrem(zsetKey, visitorToken);
      }
      
      // Prune expired
      await redisPub.zremrangebyscore(zsetKey, "-inf", now);
      
      // Publish event to cluster
      await redisPub.publish("webpulse-active-sync", JSON.stringify({ monitorId }));
    } catch (err) {
      // Fallback
    }
  }

  io.on("connection", (socket) => {
    let currentMonitorId = null;
    let currentVisitorToken = null;

    socket.on("join-monitor", ({ monitorId, visitorToken }) => {
      currentMonitorId = monitorId;
      currentVisitorToken = visitorToken;
      socket.join(`monitor:${monitorId}`);

      trackActiveVisitor(monitorId, visitorToken, "add");
    });

    socket.on("heartbeat", ({ monitorId, visitorToken }) => {
      if (monitorId && visitorToken) {
        trackActiveVisitor(monitorId, visitorToken, "add");
      }
    });

    socket.on("leave-monitor", ({ monitorId, visitorToken }) => {
      socket.leave(`monitor:${monitorId}`);
      if (monitorId && visitorToken) {
        trackActiveVisitor(monitorId, visitorToken, "remove");
      }
    });

    socket.on("disconnect", () => {
      if (currentMonitorId && currentVisitorToken) {
        trackActiveVisitor(currentMonitorId, currentVisitorToken, "remove");
      }
    });
  });

  httpServer.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
  });
});
