import { EventEmitter } from "events";
import httpMocks from "node-mocks-http";

function normalizeBody(body) {
  if (body === undefined) return undefined;
  return typeof body === "string" ? body : JSON.stringify(body);
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};

  return cookieHeader.split(";").reduce((cookies, part) => {
    const [rawName, ...rawValue] = part.split("=");
    const name = rawName?.trim();
    if (!name) return cookies;
    cookies[name] = rawValue.join("=").trim();
    return cookies;
  }, {});
}

export async function invokeApp(app, { method = "GET", url = "/", headers = {}, body } = {}) {
  const req = httpMocks.createRequest({
    method,
    url,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body,
    rawBody: normalizeBody(body),
  });
  const res = httpMocks.createResponse({ eventEmitter: EventEmitter });
  req.cookies = parseCookies(headers.cookie || headers.Cookie);

  await new Promise((resolve, reject) => {
    res.on("finish", resolve);
    res.on("end", resolve);
    app.handle(req, res, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const data = res._getData();
  let parsed = data;

  if (typeof data === "string" && data.length > 0) {
    try {
      parsed = JSON.parse(data);
    } catch {
      parsed = data;
    }
  }

  return {
    status: res.statusCode,
    body: parsed,
    headers: res._getHeaders(),
  };
}
