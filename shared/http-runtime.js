// MCP HTTP runtime 薄层：把每台 server 都要重复的 HTTP 样板抽成共享实现。
//
// 只抽“大家逐字相同”的部分：允许的 Host 计算 + /mcp 的 StreamableHTTP session 样板
// + 不记请求正文/查询/凭据的请求级观测。
// 鉴权（OAuth router / 静态 Bearer / 限流）不在这里——各服务自己组好门卫中间件，
// 通过 middleware 传进来，OAuth 与静态 token 各守各的门。
//
// 关系：buildAllowedHosts 原本在 memory/journal/mixue/xhs 各有一份几乎相同的实现；
// mountMcpEndpoint 的原型是 xhs-server.js 里的本地 registerMcpEndpoint。

const crypto = require("node:crypto");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { isInitializeRequest } = require("@modelcontextprotocol/sdk/types.js");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,100}$/;

function redactText(value) {
  return String(value == null ? "" : value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/((?:access[_-]?token|service[_-]?token|api[_-]?key|authorization|token|password|passphrase|secret|cookie)\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:access[_-]?token|service[_-]?token|api[_-]?key|token|key|password|passphrase|secret)=)[^&#\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}

function normalizeRequestId(value) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return typeof candidate === "string" && REQUEST_ID_PATTERN.test(candidate)
    ? candidate
    : crypto.randomUUID();
}

function requestPath(req) {
  try {
    return new URL(req.originalUrl || req.url || "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

function errorFields(error) {
  if (!error || typeof error !== "object") return { error_name: "Error" };
  const fields = { error_name: redactText(error.name || "Error") };
  if (error.code !== undefined) fields.error_code = redactText(error.code);
  return fields;
}

function defaultLogWriter(entry) {
  console.log(JSON.stringify(entry));
}

function installRequestObservability(app, { service, logger = defaultLogWriter, now = Date.now, trustProxy = "loopback" } = {}) {
  if (!service) throw new Error("installRequestObservability 需要 service 名称");

  // 每台 MCP 只监听 127.0.0.1，公网流量一律由同机的 cloudflared 转发进来，所以信任 loopback
  // 这一跳：req.ip 取 X-Forwarded-For 最右侧的非信任地址，也就是 Cloudflare 认定的真实调用方，
  // 客户端自己伪造的 X-Forwarded-For 只会留在左侧、拿不到信任。
  //
  // 不设置的后果不是“少一个字段”：express-rate-limit（包括 MCP SDK 给 /register、/token、
  // /authorize、/revoke 内置的那几个）在收到 X-Forwarded-For 而 trust proxy 为默认 false 时会抛
  // ERR_ERL_UNEXPECTED_X_FORWARDED_FOR。该校验每进程只触发一次，被它打断的那一次公网请求在
  // Cloudflare 侧表现为 520；之后校验被禁用，限流则一直按 cloudflared 的连接 IP 计数，
  // 等价于把所有调用方合并成一个全局配额。传 false 可跳过（本地测试用）。
  if (trustProxy !== false) app.set("trust proxy", trustProxy);

  app.use((req, res, next) => {
    const requestId = normalizeRequestId(req.get ? req.get("x-request-id") : req.headers["x-request-id"]);
    const startedAt = now();
    let logged = false;
    req.requestId = requestId;
    res.setHeader("X-Request-ID", requestId);

    const write = (entry) => {
      try { logger(entry); } catch { /* 日志失败不应影响请求 */ }
    };
    req.logError = (error, fields = {}) => write({
      timestamp: new Date().toISOString(),
      level: "error",
      event: redactText(fields.event || "request_error"),
      service,
      request_id: requestId,
      method: req.method,
      path: requestPath(req),
      ...errorFields(error),
    });

    const finish = (aborted = false) => {
      if (logged) return;
      logged = true;
      const body = req.body && typeof req.body === "object" ? req.body : null;
      const mcpMethod = body && typeof body.method === "string" ? redactText(body.method) : undefined;
      const toolName = mcpMethod === "tools/call" && body.params && typeof body.params.name === "string"
        ? redactText(body.params.name)
        : undefined;
      write({
        timestamp: new Date().toISOString(),
        level: aborted || res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info",
        event: "http_request",
        service,
        request_id: requestId,
        method: req.method,
        path: requestPath(req),
        status: aborted ? 499 : res.statusCode,
        duration_ms: Math.max(0, now() - startedAt),
        ...(mcpMethod ? { mcp_method: mcpMethod } : {}),
        ...(toolName ? { tool: toolName } : {}),
      });
    };

    res.once("finish", () => finish(false));
    res.once("close", () => { if (!res.writableEnded) finish(true); });
    next();
  });
  return app;
}

// 本机三种写法始终允许；对外域名从 publicUrl 推导，没配或配错就只留本机——
// 宁可只开本机也不要放开成任意 Host。
//
// 注意：SDK 默认只接受 localhost 的 Host 头（DNS rebinding 保护）。对外提供服务时
// 必须把公开域名显式加进白名单，否则所有走域名进来的请求都会被 403 挡掉，而那个
// 403 长得很像网关拒绝，很容易误判成 Cloudflare 的问题。校验是 port-agnostic 的，
// 填主机名即可，不要带端口。
function buildAllowedHosts(publicUrl) {
  const hosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (publicUrl) {
    try {
      hosts.add(new URL(publicUrl).hostname);
    } catch {
      // 配错了就当没配，保持仅本机
    }
  }
  return [...hosts];
}

// 把「path 上的 POST（StreamableHTTP session 样板）+ 其它方法返回 405」挂到 app 上。
//
// - createServer：每次初始化新 session 时调用，返回该服务自己的 McpServer 实例。
//   调用方用箭头函数闭包捕获自己的 store/reader/orderService，例如
//   `createServer: () => createServer(store)`。
// - middleware：这条路径各自的门卫（鉴权 / 限流），按顺序作用于 POST 与兜底的 405。
// - 每次调用各自持有一份 transports Map，因此同一个 app 上挂多条路径时 session 互相隔离。
function mountMcpEndpoint(app, { path = "/mcp", middleware = [], createServer }) {
  const transports = new Map();
  app.post(path, ...middleware, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"];
      let transport = sessionId && transports.get(sessionId);
      if (!transport && !sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: crypto.randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => transports.set(id, transport),
        });
        transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
        await createServer().connect(transport);
      }
      if (!transport) {
        // session 只活在进程内存里，服务一重启就全没了，而客户端手上还留着重启前的
        // Mcp-Session-Id。规范对这种请求要求 404：客户端收到 404 才会丢掉旧 session、
        // 重新发一次不带 session 的 initialize。返回 400 会被理解成"这次请求本身有问题"，
        // 于是客户端抱着同一个失效 session 一直重试，表现为连接页反复报错却永远连不上
        // （服务重启后尤其容易出现：每次都完整重新握手的客户端无感，而复用旧 session
        // 的客户端会一直卡在失效 session 上）。
        // 只有既没带 session、又不是 initialize 的请求才是客户端自己的问题，仍然 400。
        const missingSession = !sessionId;
        res.status(missingSession ? 400 : 404).json({
          jsonrpc: "2.0",
          error: missingSession
            ? { code: -32000, message: "No valid session" }
            : { code: -32001, message: "Session not found" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (typeof req.logError === "function") req.logError(error, { event: "mcp_request_error" });
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  });
  app.all(path, ...middleware, (_req, res) => res.status(405).set("Allow", "POST").send("Method Not Allowed"));
}

module.exports = {
  buildAllowedHosts,
  installRequestObservability,
  mountMcpEndpoint,
  normalizeRequestId,
  redactText,
};
