const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");

const { ValidationError } = require("../platform/contracts");

class ObjectStoreError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = options.code || "OBJECT_STORE_ERROR";
    this.status = options.status || 500;
    this.response = options.response || null;
  }
}

class ObjectStoreConflictError extends ObjectStoreError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || "OBJECT_STORE_CONFLICT",
      status: options.status || 412
    });
    this.name = "ObjectStoreConflictError";
  }
}

class ObjectStoreNotFoundError extends ObjectStoreError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || "OBJECT_NOT_FOUND",
      status: options.status || 404
    });
    this.name = "ObjectStoreNotFoundError";
  }
}

function encodeObjectKey(key) {
  return String(key || "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function canonicalizeOssHeaders(headers = {}) {
  return Object.entries(headers)
    .map(([key, value]) => [String(key || "").toLowerCase(), String(value || "").trim()])
    .filter(([key]) => key.startsWith("x-oss-"))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}:${value}\n`)
    .join("");
}

function canonicalizeResource(bucket, objectKey, query = {}) {
  const base = `/${bucket}/${String(objectKey || "").replace(/^\/+/, "")}`;
  const subresources = Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => value === true ? key : `${key}=${value}`);
  if (subresources.length === 0) {
    return base;
  }
  return `${base}?${subresources.join("&")}`;
}

function buildOssAuthorizationHeader({
  accessKeyId,
  accessKeySecret,
  method,
  bucket,
  objectKey,
  headers = {},
  query = {}
}) {
  const normalizedHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders[String(key)] = String(value || "");
  }
  const stringToSign = [
    method,
    normalizedHeaders["Content-MD5"] || "",
    normalizedHeaders["Content-Type"] || "",
    normalizedHeaders.Date || normalizedHeaders.date || "",
    `${canonicalizeOssHeaders(normalizedHeaders)}${canonicalizeResource(bucket, objectKey, query)}`
  ].join("\n");
  const signature = crypto
    .createHmac("sha1", String(accessKeySecret || ""))
    .update(stringToSign, "utf8")
    .digest("base64");
  return `OSS ${accessKeyId}:${signature}`;
}

function defaultRequester({ url, method, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === "https:" ? https : http;
    const req = client.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers
    }, (res) => {
      let raw = "";
      res.on("data", (chunk) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        resolve({
          status_code: res.statusCode || 0,
          headers: res.headers || {},
          body: raw
        });
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("OSS_REQUEST_TIMEOUT"));
    });
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

class OssObjectStorageClient {
  constructor(options = {}) {
    this.endpoint = String(options.endpoint || "").trim().replace(/\/+$/, "");
    this.bucket = String(options.bucket || "").trim();
    this.prefix = String(options.prefix || "").trim().replace(/^\/+|\/+$/g, "");
    this.timeoutMs = Number(options.timeoutMs || 5000);
    this.virtualHostedStyle = options.virtualHostedStyle !== false;
    this.accessKeyId = String(options.accessKeyId || "").trim();
    this.accessKeySecret = String(options.accessKeySecret || "").trim();
    this.requester = options.requester || defaultRequester;

    if (!this.endpoint || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
      throw new ValidationError("OSS endpoint, bucket, accessKeyId, and accessKeySecret are required");
    }
    this.endpointUrl = new URL(this.endpoint.includes("://") ? this.endpoint : `https://${this.endpoint}`);
  }

  resolveObjectKey(key) {
    const normalizedKey = String(key || "").replace(/^\/+/, "");
    return this.prefix ? `${this.prefix}/${normalizedKey}` : normalizedKey;
  }

  buildObjectUrl(objectKey, query = {}) {
    const encodedKey = encodeObjectKey(this.resolveObjectKey(objectKey));
    const base = new URL(this.endpointUrl.toString());
    if (this.virtualHostedStyle) {
      base.hostname = `${this.bucket}.${base.hostname}`;
      base.pathname = `/${encodedKey}`;
    } else {
      base.pathname = `/${this.bucket}/${encodedKey}`;
    }
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") {
        continue;
      }
      base.searchParams.set(key, value === true ? "" : String(value));
    }
    return base.toString();
  }

  async requestObject({ method, key, body = "", headers = {}, query = {} }) {
    const payloadText = typeof body === "string" ? body : JSON.stringify(body);
    const dateHeader = new Date().toUTCString();
    const normalizedHeaders = {
      Date: dateHeader,
      ...headers
    };
    if (payloadText) {
      normalizedHeaders["Content-Length"] = Buffer.byteLength(payloadText);
      if (!normalizedHeaders["Content-Type"]) {
        normalizedHeaders["Content-Type"] = "application/octet-stream";
      }
      normalizedHeaders["Content-MD5"] = crypto
        .createHash("md5")
        .update(payloadText, "utf8")
        .digest("base64");
    }
    normalizedHeaders.Authorization = buildOssAuthorizationHeader({
      accessKeyId: this.accessKeyId,
      accessKeySecret: this.accessKeySecret,
      method,
      bucket: this.bucket,
      objectKey: this.resolveObjectKey(key),
      headers: normalizedHeaders,
      query
    });

    let response;
    try {
      response = await this.requester({
        url: this.buildObjectUrl(key, query),
        method,
        headers: normalizedHeaders,
        body: payloadText,
        timeoutMs: this.timeoutMs
      });
    } catch (error) {
      throw new ObjectStoreError(error && error.message ? error.message : "OSS request failed", {
        code: "OBJECT_STORE_NETWORK_ERROR",
        status: 503
      });
    }

    const statusCode = Number(response.status_code || 0);
    if (statusCode === 404) {
      throw new ObjectStoreNotFoundError(`Object not found: ${key}`, {
        response
      });
    }
    if ([409, 412].includes(statusCode)) {
      throw new ObjectStoreConflictError(`Object write conflict: ${key}`, {
        status: statusCode,
        response
      });
    }
    if (statusCode < 200 || statusCode >= 300) {
      throw new ObjectStoreError(`OSS request failed with status ${statusCode}`, {
        status: statusCode,
        response
      });
    }
    return response;
  }

  async getJson(key) {
    const response = await this.requestObject({
      method: "GET",
      key
    });
    return {
      etag: String(response.headers.etag || "").replace(/"/g, ""),
      data: response.body ? JSON.parse(response.body) : null
    };
  }

  async putJson(key, payload, options = {}) {
    const headers = {
      "Content-Type": "application/json; charset=utf-8"
    };
    if (options.ifMatch) {
      headers["If-Match"] = options.ifMatch;
    }
    if (options.ifNoneMatch) {
      headers["If-None-Match"] = options.ifNoneMatch;
    }
    const response = await this.requestObject({
      method: "PUT",
      key,
      body: JSON.stringify(payload),
      headers
    });
    return {
      etag: String(response.headers.etag || "").replace(/"/g, "")
    };
  }

  async deleteObject(key, options = {}) {
    const headers = {};
    if (options.ifMatch) {
      headers["If-Match"] = options.ifMatch;
    }
    const response = await this.requestObject({
      method: "DELETE",
      key,
      headers
    });
    return {
      etag: String(response.headers.etag || "").replace(/"/g, "")
    };
  }

  async headObject(key) {
    const response = await this.requestObject({
      method: "HEAD",
      key
    });
    return {
      etag: String(response.headers.etag || "").replace(/"/g, ""),
      headers: response.headers
    };
  }
}

module.exports = {
  ObjectStoreConflictError,
  ObjectStoreError,
  ObjectStoreNotFoundError,
  OssObjectStorageClient,
  buildOssAuthorizationHeader,
  canonicalizeOssHeaders,
  canonicalizeResource
};
