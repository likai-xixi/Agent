const os = require("os");
const process = require("process");
const { randomUUID } = require("crypto");

const {
  ObjectStoreConflictError,
  ObjectStoreNotFoundError,
  OssObjectStorageClient
} = require("./ossObjectStorageClient");

const LOCK_ROLES = Object.freeze({
  MASTER: "MASTER",
  SATELLITE: "SATELLITE"
});

function nowIso() {
  return new Date().toISOString();
}

function defaultNodeId() {
  return `${os.hostname()}-${process.pid}`;
}

function normalizeCapabilities(capabilities = {}) {
  return {
    hostname: os.hostname(),
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    cpu_count: os.cpus().length,
    free_memory_mb: Math.round(os.freemem() / 1024 / 1024),
    total_memory_mb: Math.round(os.totalmem() / 1024 / 1024),
    ...capabilities
  };
}

function isLeaseExpired(lease, now = Date.now()) {
  const leaseUntil = Date.parse(lease && lease.lease_expires_at ? lease.lease_expires_at : "");
  if (!Number.isFinite(leaseUntil)) {
    return true;
  }
  return leaseUntil <= now;
}

class OssHeartbeatLeaderElection {
  constructor(options = {}) {
    this.storage = options.storage || new OssObjectStorageClient(options.oss || {});
    this.lockKey = String(options.lockKey || "cluster/leader-lock.json");
    this.scope = String(options.scope || "agent-control-plane");
    this.nodeId = String(options.nodeId || defaultNodeId());
    this.leaseTtlMs = Number(options.leaseTtlMs || 15000);
    this.heartbeatIntervalMs = Number(options.heartbeatIntervalMs || 5000);
    this.capabilities = normalizeCapabilities(options.capabilities || {});
    this.onStateChange = typeof options.onStateChange === "function" ? options.onStateChange : null;
    this.timer = null;
    this.currentLease = null;
    this.state = {
      node_id: this.nodeId,
      scope: this.scope,
      assignment: LOCK_ROLES.SATELLITE,
      is_leader: false,
      last_error: "",
      holder: null,
      capabilities: this.capabilities
    };
  }

  buildLease(version = 1) {
    const now = Date.now();
    return {
      lease_id: randomUUID(),
      scope: this.scope,
      node_id: this.nodeId,
      assignment: LOCK_ROLES.MASTER,
      capabilities: this.capabilities,
      acquired_at: nowIso(),
      last_heartbeat_at: nowIso(),
      lease_expires_at: new Date(now + this.leaseTtlMs).toISOString(),
      version
    };
  }

  async readLease() {
    try {
      return await this.storage.getJson(this.lockKey);
    } catch (error) {
      if (error instanceof ObjectStoreNotFoundError) {
        return null;
      }
      throw error;
    }
  }

  updateState(nextState) {
    const previous = this.getState();
    this.state = {
      ...this.state,
      ...nextState
    };
    if (this.onStateChange) {
      this.onStateChange(previous, this.getState());
    }
    return this.getState();
  }

  getState() {
    return JSON.parse(JSON.stringify(this.state));
  }

  canAcceptImCommands() {
    return this.state.is_leader === true;
  }

  async acquire() {
    const current = await this.readLease();
    if (current && current.data && current.data.node_id !== this.nodeId && !isLeaseExpired(current.data)) {
      this.currentLease = null;
      return this.updateState({
        assignment: LOCK_ROLES.SATELLITE,
        is_leader: false,
        holder: current.data,
        last_error: ""
      });
    }
    const nextVersion = current && current.data && Number.isInteger(current.data.version)
      ? current.data.version + 1
      : 1;
    const nextLease = this.buildLease(nextVersion);
    try {
      const write = current
        ? await this.storage.putJson(this.lockKey, nextLease, { ifMatch: current.etag })
        : await this.storage.putJson(this.lockKey, nextLease, { ifNoneMatch: "*" });
      this.currentLease = {
        data: nextLease,
        etag: write.etag
      };
      return this.updateState({
        assignment: LOCK_ROLES.MASTER,
        is_leader: true,
        holder: nextLease,
        last_error: ""
      });
    } catch (error) {
      if (error instanceof ObjectStoreConflictError) {
        const latest = await this.readLease();
        return this.updateState({
          assignment: LOCK_ROLES.SATELLITE,
          is_leader: false,
          holder: latest ? latest.data : null,
          last_error: ""
        });
      }
      throw error;
    }
  }

  async renew() {
    if (!this.currentLease || !this.currentLease.data) {
      return this.acquire();
    }
    const nextLease = {
      ...this.currentLease.data,
      last_heartbeat_at: nowIso(),
      lease_expires_at: new Date(Date.now() + this.leaseTtlMs).toISOString(),
      version: Number(this.currentLease.data.version || 1) + 1
    };
    try {
      const write = await this.storage.putJson(this.lockKey, nextLease, {
        ifMatch: this.currentLease.etag
      });
      this.currentLease = {
        data: nextLease,
        etag: write.etag
      };
      return this.updateState({
        assignment: LOCK_ROLES.MASTER,
        is_leader: true,
        holder: nextLease,
        last_error: ""
      });
    } catch (error) {
      if (error instanceof ObjectStoreConflictError) {
        this.currentLease = null;
        const latest = await this.readLease();
        return this.updateState({
          assignment: LOCK_ROLES.SATELLITE,
          is_leader: false,
          holder: latest ? latest.data : null,
          last_error: "LEASE_CONFLICT"
        });
      }
      throw error;
    }
  }

  async tick() {
    try {
      const current = await this.readLease();
      if (!current || !current.data) {
        return this.acquire();
      }
      if (current.data.node_id === this.nodeId) {
        this.currentLease = current;
        return this.renew();
      }
      if (isLeaseExpired(current.data)) {
        return this.acquire();
      }
      this.currentLease = null;
      return this.updateState({
        assignment: LOCK_ROLES.SATELLITE,
        is_leader: false,
        holder: current.data,
        last_error: ""
      });
    } catch (error) {
      return this.updateState({
        assignment: LOCK_ROLES.SATELLITE,
        is_leader: false,
        holder: this.state.holder,
        last_error: error && error.message ? error.message : "LEADER_ELECTION_FAILED"
      });
    }
  }

  async start() {
    if (this.timer) {
      return this.getState();
    }
    await this.tick();
    this.timer = setInterval(() => {
      this.tick().catch(() => {
        this.updateState({
          assignment: LOCK_ROLES.SATELLITE,
          is_leader: false
        });
      });
    }, this.heartbeatIntervalMs);
    this.timer.unref();
    return this.getState();
  }

  async release() {
    if (!this.currentLease) {
      return this.updateState({
        assignment: LOCK_ROLES.SATELLITE,
        is_leader: false
      });
    }
    try {
      await this.storage.deleteObject(this.lockKey, {
        ifMatch: this.currentLease.etag
      });
    } catch (error) {
      if (!(error instanceof ObjectStoreNotFoundError) && !(error instanceof ObjectStoreConflictError)) {
        throw error;
      }
    }
    this.currentLease = null;
    return this.updateState({
      assignment: LOCK_ROLES.SATELLITE,
      is_leader: false
    });
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    try {
      await this.release();
    } catch {
      this.currentLease = null;
      this.updateState({
        assignment: LOCK_ROLES.SATELLITE,
        is_leader: false
      });
    }
    return this.getState();
  }
}

module.exports = {
  LOCK_ROLES,
  OssHeartbeatLeaderElection,
  defaultNodeId,
  isLeaseExpired,
  normalizeCapabilities
};
