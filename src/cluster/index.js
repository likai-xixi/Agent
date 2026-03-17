const {
  LOCK_ROLES,
  OssHeartbeatLeaderElection,
  defaultNodeId,
  isLeaseExpired,
  normalizeCapabilities
} = require("./heartbeatLock");
const {
  ObjectStoreConflictError,
  ObjectStoreError,
  ObjectStoreNotFoundError,
  OssObjectStorageClient,
  buildOssAuthorizationHeader,
  canonicalizeOssHeaders,
  canonicalizeResource
} = require("./ossObjectStorageClient");

module.exports = {
  LOCK_ROLES,
  ObjectStoreConflictError,
  ObjectStoreError,
  ObjectStoreNotFoundError,
  OssHeartbeatLeaderElection,
  OssObjectStorageClient,
  buildOssAuthorizationHeader,
  canonicalizeOssHeaders,
  canonicalizeResource,
  defaultNodeId,
  isLeaseExpired,
  normalizeCapabilities
};
