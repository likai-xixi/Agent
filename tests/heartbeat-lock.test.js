const test = require("node:test");
const assert = require("node:assert/strict");

const {
  ObjectStoreConflictError,
  ObjectStoreNotFoundError,
  buildOssAuthorizationHeader
} = require("../src/cluster/ossObjectStorageClient");
const { OssHeartbeatLeaderElection } = require("../src/cluster/heartbeatLock");

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class InMemoryObjectStore {
  constructor() {
    this.record = null;
    this.version = 0;
  }

  async getJson() {
    if (!this.record) {
      throw new ObjectStoreNotFoundError("missing");
    }
    return {
      etag: this.record.etag,
      data: clone(this.record.data)
    };
  }

  async putJson(_key, payload, options = {}) {
    if (options.ifNoneMatch === "*" && this.record) {
      throw new ObjectStoreConflictError("exists");
    }
    if (options.ifMatch && (!this.record || options.ifMatch !== this.record.etag)) {
      throw new ObjectStoreConflictError("etag mismatch");
    }
    this.version += 1;
    this.record = {
      etag: `etag-${this.version}`,
      data: clone(payload)
    };
    return {
      etag: this.record.etag
    };
  }

  async deleteObject(_key, options = {}) {
    if (!this.record) {
      throw new ObjectStoreNotFoundError("missing");
    }
    if (options.ifMatch && options.ifMatch !== this.record.etag) {
      throw new ObjectStoreConflictError("etag mismatch");
    }
    const current = this.record;
    this.record = null;
    return {
      etag: current.etag
    };
  }
}

test("heartbeat leader election hands over leadership after lease expiry", async () => {
  const storage = new InMemoryObjectStore();
  const leader = new OssHeartbeatLeaderElection({
    storage,
    nodeId: "node-master",
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 1000
  });
  const follower = new OssHeartbeatLeaderElection({
    storage,
    nodeId: "node-satellite",
    heartbeatIntervalMs: 1000,
    leaseTtlMs: 1000
  });

  const first = await leader.acquire();
  assert.equal(first.is_leader, true);
  assert.equal(first.assignment, "MASTER");

  const second = await follower.tick();
  assert.equal(second.is_leader, false);
  assert.equal(second.assignment, "SATELLITE");
  assert.equal(second.holder.node_id, "node-master");

  storage.record.data.lease_expires_at = new Date(Date.now() - 10).toISOString();
  const takeover = await follower.tick();
  assert.equal(takeover.is_leader, true);
  assert.equal(takeover.holder.node_id, "node-satellite");
});

test("buildOssAuthorizationHeader produces OSS-signed header", () => {
  const header = buildOssAuthorizationHeader({
    accessKeyId: "ak-test",
    accessKeySecret: "sk-test",
    method: "PUT",
    bucket: "agent-bucket",
    objectKey: "locks/leader.json",
    headers: {
      Date: "Tue, 17 Mar 2026 10:00:00 GMT",
      "Content-Type": "application/json",
      "Content-MD5": "abc123==",
      "x-oss-meta-role": "master"
    }
  });
  assert.equal(header.startsWith("OSS ak-test:"), true);
});
