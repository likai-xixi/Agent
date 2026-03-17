const crypto = require("crypto");
const fs = require("fs");

class AuthError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthError";
    this.code = options.code || "AUTH_REQUIRED";
    this.status = options.status || 401;
  }
}

class AuthConfigError extends AuthError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      status: options.status || 503
    });
    this.name = "AuthConfigError";
  }
}

const DEFAULT_API_AUTH_CONFIG = Object.freeze({
  auth_enabled: true,
  jwt_secret: "",
  jwt_issuer: "",
  jwt_audience: "",
  static_tokens: []
});

function normalizeStaticTokens(input = []) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input
    .map((item) => {
      if (typeof item === "string") {
        const token = String(item).trim();
        if (!token) {
          return null;
        }
        return {
          token,
          subject: "api-token-user",
          roles: [],
          mfa_verified: false
        };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return null;
      }
      const token = String(item.token || "").trim();
      if (!token) {
        return null;
      }
      return {
        token,
        subject: String(item.subject || "api-token-user").trim() || "api-token-user",
        role: String(item.role || "").trim(),
        roles: Array.isArray(item.roles) ? item.roles : [],
        mfa_verified: item.mfa_verified === true
      };
    })
    .filter(Boolean);
}

function normalizeApiAuthConfig(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULT_API_AUTH_CONFIG };
  }
  return {
    auth_enabled: raw.auth_enabled !== false,
    jwt_secret: String(raw.jwt_secret || ""),
    jwt_issuer: String(raw.jwt_issuer || ""),
    jwt_audience: String(raw.jwt_audience || ""),
    static_tokens: normalizeStaticTokens(raw.static_tokens)
  };
}

function loadApiAuthConfig(path = "config/api_auth.json") {
  if (!fs.existsSync(path)) {
    return { ...DEFAULT_API_AUTH_CONFIG };
  }
  const raw = JSON.parse(fs.readFileSync(path, "utf8"));
  return normalizeApiAuthConfig(raw);
}

function decodeBase64Url(value) {
  const normalized = String(value || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = normalized.length % 4;
  const padded = pad === 0 ? normalized : `${normalized}${"=".repeat(4 - pad)}`;
  return Buffer.from(padded, "base64").toString("utf8");
}

function encodeBase64Url(value) {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function extractBearerToken(headers = {}) {
  const authHeader = String(headers.authorization || headers.Authorization || "").trim();
  if (/^Bearer\s+/i.test(authHeader)) {
    return authHeader.replace(/^Bearer\s+/i, "").trim();
  }
  const apiToken = String(headers["x-api-token"] || headers["X-API-Token"] || "").trim();
  return apiToken || "";
}

function parseTokenRoles(payload = {}) {
  if (Array.isArray(payload.roles)) {
    return payload.roles.map((item) => String(item || "").trim()).filter(Boolean);
  }
  if (payload.role) {
    return [String(payload.role).trim()].filter(Boolean);
  }
  return [];
}

function parseMfaVerified(payload = {}) {
  if (payload.mfa === true || payload.mfa_verified === true) {
    return true;
  }
  if (Array.isArray(payload.amr)) {
    return payload.amr.some((item) => /^(mfa|otp|totp)$/i.test(String(item || "").trim()));
  }
  if (typeof payload.amr === "string") {
    return /(^|[\s,])(mfa|otp|totp)([\s,]|$)/i.test(payload.amr);
  }
  return false;
}

function identityHasMfa(identity) {
  return Boolean(identity && identity.mfa_verified === true);
}

function hasConfiguredCredentials(config = DEFAULT_API_AUTH_CONFIG) {
  return Boolean(String(config.jwt_secret || "").trim()) || config.static_tokens.length > 0;
}

function toIdentity(base = {}) {
  const subject = String(base.subject || "").trim() || "authenticated-user";
  return {
    subject,
    roles: parseTokenRoles(base),
    auth_type: String(base.auth_type || "none"),
    mfa_verified: identityHasMfa(base)
  };
}

function verifyHs256Jwt(token, secret, options = {}) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) {
    throw new AuthError("Invalid JWT format", {
      code: "AUTH_INVALID_TOKEN"
    });
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  let header;
  let payload;
  try {
    header = JSON.parse(decodeBase64Url(encodedHeader));
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    throw new AuthError("Invalid JWT payload", {
      code: "AUTH_INVALID_TOKEN"
    });
  }
  if (String(header.alg || "").toUpperCase() !== "HS256") {
    throw new AuthError("Unsupported JWT algorithm", {
      code: "AUTH_INVALID_ALGORITHM"
    });
  }
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = crypto
    .createHmac("sha256", String(secret))
    .update(signingInput, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const left = Buffer.from(expectedSignature, "utf8");
  const right = Buffer.from(String(encodedSignature), "utf8");
  const valid = left.length === right.length && crypto.timingSafeEqual(left, right);
  if (!valid) {
    throw new AuthError("Invalid JWT signature", {
      code: "AUTH_INVALID_SIGNATURE"
    });
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Number.isFinite(payload.exp) && nowSeconds >= Number(payload.exp)) {
    throw new AuthError("JWT expired", {
      code: "AUTH_TOKEN_EXPIRED"
    });
  }
  if (Number.isFinite(payload.nbf) && nowSeconds < Number(payload.nbf)) {
    throw new AuthError("JWT not active yet", {
      code: "AUTH_INVALID_TOKEN"
    });
  }
  if (options.issuer && String(payload.iss || "") !== options.issuer) {
    throw new AuthError("Invalid JWT issuer", {
      code: "AUTH_INVALID_ISSUER"
    });
  }
  if (options.audience && String(payload.aud || "") !== options.audience) {
    throw new AuthError("Invalid JWT audience", {
      code: "AUTH_INVALID_AUDIENCE"
    });
  }
  return {
    subject: payload.sub || payload.subject || "jwt-user",
    role: payload.role || "",
    roles: payload.roles || [],
    auth_type: "jwt",
    mfa_verified: parseMfaVerified(payload)
  };
}

function matchStaticToken(token, config) {
  for (const item of config.static_tokens) {
    if (!item || typeof item !== "object") {
      continue;
    }
    if (String(item.token || "") !== token) {
      continue;
    }
    return {
      subject: item.subject || "api-token-user",
      role: item.role || "",
      roles: Array.isArray(item.roles) ? item.roles : [],
      auth_type: "static_token",
      mfa_verified: item.mfa_verified === true
    };
  }
  return null;
}

function authenticateIncomingRequest(req, config = DEFAULT_API_AUTH_CONFIG) {
  const effectiveConfig = normalizeApiAuthConfig(config);
  if (effectiveConfig.auth_enabled !== true) {
    return {
      required: true,
      authenticated: false,
      identity: null,
      token: "",
      error: new AuthConfigError("API authentication is disabled; control plane is locked down.", {
        code: "AUTH_LOCKDOWN"
      })
    };
  }

  if (!hasConfiguredCredentials(effectiveConfig)) {
    return {
      required: true,
      authenticated: false,
      identity: null,
      token: "",
      error: new AuthConfigError("API authentication is misconfigured; no bearer credential source is configured.", {
        code: "AUTH_MISCONFIGURED"
      })
    };
  }

  const token = extractBearerToken(req.headers || {});
  if (!token) {
    return {
      required: true,
      authenticated: false,
      identity: null,
      token: "",
      error: new AuthError("Missing bearer token", {
        code: "AUTH_REQUIRED"
      })
    };
  }

  const staticIdentity = matchStaticToken(token, effectiveConfig);
  if (staticIdentity) {
    return {
      required: true,
      authenticated: true,
      identity: toIdentity(staticIdentity),
      token
    };
  }

  if (effectiveConfig.jwt_secret) {
    try {
      const jwtIdentity = verifyHs256Jwt(token, effectiveConfig.jwt_secret, {
        issuer: effectiveConfig.jwt_issuer,
        audience: effectiveConfig.jwt_audience
      });
      return {
        required: true,
        authenticated: true,
        identity: toIdentity(jwtIdentity),
        token
      };
    } catch (err) {
      return {
        required: true,
        authenticated: false,
        identity: null,
        token,
        error: err instanceof AuthError
          ? err
          : new AuthError("Invalid bearer token", { code: "AUTH_INVALID_TOKEN" })
      };
    }
  }

  return {
    required: true,
    authenticated: false,
    identity: null,
    token,
    error: new AuthError("Invalid bearer token", {
      code: "AUTH_INVALID_TOKEN"
    })
  };
}

function buildSignedJwt(payload = {}, secret = "secret", options = {}) {
  const header = {
    alg: "HS256",
    typ: "JWT"
  };
  const now = Math.floor(Date.now() / 1000);
  const body = {
    iat: now,
    ...payload
  };
  if (options.expiresInSeconds && !Object.prototype.hasOwnProperty.call(body, "exp")) {
    body.exp = now + Number(options.expiresInSeconds);
  }
  const encodedHeader = encodeBase64Url(JSON.stringify(header));
  const encodedPayload = encodeBase64Url(JSON.stringify(body));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", String(secret))
    .update(signingInput, "utf8")
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  return `${signingInput}.${signature}`;
}

module.exports = {
  AuthError,
  AuthConfigError,
  DEFAULT_API_AUTH_CONFIG,
  authenticateIncomingRequest,
  buildSignedJwt,
  hasConfiguredCredentials,
  identityHasMfa,
  loadApiAuthConfig,
  normalizeApiAuthConfig,
  verifyHs256Jwt
};
